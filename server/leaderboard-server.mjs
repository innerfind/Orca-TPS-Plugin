import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_SYNC_ENTRIES = 400;
const MAX_SCOPES_PER_USER = 32;
const MAX_DAILY_REAL_TOKENS = 50_000_000_000;
const MAX_DAILY_REQUESTS = 500_000;
const SCOPE_PATTERN = /^(?:local|remote):[a-f0-9]{12,64}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}$/;

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const cleanName = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
  return trimmed || fallback;
};
const safeAvatar = url => {
  if (typeof url !== 'string' || !url || url.length > 512) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};
const validDay = (day, nowMs) => {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() + 1 !== m || parsed.getUTCDate() !== d) return false;
  const deltaDays = (parsed.getTime() - nowMs) / 86_400_000;
  return deltaDays >= -372 && deltaDays <= 2;
};

function defaultPeriodKey(period, nowMs) {
  const date = new Date(nowMs);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  return day.slice(0, 4);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    authKind: row.auth_kind,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? null,
    anonymousMode: Boolean(row.anonymous_mode)
  };
}

function maskedRowName(row) {
  if (row.anonymous_mode) return `匿名选手 #${sha256(row.id).slice(0, 4).toUpperCase()}`;
  return row.display_name;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('invalid_json'), { status: 400 });
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

