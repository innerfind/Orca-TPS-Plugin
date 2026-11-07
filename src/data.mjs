import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { configuredRoots, defaultRoots } from './data-paths.mjs';
import {
  SESSION_PROXY_DEDUP_WINDOW_SECONDS,
  mergeProxyRecords,
  parseJsonl,
  parseOpenCodeRows,
  recentRecords
} from './parsers.mjs';

const MAX_FILES = 1500, MAX_DIRECTORIES = 500, MAX_DEPTH = 8, MAX_SUBAGENT_FILES = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_SCAN_BYTES = 64 * 1024 * 1024;
const parseCache = new Map(), discoveryCache = new Map(), databaseCache = new Map(), locationCache = new Map(), ccSwitchCache = new Map();
const skippedDirectories = new Set(['node_modules', '.git', 'subagents', 'cache', 'plugins', 'skills', 'auth', 'credentials']);
const shortError = error => typeof error?.code === 'string' ? error.code : '读取失败';
const identity = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const safeTitle = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '';
const safeSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value !== '.' && value !== '..' && !/[\\/\u0000]/.test(value);

function trimCache(cache) {
  while (cache.size > 200) cache.delete(cache.keys().next().value);
}

function replayWarnings(warnings, cached) {
  for (const warning of cached?.warnings ?? []) warnings.add(warning);
}

async function info(file) {
  try { return await stat(file); } catch { return null; }
}

async function discover(provider, root, warnings) {
  const key = `${provider}:${root}`, cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.at < 20_000) {
    replayWarnings(warnings, cached);
    return cached.files;
  }
  if (root === path.parse(root).root || root === homedir()) {
    warnings.add(`${provider}：请选择会话目录，不能扫描整个磁盘或用户主目录。`);
    return [];
  }
  const files = [], queue = [{ directory: root, depth: 0 }], sourceWarnings = new Set();
  let visited = 0, limited = false;
  const rootStat = await info(root);
  if (!rootStat) return [];
  const matches = file => provider === 'opencode' ? /\.(?:db|sqlite|sqlite3)$/i.test(file) : /\.jsonl$/i.test(file);
  if (rootStat.isFile()) return matches(root) ? [root] : [];
  const seen = new Set();
  while (queue.length && files.length < MAX_FILES && visited < MAX_DIRECTORIES) {
    const { directory, depth } = queue.pop();
    visited++;
    let entries;
    try {
      const canonical = await realpath(directory);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { sourceWarnings.add(`${provider}：部分会话目录无法读取（${shortError(error)}）。`); continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    const children = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && matches(entry.name)) {
        files.push(file);
        if (files.length >= MAX_FILES) { limited = true; break; }
      } else if (entry.isDirectory() && !skippedDirectories.has(entry.name.toLowerCase())) {
        if (depth < MAX_DEPTH) children.push({ directory: file, depth: depth + 1 });
        else limited = true;
      }
    }
    // The stack visits recent date-named folders before older history.
    queue.push(...children.reverse());
  }
  limited ||= queue.length > 0;
  if (limited) sourceWarnings.add(`${provider}：文件发现达到上限，仅扫描部分会话目录。`);
  const result = { at: Date.now(), files, warnings: [...sourceWarnings] };
  replayWarnings(warnings, result);
  discoveryCache.set(key, result); trimCache(discoveryCache);
  return files;
}

