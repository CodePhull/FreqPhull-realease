// Freq.Phull integrity verification
// Copyright © Cynphull · Hood Knights — all rights reserved.
//
// Verifies that critical app files match the SHA-256 hashes recorded at
// build time. Tampered or modified files cause the engine layer to refuse
// to start, but the rest of the app keeps running so the user has an
// avenue to seek support or reinstall.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Files to verify on startup. These are the files that would matter most
// if modified — engine entry points, server routing, model registry.
// The list is not exhaustive: a determined attacker can edit anything not
// on it. The intent here is to catch casual modifications and to make
// silent tampering visible.
const PROTECTED_FILES = [
  'server.js',
  'main.js',
  'preload.js',
  'stems.py',
  'analyze.py',
  '_phull_internal.py',
];

// Build manifest path. Created by build/sign-manifest.js during npm prebuild.
// In a packaged app this lives at <RES>/manifest.sha256.json.
function locateManifest(resourcesDir) {
  const candidates = [
    path.join(resourcesDir || '', 'manifest.sha256.json'),
    path.join(__dirname, 'manifest.sha256.json'),
    path.join(__dirname, '..', 'manifest.sha256.json'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function sha256OfFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// Returns { ok, status, mismatches }.
// status: 'ok' | 'missing-manifest' | 'tampered' | 'missing-files'
//
// 'missing-manifest' is treated as soft-failure (we log it but don't refuse
// to run) because dev builds and unsigned community builds may legitimately
// not have one. The setup gate consumes the status field and decides how
// to react.
// Files in package.json's asarUnpack live OUTSIDE the asar at runtime, in
// a sibling directory `app.asar.unpacked/`. Hashing them through __dirname
// (which is inside the asar) finds nothing or finds the wrong content.
// We resolve unpacked files to their real on-disk location before hashing.
const UNPACKED_FILES = new Set(['stems.py', 'analyze.py', '_phull_internal.py']);

function resolveProtectedPath(baseDir, rel) {
  // baseDir for a packaged build is .../resources/app.asar (a virtual path
  // that maps inside the asar archive). For unpacked files we have to find
  // them in their REAL on-disk location, which electron-builder places in
  // a sibling app.asar.unpacked directory.
  //
  // Different electron-builder configs / Electron versions resolve this in
  // subtly different ways, so try every layout we've seen in the wild and
  // accept the first one that exists. Without this, "Serving file" works
  // fine at runtime (because server.js opens files via require/fs from
  // its own asar location which Electron transparently maps), but the
  // integrity check via direct fs.existsSync on the virtual asar path
  // would fail — and we'd report a false positive missing-files.
  if (UNPACKED_FILES.has(rel)) {
    const candidates = [];
    // 1. Standard electron-builder layout: app.asar → app.asar.unpacked sibling
    candidates.push(path.join(baseDir.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'), rel));
    // 2. Some packagers put unpacked files directly in resources/
    const resourcesDir = baseDir.replace(/[\\/]app\.asar(?:\.unpacked)?$/, '');
    if (resourcesDir !== baseDir) {
      candidates.push(path.join(resourcesDir, 'app.asar.unpacked', rel));
      candidates.push(path.join(resourcesDir, rel));
    }
    // 3. Dev / unpacked build — file is just next to integrity.js
    candidates.push(path.join(baseDir, rel));
    candidates.push(path.join(__dirname, rel));
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Nothing found — return the most-likely path so the error message
    // points at where we expected it.
    return candidates[0];
  }
  return path.join(baseDir, rel);
}

function verifyIntegrity(baseDir, resourcesDir) {
  const manifestPath = locateManifest(resourcesDir);
  if (!manifestPath) {
    return { ok: true, status: 'missing-manifest', mismatches: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, status: 'tampered', mismatches: ['manifest.sha256.json: ' + e.message] };
  }
  const expected = manifest.files || {};
  const mismatches = [];
  const missing = [];
  for (const rel of PROTECTED_FILES) {
    const full = resolveProtectedPath(baseDir, rel);
    if (!fs.existsSync(full)) {
      missing.push(rel);
      continue;
    }
    const actual = sha256OfFile(full);
    const want = expected[rel];
    if (!want) continue;       // file not tracked in this manifest
    if (actual !== want) mismatches.push(rel + ': expected ' + want.slice(0,12) + '… got ' + (actual||'').slice(0,12) + '…');
  }
  if (mismatches.length) return { ok: false, status: 'tampered', mismatches };
  if (missing.length)    return { ok: false, status: 'missing-files', mismatches: missing.map(f => f + ': not found') };
  return { ok: true, status: 'ok', mismatches: [] };
}

module.exports = { verifyIntegrity, sha256OfFile, PROTECTED_FILES, resolveProtectedPath };
