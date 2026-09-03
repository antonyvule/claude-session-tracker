const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('./src/db');
const sse = require('./src/sse');
const health = require('./src/health');
const browseModule = require('./src/browse');
const search = require('./src/search');
const actions = require('./src/actions');
const historyScanner = require('./src/historyScanner');
const gitBranch = require('./src/gitBranch');
const statusEngine = require('./src/statusEngine');
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
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const settings = loadSettings();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- Project patch (rename, ADO ticket link, priority, ignore) ---
app.patch('/api/projects/:projectKey', (req, res) => {
  const updated = db.patchProject(req.params.projectKey, req.body || {});
  recomputeAndBroadcast();
  res.json(updated);
});

// --- Project reorder (drag on the board) ---
app.post('/api/projects/reorder', (req, res) => {
  const { orderedKeys } = req.body || {};
  if (!Array.isArray(orderedKeys)) {
    res.status(400).json({ error: 'orderedKeys must be an array' });
    return;
  }
  db.reorderProjects(orderedKeys);
  recomputeAndBroadcast();
  res.json({ ok: true });
});

// --- Session reorder within a project (drag in the list) ---
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
app.post('/api/actions/resume', (req, res) => {
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
  try {
    const { cwd, name, model, effort } = req.body || {};
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

app.listen(settings.port, '127.0.0.1', () => {
  console.log(`claude-session-tracker listening on http://127.0.0.1:${settings.port}`);
});
