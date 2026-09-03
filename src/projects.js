const path = require('path');

// Canonical grouping key for "same project" regardless of case/separator differences
// across the live agents roster and historical transcripts.
function canonicalProjectKey(cwd) {
  return cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Claude Code's own slug algorithm (one-way: cwd -> slug). Never invert this —
// folder names can contain literal dashes, so slug -> cwd is ambiguous. The real
// cwd is always read from the source data (agents roster or transcript content),
// never reconstructed from the slug.
function cwdToSlug(cwd) {
  return cwd.replace(/[/\\:]/g, '-');
}

function displayNameFromCwd(cwd) {
  return path.basename(cwd.replace(/\\+$/, '')) || cwd;
}

module.exports = { canonicalProjectKey, cwdToSlug, displayNameFromCwd };