export function seedDemoLeaderboard(db, { nowMs = Date.now() } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1').get()?.n ?? 0;
  if (count > 0) return 0;

  const names = [
    'CodePhoenix', 'KuroNeko', 'ByteVoyager', 'AstraDev', 'LinusFan', 'Rustacean42', 'VibeCoder',
    'QuantShark', 'SkyWalker_CN', 'ZeroLatency', 'TurboToken', 'NodeNinja', 'PixelCraft', 'MochiAI',
    'CloudDrifter', 'AsyncAwait', 'DeepCache', 'EchoPulse', 'Solstice', 'NovaKernel'
  ];
  const today = defaultPeriodKey('day', nowMs);
  const monthPrefix = today.slice(0, 7);
  const yearPrefix = today.slice(0, 4);
  const prevMonth = monthPrefix.endsWith('-01') ? `${Number(yearPrefix) - 1}-12` : `${yearPrefix}-${String(Number(monthPrefix.slice(5)) - 1).padStart(2, '0')}`;
  const insertUser = db.prepare(
    'INSERT INTO users (id, auth_kind, display_name, avatar_url, anonymous_mode, is_demo, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)'
  );
  const insertDay = db.prepare(
    'INSERT INTO daily_usage (user_id, source_scope, day, real_tokens, net_tokens, requests, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 1; i <= 115; i += 1) {
      const id = `demo:${String(i).padStart(3, '0')}`;
      const base = names[(i - 1) % names.length];
      const displayName = i <= names.length ? base : `${base}#${i}`;
      const anon = i % 9 === 0 ? 1 : 0;
      insertUser.run(id, 'anon', displayName, anon, nowMs - i * 86_400_000, nowMs);

      const scale = Math.max(1, Math.round(3_500_000_000 / Math.pow(i, 1.35)));
      const dayReqs = Math.max(8, Math.round(1800 / Math.pow(i, 0.72)));
      const dayNet = Math.max(10_000, Math.round(scale * 0.045));
      insertDay.run(id, `local:${sha256(id).slice(0, 24)}`, today, scale, dayNet, dayReqs, nowMs);

      const monthDay = `${monthPrefix}-01`;
      if (monthDay !== today) {
        const monthExtra = scale * 9;
        insertDay.run(id, `local:${sha256(id).slice(0, 24)}`, monthDay, monthExtra, Math.round(monthExtra * 0.05), dayReqs * 8, nowMs);
      }
      if (prevMonth.startsWith(yearPrefix)) {
        const yearExtra = scale * 42;
        insertDay.run(id, `local:${sha256(id).slice(0, 24)}`, `${prevMonth}-15`, yearExtra, Math.round(yearExtra * 0.055), dayReqs * 35, nowMs);
      }
    }
    db.exec('COMMIT');
    return 115;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function createLeaderboardServer({
  dbPath = path.join(homedir(), '.orca-tps-leaderboard', 'leaderboard.db'),
  githubClientId = process.env.GITHUB_CLIENT_ID || '',
  githubFetch = fetch,
  now = () => Date.now()
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      auth_kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      anonymous_mode INTEGER NOT NULL DEFAULT 0,
      claim_code_hash TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_scope TEXT NOT NULL,
      day TEXT NOT NULL,
      real_tokens INTEGER NOT NULL,
      net_tokens INTEGER NOT NULL,
      requests INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, source_scope, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_day_user ON daily_usage(day, user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_claim ON users(claim_code_hash);
  `);

  function issueSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const ts = now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, ts, ts);
    return token;
  }

  function authenticate(req) {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length).trim();
    if (!token) return null;
    const hash = sha256(token);
    const row = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
    `).get(hash);
    if (!row) return null;
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), hash);
    return { user: row, tokenHash: hash };
  }

  function queryLeaderboard({ period, key, metric, selfUserId }) {
    const ts = now();
    const cleanPeriod = period === 'month' || period === 'year' ? period : 'day';
    const expectedPattern = cleanPeriod === 'day' ? DAY_PATTERN : cleanPeriod === 'month' ? MONTH_PATTERN : YEAR_PATTERN;
    const periodKey = typeof key === 'string' && expectedPattern.test(key) ? key : defaultPeriodKey(cleanPeriod, ts);
    const cleanMetric = metric === 'net' ? 'net' : 'real';
    const scoreExpr = cleanMetric === 'net' ? 'SUM(d.net_tokens)' : 'SUM(d.real_tokens)';
    const filterSql = cleanPeriod === 'day'
      ? 'd.day = ?'
      : cleanPeriod === 'month'
        ? 'substr(d.day, 1, 7) = ?'
        : 'substr(d.day, 1, 4) = ?';

    const rankedRows = db.prepare(`
      WITH aggregated AS (
        SELECT
          u.id AS user_id,
          u.auth_kind,
          u.display_name,
          u.avatar_url,
          u.anonymous_mode,
          u.created_at,
          SUM(d.real_tokens) AS real_tokens,
          SUM(d.net_tokens) AS net_tokens,
          SUM(d.requests) AS requests,
          ${scoreExpr} AS score
        FROM daily_usage d
        JOIN users u ON u.id = d.user_id
        WHERE ${filterSql}
        GROUP BY u.id
        HAVING score > 0 OR SUM(d.requests) > 0
      ),
      ranked AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY score DESC, requests DESC, created_at ASC, user_id ASC) AS rank,
          *
        FROM aggregated
      )
      SELECT * FROM ranked
      WHERE rank <= 100 OR user_id = ?
      ORDER BY rank ASC
    `).all(periodKey, selfUserId ?? '');

    const totalsRow = db.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT d.user_id
        FROM daily_usage d
        WHERE ${filterSql}
        GROUP BY d.user_id
        HAVING ${scoreExpr} > 0 OR SUM(d.requests) > 0
      )
    `).get(periodKey);
    const totalParticipants = totalsRow?.total ?? 0;

    const top100 = [];
    let meRow = null;
    for (const row of rankedRows) {
      const isSelf = Boolean(selfUserId && row.user_id === selfUserId);
      if (isSelf) meRow = row;
      if (row.rank <= 100) {
        top100.push({
          rank: row.rank,
          userId: row.user_id,
          displayName: isSelf ? row.display_name : maskedRowName({ id: row.user_id, display_name: row.display_name, anonymous_mode: row.anonymous_mode }),
          avatarUrl: !isSelf && row.anonymous_mode ? null : (row.avatar_url ?? null),
          authKind: row.auth_kind,
          anonymousMode: Boolean(row.anonymous_mode),
          realTokens: row.real_tokens,
          netTokens: row.net_tokens,
          requests: row.requests,
          isSelf
        });
      }
    }

    const scoreField = cleanMetric === 'net' ? 'net_tokens' : 'real_tokens';
    const scoreOf = row => row?.[scoreField] ?? 0;
    const scoreAtRank100 = top100.length >= 100 ? (cleanMetric === 'net' ? top100[99].netTokens : top100[99].realTokens) : 0;

    let me = null;
    if (selfUserId) {
      if (meRow) {
        let gapToPrev = 0;
        if (meRow.rank > 1) {
          const prevInTop = top100.find(item => item.rank === meRow.rank - 1);
          if (prevInTop) {
            const prevScore = cleanMetric === 'net' ? prevInTop.netTokens : prevInTop.realTokens;
            gapToPrev = Math.max(0, prevScore - scoreOf(meRow));
          } else {
            const prevDbRow = db.prepare(`
              WITH aggregated AS (
                SELECT u.id AS user_id, u.created_at, SUM(d.real_tokens) AS real_tokens, SUM(d.net_tokens) AS net_tokens, SUM(d.requests) AS requests, ${scoreExpr} AS score
                FROM daily_usage d JOIN users u ON u.id = d.user_id
                WHERE ${filterSql}
                GROUP BY u.id
                HAVING score > 0 OR SUM(d.requests) > 0
              ),
              ranked AS (
                SELECT ROW_NUMBER() OVER (ORDER BY score DESC, requests DESC, created_at ASC, user_id ASC) AS rank, *
                FROM aggregated
              )
              SELECT * FROM ranked WHERE rank = ?
            `).get(periodKey, meRow.rank - 1);
            gapToPrev = prevDbRow ? Math.max(0, scoreOf(prevDbRow) - scoreOf(meRow)) : 0;
          }
        }
        me = {
          rank: meRow.rank,
          totalParticipants,
          percentile: totalParticipants > 0 ? Math.round(((totalParticipants - meRow.rank + 1) / totalParticipants) * 1000) / 10 : 0,
          realTokens: meRow.real_tokens,
          netTokens: meRow.net_tokens,
          requests: meRow.requests,
          gapToPrev,
          gapToTop100: meRow.rank <= 100 ? 0 : Math.max(0, scoreAtRank100 - scoreOf(meRow) + 1),
          inTop100: meRow.rank <= 100
        };
      } else {
        me = {
          rank: null,
          totalParticipants,
          percentile: 0,
          realTokens: 0,
          netTokens: 0,
          requests: 0,
          gapToPrev: null,
          gapToTop100: totalParticipants >= 100 ? scoreAtRank100 + 1 : 0,
          inTop100: false
        };
      }
    }

    return {
      period: cleanPeriod,
      key: periodKey,
      metric: cleanMetric,
      updatedAt: ts,
      githubEnabled: Boolean(githubClientId),
      totalParticipants,
      top100,
      me
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'orca-tps-leaderboard', version: 1, githubEnabled: Boolean(githubClientId) });
      }

      if (req.method === 'POST' && pathname === '/v1/auth/anon') {
        const body = await readJsonBody(req);
        const userId = `anon:${randomBytes(8).toString('hex')}`;
        const displayName = cleanName(body.displayName, `玩家-${userId.slice(-4).toUpperCase()}`);
        const anonymousMode = body.anonymousMode ? 1 : 0;
        const claimCode = `ORCA-${randomBytes(6).toString('hex').toUpperCase()}`;
        const ts = now();
        db.prepare(
          'INSERT INTO users (id, auth_kind, display_name, avatar_url, anonymous_mode, claim_code_hash, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
        ).run(userId, 'anon', displayName, anonymousMode, sha256(claimCode), ts, ts);
        const token = issueSession(userId);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        return sendJson(res, 201, { token, claimCode, user: publicUser(user) });
      }

      if (req.method === 'POST' && pathname === '/v1/auth/claim') {
        const body = await readJsonBody(req);
        const claimCode = typeof body.claimCode === 'string' ? body.claimCode.trim().toUpperCase() : '';
        if (!claimCode || claimCode.length > 64) return sendJson(res, 400, { error: 'invalid_claim_code' });
        const user = db.prepare('SELECT * FROM users WHERE claim_code_hash = ? AND auth_kind = ?').get(sha256(claimCode), 'anon');
        if (!user) return sendJson(res, 404, { error: 'claim_code_not_found' });
        const token = issueSession(user.id);
        return sendJson(res, 200, { token, user: publicUser(user) });
      }

      if (req.method === 'POST' && pathname === '/v1/auth/github/device') {
        if (!githubClientId) {
          return sendJson(res, 501, {
            error: 'github_not_configured',
            message: '天梯服务端尚未配置 GITHUB_CLIENT_ID，请改用匿名加入或配置 GitHub OAuth App。'
          });
        }
        const resp = await githubFetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: githubClientId, scope: 'read:user' })
        });
        const data = await resp.json();
        if (!resp.ok || !data?.device_code || !data?.user_code) {
          return sendJson(res, 502, { error: 'github_device_failed' });
        }
        return sendJson(res, 200, {
          deviceCode: data.device_code,
          userCode: data.user_code,
          verificationUri: data.verification_uri || 'https://github.com/login/device',
          expiresIn: data.expires_in ?? 900,
          interval: data.interval ?? 5
        });
      }

      if (req.method === 'POST' && pathname === '/v1/auth/github/poll') {
        if (!githubClientId) return sendJson(res, 501, { error: 'github_not_configured' });
        const body = await readJsonBody(req);
        const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode.trim() : '';
        if (!deviceCode || deviceCode.length > 256) return sendJson(res, 400, { error: 'invalid_device_code' });

        const resp = await githubFetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: githubClientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const tokenData = await resp.json();
        if (tokenData?.error === 'authorization_pending') return sendJson(res, 200, { status: 'pending' });
        if (tokenData?.error === 'slow_down') return sendJson(res, 200, { status: 'slow_down', interval: tokenData.interval ?? 10 });
        if (tokenData?.error) return sendJson(res, 200, { status: 'expired', error: tokenData.error });
        if (!tokenData?.access_token) return sendJson(res, 502, { error: 'github_token_failed' });

        const userResp = await githubFetch('https://api.github.com/user', {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'orca-tps-leaderboard/1.0'
          }
        });
        if (!userResp.ok) return sendJson(res, 502, { error: 'github_user_failed' });
        const gh = await userResp.json();
        if (!gh?.id || typeof gh.login !== 'string') return sendJson(res, 502, { error: 'github_user_invalid' });

        const userId = `gh:${String(gh.id)}`;
        const displayName = cleanName(gh.name || gh.login, gh.login.slice(0, 40));
        const avatarUrl = safeAvatar(gh.avatar_url);
        const ts = now();
        const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (existing) {
          db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?').run(avatarUrl, ts, userId);
        } else {
          db.prepare(
            'INSERT INTO users (id, auth_kind, display_name, avatar_url, anonymous_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
          ).run(userId, 'github', displayName, avatarUrl, ts, ts);
        }
        const token = issueSession(userId);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        return sendJson(res, 200, { status: 'authorized', token, user: publicUser(user) });
      }

      if (req.method === 'GET' && pathname === '/v1/me') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
        return sendJson(res, 200, { user: publicUser(auth.user) });
      }

      if (req.method === 'PATCH' && pathname === '/v1/me') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readJsonBody(req);
        const nextName = body.displayName !== undefined ? cleanName(body.displayName, auth.user.display_name) : auth.user.display_name;
        const nextAnon = body.anonymousMode !== undefined ? (body.anonymousMode ? 1 : 0) : auth.user.anonymous_mode;
        db.prepare('UPDATE users SET display_name = ?, anonymous_mode = ?, updated_at = ? WHERE id = ?')
          .run(nextName, nextAnon, now(), auth.user.id);
        const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id);
        return sendJson(res, 200, { user: publicUser(updated) });
      }

      if (req.method === 'POST' && pathname === '/v1/auth/logout') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/v1/usage/sync') {
        const auth = authenticate(req);
        if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readJsonBody(req);
        if (!Array.isArray(body.entries) || body.entries.length > MAX_SYNC_ENTRIES) {
          return sendJson(res, 400, { error: 'invalid_entries' });
        }
        const ts = now();
        const existingScopes = new Set(
          db.prepare('SELECT DISTINCT source_scope FROM daily_usage WHERE user_id = ?').all(auth.user.id).map(r => r.source_scope)
        );
        const validated = [];
        for (const item of body.entries) {
          if (!item || typeof item !== 'object') return sendJson(res, 400, { error: 'invalid_entry' });
          const { sourceScope, day, realTokens, netTokens, requests } = item;
          if (!SCOPE_PATTERN.test(sourceScope) || !validDay(day, ts)) {
            return sendJson(res, 400, { error: 'invalid_entry_scope_or_day' });
          }
          if (!Number.isSafeInteger(realTokens) || !Number.isSafeInteger(netTokens) || !Number.isSafeInteger(requests) ||
            realTokens < 0 || netTokens < 0 || requests < 0 || netTokens > realTokens ||
            realTokens > MAX_DAILY_REAL_TOKENS || requests > MAX_DAILY_REQUESTS) {
            return sendJson(res, 400, { error: 'invalid_entry_counters' });
          }
          existingScopes.add(sourceScope);
          if (existingScopes.size > MAX_SCOPES_PER_USER) {
            return sendJson(res, 429, { error: 'too_many_scopes' });
          }
          validated.push({ sourceScope, day, realTokens, netTokens, requests });
        }

        const upsert = db.prepare(`
          INSERT INTO daily_usage (user_id, source_scope, day, real_tokens, net_tokens, requests, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, source_scope, day) DO UPDATE SET
            real_tokens = excluded.real_tokens,
            net_tokens = excluded.net_tokens,
            requests = excluded.requests,
            updated_at = excluded.updated_at
        `);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const entry of validated) {
            upsert.run(auth.user.id, entry.sourceScope, entry.day, entry.realTokens, entry.netTokens, entry.requests, ts);
          }
          db.exec('COMMIT');
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
        return sendJson(res, 200, { ok: true, accepted: validated.length, updatedAt: ts });
      }

      if (req.method === 'GET' && pathname === '/v1/leaderboard') {
        const auth = authenticate(req);
        const board = queryLeaderboard({
          period: url.searchParams.get('period'),
          key: url.searchParams.get('key'),
          metric: url.searchParams.get('metric'),
          selfUserId: auth?.user.id ?? null
        });
        return sendJson(res, 200, board);
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error?.status) return sendJson(res, error.status, { error: error.message });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });

  return {
    server,
    db,
    seedDemo: options => seedDemoLeaderboard(db, options),
    close: () => new Promise(resolve => {
      server.close(() => {
        try { db.close(); } catch { /* already closed */ }
        resolve();
      });
    })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const argValue = flag => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const port = Number(argValue('--port') ?? process.env.LEADERBOARD_PORT ?? 8787);
  const host = argValue('--host') ?? process.env.LEADERBOARD_HOST ?? '127.0.0.1';
  const dbPath = argValue('--db') ?? process.env.LEADERBOARD_DB ?? path.join(homedir(), '.orca-tps-leaderboard', 'leaderboard.db');
  const instance = createLeaderboardServer({ dbPath });
  if (args.includes('--seed-demo')) {
    const seeded = instance.seedDemo();
    if (seeded) console.log(`Seeded ${seeded} demo leaderboard players.`);
  }
  instance.server.listen(port, host, () => {
    const addr = instance.server.address();
    console.log(`Orca TPS Leaderboard Server listening on http://${addr.address}:${addr.port}`);
  });
}
