const { execFile } = require('child_process');

// In-memory only — this is a cache, not user data, so it doesn't belong in SQLite.
const cache = new Map(); // cwd -> branch name (or '' if not a repo / no branch)
const pending = new Map(); // cwd -> in-flight promise, to avoid duplicate concurrent lookups

function getCachedBranch(cwd) {
  return cache.get(cwd) ?? null;
}

function refreshBranch(cwd) {
  if (pending.has(cwd)) return pending.get(cwd);
  const p = new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'branch', '--show-current'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      pending.delete(cwd);
      const branch = err ? '' : stdout.trim();
      cache.set(cwd, branch);
      resolve(branch);
    });
  });
  pending.set(cwd, p);
  return p;
}

function invalidate(cwd) {
  cache.delete(cwd);
}

module.exports = { getCachedBranch, refreshBranch, invalidate };
