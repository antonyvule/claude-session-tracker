const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const db = require('./src/db');
const sse = require('./src/sse');
const health = require('./src/health');
const browseModule = require('./src/browse');
const search = require('./src/search');
const actions = require('./src/actions');
const historyScanner = require('./src/historyScanner');
const gitBranch = require('./src/gitBranch');
const statusEngine = require('./src/statusEngine');
const ptyManager = require('./src/ptyManager');
const { createAgentsPoller } = require('./src/agentsPoller');

const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');
const DEFAULT_SETTINGS = {
  port: 4756,
  pollIntervalMs: 4000,
  staleThresholdHours: 24,
  allowedBrowseRoots: [],
  ado: { org: '', project: '' },
  ignoredProjects: [],
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Missing file is normal (first run); anything else (bad JSON, permissions)
      // means the user's edit was silently ignored, which they should know about.
      console.error(`[settings] failed to load ${SETTINGS_PATH}, using defaults: ${err.message}`);
    }
    return DEFAULT_SETTINGS;
  }
}

const settings = loadSettings();

const app = express();
app.use(express.json());

// No auth is intentional (single-user localhost tool), but that's distinct from
// CSRF: a browser still *sends* a cross-origin POST/PATCH to 127.0.0.1 even
// without CORS headers (same-origin policy only blocks reading the response).
// Reject state-changing requests whose Origin/Referer doesn't match our own
// origin; requests with no Origin header at all (curl, scripts) are allowed,
// since that header is browser-only in the first place.
//
// Matches the *origin* exactly (scheme + host + port, nothing after), not a
// string prefix — startsWith would let "http://127.0.0.1:47560" pass a check
// for port 4756. Both 127.0.0.1 and localhost are accepted since the server
// binds 127.0.0.1 but a browser may still be pointed at either hostname.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${settings.port}`,
  `http://localhost:${settings.port}`,
]);
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    const originHeader = req.get('origin') || req.get('referer');
    if (originHeader) {
      let originOnly;
      try {
        originOnly = new URL(originHeader).origin;
      } catch {
        res.status(403).json({ error: 'cross-origin request rejected' });
        return;
      }
      if (!ALLOWED_ORIGINS.has(originOnly)) {
        res.status(403).json({ error: 'cross-origin request rejected' });
        return;
      }
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Actions accept a client-supplied cwd (Resume/Fork/Continue/New Session) —
// actions.js enforces the same folder scoping the New Session picker already
// promises, so an action can't be pointed at an arbitrary directory outside it.
actions.configure(settings);

let lastCardsById = new Map();
let lastProjectsJson = '[]';

function recomputeAndBroadcast() {
  const liveMap = poller.getLiveMap();
  const { cards, projects } = statusEngine.buildBoard(liveMap, settings.staleThresholdHours);
  const nextCardsById = new Map(cards.map((c) => [c.sessionId, c]));

  for (const [id, card] of nextCardsById) {
    const prev = lastCardsById.get(id);
    if (!prev) {
      sse.broadcast({ type: 'session:update', sessionId: id, patch: card });
      continue;
    }
    const patch = {};
    for (const key of Object.keys(card)) {
      if (JSON.stringify(card[key]) !== JSON.stringify(prev[key])) patch[key] = card[key];
    }
    if (Object.keys(patch).length > 0) {
      sse.broadcast({ type: 'session:update', sessionId: id, patch });
    }
  }
  for (const id of lastCardsById.keys()) {
    if (!nextCardsById.has(id)) sse.broadcast({ type: 'session:remove', sessionId: id });
  }
  lastCardsById = nextCardsById;

  const projectsJson = JSON.stringify(projects);
  if (projectsJson !== lastProjectsJson) {
    lastProjectsJson = projectsJson;
    sse.broadcast({ type: 'projects:update', projects });
  }
}

function getSnapshot() {
  return {
    cards: Array.from(lastCardsById.values()),
    projects: JSON.parse(lastProjectsJson),
    settings: { staleThresholdHours: settings.staleThresholdHours },
  };
}

const poller = createAgentsPoller({
  intervalMs: settings.pollIntervalMs,
  onUpdate: ({ ok, error }) => {
    health.recordPoll({ ok, error });
    recomputeAndBroadcast();
    sse.broadcast({ type: 'poll:status', ok, error });
  },
});

historyScanner.watchProjects({
  onChange: ({ sessionId }) => {
    const info = historyScanner.getIndexEntry(sessionId);
    if (info) {
      const cwd = historyScanner.getRealCwdForSlug(info.slugDir);
      if (cwd) {
        gitBranch.invalidate(cwd);
        gitBranch.refreshBranch(cwd);
      }
    }
    recomputeAndBroadcast();
  },
});

poller.start();

// --- SSE ---
app.get('/events', (req, res) => sse.handleConnection(req, res, getSnapshot));

// --- Health ---
app.get('/api/health', health.handler);

// --- Config (read-only surface for the client) ---
app.get('/api/config', (req, res) => {
  res.json({
    staleThresholdHours: settings.staleThresholdHours,
    ado: settings.ado,
  });
});

// --- Browse (New Session folder picker) ---
app.get('/api/browse', (req, res) => browseModule.browse(req, res, settings));

// --- Known project roots (New Session quick-pick) ---
app.get('/api/projects/roots', (req, res) => {
  res.json({ roots: historyScanner.knownProjectRoots() });
});

// --- Search ---
app.get('/api/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ ok: true, results: [] });
    return;
  }
  const result = await search.searchTranscripts(q);
  res.json(result);
});

