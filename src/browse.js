const fs = require('fs');
const path = require('path');
const os = require('os');

function allowedRoots(settings) {
  const roots = [...(settings.allowedBrowseRoots || []), os.homedir()];
  return roots.map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r);
    }
  });
}

function isWithinAllowedRoots(targetRealPath, roots) {
  const normalizedTarget = targetRealPath.toLowerCase();
  return roots.some((root) => {
    const normalizedRoot = root.toLowerCase();
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function listDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function browse(req, res, settings) {
  const roots = allowedRoots(settings);
  const requested = req.query.path;

  if (!requested) {
    res.json({ path: null, parent: null, entries: roots.map((r) => ({ name: r, path: r })) });
    return;
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(path.resolve(String(requested)));
  } catch {
    res.status(404).json({ entries: [], error: 'path not found' });
    return;
  }

  if (!isWithinAllowedRoots(realTarget, roots)) {
    res.status(403).json({ entries: [], error: 'path is outside allowed browse roots' });
    return;
  }

  try {
    const entries = listDir(realTarget);
    const parent = path.dirname(realTarget);
    res.json({
      path: realTarget,
      parent: isWithinAllowedRoots(parent, roots) ? parent : null,
      entries,
    });
  } catch (err) {
    res.json({ path: realTarget, parent: null, entries: [], error: err.message });
  }
}

module.exports = { browse };
