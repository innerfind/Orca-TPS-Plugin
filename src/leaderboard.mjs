import { createHash, randomBytes, randomUUID } from 'node:crypto';

const METHOD = 'tps.leaderboard';
const SECRET = 'leaderboard-session';
const SCHEDULE = 'leaderboard:schedule';
const SCHEDULE_DAY = 'leaderboard:auto-day';
const DEFAULT_ENDPOINT = 'https://43.157.2.14';
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const LOGIN_POLL = 2000;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const tokenPattern = /^[\w-]{43}$/;

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
  let token = '', schedule = '', automaticDay = '', login, submitting, scheduling = false;
  let lastAutomaticResult = null;
  const secretAvailable = method => orca.grantedCapabilities?.includes('secrets:own') && host?.has(method);

  const ready = (async () => {
    const tasks = [orca.storage.get(SCHEDULE), orca.storage.get(SCHEDULE_DAY)];
    if (secretAvailable('secrets.get')) tasks.push(host.call('secrets.get', { key: SECRET }));
    const [setting, day, saved] = await Promise.allSettled(tasks);
    if (timePattern.test(setting.value ?? '')) schedule = setting.value;
    if (typeof day.value === 'string') automaticDay = day.value;
    if (tokenPattern.test(saved?.value?.value ?? '')) token = saved.value.value;
  })();

  async function saveToken(value) {
    token = value;
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
    const [local, board] = await Promise.all([readUsage(), request('/api/today')]);
    return { local, board, schedule, lastAutomaticResult };
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

  function submit(preview) {
    if (submitting) return submitting;
    submitting = performSubmission(preview).finally(() => { submitting = undefined; });
    return submitting;
  }

  async function performSubmission(preview) {
    if (!token) return { code: 'login_required' };
    const credential = token;
    if (!preview?.ready || !Number.isSafeInteger(preview.tokens) || preview.tokens < 1) return { code: 'usage_unready' };
    const status = await request('/api/today/status');
    if (token !== credential) return { code: 'login_required' };
    if (status.code) return status;
    if (status.day !== preview.day) return { code: 'new_day' };
    if (status.lockedUntil) return { code: 'locked', ...status };
    if (status.submitted) return { code: 'duplicate', ...status };

    const requestId = randomUUID();
    const result = await request('/api/today/submit', { requestId, body: { day: preview.day, tokens: preview.tokens } });
    if (result.code !== 'unavailable') return result;
    const latest = await request('/api/today/status');
    if (latest.day === preview.day && latest.submitted) return { code: 'accepted', ...latest };
    return result;
  }

  async function runScheduled() {
    await ready;
    if (!schedule || !token || scheduling || lifetime.signal.aborted) return;
    const clock = now();
    const credential = token;
    const time = [clock.getHours(), clock.getMinutes()].map(part => String(part).padStart(2, '0')).join(':');
    if (time !== schedule) return;
    scheduling = true;
    try {
      const preview = await readUsage();
      const mark = preview.day + ':' + createHash('sha256').update(credential).digest('hex');
      if (token !== credential || !preview.ready || preview.tokens < 1 || mark === automaticDay) return;
      automaticDay = mark;
      await orca.storage.set(SCHEDULE_DAY, automaticDay).catch(() => {});
      if (token !== credential) return;
      const result = await submit(preview);
      if (token === credential) lastAutomaticResult = { day: preview.day, code: result.code };
    } finally { scheduling = false; }
  }

  const registration = orca.panels.handle(METHOD, async payload => {
    await ready;
    switch (payload?.action) {
      case 'state': return state();
      case 'login': return beginLogin();
      case 'poll': return pollLogin();
      case 'cancel': login = undefined; return { ok: true };
      case 'logout': {
        login = undefined;
        lastAutomaticResult = null;
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
      case 'schedule': {
        if (payload.time !== '' && !timePattern.test(payload.time ?? '')) return { code: 'invalid_time' };
        await orca.storage.set(SCHEDULE, payload.time);
        schedule = payload.time;
        void runScheduled().catch(() => {});
        return state();
      }
      default: return { code: 'invalid' };
    }
  });
  const timer = setInterval(() => void runScheduled().catch(() => {}), 5000);
  timer.unref?.();
  void runScheduled().catch(() => {});
  return () => {
    lifetime.abort();
    clearInterval(timer);
    registration.dispose?.();
  };
}