async function readJsonl(candidate, budget, warnings, expectedSessionId, { isSubagent = false } = {}) {
  const key = `${candidate.provider}:${candidate.path}:${isSubagent ? 'sub' : 'main'}`;
  const stamp = `${candidate.info.size}:${candidate.info.mtimeMs}`;
  const cached = parseCache.get(key);
  const matches = result => {
    if (expectedSessionId === undefined) return true;
    if (isSubagent && !result?.sourceSessionId) return true;
    return result?.sourceSessionId === expectedSessionId;
  };
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return matches(cached) ? cached.session : null; }
  const bytes = Math.min(candidate.info.size, MAX_FILE_BYTES);
  if (bytes > budget.remaining) {
    warnings.add('本次读取达到 64 MiB 上限，较旧会话稍后读取；已有缓存仍可使用。');
    replayWarnings(warnings, cached);
    return matches(cached) ? cached?.session ?? null : null;
  }
  budget.remaining -= bytes;
  const file = await open(candidate.path, 'r');
  try {
    const sourceWarnings = [];
    const offset = candidate.info.size - bytes, buffer = Buffer.alloc(bytes);
    const read = await file.read(buffer, 0, bytes, offset);
    let text = buffer.subarray(0, read.bytesRead).toString('utf8'), header = '';
    if (offset > 0) {
      const firstLine = text.indexOf('\n');
      text = firstLine < 0 ? '' : text.slice(firstLine + 1);
      const start = Buffer.alloc(Math.min(16_384, candidate.info.size));
      const head = await file.read(start, 0, start.length, 0);
      header = start.subarray(0, head.bytesRead).toString('utf8');
      sourceWarnings.push(`${candidate.provider}：较大会话只读取末尾 16 MiB，缺少开头的轮次不计入。`);
    }
    // Writers append JSONL a line at a time; an unfinished final line is not evidence.
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    const parsed = parseJsonl(text, candidate.provider, header, { truncated: offset > 0, isSubagent });
    const sessionId = parsed.sessionId || path.basename(candidate.path, '.jsonl');
    const session = { id: `${candidate.provider}:${sessionId || identity(candidate.path)}`,
      title: `${candidate.provider} · ${sessionId.slice(-20)}`, provider: candidate.provider,
      path: candidate.path, updatedAt: candidate.info.mtimeMs, records: parsed.records,
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
    const result = { stamp, session, sourceSessionId: parsed.sessionId, warnings: sourceWarnings };
    replayWarnings(warnings, result);
    parseCache.set(key, result); trimCache(parseCache);
    return matches(result) ? session : null;
  } finally { await file.close(); }
}

/** Collect Claude subagent JSONL files at fixed depths matching CC Switch's collect_jsonl_files. */
async function collectClaudeSubagentCandidates(mainPath, sessionId) {
  if (!safeSegment(sessionId)) return [];
  const subagentsDir = path.join(path.dirname(mainPath), sessionId, 'subagents');
  const dirStat = await info(subagentsDir);
  if (!dirStat?.isDirectory()) return [];

  const paths = [];
  try {
    const entries = await readdir(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
        paths.push(path.join(subagentsDir, entry.name));
      } else if (entry.isDirectory() && entry.name === 'workflows') {
        const workflowsDir = path.join(subagentsDir, 'workflows');
        let wfDirs = [];
        try { wfDirs = await readdir(workflowsDir, { withFileTypes: true }); } catch { wfDirs = []; }
        for (const wfEntry of wfDirs.slice(0, 50)) {
          if (!wfEntry.isDirectory()) continue;
          const wfPath = path.join(workflowsDir, wfEntry.name);
          let wfFiles = [];
          try { wfFiles = await readdir(wfPath, { withFileTypes: true }); } catch { wfFiles = []; }
          for (const f of wfFiles) {
            if (f.isFile() && /\.jsonl$/i.test(f.name)) paths.push(path.join(wfPath, f.name));
          }
        }
      }
    }
  } catch { return []; }

  const candidates = [];
  const seen = new Set();
  for (const file of paths) {
    const candidate = await candidateFor('claude', file);
    if (!candidate || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    candidates.push(candidate);
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  return candidates.slice(0, MAX_SUBAGENT_FILES);
}

async function attachClaudeSubagents(session, rawSessionId, budget, warnings) {
  if (!session || session.provider !== 'claude' || !rawSessionId) return session;
  const subCandidates = await collectClaudeSubagentCandidates(session.path, rawSessionId);
  if (!subCandidates.length) return session;
  const allRecords = [...session.records];
  let maxUpdated = session.updatedAt;
  for (const sub of subCandidates) {
    try {
      const subSession = await readJsonl(sub, budget, warnings, rawSessionId, { isSubagent: true });
      if (subSession?.records?.length) {
        allRecords.push(...subSession.records);
        if (sub.info.mtimeMs > maxUpdated) maxUpdated = sub.info.mtimeMs;
      }
    } catch (error) {
      warnings.add(`claude：子代理记录读取失败（${shortError(error)}）。`);
    }
  }
  return { ...session, updatedAt: maxUpdated, records: recentRecords(allRecords) };
}

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));

