import { randomUUID } from 'node:crypto';
import { formatHitRatePercent, formatSpeedDisplay } from './parsers.mjs';

const PROVIDERS = ['codex', 'claude', 'opencode', 'pi'];
const STORE_KEY = 'preferences-v1';
const EMPTY_ROOTS = () => Object.fromEntries(PROVIDERS.map(key => [key, []]));
const cleanText = (value, limit = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const HIDDEN_ROUTINE_WARNINGS = new Set([
  '仅读取最近 100 个文件会话及最多 10 个数据库。',
  'codex：较大会话只读取末尾 16 MiB，缺少开头的轮次不计入。'
]);

export function validateRoots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录路径设置无效');
  const roots = EMPTY_ROOTS();
  for (const key of Object.keys(value)) {
    if (!PROVIDERS.includes(key)) throw new Error('未知的记录类型');
    if (!Array.isArray(value[key]) || value[key].length > 16) throw new Error('每种记录最多填写 16 个路径');
    roots[key] = [...new Set(value[key].map(path => {
      if (typeof path !== 'string' || path.length > 4096 || /[\u0000\r\n]/.test(path)) throw new Error('记录路径无效');
      const trimmed = path.trim();
      if (/^[a-z]+:\/\//i.test(trimmed)) throw new Error('请填写本机文件路径，不支持网址');
      return trimmed;
    }).filter(Boolean))];
  }
  if (Buffer.byteLength(JSON.stringify(roots), 'utf8') > 16 * 1024) throw new Error('路径设置过长，请减少额外路径');
  return roots;
}

const targetKey = target => target ? JSON.stringify([
  target.key, target.provider, target.sessionId, target.transcriptPath, target.dbPath
]) : null;
const matchesTarget = (session, target) => session && target &&
  session.id === `${session.provider}:${target.sessionId}` &&
  (session.provider === target.provider ||
    (['opencode', 'opencode2'].includes(session.provider) && ['opencode', 'opencode2'].includes(target.provider)));

export function createTpsController(orca, {
  readActive, readSession, now = Date.now, pollMs = 5000, focusPollMs = 500
} = {}) {
  const instanceId = randomUUID();
  let target = null, key = null, session = null;
  let roots = EMPTY_ROOTS(), warnings = [];
  let updatedAt = null, loading = true, generation = 0;
  let emptyMessage = '正在识别当前对话…';
  let stopped = false, started = false;
  let contextPending = null, loadTask = null, timer = null;
  let lastReadAt = -Infinity, lastStatus = '', publishSequence = 0;
  let statusQueue = Promise.resolve();
  const registrations = [];

  function state() {
    return {
      instanceId, generation,
      activeSession: target ? {
        id: `${target.provider}:${target.sessionId}`,
        title: cleanText(target.title || session?.title || '当前对话'),
        provider: target.provider
      } : null,
      records: session?.records?.slice(0, 100) ?? [],
      loading, updatedAt, warnings: [...warnings], emptyMessage
    };
  }

  function publish() {
    if (stopped) return Promise.resolve();
    const snapshot = state(), sequence = ++publishSequence;
    try { orca.panels.post('tps.changed', snapshot); }
    catch { orca.log('面板推送暂未送达，打开右侧对话 TPS 可重新读取。'); }
    const latest = snapshot.records[0];
    const speedText = formatSpeedDisplay(latest);
    const cacheText = formatHitRatePercent(latest?.cacheHitRate);
    const text = `🚀 ${speedText} tokens/s · 🍪 命中 ${cacheText}`;
    const tooltip = cleanText([
      snapshot.activeSession ? `当前对话：${snapshot.activeSession.title}` : snapshot.emptyMessage,
      '最新请求速度（剔除工具耗时；代理扣首字 ≥100 tok，日志估算 ≥200 tok 且 ≥1s）。',
      snapshot.loading ? '正在刷新' : snapshot.warnings.length ? '部分数据不可用，详见面板' : '点击刷新'
    ].join('\n'), 256);
    const status = JSON.stringify({ text, tooltip });
    // Serialize host writes so an older asynchronous update cannot win after a switch.
    statusQueue = statusQueue.then(async () => {
      if (stopped || sequence !== publishSequence || status === lastStatus) return;
      try {
        await orca.host.call('statusBar.update', { id: 'speed', text, tooltip, tone: 'success', visible: true });
        lastStatus = status;
      } catch { orca.log('状态栏暂不可用，请使用 Orca 1.4.251 或更新版本。'); }
    });
    return statusQueue;
  }

  async function syncActive() {
    if (contextPending) return contextPending;
    const task = (async () => {
      let context;
      try { context = await readActive(); }
      catch { context = { target: null, message: '暂时无法读取当前对话，请稍后刷新。' }; }
      if (stopped) return;
      const next = context?.target ?? null, nextKey = targetKey(next);
      const message = cleanText(context?.message || (next ? '当前对话还没有可统计的请求记录。' : '当前页面暂无可统计的对话。'), 300);
      const changed = nextKey !== key;
      const messageChanged = message !== emptyMessage;
      if (changed) {
        generation += 1;
        key = nextKey;
        session = null;
        warnings = [];
        updatedAt = null;
        lastReadAt = -Infinity;
      }
      target = next;
      emptyMessage = message;
      if (changed || !next) loading = Boolean(next);
      if (changed || messageChanged) void publish();
    })();
    contextPending = task;
    try { await task; }
    finally { if (contextPending === task) contextPending = null; }
  }

  async function loadCurrent(force) {
    if (stopped || !target) return state();
    if (loadTask?.generation === generation) return loadTask.promise;
    if (!force && now() - lastReadAt < pollMs) return state();
    const requestedGeneration = generation, requestedTarget = { ...target };
    lastReadAt = now();
    loading = force || !session;
    const task = { generation: requestedGeneration, promise: null };
    task.promise = (async () => {
      void publish();
      if (stopped || requestedGeneration !== generation) return state();
      try {
        const result = await readSession(requestedTarget, { roots: structuredClone(roots) });
        if (stopped || requestedGeneration !== generation) return state();
        session = matchesTarget(result.session, requestedTarget) ? result.session : null;
        warnings = (result.warnings ?? []).map(text => cleanText(text, 500))
          .filter(text => !HIDDEN_ROUTINE_WARNINGS.has(text)).slice(0, 20);
        updatedAt = now();
      } catch {
        if (stopped || requestedGeneration !== generation) return state();
        session = null;
        updatedAt = null;
        warnings = ['当前对话的记录读取失败，请稍后刷新。'];
      }
      loading = false;
      void publish();
      return state();
    })().finally(() => { if (loadTask === task) loadTask = null; });
    loadTask = task;
    return task.promise;
  }

  async function checkActive({ force = false } = {}) {
    if (stopped) return state();
    await syncActive();
    return loadCurrent(force);
  }
  const refresh = () => checkActive({ force: true });

  async function start({ background = false } = {}) {
    if (started) return;
    started = true;
    try {
      const saved = await orca.storage.get(STORE_KEY);
      if (saved?.roots) roots = validateRoots(saved.roots);
    } catch { orca.log('旧路径设置无法读取，使用默认位置。'); }
    if (stopped) return;
    registrations.push(
      orca.panels.handle('tps.state', () => state()),
      orca.panels.handle('tps.refresh', refresh),
      orca.commands.register('tps.refresh', refresh)
    );
    const firstRefresh = refresh();
    if (focusPollMs > 0) {
      timer = setInterval(() => { void checkActive().catch(() => orca.log('后台刷新失败，将在下次重试。')); }, focusPollMs);
      timer.unref?.();
    }
    if (!background) await firstRefresh;
    else void firstRefresh.catch(() => orca.log('当前对话读取失败，请稍后刷新。'));
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const entry of registrations) entry.dispose();
  }
  return { start, stop, refresh, checkActive, state };
}
