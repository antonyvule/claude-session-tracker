const path = require('path');
const { execFile } = require('child_process');
const { PROJECTS_DIR, extractText } = require('./historyScanner');

let ripgrepAvailable = null;

function checkRipgrepAvailable() {
  if (ripgrepAvailable !== null) return Promise.resolve(ripgrepAvailable);
  return new Promise((resolve) => {
    execFile('rg', ['--version'], { windowsHide: true, timeout: 5000 }, (err) => {
      ripgrepAvailable = !err;
      resolve(ripgrepAvailable);
    });
  });
}

// Returns null (not a raw-JSON fallback) when the matched line isn't real
// conversational text — a tool_result payload, queue-operation metadata, etc.
// Those matches get dropped entirely rather than shown as unreadable JSON dumps.
function snippetFromLine(rawLine) {
  try {
    const parsed = JSON.parse(rawLine);
    if (!parsed || !parsed.message || parsed.message.content === undefined) return null;
    const text = extractText(parsed.message.content);
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch {
    return null;
  }
}

// Query reaches ripgrep as a single argv element (execFile, no shell) — never
// interpolated into a shell string — so it cannot break out into another command.
async function searchTranscripts(query) {
  const available = await checkRipgrepAvailable();
  if (!available) {
    return { ok: false, error: 'ripgrep (rg) is not installed or not on PATH', results: [] };
  }
  return new Promise((resolve) => {
    execFile(
      'rg',
      // -m 5: cap at 5 matching lines *per file* — ripgrep stops scanning a file
      // early once it hits this, which is a real performance win on large
      // transcripts, not just a display choice. 5 (not 1) gives the noise filter
      // below a few chances to find a real conversational line before this
      // session's matches are exhausted — a session whose only hits are early
      // tool-result lines would otherwise be silently dropped entirely.
      ['-n', '--no-heading', '-i', '-m', '5', '--glob', '!**/subagents/**', '--', query, PROJECTS_DIR],
      { windowsHide: true, timeout: 15000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1) {
          // rg exits 1 for "no matches", which is not a failure
          resolve({ ok: false, error: err.message, results: [] });
          return;
        }
        const lines = (stdout || '').split('\n').filter((l) => l.trim());
        const matches = lines.slice(0, 400).map((line) => {
          const match = line.match(/^(.*?):(\d+):(.*)$/);
          if (!match) return null;
          const [, filePath, lineNo, content] = match;
          const snippet = snippetFromLine(content);
          if (!snippet) return null;
          return { sessionId: path.basename(filePath, '.jsonl'), line: Number(lineNo), snippet };
        }).filter(Boolean);

        // One result per session — multiple matching lines in the same session
        // add no value here since selecting a result just opens that session's
        // transcript (scrolled to the latest messages, not the matched line).
        const seen = new Set();
        const results = [];
        for (const m of matches) {
          if (seen.has(m.sessionId)) continue;
          seen.add(m.sessionId);
          results.push(m);
        }
        resolve({ ok: true, error: null, results });
      }
    );
  });
}

module.exports = { checkRipgrepAvailable, searchTranscripts };
