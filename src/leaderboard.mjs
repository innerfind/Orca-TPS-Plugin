import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { leaderboardDay } from './usage-summary.mjs';

const METHOD = 'tps.leaderboard';
const SECRET = 'leaderboard-session';
const UPLOAD = 'leaderboard:upload';
const RANKING_CACHE = 'leaderboard:ranking';
const DEFAULT_ENDPOINT = 'https://43.157.2.14';
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const LOGIN_POLL = 2000;
const DEFAULT_UPLOAD_INTERVAL = 60;
const validInterval = seconds => Number.isSafeInteger(seconds) && seconds >= 10 && Number.isSafeInteger(seconds * 1000);
const sessionKey = value => value ? createHash('sha256').update(value).digest('hex') : '';
const tokenPattern = /^[\w-]{43}$/;

function publicRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100 || !rows.every(row =>
    row && typeof row.username === 'string' && Number.isSafeInteger(row.rank) && row.rank > 0 &&
    Number.isSafeInteger(row.tokens) && row.tokens > 0 &&
    Number.isSafeInteger(row.submittedAt) && Number.isFinite(new Date(row.submittedAt).getTime())
  )) return null;
  return rows.map(({ rank, username, tokens, submittedAt }) => ({ rank, username, tokens, submittedAt }));
}