function projectedData() {
  return `CASE WHEN json_valid(data) THEN json_object(
    'role',json_extract(data,'$.role'), 'tokens',json_extract(data,'$.tokens'),
    'time',json_extract(data,'$.time'), 'model',json_extract(data,'$.model'),
    'modelID',json_extract(data,'$.modelID'), 'modelId',json_extract(data,'$.modelId'),
    'finish',json_extract(data,'$.finish'), 'status',json_extract(data,'$.status')) ELSE '{}' END AS data`;
}

async function readDatabase(candidate, maxSessions, warnings, target) {
  const wal = await info(`${candidate.path}-wal`);
  const stamp = `${candidate.info.size}:${candidate.info.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}:${maxSessions}`;
  const cacheKey = target ? JSON.stringify([candidate.path, target.provider, target.sessionId]) : candidate.path;
  const cached = databaseCache.get(cacheKey);
  if (cached?.stamp === stamp) { replayWarnings(warnings, cached); return cached.sessions; }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { warnings.add('SQLite 不可用：当前 Orca 的 Node 运行时不能读取 OpenCode 数据库。'); return []; }
  let db;
  try {
    db = new DatabaseSync(candidate.path, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
    const available = tables(db), sessions = [], seen = new Set(), sourceWarnings = new Set();
    for (const v2 of [true, false]) {
      if (target && (target.provider === 'opencode2') !== v2) continue;
      const table = v2 ? 'session_v2' : 'session', messageTable = v2 ? 'session_message' : 'message';
      if (!available.has(table) || !available.has(messageTable)) continue;
      const sessionColumns = columns(db, table), messageColumns = columns(db, messageTable);
      if (!['id'].every(key => sessionColumns.has(key)) || !['id', 'session_id', 'data', 'time_created'].every(key => messageColumns.has(key))) continue;
      if (v2 && !['seq', 'type'].every(key => messageColumns.has(key))) continue;
      const select = column => sessionColumns.has(column) ? `"${column}"` : `NULL AS "${column}"`;
      const order = sessionColumns.has('time_updated') ? 'time_updated DESC' : 'id DESC';
      const parentFilter = sessionColumns.has('parent_id') ? "WHERE parent_id IS NULL OR parent_id = ''" : '';
      const selection = `SELECT id,${select('title')},${select('directory')},${select('time_updated')} FROM ${table}`;
      const metadata = target
        ? db.prepare(`${selection} WHERE id=?`).all(target.sessionId)
        : db.prepare(`${selection} ${parentFilter} ORDER BY ${order} LIMIT ?`).all(maxSessions);
      for (const meta of metadata) {
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        const orderColumn = v2 ? 'seq' : 'rowid';
        const messageRows = db.prepare(`SELECT id,${v2 ? 'type' : 'NULL AS type'},time_created,${projectedData()}
          FROM ${messageTable} WHERE session_id=? ORDER BY ${orderColumn} DESC LIMIT 10001`).all(meta.id);
        if (messageRows.length > 10_000) { messageRows.pop(); sourceWarnings.add('OpenCode：较大会话仅读取最近 10000 条消息。'); }
        const provider = v2 ? 'opencode2' : 'opencode', records = parseOpenCodeRows(messageRows.reverse(), v2);
        sessions.push({ id: `${provider}:${meta.id}`, title: safeTitle(meta.title) || `${provider} · ${String(meta.id).slice(-20)}`,
          provider, path: candidate.path, updatedAt: Number.isFinite(meta.time_updated) ? meta.time_updated : candidate.info.mtimeMs,
          ...(typeof meta.directory === 'string' ? { cwd: meta.directory } : {}), records });
      }
    }
    if (!sessions.length && !available.has('session') && !available.has('session_v2')) sourceWarnings.add('OpenCode：数据库没有受支持的会话表。');
    const result = { stamp, sessions, warnings: [...sourceWarnings] };
    replayWarnings(warnings, result);
    databaseCache.set(cacheKey, result); trimCache(databaseCache);
    return sessions;
  } finally { db?.close(); }
}

/** Read 2xx local-proxy rows from ~/.cc-switch/cc-switch.db when present, strictly read-only. */
async function readCcSwitchProxyRows(dbPath, provider, sessionId, records) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath.includes('\0')) return [];
  let canonical;
  try { canonical = await realpath(dbPath); } catch { return []; }
  const dbInfo = await info(canonical);
  if (!dbInfo?.isFile()) return [];
  const wal = await info(`${canonical}-wal`);
  const minSec = records.length ? Math.min(...records.map(r => r.createdAtSec)) - SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const maxSec = records.length ? Math.max(...records.map(r => r.createdAtSec)) + SESSION_PROXY_DEDUP_WINDOW_SECONDS : null;
  const stamp = `${dbInfo.size}:${dbInfo.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
  const cacheKey = JSON.stringify([canonical, provider, sessionId, minSec, maxSec]);
  const cached = ccSwitchCache.get(cacheKey);
  if (cached?.stamp === stamp) return cached.rows;

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return []; }
  let db;
  try {
    db = new DatabaseSync(canonical, { readOnly: true, enableExtensionLoading: false });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500; PRAGMA trusted_schema=OFF;');
    const available = tables(db);
    if (!available.has('proxy_request_logs')) {
      ccSwitchCache.set(cacheKey, { stamp, rows: [] }); trimCache(ccSwitchCache);
      return [];
    }
    const cols = columns(db, 'proxy_request_logs');
    const required = ['request_id', 'app_type', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'latency_ms', 'first_token_ms', 'status_code', 'created_at'];
    if (!required.every(col => cols.has(col))) return [];

    const optCol = (col, fallback = 'NULL') => cols.has(col) ? `"${col}"` : `${fallback} AS "${col}"`;
    const sourceFilter = cols.has('data_source') ? "COALESCE(data_source, 'proxy') = 'proxy'" : '1 = 1';
    const appFamily = provider === 'opencode2' ? 'opencode' : provider;
    const appClause = appFamily === 'claude' ? "app_type IN ('claude', 'claude-desktop')" : 'app_type = ?';
    const params = appFamily === 'claude' ? [] : [appFamily];

    const scopeParts = [];
    if (cols.has('session_id') && sessionId) {
      scopeParts.push('session_id = ?');
      params.push(sessionId);
    }
    if (minSec !== null && maxSec !== null) {
      scopeParts.push('(created_at >= ? AND created_at <= ?)');
      params.push(minSec, maxSec);
    }
    if (!scopeParts.length) return [];

    const sql = `SELECT request_id, ${optCol('session_id')}, app_type, model, ${optCol('request_model')},
      ${optCol('pricing_model')}, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      ${optCol('input_token_semantics', '0')}, latency_ms, first_token_ms, created_at
      FROM proxy_request_logs
      WHERE ${sourceFilter} AND status_code >= 200 AND status_code < 300
        AND (${appClause}) AND (${scopeParts.join(' OR ')})
      ORDER BY created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...params);
    ccSwitchCache.set(cacheKey, { stamp, rows }); trimCache(ccSwitchCache);
    return rows;
  } catch { return []; }
  finally { db?.close(); }
}

