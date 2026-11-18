import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { activeProfileUserData } from './active-conversation.mjs';
import { localDayKey } from './usage-summary.mjs';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';
const CONFIG_STORAGE_KEY = 'leaderboard:config:v1';
const SYNC_STORAGE_KEY = 'leaderboard:sync:v1';
const CACHE_STORAGE_KEY = 'leaderboard:cache:v1';
const TOKEN_SECRET_KEY = 'leaderboard:token:v1';
const CLAIM_SECRET_KEY = 'leaderboard:claim:v1';
const SYNC_BATCH_SIZE = 400;
const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 6_000;

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

export function normalizeServerUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return null;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${normalizedPath}`;
}

export function periodKeyFor(period, nowMs = Date.now()) {
  const day = localDayKey(nowMs);
  if (period === 'month') return day.slice(0, 7);
  if (period === 'year') return day.slice(0, 4);
  return day;
}

async function readOrcaCloudDisplayHint() {
  try {
    const userDataPath = activeProfileUserData();
    const raw = await readFile(path.join(userDataPath, 'orca-profile-index.json'), 'utf8');
    const index = JSON.parse(raw);
    const active = Array.isArray(index?.profiles)
      ? index.profiles.find(profile => profile?.id === index.activeProfileId)
      : null;
    if (active?.kind === 'cloud-linked' && typeof active.cloud?.displayName === 'string') {
      return active.cloud.displayName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    }
    if (typeof active?.name === 'string' && active.name && active.name !== 'Personal') {
      return active.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    }
  } catch { /* Optional hint only; missing or local profiles return empty. */ }
  return '';
}

export function createLeaderboardService(orca, {
  getSnapshot,
  fetchImpl = fetch,
  now = () => Date.now(),
  readDisplayHint = readOrcaCloudDisplayHint
} = {}) {
  const lifetime = new AbortController();
  let initialized = null;
  let config = {
    enabled: false,
    serverUrl: DEFAULT_SERVER_URL,
    anonymousMode: false,
    localScopeId: randomBytes(12).toString('hex')
  };
  let syncState = { serverUrl: '', userId: '', hashes: {}, lastSyncAt: 0 };
  let cacheState = { serverUrl: '', user: null, boards: {}, updatedAt: null };
  let authToken = null;
  let claimCode = null;
  let serverInfo = null;
  let secretError = '';
  let lastSyncError = '';
  let syncing = false;
  let lastAutoSyncAt = 0;

  const hasCapability = kind => !Array.isArray(orca?.grantedCapabilities) || orca.grantedCapabilities.includes(kind);

  async function readSetting(key) {
    if (!orca?.settings?.get || !hasCapability('settings:own')) return undefined;
    try { return await orca.settings.get(key); }
    catch { return undefined; }
  }

  async function writeSetting(key, value) {
    if (!orca?.settings?.set || !hasCapability('settings:own')) return;
    try {
      const existing = await readSetting(key);
      if (existing === value) return;
      await orca.settings.set(key, value);
    } catch { /* Settings storage is best-effort alongside storage:own. */ }
  }

  async function loadSecret(key) {
    if (!orca?.secrets?.get || !hasCapability('secrets:own')) return null;
    try { return await orca.secrets.get(key); }
    catch { return null; }
  }

  async function saveSecret(key, value) {
    if (!orca?.secrets?.set || !hasCapability('secrets:own')) {
      throw new Error('请先在 Orca 插件权限中批准“保存密钥（secrets:own）”');
    }
    try {
      if (value === null) await orca.secrets.delete(key);
      else await orca.secrets.set(key, value);
      secretError = '';
    } catch (error) {
      secretError = error?.code === 'unavailable'
        ? '当前系统未提供密钥链保护，无法安全保存登录凭证。'
        : `凭证存储失败（${error?.message ?? 'unknown'}）`;
      throw new Error(secretError);
    }
  }

  async function init() {
    if (initialized) return initialized;
    initialized = (async () => {
      try {
        const storedConfig = await orca.storage.get(CONFIG_STORAGE_KEY);
        if (storedConfig && typeof storedConfig === 'object') {
          if (typeof storedConfig.enabled === 'boolean') config.enabled = storedConfig.enabled;
          if (typeof storedConfig.anonymousMode === 'boolean') config.anonymousMode = storedConfig.anonymousMode;
          const url = normalizeServerUrl(storedConfig.serverUrl);
          if (url) config.serverUrl = url;
          if (typeof storedConfig.localScopeId === 'string' && /^[a-f0-9]{16,64}$/.test(storedConfig.localScopeId)) {
            config.localScopeId = storedConfig.localScopeId;
          }
        }
      } catch { /* Use defaults when storage is empty. */ }

      const settingUrl = normalizeServerUrl(await readSetting('leaderboard.serverUrl'));
      if (settingUrl) config.serverUrl = settingUrl;
      const settingEnabled = await readSetting('leaderboard.enabled');
      if (typeof settingEnabled === 'boolean') config.enabled = settingEnabled;
      const settingAnon = await readSetting('leaderboard.anonymousMode');
      if (typeof settingAnon === 'boolean') config.anonymousMode = settingAnon;

      await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});

      try {
        const storedSync = await orca.storage.get(SYNC_STORAGE_KEY);
        if (storedSync && typeof storedSync === 'object' && storedSync.hashes && typeof storedSync.hashes === 'object') {
          syncState = {
            serverUrl: typeof storedSync.serverUrl === 'string' ? storedSync.serverUrl : '',
            userId: typeof storedSync.userId === 'string' ? storedSync.userId : '',
            hashes: { ...storedSync.hashes },
            lastSyncAt: Number.isFinite(storedSync.lastSyncAt) ? storedSync.lastSyncAt : 0
          };
        }
      } catch { /* ignore */ }

      try {
        const storedCache = await orca.storage.get(CACHE_STORAGE_KEY);
        if (storedCache && typeof storedCache === 'object') {
          cacheState = {
            serverUrl: typeof storedCache.serverUrl === 'string' ? storedCache.serverUrl : '',
            user: storedCache.user && typeof storedCache.user === 'object' ? storedCache.user : null,
            boards: storedCache.boards && typeof storedCache.boards === 'object' ? storedCache.boards : {},
            updatedAt: Number.isFinite(storedCache.updatedAt) ? storedCache.updatedAt : null
          };
        }
      } catch { /* ignore */ }

      authToken = await loadSecret(TOKEN_SECRET_KEY);
      claimCode = await loadSecret(CLAIM_SECRET_KEY);
    })();
    return initialized;
  }

  async function api(pathname, { method = 'GET', body, token = authToken } = {}) {
    const url = `${config.serverUrl}${pathname}`;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal
      });
    } catch (error) {
      if (lifetime.signal.aborted) throw error;
      throw new Error(`无法连接天梯服务（${config.serverUrl}），请确认服务已启动或检查网络。`);
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (response.status === 401 && token && token === authToken) {
      authToken = null;
      cacheState.user = null;
      await saveSecret(TOKEN_SECRET_KEY, null).catch(() => {});
      await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
      throw new Error('登录状态已失效，请重新加入或登录天梯。');
    }
    if (!response.ok) {
      const msg = typeof payload?.message === 'string' ? payload.message : (payload?.error || `请求失败 (${response.status})`);
      const err = new Error(msg);
      err.code = payload?.error;
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  async function saveConfig(next = {}) {
    await init();
    const updated = { ...config };
    if (next.serverUrl !== undefined) {
      const normalized = normalizeServerUrl(next.serverUrl);
      if (!normalized) throw new Error('服务端地址无效，请输入 http:// 或 https:// 开头的地址');
      if (normalized !== updated.serverUrl) {
        updated.serverUrl = normalized;
        if (cacheState.serverUrl && cacheState.serverUrl !== normalized) {
          cacheState = { serverUrl: normalized, user: null, boards: {}, updatedAt: null };
          authToken = null;
          claimCode = null;
          await saveSecret(TOKEN_SECRET_KEY, null).catch(() => {});
          await saveSecret(CLAIM_SECRET_KEY, null).catch(() => {});
          await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
        }
        serverInfo = null;
      }
    }
    if (typeof next.enabled === 'boolean') updated.enabled = next.enabled;
    if (typeof next.anonymousMode === 'boolean') updated.anonymousMode = next.anonymousMode;
    const changed = updated.serverUrl !== config.serverUrl || updated.enabled !== config.enabled || updated.anonymousMode !== config.anonymousMode;
    config = updated;
    if (changed) {
      await orca.storage.set(CONFIG_STORAGE_KEY, config);
      await writeSetting('leaderboard.serverUrl', config.serverUrl);
      await writeSetting('leaderboard.enabled', config.enabled);
      await writeSetting('leaderboard.anonymousMode', config.anonymousMode);
    }

    if (typeof next.anonymousMode === 'boolean' && authToken) {
      try {
        const res = await api('/v1/me', { method: 'PATCH', body: { anonymousMode: config.anonymousMode } });
        if (res?.user) {
          cacheState.user = res.user;
          await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
        }
      } catch { /* Profile update will retry when server is reachable. */ }
    }
    return getState();
  }

  async function syncUsage({ force = false } = {}) {
    await init();
    if (!config.enabled || !authToken || !cacheState.user?.id) {
      return { synced: 0, skipped: true };
    }
    if (syncing) return { synced: 0, skipped: true };
    const ts = now();
    if (!force && ts - lastAutoSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) {
      return { synced: 0, skipped: true };
    }
    syncing = true;
    try {
      const snapshot = await getSnapshot(config.localScopeId);
      const scopedDays = Array.isArray(snapshot?.scopedDays) ? snapshot.scopedDays : [];
      const resetHashes = syncState.serverUrl !== config.serverUrl || syncState.userId !== cacheState.user.id;
      const priorHashes = resetHashes ? {} : syncState.hashes;
      const changed = [];
      const nextHashes = { ...priorHashes };

      for (const entry of scopedDays) {
        const k = `${entry.sourceScope}|${entry.day}`;
        const digest = sha256(`${entry.realTokens}:${entry.netTokens}:${entry.requests}`).slice(0, 16);
        if (priorHashes[k] !== digest) {
          changed.push({ entry, k, digest });
        }
      }
      if (!changed.length) {
        lastAutoSyncAt = ts;
        lastSyncError = '';
        return { synced: 0 };
      }

      let totalSynced = 0;
      for (let i = 0; i < changed.length; i += SYNC_BATCH_SIZE) {
        const batch = changed.slice(i, i + SYNC_BATCH_SIZE);
        await api('/v1/usage/sync', {
          method: 'POST',
          body: { entries: batch.map(item => item.entry) }
        });
        for (const item of batch) nextHashes[item.k] = item.digest;
        totalSynced += batch.length;
      }

      syncState = {
        serverUrl: config.serverUrl,
        userId: cacheState.user.id,
        hashes: nextHashes,
        lastSyncAt: now()
      };
      lastAutoSyncAt = syncState.lastSyncAt;
      lastSyncError = '';
      await orca.storage.set(SYNC_STORAGE_KEY, syncState).catch(() => {});
      return { synced: totalSynced };
    } catch (error) {
      lastSyncError = error?.message ?? '同步失败';
      throw error;
    } finally {
      syncing = false;
    }
  }

  async function maybeSync() {
    await init();
    if (!config.enabled || !authToken) return;
    try { await syncUsage({ force: false }); }
    catch (error) { orca?.log?.(`天梯同步暂未完成：${error?.message ?? 'unknown'}`); }
  }

  async function authAnon({ displayName, anonymousMode } = {}) {
    await init();
    const res = await api('/v1/auth/anon', {
      method: 'POST',
      token: null,
      body: {
        ...(displayName ? { displayName } : {}),
        anonymousMode: Boolean(anonymousMode ?? config.anonymousMode)
      }
    });
    await saveSecret(TOKEN_SECRET_KEY, res.token);
    if (res.claimCode) await saveSecret(CLAIM_SECRET_KEY, res.claimCode).catch(() => {});
    authToken = res.token;
    claimCode = res.claimCode ?? null;
    config = { ...config, enabled: true, anonymousMode: Boolean(res.user?.anonymousMode) };
    cacheState = { serverUrl: config.serverUrl, user: res.user, boards: {}, updatedAt: now() };
    await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});
    await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
    await writeSetting('leaderboard.enabled', true);
    await writeSetting('leaderboard.anonymousMode', config.anonymousMode);
    await syncUsage({ force: true }).catch(() => {});
    return getState();
  }

  async function authClaim({ claimCode: inputCode } = {}) {
    await init();
    const res = await api('/v1/auth/claim', {
      method: 'POST',
      token: null,
      body: { claimCode: String(inputCode ?? '').trim() }
    });
    await saveSecret(TOKEN_SECRET_KEY, res.token);
    await saveSecret(CLAIM_SECRET_KEY, String(inputCode ?? '').trim().toUpperCase()).catch(() => {});
    authToken = res.token;
    claimCode = String(inputCode ?? '').trim().toUpperCase();
    config = { ...config, enabled: true, anonymousMode: Boolean(res.user?.anonymousMode) };
    cacheState = { serverUrl: config.serverUrl, user: res.user, boards: {}, updatedAt: now() };
    await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});
    await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
    await writeSetting('leaderboard.enabled', true);
    await syncUsage({ force: true }).catch(() => {});
    return getState();
  }

  async function authGithubStart() {
    await init();
    return api('/v1/auth/github/device', { method: 'POST', token: null, body: {} });
  }

  async function authGithubPoll({ deviceCode } = {}) {
    await init();
    const res = await api('/v1/auth/github/poll', {
      method: 'POST',
      token: null,
      body: { deviceCode }
    });
    if (res?.status === 'authorized' && res.token) {
      await saveSecret(TOKEN_SECRET_KEY, res.token);
      await saveSecret(CLAIM_SECRET_KEY, null).catch(() => {});
      authToken = res.token;
      claimCode = null;
      config = { ...config, enabled: true, anonymousMode: Boolean(res.user?.anonymousMode) };
      cacheState = { serverUrl: config.serverUrl, user: res.user, boards: {}, updatedAt: now() };
      await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});
      await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
      await writeSetting('leaderboard.enabled', true);
      await syncUsage({ force: true }).catch(() => {});
      return { ...res, state: await getState() };
    }
    return res;
  }

  async function updateProfile({ displayName, anonymousMode } = {}) {
    await init();
    if (!authToken) throw new Error('尚未登录天梯账号');
    const res = await api('/v1/me', {
      method: 'PATCH',
      body: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(anonymousMode !== undefined ? { anonymousMode: Boolean(anonymousMode) } : {})
      }
    });
    if (res?.user) {
      cacheState.user = res.user;
      config.anonymousMode = Boolean(res.user.anonymousMode);
      await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});
      await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
      await writeSetting('leaderboard.anonymousMode', config.anonymousMode);
    }
    return getState();
  }

  async function logout() {
    await init();
    if (authToken) {
      await api('/v1/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    }
    authToken = null;
    claimCode = null;
    config.enabled = false;
    cacheState = { ...cacheState, user: null };
    syncState = { serverUrl: '', userId: '', hashes: {}, lastSyncAt: 0 };
    await saveSecret(TOKEN_SECRET_KEY, null).catch(() => {});
    await saveSecret(CLAIM_SECRET_KEY, null).catch(() => {});
    await orca.storage.set(CONFIG_STORAGE_KEY, config).catch(() => {});
    await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
    await orca.storage.set(SYNC_STORAGE_KEY, syncState).catch(() => {});
    await writeSetting('leaderboard.enabled', false);
    return getState();
  }

  async function refreshBoard({ period = 'day', metric = 'real', syncFirst = true } = {}) {
    await init();
    const cleanPeriod = period === 'month' || period === 'year' ? period : 'day';
    const cleanMetric = metric === 'net' ? 'net' : 'real';
    const key = periodKeyFor(cleanPeriod, now());
    let syncWarning = '';
    if (syncFirst && config.enabled && authToken) {
      try { await syncUsage({ force: true }); }
      catch (error) { syncWarning = error?.message ?? '同步失败'; }
    }
    let board = null;
    let problem = '';
    try {
      board = await api(`/v1/leaderboard?period=${encodeURIComponent(cleanPeriod)}&key=${encodeURIComponent(key)}&metric=${encodeURIComponent(cleanMetric)}`);
      if (typeof board?.githubEnabled === 'boolean') {
        serverInfo = { githubEnabled: board.githubEnabled };
      }
      const cacheKey = `${cleanPeriod}:${cleanMetric}`;
      cacheState = {
        serverUrl: config.serverUrl,
        user: cacheState.user,
        boards: { ...cacheState.boards, [cacheKey]: board },
        updatedAt: now()
      };
      await orca.storage.set(CACHE_STORAGE_KEY, cacheState).catch(() => {});
    } catch (error) {
      problem = error?.message ?? '榜单拉取失败';
      board = cacheState.serverUrl === config.serverUrl
        ? (cacheState.boards?.[`${cleanPeriod}:${cleanMetric}`] ?? null)
        : null;
    }
    return {
      state: await getState(),
      board,
      problem: problem || syncWarning
    };
  }

  async function getState() {
    await init();
    const snapshot = await getSnapshot(config.localScopeId);
    const displayHint = await readDisplayHint();
    return {
      config: {
        enabled: config.enabled,
        serverUrl: config.serverUrl,
        anonymousMode: config.anonymousMode
      },
      auth: {
        authenticated: Boolean(authToken && cacheState.user),
        user: cacheState.user,
        claimCode,
        displayHint,
        secretError,
        githubEnabled: serverInfo ? Boolean(serverInfo.githubEnabled) : true
      },
      sync: {
        lastSyncAt: syncState.lastSyncAt || null,
        lastSyncError,
        syncedDays: Object.keys(syncState.hashes ?? {}).length
      },
      localTotals: snapshot.localTotals,
      cachedBoards: cacheState.serverUrl === config.serverUrl ? cacheState.boards : {},
      updatedAt: cacheState.updatedAt
    };
  }

  function dispose() {
    lifetime.abort();
  }

  return {
    init,
    getState,
    saveConfig,
    syncUsage,
    maybeSync,
    authAnon,
    authClaim,
    authGithubStart,
    authGithubPoll,
    updateProfile,
    logout,
    refreshBoard,
    dispose
  };
}