export function startLeaderboard(orca, {
  readUsage, endpoint = process.env.ORCA_TPS_LEADERBOARD_URL || DEFAULT_ENDPOINT,
  fetcher = fetch, now = () => new Date()
}) {
  const base = new URL(endpoint);
  if (base.username || base.password || (base.protocol !== 'https:' &&
      (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('榜单服务需要 HTTPS。');
  }
  const lifetime = new AbortController();
  const host = orca.host;
  let token = '', login, submitting, scheduling = false, nextAttempt = 0;
  let upload = { enabled: false, interval: DEFAULT_UPLOAD_INTERVAL };
  let settingsWrite = Promise.resolve();
  let ranking, savedRanking;
  let rankingRequest = 0, latestRankingRequest = 0;
  let rankingWrite = Promise.resolve();
  let lastAutomaticResult = null;
  const secretAvailable = method => orca.grantedCapabilities?.includes('secrets:own') && host?.has(method);
  const today = () => leaderboardDay(now().getTime());

  const rankingReady = Promise.resolve().then(async () => {
    const saved = await orca.storage.get(RANKING_CACHE);
    if (ranking || saved?.origin !== base.origin || saved.day !== today() || !Number.isSafeInteger(saved.updatedAt) ||
        !Number.isFinite(new Date(saved.updatedAt).getTime())) return;
    const rows = publicRows(saved.rows);
    if (!rows) return;
    ranking = { day: saved.day, rows, updatedAt: saved.updatedAt };
    savedRanking = JSON.stringify([saved.day, rows]);
  }).catch(() => {});

  function rememberRanking(day, rows, updatedAt) {
    ranking = { day, rows, updatedAt };
    const signature = JSON.stringify([day, rows]);
    if (signature === savedRanking) return;
    savedRanking = signature;
    const saved = { ...ranking, origin: base.origin };
    rankingWrite = rankingWrite.then(async () => {
      try { await orca.storage.set(RANKING_CACHE, saved); }
      catch { if (savedRanking === signature) savedRanking = undefined; }
    });
  }

  const ready = (async () => {
    const tasks = [orca.storage.get(UPLOAD)];
    if (secretAvailable('secrets.get')) tasks.push(host.call('secrets.get', { key: SECRET }));
    const [setting, saved] = await Promise.allSettled(tasks);
    if (tokenPattern.test(saved?.value?.value ?? '')) token = saved.value.value;
    if (validInterval(setting.value?.interval)) {
      upload = { enabled: Boolean(token) && setting.value.enabled === true && setting.value.session === sessionKey(token), interval: setting.value.interval };
    }
  })();

  function saveUpload() {
    const setting = { ...upload, session: upload.enabled ? sessionKey(token) : '' };
    settingsWrite = settingsWrite.catch(() => {}).then(() => orca.storage.set(UPLOAD, setting));
    return settingsWrite;
  }

  async function stopUpload() {
    if (!upload.enabled) return;
    upload = { ...upload, enabled: false };
    lastAutomaticResult = null;
    await saveUpload().catch(() => {});
  }

  async function saveToken(value) {
    const changed = token !== value;
    token = value;
    if (changed) await stopUpload();
    const operation = value ? 'secrets.set' : 'secrets.delete';
    if (secretAvailable(operation)) {
      try { await host.call(operation, value ? { key: SECRET, value } : { key: SECRET }); }
      catch { /* The current session still works if the OS keyring is unavailable. */ }
    }
  }

  async function request(path, { body, auth = true, requestId } = {}) {
    const credential = token;
    try {
      const headers = { Accept: 'application/json' };
      if (auth && credential) headers.Authorization = 'Bearer ' + credential;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (requestId) headers['Idempotency-Key'] = requestId;
      const response = await fetcher(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      });
      const result = await response.json();
      if (!result || typeof result !== 'object') return { code: 'unavailable' };
      if (auth && credential && token === credential && (response.status === 401 || result.authenticated === false)) {
        await saveToken('');
      }
      return result;
    } catch {
      return { code: 'unavailable' };
    }
  }

  async function state() {
    const requested = ++rankingRequest;
    const board = await request('/api/today');
    const updatedAt = now().getTime();
    const rows = board.day === leaderboardDay(updatedAt) ? publicRows(board.rows) : null;
    if (rows && requested > latestRankingRequest) {
      latestRankingRequest = requested;
      rememberRanking(board.day, rows, updatedAt);
    }
    return {
      board: rows ? board : { code: board.code ?? 'unavailable' },
      updatedAt: rows ? updatedAt : null,
      signedIn: Boolean(token), upload, lastAutomaticResult
    };
  }

  function beginLogin() {
    if (!login || (login.expiresAt && login.expiresAt <= now().getTime())) {
      const verifier = randomBytes(32).toString('base64url');
      const url = new URL('/auth/plugin/start', base);
      url.searchParams.set('challenge', createHash('sha256').update(verifier).digest('base64url'));
      login = { verifier, url: url.href, expiresAt: 0 };
    }
    return { loginUrl: login.url, interval: LOGIN_POLL, timeout: LOGIN_TIMEOUT };
  }

  async function pollLogin() {
    if (!login) return { code: 'login_expired' };
    const attempt = login;
    const time = now().getTime();
    attempt.expiresAt ||= time + LOGIN_TIMEOUT;
    if (time >= attempt.expiresAt) {
      login = undefined;
      return { code: 'login_expired' };
    }
    const result = await request('/api/auth/plugin/poll', { auth: false, body: { verifier: attempt.verifier } });
    if (attempt !== login) return { code: 'login_expired' };
    if (tokenPattern.test(result.token ?? '')) {
      login = undefined;
      await saveToken(result.token);
      return { code: 'signed_in', ...await state() };
    }
    if (['login_expired', 'login_denied', 'github_unavailable'].includes(result.code)) login = undefined;
    return { code: result.code || 'unavailable' };
  }

  function submit(preview, stillEnabled = () => true) {
    if (submitting) return { code: 'upload_in_progress' };
    submitting = performSubmission(preview, stillEnabled).finally(() => { submitting = undefined; });
    return submitting;
  }

  async function performSubmission(preview, stillEnabled) {
    if (!token) return { code: 'login_required' };
    const credential = token;
    if (!preview?.ready || !Number.isSafeInteger(preview.tokens) || preview.tokens < 1) return { code: 'usage_unready' };
    const status = await request('/api/today/status');
    if (token !== credential) return { code: 'login_required' };
    if (!stillEnabled()) return { code: 'upload_disabled' };
    if (status.code) return status;
    if (status.day !== preview.day) return { code: 'new_day' };
    if (status.lockedUntil) return { code: 'locked', ...status };
    if (status.submitted && status.tokens === null) return { code: 'removed', ...status };
    if (status.nextUploadAt !== null && status.nextUploadAt !== undefined) return { code: 'too_soon', ...status };

    const requestId = randomUUID();
    const options = { requestId, body: { day: preview.day, tokens: preview.tokens } };
    const result = await request('/api/today/submit', options);
    if (result.code === 'unavailable' && token === credential && stillEnabled()) return request('/api/today/submit', options);
    return result;
  }

  async function runScheduled() {
    await ready;
    if (!upload.enabled || !token || scheduling || lifetime.signal.aborted || now().getTime() < nextAttempt) return;
    const settings = upload;
    const credential = token;
    const stillEnabled = () => upload === settings && token === credential && !lifetime.signal.aborted;
    scheduling = true;
    try {
      const preview = await readUsage();
      if (!stillEnabled() || !preview.ready || preview.tokens < 1) return;
      const result = await submit(preview, stillEnabled);
      if (stillEnabled()) {
        nextAttempt = now().getTime() + settings.interval * 1000;
        lastAutomaticResult = { day: preview.day, code: result.code || 'unavailable' };
      }
    } finally { scheduling = false; }
  }

  const registration = orca.panels.handle(METHOD, async payload => {
    if (payload?.action === 'cache') {
      if (!ranking) await rankingReady;
      return { ranking: ranking?.day === today() ? ranking : null };
    }
    if (payload?.action === 'usage') return { local: await readUsage() };
    await ready;
    switch (payload?.action) {
      case 'state': return state();
      case 'login': return beginLogin();
      case 'poll': return pollLogin();
      case 'cancel': login = undefined; return { ok: true };
      case 'logout': {
        login = undefined;
        lastAutomaticResult = null;
        await stopUpload();
        if (token) await request('/api/auth/logout', { body: {} });
        await saveToken('');
        return state();
      }
      case 'submit': {
        const current = await readUsage();
        if (payload.day !== current.day || payload.tokens !== current.tokens) return { code: 'usage_changed', ...await state() };
        const result = await submit(current);
        return { code: result.code || 'unavailable', ...await state() };
      }
      case 'upload': {
        if (typeof payload.enabled !== 'boolean' || !validInterval(payload.interval)) return { code: 'invalid_interval' };
        if (payload.enabled && !token) return { code: 'login_required' };
        const setting = { enabled: payload.enabled, interval: payload.interval };
        upload = setting;
        nextAttempt = upload.enabled && nextAttempt > now().getTime() ? now().getTime() + upload.interval * 1000 : 0;
        lastAutomaticResult = null;
        try { await saveUpload(); }
        catch {
          if (upload === setting) upload = { ...upload, enabled: false };
          return { code: 'unavailable', upload, lastAutomaticResult };
        }
        void runScheduled().catch(() => {});
        return { upload, lastAutomaticResult };
      }
      default: return { code: 'invalid' };
    }
  });
  const timer = setInterval(() => void runScheduled().catch(() => {}), 1000);
  timer.unref?.();
  void runScheduled().catch(() => {});
  return () => {
    lifetime.abort();
    clearInterval(timer);
    registration.dispose?.();
  };
}
