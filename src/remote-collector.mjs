import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeComparePath, readTargetSession } from './data.mjs';

export const COLLECTOR_FILES = ['remote-collector.mjs', 'data.mjs', 'data-paths.mjs', 'parsers.mjs', 'usage-summary.mjs'];
const PROVIDERS = new Set(['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity']);
const NUMBERS = [
  'completedAt', 'createdAtSec', 'freshInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'durationMs', 'firstTokenMs', 'generationMs', 'tokensPerSecond', 'cacheHitRate'
];
const clean = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);

export function remoteRecord(record) {
  if (!record || !PROVIDERS.has(record.provider) || !Number.isFinite(record.completedAt) || record.completedAt < 0 ||
    typeof record.id !== 'string' || !record.id) return null;
  const result = {
    id: createHash('sha256').update(record.id).digest('hex').slice(0, 24),
    provider: record.provider,
    dataSource: record.dataSource === 'proxy' ? 'proxy' : 'session_log'
  };
  for (const field of NUMBERS) {
    if (Number.isFinite(record[field]) && record[field] >= 0) result[field] = record[field];
  }
  if (result.cacheHitRate > 1) delete result.cacheHitRate;
  if (clean(record.model) && record.model.length <= 128 && !/[/\\]/.test(record.model)) result.model = record.model;
  if (record.isEstimatedSpeed === true) result.isEstimatedSpeed = true;
  if (record.isSubagent === true) result.isSubagent = true;
  return result;
}

export async function collectRemoteChannel(request, { cwd = process.cwd(), load = readTargetSession } = {}) {
  if (!clean(request?.worktreePath) || !path.isAbsolute(request.worktreePath)) return { error: 'workspace' };
  const [actual, expected] = await Promise.all([realpath(cwd), realpath(request.worktreePath)]);
  if (normalizeComparePath(actual) !== normalizeComparePath(expected)) return { error: 'workspace' };

  const sessions = [];
  for (const entry of (Array.isArray(request.sessions) ? request.sessions.slice(0, 128) : [])) {
    if (!PROVIDERS.has(entry?.provider) || !clean(entry.sessionId) || !entry.sessionId || entry.sessionId.length > 256) continue;
    const session = { provider: entry.provider, sessionId: entry.sessionId };
    const field = entry.provider === 'opencode' || entry.provider === 'opencode2' ? 'dbPath' : 'transcriptPath';
    if (clean(entry[field]) && path.isAbsolute(entry[field])) session[field] = entry[field];
    sessions.push(session);
  }
  const { session, warnings } = await load(
    { worktreePath: request.worktreePath, sessions },
    { fresh: request.fresh === true }
  );
  return {
    records: session ? session.records.slice(0, 100).map(remoteRecord).filter(Boolean) : null,
    incomplete: Boolean(warnings?.length)
  };
}

// This function runs in a clean Node process on the remote host. The caller passes
// the bundled modules over the plugin-owned terminal after receiving the ready line.
async function bootstrap(token, filenames) {
  const output = (line) => process.stdout.write(line + '\n');
  const prefix = '@TPS:' + token + ':';
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) { output(prefix + 'node'); return; }
  try { require('node:sqlite'); }
  catch { output(prefix + 'node'); return; }
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { createInterface } = require('node:readline');
  const { gzipSync, gunzipSync } = require('node:zlib');
  const input = process.stdin;
  if (input.isTTY) input.setRawMode(true);
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  let id, chunks = [], size = 0, collect, idle;

  function respond(requestId, value) {
    let body = gzipSync(JSON.stringify(value)).toString('base64');
    if (body.length > 48_000) body = gzipSync('{"error":"limit"}').toString('base64');
    const parts = body.match(/.{1,60}/g);
    parts.forEach((part, index) => output(prefix + requestId + ':' + index + ':' + parts.length + ':' + part));
  }

  async function install(files) {
    if (collect || !files || filenames.some(name => typeof files[name] !== 'string')) throw new Error('bundle');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tps-'));
    try {
      for (const name of filenames) await fs.writeFile(path.join(dir, name), files[name], { flag: 'wx', mode: 0o600 });
      ({ collectRemoteChannel: collect } = await import(pathToFileURL(path.join(dir, filenames[0])).href));
    } finally {
      await Promise.allSettled(filenames.map(name => fs.unlink(path.join(dir, name))));
      await fs.rmdir(dir).catch(() => {});
    }
  }

  try {
    output(prefix + 'ready');
    idle = setTimeout(() => lines.close(), 90_000);
    for await (const line of lines) {
      idle.refresh();
      if (line === 'quit') break;
      if (/^>[0-9a-f]{16}$/.test(line)) {
        id = line.slice(1);
        chunks = [];
        size = 0;
      } else if (id && /^\+[A-Za-z0-9+/=]{1,3500}$/.test(line)) {
        size += line.length - 1;
        if (size <= 96_000) chunks.push(line.slice(1));
      } else if (id && line === '.') {
        const requestId = id;
        id = undefined;
        try {
          if (size > 96_000) throw new Error('limit');
          const request = JSON.parse(gunzipSync(Buffer.from(chunks.join(''), 'base64'), { maxOutputLength: 512 * 1024 }));
          if (!collect) {
            await install(request.files);
            respond(requestId, { installed: true });
          } else {
            respond(requestId, await collect(request));
          }
        } catch {
          respond(requestId, { error: collect ? 'read' : 'bundle' });
        }
        chunks = [];
      }
    }
  } finally {
    clearTimeout(idle);
    lines.close();
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  }
}

export function collectorCommand(token) {
  const entry = '(' + bootstrap.toString() + ')(' + JSON.stringify(token) + ',' + JSON.stringify(COLLECTOR_FILES) + ')';
  const compressed = gzipSync(entry).toString('base64');
  return "node --input-type=commonjs -e \"eval(require('node:zlib').gunzipSync(Buffer.from('" + compressed + "','base64')).toString())\"";
}
