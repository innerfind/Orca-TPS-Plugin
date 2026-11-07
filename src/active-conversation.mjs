import { open } from 'node:fs/promises';
import path from 'node:path';
import { defaultRoots } from './data-paths.mjs';

const observations = new Map();
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const list = value => Array.isArray(value) ? value : [];
const empty = message => ({ target: null, message });
const providerName = value => ['codex', 'claude', 'opencode', 'opencode2', 'pi'].includes(value) ? value : null;
const family = value => value === 'opencode2' ? 'opencode' : value;

/** The packaged Orca default, also usable without APPDATA in a plugin worker. */
export function activeProfileUserData(options = {}) {
  return options.userDataPath || defaultRoots(options).userData;
}

async function readSmallJson(file, maxBytes = 256 * 1024) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) throw new Error('oversize');
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > size) throw new Error('changed');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

function leafIds(root, found = [], depth = 0) {
  if (!object(root) || depth > 32 || found.length > 128) return found;
  if (root.type === 'leaf' && text(root.leafId)) found.push(root.leafId);
  else if (root.type === 'split') { leafIds(root.first, found, depth + 1); leafIds(root.second, found, depth + 1); }
  return found;
}

/** Pure selection, exported for platform-independent fixtures. No recent-session fallback. */
export function selectActiveConversation(state, options = {}) {
  const w = text(state?.activeWorktreeId);
  if (!w) return empty('当前没有打开对话。');
  const host = state.activeWorkspaceExecutionHostId;
  if (host != null && host !== 'local') return empty('当前是远程对话，暂不读取远程统计。');
  const workspaceKey = text(state.activeWorkspaceKey);
  if (workspaceKey && workspaceKey !== `worktree:${w}`) return empty('当前工作区状态尚未同步。');

  const groups = list(own(state.tabGroups, w));
  const unified = list(own(state.unifiedTabs, w));
  const selectedGroupId = text(own(state.activeGroupIdByWorktree, w));
  let selected;
  if (groups.length || unified.length) {
    const group = selectedGroupId ? groups.find(value => value?.id === selectedGroupId) : groups.length === 1 ? groups[0] : null;
    if (!group || !text(group.activeTabId)) return empty('当前页签尚未识别。');
    selected = unified.find(value => value?.id === group.activeTabId && value?.groupId === group.id);
    if (!selected) return empty('当前页签状态尚未同步。');
    if (selected.contentType !== 'terminal') return empty('当前页签不是可统计的终端对话。');
    if (selected.executionHostId != null && selected.executionHostId !== 'local') return empty('当前是远程对话，暂不读取远程统计。');
  } else if (own(state.activeTabTypeByWorktree, w) !== 'terminal') {
    return empty('当前页签不是可统计的终端对话。');
  }
  // A group's selection is authoritative: activeTabId may remember another group.
  const tabId = selected ? text(selected.entityId) : text(own(state.activeTabIdByWorktree, w)) || text(state.activeTabId);
  const tab = list(own(state.tabsByWorktree, w)).find(value => value?.id === tabId);
  if (!tab || tab.worktreeId !== w) return empty('当前终端尚未识别。');
  if (tab.executionHostId != null && tab.executionHostId !== 'local') return empty('当前是远程对话，暂不读取远程统计。');
  const layout = own(state.terminalLayoutsByTabId, tabId);
  const leafId = text(layout?.activeLeafId), leaves = leafIds(layout?.root);
  if (!leafId || !leaves.includes(leafId)) return empty('当前终端分屏尚未识别。');
  const paneKey = `${tabId}:${leafId}`;
  const record = own(state.sleepingAgentSessionsByPaneKey, paneKey);
  if (!object(record) || record.paneKey !== paneKey || record.worktreeId !== w || (record.tabId != null && record.tabId !== tabId)) {
    return empty('等待 Orca 记录当前对话。');
  }
  if (record.connectionId != null) return empty('当前是远程对话，暂不读取远程统计。');
  const provider = providerName(record.agent), sessionId = text(record.providerSession?.id);
  if (!provider || !sessionId || sessionId.length > 512) return empty('当前对话类型暂不支持统计。');
  const titleMetadata = [tab.aiVaultTitle, selected?.aiVaultTitle].filter(object);
  // A tab title cannot identify a split pane. Only use it as corroboration on a single-pane tab.
  if (leaves.length === 1 && titleMetadata.some(meta => (text(meta.sessionId) && meta.sessionId !== sessionId)
    || (text(meta.agent) && family(meta.agent) !== family(provider)))) {
    return empty('当前对话标识正在更新，稍后重试。');
  }
  const capturedAt = Number.isFinite(record.capturedAt) ? record.capturedAt : 0;
  if (Number.isFinite(tab.createdAt) && capturedAt && tab.createdAt > capturedAt) return empty('等待新终端的对话记录。');
  const stampKey = JSON.stringify([options.userDataPath || '', options.profileId || '', w, tabId, leafId]);
  const incarnation = text(own(state.terminalPtyIncarnationsByPaneKey, paneKey)) || text(own(layout.ptyIdsByLeafId, leafId)) || null;
  const history = options.observations || observations, prior = history.get(stampKey);
  const signature = `${provider}:${sessionId}`;
  const priorCapture = Number.isFinite(prior?.capturedAt) ? prior.capturedAt : 0;
  let pendingCaptureBaseline = prior?.pendingCaptureBaseline ?? null;
  if (prior && prior.incarnation !== incarnation && signature === prior.signature) pendingCaptureBaseline = priorCapture;
  if (prior && signature !== prior.signature) pendingCaptureBaseline = null;
  // Both changes can arrive in one saved snapshot. Compare capture versions, not
  // the reader's clock: an already refreshed capture necessarily predates this poll.
  if (pendingCaptureBaseline !== null && capturedAt > pendingCaptureBaseline) pendingCaptureBaseline = null;
  const highestCapture = prior && signature === prior.signature ? Math.max(capturedAt, priorCapture) : capturedAt;
  history.set(stampKey, { incarnation, signature, capturedAt: highestCapture, pendingCaptureBaseline });
  while (history.size > 128) history.delete(history.keys().next().value);
  if (pendingCaptureBaseline !== null) return empty('终端已重开，等待当前对话标识更新。');

  const pathApi = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const transcriptPath = text(record.providerSession?.transcriptPath);
  if (transcriptPath && !pathApi.isAbsolute(transcriptPath)) return empty('当前对话记录路径无效。');
  const target = { key: JSON.stringify([options.userDataPath || '', options.profileId || '', w, tabId, leafId, incarnation, provider, sessionId]), provider, sessionId };
  if (transcriptPath) {
    if (family(provider) === 'opencode' && /\.(?:db|sqlite|sqlite3)$/i.test(transcriptPath)) target.dbPath = transcriptPath;
    else if (/\.jsonl$/i.test(transcriptPath)) target.transcriptPath = transcriptPath;
    else return empty('当前对话记录格式暂不支持。');
  }
  const title = text(tab.customTitle) || (leaves.length === 1 ? text(tab.aiVaultTitle?.title) : null) || text(record.terminalTitle);
  if (title) target.title = title.slice(0, 200);
  return { target };
}