// --- Session detail (full parse, on demand) ---
app.get('/api/sessions/:sessionId/detail', (req, res) => {
  const detail = historyScanner.parseSessionDetail(req.params.sessionId);
  if (!detail) {
    res.status(404).json({ error: 'no transcript found for this session yet' });
    return;
  }
  res.json(detail);
});

// --- Session status/notes/tags/pin/ignore patch ---
app.patch('/api/sessions/:sessionId', (req, res) => {
  const updated = db.patchSession(req.params.sessionId, req.body || {});
  recomputeAndBroadcast();
  res.json(updated);
});

// --- Project patch (rename, ADO ticket link, ignore) ---
app.patch('/api/projects/:projectKey', (req, res) => {
  const updated = db.patchProject(req.params.projectKey, req.body || {});
  recomputeAndBroadcast();
  res.json(updated);
});

// --- Session reorder (drag in the list) ---
app.post('/api/sessions/reorder', (req, res) => {
  const { orderedSessionIds } = req.body || {};
  if (!Array.isArray(orderedSessionIds)) {
    res.status(400).json({ error: 'orderedSessionIds must be an array' });
    return;
  }
  db.reorderSessions(orderedSessionIds);
  recomputeAndBroadcast();
  res.json({ ok: true });
});

// --- Actions: spawn a PowerShell window running the relevant claude command ---
// Resume reuses the exact same sessionId/transcript, so — unlike Fork, which
// deliberately starts a new session and is fine to run alongside the
// original — it's guarded against launching a second process against a
// session the live poller already reports as running (ours, via the in-app
// terminal, or an external terminal window). The "Already open" disabled
// button is the client-side version of this same check; that alone isn't
// enough since its data can lag up to one poll interval behind.
app.post('/api/actions/resume', (req, res) => {
  if (poller.getLiveMap().has(req.body.sessionId)) {
    res.status(409).json({ ok: false, error: 'session is already running elsewhere' });
    return;
  }
  try {
    actions.resume(req.body.sessionId, req.body.cwd);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/actions/fork', (req, res) => {
  try {
    actions.fork(req.body.sessionId, req.body.cwd);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/actions/continue', (req, res) => {
  try {
    actions.continueLatest(req.body.cwd);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/actions/focus', async (req, res) => {
  const result = await actions.focusWindow(Number(req.body.pid));
  res.json(result);
});

app.post('/api/actions/new', (req, res) => {
  const { cwd, name, model, effort } = req.body || {};
  try {
    actions.newSession(cwd, { name, model, effort });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Copy-command fallback text (client copies via navigator.clipboard) ---
app.get('/api/actions/command', (req, res) => {
  const { type, sessionId, name, model, effort } = req.query;
  switch (type) {
    case 'resume':
      res.json({ command: actions.commandTextResume(sessionId) });
      break;
    case 'fork':
      res.json({ command: actions.commandTextFork(sessionId) });
      break;
    case 'continue':
      res.json({ command: actions.commandTextContinue() });
      break;
    case 'new':
      res.json({ command: actions.commandTextNewSession({ name, model, effort }) });
      break;
    default:
      res.status(400).json({ error: 'unknown command type' });
  }
});

// --- In-app terminal (embedded PTY, see src/ptyManager.js) ---
// WebSocket handshakes aren't subject to the same-origin fetch/XHR read-block
// the POST/PATCH origin check above relies on, so it's checked explicitly here
// too — otherwise any page in the browser could open a socket straight into a
// live claude session.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    ws.close(1008, 'cross-origin request rejected');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const cwd = url.searchParams.get('cwd');

  if (!ptyManager.isOpen(sessionId)) {
    const live = poller.getLiveMap().get(sessionId);
    if (live) {
      ws.close(1008, 'session is already running elsewhere');
      return;
    }
  }

  try {
    ptyManager.open(sessionId, cwd);
  } catch (err) {
    ws.close(1008, err.message);
    return;
  }
  ptyManager.subscribe(sessionId, ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      ptyManager.write(sessionId, msg.data);
    } else if (msg.type === 'resize') {
      ptyManager.resize(sessionId, msg.cols, msg.rows);
    }
  });
});

// Detached `claude`/powershell processes would otherwise outlive the tracker
// itself across a restart, piling up in the background.
function shutdown() {
  ptyManager.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(settings.port, '127.0.0.1', () => {
  console.log(`claude-session-tracker listening on http://127.0.0.1:${settings.port}`);
});
