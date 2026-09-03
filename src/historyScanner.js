const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { estimateCostUsd } = require('./pricing');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// sessionId -> { slugDir, filePath, mtimeMs }
const sessionIndex = new Map();
// slugDir -> real cwd (read once from transcript content, never decoded from the slug —
// slug->path is ambiguous when a folder name itself contains dashes)
const slugCwdCache = new Map();

function isJsonlFile(filePath) {
  return filePath.toLowerCase().endsWith('.jsonl');
}

// Subagent (Task-tool) runs get their own transcript, nested under the parent
// session as <slug>/<parentSessionId>/subagents/agent-<id>.jsonl (confirmed by
// direct inspection — these are marked isSidechain:true internally too). The
// chokidar watcher below uses a recursive glob so it catches new session files
// added anywhere under a project, which also means it would otherwise pick these
// up and list a subagent run as if it were its own top-level session — one the
// user never interacts with directly and can't usefully act on. scanAll() can't
// reach these anyway (one level of readdir per slug dir), but the watcher can,
// so both paths are guarded here for the same reason.
function isSubagentTranscript(filePath) {
  return filePath.split(/[\\/]/).includes('subagents');
}

function sessionIdFromFile(filePath) {
  return path.basename(filePath, '.jsonl');
}

function slugDirOf(filePath) {
  return path.dirname(filePath);
}

// The first several lines of a transcript are often metadata entries (mode,
// permission-mode, file-history-snapshot, ...) with no `cwd` field — only the
// actual turn entries carry it. Scan a bounded prefix rather than assuming line 1.
function findCwdInLeadingLines(filePath, maxLines = 30) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let checked = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      checked += 1;
      if (checked > maxLines) break;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && typeof entry.cwd === 'string') return entry.cwd;
      } catch {
        // partial/malformed line — keep scanning
      }
    }
  } catch {
    // unreadable — fall through to null
  }
  return null;
}

function getRealCwdForSlug(slugDir) {
  if (slugCwdCache.has(slugDir)) return slugCwdCache.get(slugDir);
  let cwd = null;
  try {
    const files = fs.readdirSync(slugDir).filter((f) => isJsonlFile(f));
    for (const f of files) {
      cwd = findCwdInLeadingLines(path.join(slugDir, f));
      if (cwd) break;
    }
  } catch {
    cwd = null;
  }
  slugCwdCache.set(slugDir, cwd);
  return cwd;
}

function scanAll() {
  sessionIndex.clear();
  if (!fs.existsSync(PROJECTS_DIR)) return;
  const slugDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(PROJECTS_DIR, d.name));

  for (const slugDir of slugDirs) {
    let files = [];
    try {
      files = fs.readdirSync(slugDir).filter((f) => isJsonlFile(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const filePath = path.join(slugDir, f);
      try {
        const stat = fs.statSync(filePath);
        sessionIndex.set(sessionIdFromFile(filePath), { slugDir, filePath, mtimeMs: stat.mtimeMs });
      } catch {
        // file disappeared between readdir and stat — skip it
      }
    }
  }
}

function listHistoricalSessions() {
  const out = [];
  for (const [sessionId, info] of sessionIndex.entries()) {
    const cwd = getRealCwdForSlug(info.slugDir);
    if (!cwd) continue;
    out.push({ sessionId, cwd, mtimeMs: info.mtimeMs, filePath: info.filePath });
  }
  return out;
}

function getIndexEntry(sessionId) {
  return sessionIndex.get(sessionId) || null;
}

function knownProjectRoots() {
  const seen = new Map(); // cwd -> true
  for (const slugDir of new Set(Array.from(sessionIndex.values()).map((v) => v.slugDir))) {
    const cwd = getRealCwdForSlug(slugDir);
    if (cwd) seen.set(cwd, true);
  }
  return Array.from(seen.keys());
}

function parseJsonlLines(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  const parsed = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Partial last line (file mid-write) or malformed entry — skip, don't fail the whole parse.
    }
  }
  return parsed;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    return textBlock ? textBlock.text : '';
  }
  return '';
}

function deriveTitle(entries) {
  const firstUser = entries.find((e) => e && e.type === 'user' && e.message && e.message.role === 'user');
  if (!firstUser) return null;
  const text = extractText(firstUser.message.content).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// Best-effort: a pending tool_use / permission approval is a reliable "waiting on you"
// signal. Free-form "the assistant asked a question" is not detected — that needs
// semantic understanding of the reply text, which this heuristic does not attempt.
function detectNeedsAttention(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    return Boolean(e.type === 'assistant' && e.message && e.message.stop_reason === 'tool_use');
  }
  return false;
}