/** Reads one committed SQLite document per poll, including live WAL; never writes Orca state. */
export async function readActiveConversation(options = {}) {
  const userDataPath = activeProfileUserData(options);
  let profileId;
  for (const suffix of ['', '.bak']) {
    try {
      const index = await readSmallJson(path.join(userDataPath, `orca-profile-index.json${suffix}`));
      if (typeof index?.activeProfileId === 'string' && PROFILE_ID.test(index.activeProfileId) && list(index.profiles).some(profile => profile?.id === index.activeProfileId)) {
        profileId = index.activeProfileId; break;
      }
    } catch { /* The official resolver also accepts a valid backup index. */ }
  }
  if (!profileId) return empty('无法识别 Orca 当前配置。');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return empty('当前运行时不支持 SQLite，无法识别当前对话。'); }
  let db;
  try {
    db = new DatabaseSync(path.join(userDataPath, 'profiles', profileId, 'profile-state.db'), { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    const row = db.prepare("SELECT payload FROM profile_state_documents WHERE domain='workspaceSession' AND length(payload)<=8388608").get();
    if (!row) return empty('Orca 尚未保存当前工作区状态。');
    const state = JSON.parse(row.payload);
    if (!object(state)) return empty('Orca 当前工作区状态无效。');
    return selectActiveConversation(state, { ...options, userDataPath, profileId });
  } catch { return empty('暂时无法读取 Orca 当前对话。'); }
  finally { db?.close(); }
}
