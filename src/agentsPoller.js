const { exec } = require('child_process');

// The command is a fixed, argument-free string (no user input reaches it), so
// exec's shell invocation is safe here and also resolves the `claude.cmd` shim
// that npm installs on Windows without needing execFile+shell:true (which Node
// warns against for arg-array invocations).
function runAgentsCommand() {
  return new Promise((resolve) => {
    exec(
      'claude agents --json --all',
      { windowsHide: true, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: err.message, entries: [] });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) {
            resolve({ ok: false, error: 'unexpected output shape (not an array)', entries: [] });
            return;
          }
          // Parse defensively: keep only entries with a usable sessionId, ignore unknown fields.
          const entries = parsed
            .filter((e) => e && typeof e.sessionId === 'string')
            .map((e) => ({
              pid: typeof e.pid === 'number' ? e.pid : null,
              cwd: typeof e.cwd === 'string' ? e.cwd : null,
              kind: typeof e.kind === 'string' ? e.kind : null,
              startedAt: typeof e.startedAt === 'number' ? e.startedAt : null,
              sessionId: e.sessionId,
              name: typeof e.name === 'string' ? e.name : null,
              status: typeof e.status === 'string' ? e.status : null,
            }));
          resolve({ ok: true, error: null, entries });
        } catch (parseErr) {
          resolve({ ok: false, error: `failed to parse agents JSON: ${parseErr.message}`, entries: [] });
        }
      }
    );
  });
}

function diffLiveMaps(prevMap, nextMap) {
  const changed = new Set();
  for (const id of nextMap.keys()) {
    const prev = prevMap.get(id);
    const next = nextMap.get(id);
    if (!prev || prev.status !== next.status || prev.pid !== next.pid) changed.add(id);
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) changed.add(id);
  }
  return changed;
}

function createAgentsPoller({ intervalMs, onUpdate }) {
  let prevMap = new Map();
  let timer = null;

  async function tick() {
    const result = await runAgentsCommand();
    const nextMap = new Map(result.entries.map((e) => [e.sessionId, e]));
    const changed = diffLiveMaps(prevMap, nextMap);
    prevMap = nextMap;
    onUpdate({ ok: result.ok, error: result.error, liveMap: nextMap, changedSessionIds: changed });
  }

  function start() {
    tick();
    timer = setInterval(tick, intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function getLiveMap() {
    return prevMap;
  }

  return { start, stop, getLiveMap };
}

module.exports = { createAgentsPoller, runAgentsCommand };
