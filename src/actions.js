const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const FOCUS_SCRIPT_PATH = path.join(__dirname, 'ps', 'focus-window.ps1');

// If this server process is itself running as a descendant of a Claude Code
// session (e.g. during development, or if launched from within one), every
// `claude` it spawns inherits CLAUDE_CODE_CHILD_SESSION and silently disables
// its own transcript persistence — the launched session runs fine but never
// creates a transcript file, so it can never be tracked (verified directly:
// the CLI prints "Transcript saving is off ... restart with
// CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 to keep future transcripts").
// Forcing this on every spawn here makes launches robust regardless of what
// environment the tracker itself happens to be running under.
const CLAUDE_ENV = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && UUID_RE.test(sessionId);
}

function isValidCwd(cwd) {
  try {
    return typeof cwd === 'string' && fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

// PowerShell single-quoted strings are fully literal (no variable/command expansion) —
// doubling an embedded quote is the standard safe escape. This is what keeps every
// spawn below immune to injection via sessionId/cwd/name/model/effort.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Spawning powershell.exe directly is a known-flaky way to get a new console window
// on Windows — it can silently inherit the parent's console state instead of opening
// one. Start-Process reliably allocates a genuine new window regardless of the
// parent's own console, so the outer call launches a short-lived bootstrap
// PowerShell whose only job is to hand off to Start-Process; -ArgumentList is a
// literal array, so nesting psQuote once more for the inner command is the correct,
// safe way to pass it through this second layer (still fully literal, no shell
// metacharacter risk at either layer). Kept only as the fallback for machines
// without Windows Terminal — see launchInTerminal below for the primary path.
function launchPowerShell(command, cwd) {
  const outer = `Start-Process -FilePath powershell.exe -ArgumentList @('-NoExit','-Command',${psQuote(command)}) -WorkingDirectory ${psQuote(cwd)}`;
  spawn('powershell.exe', ['-NoProfile', '-Command', outer], {
    cwd,
    env: CLAUDE_ENV,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

// Adds a new tab to the most-recently-used Windows Terminal window (`-w 0 nt`)
// rather than opening a brand-new window. This is a per-argv-element spawn (no
// PowerShell layer, so no shell-escaping concerns), which wt.exe itself
// reassembles into the child command line — `command` (built with psQuote above,
// e.g. containing 'sessionId' literals) passes through untouched since Windows'
// argv quoting only escapes double quotes, not single ones.
//
// This isn't just a UX choice: a window opened this way is adopted by the
// already-running, independent Windows Terminal process, so it survives even
// when this Node process itself is a short-lived or sandboxed one — verified by
// testing that a plain Start-Process-spawned window (the old approach below)
// gets killed within ~10s in a sandboxed session, while a wt.exe new-tab window
// targeting an existing Windows Terminal instance does not.
function launchInTerminal(command, cwd) {
  const child = spawn(
    'wt.exe',
    ['-w', '0', 'nt', '-d', cwd, 'powershell.exe', '-NoExit', '-Command', command],
    { env: CLAUDE_ENV, detached: true, stdio: 'ignore' }
  );
  child.on('error', () => launchPowerShell(command, cwd));
  child.unref();
}

function claudeArgsForNewSession({ name, model, effort }) {
  const parts = [];
  if (name) parts.push(`-n ${psQuote(name)}`);
  if (model) parts.push(`--model ${psQuote(model)}`);
  if (effort) parts.push(`--effort ${psQuote(effort)}`);
  return parts.join(' ');
}

function resume(sessionId, cwd) {
  if (!isValidSessionId(sessionId)) throw new Error('invalid sessionId');
  if (!isValidCwd(cwd)) throw new Error('cwd no longer exists');
  launchInTerminal(`claude --resume ${psQuote(sessionId)}`, cwd);
}

function fork(sessionId, cwd) {
  if (!isValidSessionId(sessionId)) throw new Error('invalid sessionId');
  if (!isValidCwd(cwd)) throw new Error('cwd no longer exists');
  launchInTerminal(`claude --resume ${psQuote(sessionId)} --fork-session`, cwd);
}

function continueLatest(cwd) {
  if (!isValidCwd(cwd)) throw new Error('cwd no longer exists');
  launchInTerminal('claude -c', cwd);
}

// Best-effort — see src/ps/focus-window.ps1 for why this can silently fail
// (Windows' foreground-lock restriction on background processes).
function focusWindow(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve({ ok: false, result: 'invalid-pid' });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', FOCUS_SCRIPT_PATH, '-TargetPid', String(pid)],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, result: err.message });
          return;
        }
        const result = stdout.trim();
        resolve({ ok: result === 'focused' || result === 'focused-terminal-fallback', result });
      }
    );
  });
}

function newSession(cwd, { name, model, effort } = {}) {
  if (!isValidCwd(cwd)) throw new Error('folder does not exist');
  const args = claudeArgsForNewSession({ name, model, effort });
  launchInTerminal(`claude ${args}`.trim(), cwd);
}

// Plain, human-readable command text for the "copy command" fallback — the user
// pastes this into their own terminal, so no PowerShell escaping here, just quoting
// for readability when a value contains spaces.
function displayQuote(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function commandTextResume(sessionId) {
  return `claude --resume ${sessionId}`;
}

function commandTextFork(sessionId) {
  return `claude --resume ${sessionId} --fork-session`;
}

function commandTextContinue() {
  return 'claude -c';
}

function commandTextNewSession({ name, model, effort }) {
  const parts = ['claude'];
  if (name) parts.push('-n', displayQuote(name));
  if (model) parts.push('--model', displayQuote(model));
  if (effort) parts.push('--effort', displayQuote(effort));
  return parts.join(' ');
}

module.exports = {
  isValidSessionId,
  isValidCwd,
  resume,
  fork,
  continueLatest,
  focusWindow,
  newSession,
  commandTextResume,
  commandTextFork,
  commandTextContinue,
  commandTextNewSession,
};