async function candidateFor(provider, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  let canonical;
  try { canonical = await realpath(file); } catch { return null; }
  const metadata = await info(canonical);
  return metadata?.isFile() ? { provider, path: canonical, info: metadata } : null;
}

function bestSession(sessions) {
  return sessions.sort((a, b) => (b.records[0]?.completedAt ?? 0) - (a.records[0]?.completedAt ?? 0)
    || b.records.length - a.records.length || b.updatedAt - a.updatedAt)[0] ?? null;
}

async function headerSessionId(candidate, budget) {
  const cached = parseCache.get(`${candidate.provider}:${candidate.path}:main`);
  if (cached?.stamp === `${candidate.info.size}:${candidate.info.mtimeMs}`) return cached.sourceSessionId;
  const length = Math.min(candidate.info.size, 16_384);
  if (length > budget.remaining) return null;
  budget.remaining -= length;
  const file = await open(candidate.path, 'r');
  try {
    const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, 0);
    const text = buffer.subarray(0, result.bytesRead).toString('utf8');
    return parseJsonl(text.slice(0, text.lastIndexOf('\n') + 1), candidate.provider).sessionId;
  } finally { await file.close(); }
}

/** Read only the explicitly selected conversation; absence never selects another session. */
export async function readTargetSession(target, options = {}) {
  const warnings = new Set(), budget = { remaining: MAX_SCAN_BYTES };
  if (!target || !['codex', 'claude', 'opencode', 'opencode2', 'pi'].includes(target.provider)
      || typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 256) {
    return { session: null, warnings: ['当前会话尚未识别，等待会话记录。'] };
  }
  const isDatabase = target.provider === 'opencode' || target.provider === 'opencode2';
  const rootProvider = isDatabase ? 'opencode' : target.provider;
  const explicitPath = isDatabase ? target.dbPath : target.transcriptPath;
  const ccSwitchDb = options.ccSwitchDb !== undefined
    ? options.ccSwitchDb
    : (options.includeDefaults !== false ? defaultRoots().ccSwitchDb : null);

  const read = async candidate => {
    try {
      if (isDatabase) return bestSession(await readDatabase(candidate, 100, warnings, target));
      const main = await readJsonl(candidate, budget, warnings, target.sessionId);
      return main && target.provider === 'claude'
        ? await attachClaudeSubagents(main, target.sessionId, budget, warnings)
        : main;
    } catch (error) {
      warnings.add(`${target.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`);
      return null;
    }
  };
  const finish = async session => {
    if (!session) {
      warnings.add('当前会话的本机记录暂未找到，未显示其他会话的数据。');
      return { session: null, warnings: [...warnings] };
    }
    let records = session.records;
    if (ccSwitchDb) {
      const proxyRows = await readCcSwitchProxyRows(ccSwitchDb, target.provider, target.sessionId, records);
      if (proxyRows.length) records = mergeProxyRecords(records, proxyRows, target.provider, target.sessionId);
    }
    const enriched = {
      ...session,
      records,
      ...(safeTitle(target.title) ? { title: safeTitle(target.title) } : {})
    };
    return { session: enriched, warnings: [...warnings] };
  };
  if (explicitPath !== undefined && explicitPath !== null) {
    const candidate = await candidateFor(target.provider, explicitPath);
    return finish(candidate ? await read(candidate) : null);
  }

  const roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  const providerRoots = (roots[rootProvider] ?? []).slice(0, 100);
  const lookupKey = JSON.stringify([target.provider, target.sessionId, providerRoots]);
  const savedLocation = locationCache.get(lookupKey);
  if (savedLocation && Date.now() - savedLocation.at < 20_000) {
    const sessions = [];
    for (const file of savedLocation.paths) {
      const candidate = await candidateFor(target.provider, file);
      const session = candidate ? await read(candidate) : null;
      if (session) sessions.push(session);
    }
    if (sessions.length) return finish(bestSession(sessions));
    locationCache.delete(lookupKey);
  }

  const files = new Set();
  for (const root of providerRoots) for (const file of await discover(rootProvider, root, warnings)) files.add(file);
  const filenameMatches = file => {
    const name = path.basename(file, path.extname(file));
    return name === target.sessionId || name.endsWith(`-${target.sessionId}`) || name.endsWith(`_${target.sessionId}`);
  };
  const named = [...files].filter(filenameMatches), sessions = [], matchedPaths = [];
  const visit = async (file, checkHeader) => {
    try {
      const candidate = await candidateFor(target.provider, file);
      if (!candidate || (checkHeader && await headerSessionId(candidate, budget) !== target.sessionId)) return;
      const session = await read(candidate);
      if (session) { sessions.push(session); matchedPaths.push(candidate.path); }
    } catch (error) { warnings.add(`${target.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`); }
  };
  // Normal provider filenames carry the ID. Metadata lookup also supports renamed/mirrored logs.
  if (isDatabase) for (const file of files) await visit(file, false);
  else {
    for (const file of named) await visit(file, false);
    if (!sessions.length) for (const file of files) if (!filenameMatches(file)) await visit(file, true);
  }
  if (matchedPaths.length) {
    locationCache.set(lookupKey, { at: Date.now(), paths: [...new Set(matchedPaths)] });
    trimCache(locationCache);
  }
  return finish(bestSession(sessions));
}

