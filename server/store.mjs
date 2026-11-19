import { DatabaseSync } from 'node:sqlite';
import { leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export function openLeaderboardStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=3000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS administrator (
      slot INTEGER PRIMARY KEY CHECK(slot=1), account INTEGER NOT NULL REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      digest TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id),
      tokens INTEGER, submitted_at INTEGER NOT NULL, PRIMARY KEY(day, account)
    );
    CREATE INDEX IF NOT EXISTS score_order ON scores(day, tokens DESC, submitted_at, account);
    CREATE TABLE IF NOT EXISTS attempts (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(day, account, request_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS attempt_window ON attempts(day, account, received_at);
    CREATE TABLE IF NOT EXISTS locks (
      day TEXT NOT NULL, account INTEGER NOT NULL REFERENCES accounts(id), PRIMARY KEY(day, account)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL
    );
  `);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const administrator = () => get('SELECT account FROM administrator WHERE slot=1')?.account;
  const audit = (actor, action, target, now) =>
    run('INSERT INTO audit(account, action, target, at) VALUES (?, ?, ?, ?)', actor, action, target, now);

  function upsertAccount({ id, login }) {
    run('INSERT INTO accounts(id, username) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username', id, login);
  }

  function bindAdministrator(account) {
    run('INSERT INTO administrator(slot, account) VALUES (1, ?) ON CONFLICT(slot) DO NOTHING', account);
    return administrator() === account;
  }

  function session(digest, kind, now) {
    return get(`
      SELECT accounts.id, accounts.username, accounts.banned
      FROM sessions JOIN accounts ON accounts.id=sessions.account
      WHERE digest=? AND kind=? AND expires>?
    `, digest, kind, now);
  }

  function status(account, now) {
    const day = leaderboardDay(now);
    const score = get('SELECT tokens, submitted_at FROM scores WHERE day=? AND account=?', day, account);
    const locked = Boolean(get('SELECT 1 FROM locks WHERE day=? AND account=?', day, account));
    return {
      day, submitted: Boolean(score), tokens: score?.tokens ?? null, submittedAt: score?.submitted_at ?? null,
      lockedUntil: locked ? leaderboardDayStart(day) + DAY : null
    };
  }

  function ranking(account, now) {
    const state = account === null ? { day: leaderboardDay(now) } : status(account, now);
    const rows = all(`
      SELECT accounts.username, scores.account, tokens, submitted_at AS submittedAt
      FROM scores JOIN accounts ON accounts.id=scores.account
      WHERE day=? AND tokens IS NOT NULL ORDER BY tokens DESC, submitted_at, scores.account LIMIT 100
    `, state.day).map(({ account: id, ...row }, index) => ({ ...row, rank: index + 1, mine: id === account }));
    const rank = state.tokens == null ? null : 1 + get(`
      SELECT COUNT(*) AS count FROM scores WHERE day=? AND (
        tokens>? OR (tokens=? AND (submitted_at<? OR (submitted_at=? AND account<?)))
      )
    `, state.day, state.tokens, state.tokens, state.submittedAt, state.submittedAt, account).count;
    return { ...state, rank, rows };
  }

  function submit(account, { day: requestedDay, tokens, requestId, fingerprint }, now, maxTokens) {
    const day = leaderboardDay(now);
    return transaction(() => {
      if (get('SELECT banned FROM accounts WHERE id=?', account)?.banned) return 'banned';
      if (get('SELECT 1 FROM locks WHERE day=? AND account=?', day, account)) return 'locked';
      const oldAttempt = get(`
        SELECT outcome FROM attempts WHERE day=? AND account=? AND request_id=? AND fingerprint=?
      `, day, account, requestId, fingerprint);
      if (oldAttempt) return oldAttempt.outcome === 'accepted' ? 'duplicate' : oldAttempt.outcome;
      let outcome = 'accepted';
      if (get('SELECT 1 FROM scores WHERE day=? AND account=?', day, account)) outcome = 'duplicate';
      else if (get('SELECT 1 FROM attempts WHERE day=? AND account=? AND request_id=?', day, account, requestId) ||
          requestedDay !== day || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > maxTokens) outcome = 'invalid';

      run('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)', day, account, requestId, fingerprint, outcome, now);
      if (outcome === 'accepted') {
        run('INSERT INTO scores VALUES (?, ?, ?, ?)', day, account, tokens, now);
        return outcome;
      }
      const { count } = get(`
        SELECT COUNT(*) AS count FROM attempts
        WHERE day=? AND account=? AND received_at>? AND outcome!='accepted'
      `, day, account, now - TEN_MINUTES);
      if (count < 5) return outcome;
      run('INSERT INTO locks VALUES (?, ?)', day, account);
      return 'locked';
    });
  }

  function setBan(actor, account, banned, now) {
    if (account === administrator()) return false;
    return transaction(() => {
      const changed = run('UPDATE accounts SET banned=? WHERE id=? AND banned!=?', Number(banned), account, Number(banned));
      if (!changed.changes) return false;
      audit(actor, banned ? 'ban' : 'unban', String(account), now);
      return true;
    });
  }

  function removeScores(actor, { day, account }, now) {
    const today = leaderboardDay(now);
    const filter = (day ? ' AND day=?' : '') + (account ? ' AND account=?' : '');
    const params = [...(day ? [day] : []), ...(account ? [account] : [])];
    transaction(() => {
      run('UPDATE scores SET tokens=NULL WHERE day=?' + filter, today, ...params);
      run('DELETE FROM scores WHERE day!=?' + filter, today, ...params);
      audit(actor, account ? 'delete' : 'clear', [day || 'all', account].filter(Boolean).join('/'), now);
    });
  }

  function adminView(day, search) {
    return {
      scores: all(`
        SELECT account, username, tokens, submitted_at AS submittedAt FROM scores
        JOIN accounts ON accounts.id=scores.account WHERE day=? AND tokens IS NOT NULL AND instr(lower(username), lower(?))>0
        ORDER BY tokens DESC, submitted_at, account LIMIT 500
      `, day, search),
      accounts: all('SELECT id, username, banned FROM accounts WHERE instr(lower(username), lower(?))>0 ORDER BY banned DESC, username LIMIT 500', search),
      audit: all(`
        SELECT action, target, at, username FROM audit JOIN accounts ON accounts.id=audit.account
        ORDER BY audit.id DESC LIMIT 25
      `)
    };
  }

  function prune(now) {
    const day = leaderboardDay(now);
    transaction(() => {
      run('DELETE FROM sessions WHERE expires<=?', now);
      run('DELETE FROM attempts WHERE day<?', day);
      run('DELETE FROM locks WHERE day<?', day);
      run('DELETE FROM scores WHERE day<? AND tokens IS NULL', day);
    });
  }

  return {
    upsertAccount, bindAdministrator, administrator, session, status, ranking, submit, setBan, removeScores, adminView, prune,
    addSession: (digest, account, kind, expires) => run('INSERT INTO sessions VALUES (?, ?, ?, ?)', digest, account, kind, expires),
    removeSession: digest => run('DELETE FROM sessions WHERE digest=?', digest),
    close: () => db.close()
  };
}
