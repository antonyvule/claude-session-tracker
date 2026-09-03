const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tracker.db'));
db.pragma('journal_mode = WAL');

const CURRENT_SCHEMA_VERSION = 2;
const userVersion = db.pragma('user_version', { simple: true });

if (userVersion < 1) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id            TEXT PRIMARY KEY,
      status                TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','blocked','done','archived')),
      notes                 TEXT NOT NULL DEFAULT '',
      tags                  TEXT NOT NULL DEFAULT '',
      title_override        TEXT,
      pinned                INTEGER NOT NULL DEFAULT 0,
      manually_set          INTEGER NOT NULL DEFAULT 0,
      ignored               INTEGER NOT NULL DEFAULT 0,
      last_seen_running_at  INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS projects (
      project_key   TEXT PRIMARY KEY,
      display_name  TEXT,
      ado_ticket_id INTEGER,
      priority      INTEGER,
      ignored       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
  db.pragma('user_version = 1');
}

if (userVersion < 2) {
  // Additive only — existing rows get order_index = NULL, never destructive.
  db.exec('ALTER TABLE sessions ADD COLUMN order_index INTEGER;');
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

const ALLOWED_SESSION_FIELDS = ['status', 'notes', 'tags', 'title_override', 'pinned', 'manually_set', 'ignored', 'order_index'];
const ALLOWED_PROJECT_FIELDS = ['display_name', 'ado_ticket_id', 'priority', 'ignored'];
const BOOLEAN_FIELDS = new Set(['pinned', 'manually_set', 'ignored']);

// better-sqlite3 only binds numbers/strings/bigints/buffers/null — coerce JS
// booleans (which arrive from JSON request bodies) to 0/1.
function coerceValue(key, value) {
  return BOOLEAN_FIELDS.has(key) ? (value ? 1 : 0) : value;
}

function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
}

function listSessions() {
  return db.prepare('SELECT * FROM sessions').all();
}

function patchSession(sessionId, patch) {
  const ts = Date.now();
  const fields = {};
  for (const key of ALLOWED_SESSION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) fields[key] = coerceValue(key, patch[key]);
  }
  const existing = getSession(sessionId);
  if (existing) {
    const setClause = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    if (setClause) {
      db.prepare(`UPDATE sessions SET ${setClause}, updated_at = @updated_at WHERE session_id = @session_id`)
        .run({ ...fields, updated_at: ts, session_id: sessionId });
    }
  } else {
    db.prepare(`
      INSERT INTO sessions (session_id, status, notes, tags, title_override, pinned, manually_set, ignored, created_at, updated_at)
      VALUES (@session_id, @status, @notes, @tags, @title_override, @pinned, @manually_set, @ignored, @created_at, @updated_at)
    `).run({
      session_id: sessionId,
      status: fields.status ?? 'todo',
      notes: fields.notes ?? '',
      tags: fields.tags ?? '',
      title_override: fields.title_override ?? null,
      pinned: fields.pinned ?? 0,
      manually_set: fields.manually_set ?? 0,
      ignored: fields.ignored ?? 0,
      created_at: ts,
      updated_at: ts,
    });
  }
  return getSession(sessionId);
}

function touchSessionSeenRunning(sessionId) {
  db.prepare('UPDATE sessions SET last_seen_running_at = ? WHERE session_id = ?').run(Date.now(), sessionId);
}

function listProjects() {
  return db.prepare('SELECT * FROM projects').all();
}

function getProject(projectKey) {
  return db.prepare('SELECT * FROM projects WHERE project_key = ?').get(projectKey);
}

function patchProject(projectKey, patch) {
  const ts = Date.now();
  const fields = {};
  for (const key of ALLOWED_PROJECT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) fields[key] = coerceValue(key, patch[key]);
  }
  const existing = getProject(projectKey);
  if (existing) {
    const setClause = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    if (setClause) {
      db.prepare(`UPDATE projects SET ${setClause}, updated_at = @updated_at WHERE project_key = @project_key`)
        .run({ ...fields, updated_at: ts, project_key: projectKey });
    }
  } else {
    db.prepare(`
      INSERT INTO projects (project_key, display_name, ado_ticket_id, priority, ignored, created_at, updated_at)
      VALUES (@project_key, @display_name, @ado_ticket_id, @priority, @ignored, @created_at, @updated_at)
    `).run({
      project_key: projectKey,
      display_name: fields.display_name ?? null,
      ado_ticket_id: fields.ado_ticket_id ?? null,
      priority: fields.priority ?? null,
      ignored: fields.ignored ?? 0,
      created_at: ts,
      updated_at: ts,
    });
  }
  return getProject(projectKey);
}

const reorderProjects = db.transaction((orderedKeys) => {
  const ts = Date.now();
  orderedKeys.forEach((key, idx) => {
    const existing = getProject(key);
    if (existing) {
      db.prepare('UPDATE projects SET priority = ?, updated_at = ? WHERE project_key = ?').run(idx, ts, key);
    } else {
      db.prepare(`
        INSERT INTO projects (project_key, priority, ignored, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(key, idx, ts, ts);
    }
  });
});

// Reordering within a project: the client sends the full ordered list of session
// ids for that one project's card list; unrelated sessions elsewhere keep their
// own order_index untouched.
const reorderSessions = db.transaction((orderedSessionIds) => {
  orderedSessionIds.forEach((sessionId, idx) => {
    patchSession(sessionId, { order_index: idx });
  });
});

module.exports = {
  db,
  getSession,
  listSessions,
  patchSession,
  touchSessionSeenRunning,
  listProjects,
  getProject,
  patchProject,
  reorderProjects,
  reorderSessions,
};
