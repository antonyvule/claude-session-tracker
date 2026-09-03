// Canonical grouping key for "same project" regardless of case/separator differences
// across the live agents roster and historical transcripts.
function canonicalProjectKey(cwd) {
  return cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

module.exports = { canonicalProjectKey };