/** Discover only configured provider roots. Optional includeDefaults:false isolates tests/custom scans. */
export async function scanSessions(options = {}) {
  const maxSessions = Math.max(1, Math.min(100, Number.isInteger(options.maxSessions) ? options.maxSessions : 100));
  const warnings = new Set(), roots = await configuredRoots(options.roots, options.includeDefaults !== false);
  const candidates = [], knownFiles = new Set();
  for (const [provider, values] of Object.entries(roots)) for (const root of values.slice(0, 100)) {
    for (const file of await discover(provider, root, warnings)) {
      let canonical;
      try { canonical = await realpath(file); } catch { continue; }
      const key = `${provider}:${canonical}`;
      if (knownFiles.has(key)) continue;
      knownFiles.add(key);
      const metadata = await info(canonical);
      if (metadata?.isFile()) candidates.push({ provider, path: canonical, info: metadata });
    }
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const selected = [...candidates.filter(candidate => candidate.provider === 'opencode').slice(0, 10),
    ...candidates.filter(candidate => candidate.provider !== 'opencode').slice(0, maxSessions)];
  if (candidates.length > selected.length) warnings.add(`仅读取最近 ${maxSessions} 个文件会话及最多 10 个数据库。`);
  const budget = { remaining: MAX_SCAN_BYTES }, sessions = [];
  for (const candidate of selected) {
    try {
      if (candidate.provider === 'opencode') sessions.push(...await readDatabase(candidate, maxSessions, warnings));
      else {
        let session = await readJsonl(candidate, budget, warnings);
        if (session && candidate.provider === 'claude') {
          const rawId = session.id.slice('claude:'.length);
          session = await attachClaudeSubagents(session, rawId, budget, warnings);
        }
        if (session) sessions.push(session);
      }
    } catch (error) { warnings.add(`${candidate.provider}：会话读取失败（${shortError(error)}），未生成估算数据。`); }
  }
  const unique = new Map();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    const completed = session.records[0]?.completedAt ?? 0, oldCompleted = previous?.records[0]?.completedAt ?? 0;
    if (!previous || completed > oldCompleted || (completed === oldCompleted && session.records.length > previous.records.length)) unique.set(session.id, session);
  }
  return { sessions: [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions), warnings: [...warnings] };
}
