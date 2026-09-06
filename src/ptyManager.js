const pty = require('node-pty');
const actions = require('./actions');

// Enough scrollback to redraw a reattached terminal (page refresh, or
// collapse-then-reopen the panel) without letting memory grow unbounded for a
// long-lived session.
const SCROLLBACK_LIMIT_BYTES = 200 * 1024;

// One entry per sessionId with a live in-app terminal. The underlying `claude`
// process is a real interactive session attached to a pseudo-terminal we own
// (not a one-shot spawn) — closing the browser panel detaches (like `tmux
// detach`), it doesn't kill the process; reopening it re-subscribes to the
// same still-running entry instead of spawning a second `claude` against the
// same session.
const sessions = new Map();

function isOpen(sessionId) {
  return sessions.has(sessionId);
}

function trimScrollback(entry) {
  let total = entry.scrollback.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > SCROLLBACK_LIMIT_BYTES && entry.scrollback.length > 1) {
    total -= entry.scrollback.shift().length;
  }
}

// Same command a real terminal launch would run (see actions.js's resume()) —
// this is a genuine interactive `claude` session, not a non-interactive one,
// so permission prompts, Esc-to-interrupt, and Shift+Tab mode-switching all
// work exactly as they do in an external terminal window.
//
// cols/rows (only used for a fresh spawn — an existing entry keeps whatever
// size it already has) should be the connecting client's real fitted size
// where available. Whatever width the CLI's very first output is written at
// gets permanently baked into this entry's scrollback buffer below — a
// later 'resize' message reflows the *live* terminal going forward, but
// can't retroactively rewrap bytes already recorded for replay on the next
// reattach. Spawning close to the real size from the start avoids stale,
// narrower-than-actual scrollback content for the common case of a client
// connecting for the first time.
function open(sessionId, cwd, cols, rows) {
  if (!actions.isValidSessionId(sessionId)) throw new Error('invalid sessionId');
  if (!actions.isValidCwd(cwd)) throw new Error('cwd no longer exists');
  actions.assertCwdAllowed(cwd);

  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const command = `claude --resume ${actions.psQuote(sessionId)}`;
  const proc = pty.spawn('powershell.exe', ['-NoExit', '-Command', command], {
    name: 'xterm-color',
    cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
    cwd,
    env: actions.CLAUDE_ENV,
  });

  const entry = { proc, subscribers: new Set(), scrollback: [], exited: false };
  sessions.set(sessionId, entry);

  proc.onData((data) => {
    entry.scrollback.push(data);
    trimScrollback(entry);
    for (const ws of entry.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  proc.onExit(({ exitCode }) => {
    entry.exited = true;
    for (const ws of entry.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    sessions.delete(sessionId);
  });

  return entry;
}

// Replays recent scrollback on attach so a reconnect isn't a blank screen.
function subscribe(sessionId, ws) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.subscribers.add(ws);
  for (const chunk of entry.scrollback) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data: chunk }));
  }
  ws.on('close', () => entry.subscribers.delete(ws));
}

function write(sessionId, data) {
  const entry = sessions.get(sessionId);
  if (entry && !entry.exited) entry.proc.write(data);
}

function resize(sessionId, cols, rows) {
  const entry = sessions.get(sessionId);
  if (entry && !entry.exited && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
    entry.proc.resize(cols, rows);
  }
}

// Explicit end (not used by the default collapse/reopen flow, which detaches
// instead) — kills the underlying process outright.
function close(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.proc.kill();
  sessions.delete(sessionId);
}

function closeAll() {
  for (const sessionId of Array.from(sessions.keys())) close(sessionId);
}

module.exports = { isOpen, open, subscribe, write, resize, close, closeAll };
