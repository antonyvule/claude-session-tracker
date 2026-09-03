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

function snippetFromLine(rawLine) {
  try {
    const parsed = JSON.parse(rawLine);
    if (parsed && parsed.message && parsed.message.content !== undefined) {
      const text = extractText(parsed.message.content);
      if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 240);
    }
  } catch {
    // not a clean single-line JSON object (or match spans a differently-shaped entry) — fall back to raw
  }
  return rawLine.trim().slice(0, 240);
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
      ['-n', '--no-heading', '-i', '-m', '200', '--', query, PROJECTS_DIR],
      { windowsHide: true, timeout: 15000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1) {
          // rg exits 1 for "no matches", which is not a failure
          resolve({ ok: false, error: err.message, results: [] });
          return;
        }
        const lines = (stdout || '').split('\n').filter((l) => l.trim());
        const results = lines.slice(0, 200).map((line) => {
          const match = line.match(/^(.*?):(\d+):(.*)$/);
          if (!match) return null;
          const [, filePath, lineNo, content] = match;
          return {
            sessionId: path.basename(filePath, '.jsonl'),
            line: Number(lineNo),
            snippet: snippetFromLine(content),
          };
        }).filter(Boolean);
        resolve({ ok: true, error: null, results });
      }
    );
  });
}

module.exports = { checkRipgrepAvailable, searchTranscripts };