function summarizeUsage(entries) {
  const usageByModel = new Map();
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const model = e.message.model || 'unknown';
    const u = e.message.usage;
    const acc = usageByModel.get(model) || {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    acc.input_tokens += u.input_tokens || 0;
    acc.output_tokens += u.output_tokens || 0;
    acc.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageByModel.set(model, acc);
  }
  return usageByModel;
}

function parseSessionDetail(sessionId) {
  const info = getIndexEntry(sessionId);
  if (!info) return null;
  const entries = parseJsonlLines(info.filePath);
  const turnEntries = entries.filter(
    (e) => e && (e.type === 'user' || e.type === 'assistant') && e.message
  );
  // The whole session, not a windowed preview — the detail pane is opened on demand
  // (already a full parse for the cost estimate below), so there's no extra cost to
  // returning every turn instead of an arbitrary tail slice.
  const turns = turnEntries
    .map((e) => ({
      role: e.message.role,
      text: extractText(e.message.content),
      timestamp: e.timestamp || null,
    }))
    .filter((t) => t.text);
  const usageByModel = summarizeUsage(entries);
  const lastEntry = entries[entries.length - 1];
  return {
    sessionId,
    cwd: getRealCwdForSlug(info.slugDir),
    title: deriveTitle(entries),
    needsAttention: detectNeedsAttention(entries),
    turns,
    costUsd: estimateCostUsd(usageByModel),
    lastActivityIso: (lastEntry && lastEntry.timestamp) || new Date(info.mtimeMs).toISOString(),
    turnCount: turnEntries.length,
  };
}

// Cheap board-list check: read only the file's tail instead of a full parse, so the
// "Needs You" badge can be computed for every card without the cost of the full
// per-session parse (usage summary, preview) that's reserved for the detail panel.
function peekNeedsAttention(filePath, tailBytes = 8192) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(tailBytes, stat.size);
    const buffer = Buffer.alloc(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    lines.shift(); // drop possibly-truncated first line from the tail cut
    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // truncated/malformed line — skip
      }
    }
    return detectNeedsAttention(entries);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// Safety net for the live watcher below — re-runs the same startup scan and
// reports any session id that wasn't already indexed. Verified necessary: on a
// long-running (76+ hour) instance, three real, on-disk session files went
// completely undetected — the live watcher had silently stopped delivering
// events for that project directory, with no error ever emitted. A periodic
// full re-scan self-heals regardless of why the live watcher stopped, at
// negligible cost (a readdir + stat per file, on a personal-scale session count).
function rescanForMissed(onChange) {
  const before = new Set(sessionIndex.keys());
  scanAll();
  for (const sessionId of sessionIndex.keys()) {
    if (!before.has(sessionId)) onChange({ type: 'add', sessionId });
  }
}

function watchProjects({ onChange, rescanIntervalMs = 60000 }) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  }
  scanAll();
  const debounceTimers = new Map();
  const debounced = (filePath, fn) => {
    clearTimeout(debounceTimers.get(filePath));
    debounceTimers.set(filePath, setTimeout(fn, 500));
  };

  const watcher = chokidar.watch(path.join(PROJECTS_DIR, '**', '*.jsonl'), {
    usePolling: false,
    ignoreInitial: true,
  });

  watcher.on('error', (err) => {
    console.error('[historyScanner] file watcher error (rescan safety net will still catch missed files):', err.message);
  });

  setInterval(() => rescanForMissed(onChange), rescanIntervalMs);

  watcher.on('add', (filePath) => {
    if (isSubagentTranscript(filePath)) return;
    debounced(filePath, () => {
      try {
        const stat = fs.statSync(filePath);
        const sessionId = sessionIdFromFile(filePath);
        sessionIndex.set(sessionId, { slugDir: slugDirOf(filePath), filePath, mtimeMs: stat.mtimeMs });
        onChange({ type: 'add', sessionId });
      } catch {
        // race with file removal — ignore
      }
    });
  });

  watcher.on('change', (filePath) => {
    if (isSubagentTranscript(filePath)) return;
    debounced(filePath, () => {
      try {
        const stat = fs.statSync(filePath);
        const sessionId = sessionIdFromFile(filePath);
        const existing = sessionIndex.get(sessionId);
        if (existing) existing.mtimeMs = stat.mtimeMs;
        onChange({ type: 'change', sessionId });
      } catch {
        // race with file removal — ignore
      }
    });
  });

  watcher.on('unlink', (filePath) => {
    if (isSubagentTranscript(filePath)) return;
    const sessionId = sessionIdFromFile(filePath);
    sessionIndex.delete(sessionId);
    onChange({ type: 'unlink', sessionId });
  });

  return watcher;
}

module.exports = {
  PROJECTS_DIR,
  scanAll,
  listHistoricalSessions,
  getIndexEntry,
  knownProjectRoots,
  parseSessionDetail,
  peekNeedsAttention,
  watchProjects,
  extractText,
  getRealCwdForSlug,
};
