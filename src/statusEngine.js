const db = require('./db');
const historyScanner = require('./historyScanner');
const gitBranch = require('./gitBranch');
const { canonicalProjectKey } = require('./projects');

// Builds the full board view model by merging: the live `claude agents` roster,
// on-disk transcript index (mtime only — no full parse here, see historyScanner
// for why), and our own SQLite status/notes/pin/priority data.
function buildBoard(liveMap, staleThresholdHours) {
  const historical = historyScanner.listHistoricalSessions();
  const historicalById = new Map(historical.map((h) => [h.sessionId, h]));
  const dbById = new Map(db.listSessions().map((s) => [s.session_id, s]));

  const allIds = new Set([...liveMap.keys(), ...historicalById.keys()]);
  const now = Date.now();
  const staleMs = staleThresholdHours * 3600 * 1000;
  const seenCwds = new Set();

  const cards = [];
  for (const sessionId of allIds) {
    const live = liveMap.get(sessionId) || null;
    const hist = historicalById.get(sessionId) || null;
    const dbRow = dbById.get(sessionId) || null;

    const cwd = (live && live.cwd) || (hist && hist.cwd) || null;
    if (!cwd) continue; // can't place a card without knowing its project folder

    if (dbRow && dbRow.ignored) continue;

    const projectKey = canonicalProjectKey(cwd);
    const projectRow = db.getProject(projectKey);
    if (projectRow && projectRow.ignored) continue;

    if (!seenCwds.has(cwd)) {
      seenCwds.add(cwd);
      gitBranch.refreshBranch(cwd); // fire-and-forget; cache warms for the next build
    }

    const running = Boolean(live);
    const lastActiveMs = hist ? hist.mtimeMs : now;
    const needsAttention = hist ? historyScanner.peekNeedsAttention(hist.filePath) : false;
    const manuallySet = Boolean(dbRow && dbRow.manually_set);

    // Done and Archived are explicit-only — never auto-suggested. The only
    // automatic transitions are "running -> in_progress" and, separately, an
    // idle In Progress session gets the Stale badge without its status ever
    // changing to Done.
    let status = (dbRow && dbRow.status) || 'todo';
    let stale = false;
    if (status !== 'archived' && !manuallySet) {
      if (running) {
        status = 'in_progress';
      } else if (status === 'in_progress' && now - lastActiveMs > staleMs) {
        stale = true;
      }
    }

    cards.push({
      sessionId,
      projectKey,
      cwd,
      branch: gitBranch.getCachedBranch(cwd),
      name: live ? live.name : null,
      titleOverride: (dbRow && dbRow.title_override) || null,
      status,
      notes: (dbRow && dbRow.notes) || '',
      tags: (dbRow && dbRow.tags) || '',
      pinned: Boolean(dbRow && dbRow.pinned),
      orderIndex: dbRow && dbRow.order_index !== null && dbRow.order_index !== undefined ? dbRow.order_index : null,
      manuallySet,
      ignored: Boolean(dbRow && dbRow.ignored),
      running,
      pid: live ? live.pid : null,
      needsAttention,
      stale,
      lastActiveMs,
    });
  }

  const projectRows = new Map(db.listProjects().map((p) => [p.project_key, p]));
  const projectKeys = new Set(cards.map((c) => c.projectKey));
  const projects = Array.from(projectKeys).map((key) => {
    const row = projectRows.get(key);
    return {
      projectKey: key,
      displayName: (row && row.display_name) || null,
      adoTicketId: (row && row.ado_ticket_id) || null,
      priority: row && row.priority !== null && row.priority !== undefined ? row.priority : null,
    };
  });

  return { cards, projects };
}

module.exports = { buildBoard };
