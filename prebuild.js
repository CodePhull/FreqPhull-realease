#!/usr/bin/env node
// Freq.Phull pre-build check
// Verifies that bin/ contains the required binaries before electron-builder runs.
// If anything's missing or suspiciously small, the build fails LOUDLY with a clear
// message and a "run Download-Binaries.bat" hint — instead of silently shipping
// a broken installer.

const fs = require('fs');
const path = require('path');

const REQUIRED = [
  // name, minSizeBytes — sizes are conservative lower bounds; real files are larger
  { name: 'yt-dlp.exe',  minSize: 5 * 1024 * 1024 },   // ~12MB typical
  { name: 'ffmpeg.exe',  minSize: 30 * 1024 * 1024 },  // ~80MB typical
  { name: 'ffprobe.exe', minSize: 30 * 1024 * 1024 },  // ~80MB typical
];

const projRoot = __dirname;
const binDir = path.join(projRoot, 'bin');

function fail(msg) {
  console.error('\n\x1b[31m========================================\x1b[0m');
  console.error('\x1b[31m  BUILD ABORTED — pre-build check failed\x1b[0m');
  console.error('\x1b[31m========================================\x1b[0m');
  console.error(msg);
  console.error('\n\x1b[33mFix: run \x1b[1mDownload-Binaries.bat\x1b[0m\x1b[33m, then rebuild.\x1b[0m');
  console.error('     If yt-dlp.exe is already old, delete it first to force re-download.\n');
  process.exit(1);
}

function ok(msg) { console.log('\x1b[32m  OK  ' + msg + '\x1b[0m'); }

console.log('\n== Freq.Phull pre-build check ==');
console.log('Project root: ' + projRoot);
console.log('Checking bin/ ...\n');

// Check the bin directory exists
if (!fs.existsSync(binDir)) {
  fail('bin/ directory does not exist.');
}

// Check each required binary
const issues = [];
for (const req of REQUIRED) {
  const full = path.join(binDir, req.name);
  if (!fs.existsSync(full)) {
    issues.push(`MISSING: bin/${req.name}`);
    continue;
  }
  const stat = fs.statSync(full);
  if (stat.size < req.minSize) {
    const actualMB = Math.round(stat.size / 1024 / 1024);
    const minMB = Math.round(req.minSize / 1024 / 1024);
    issues.push(`TOO SMALL: bin/${req.name} is ${actualMB}MB (expected at least ${minMB}MB) — file may be corrupted or a partial download.`);
    continue;
  }
  ok(`bin/${req.name}  (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
}

if (issues.length) {
  fail('\n  ' + issues.join('\n  '));
}

// Also check stems.py, analyze.py, setup-engines.ps1, and key_model.pkl.
// key_model.pkl is REQUIRED — it's the trained MLP that drives the primary
// path of detect_key() in analyze.py. Without it, detection falls back to
// the algorithmic Krumhansl voting, which is functional but lower accuracy
// on edge cases. Cynphull has decided accuracy is non-negotiable, so
// the file ships in every patch zip going forward and the build aborts if
// it's missing.
const aux = [
  { path: 'stems.py', minSize: 1024 },
  { path: 'analyze.py', minSize: 1024 },
  { path: path.join('installer', 'setup-engines.ps1'), minSize: 1024 },
  { path: 'key_model.pkl', minSize: 100 * 1024 },  // ~4.6MB typical, must not be a placeholder
];
for (const a of aux) {
  const full = path.join(projRoot, a.path);
  if (!fs.existsSync(full)) {
    issues.push(`MISSING: ${a.path}`);
    continue;
  }
  const stat = fs.statSync(full);
  if (stat.size < a.minSize) {
    issues.push(`TOO SMALL: ${a.path} (${(stat.size/1024).toFixed(1)}KB) — likely a placeholder; needs the real trained model`);
    continue;
  }
  ok(`${a.path}  (${(stat.size / 1024).toFixed(1)}KB)`);
}

if (issues.length) {
  fail('\n  ' + issues.join('\n  '));
}

// ── Generate integrity manifest ─────────────────────────────────────────────
// SHA-256 every protected file and write manifest.sha256.json. The runtime
// reads this on startup; mismatches make the engines refuse to load.
const crypto = require('crypto');
const integrity = require('./integrity.js');

const manifest = {
  version: 2,
  generated: new Date().toISOString(),
  files: {},
};

for (const rel of integrity.PROTECTED_FILES) {
  const full = path.join(projRoot, rel);
  if (!fs.existsSync(full)) {
    issues.push(`integrity: protected file missing: ${rel}`);
    continue;
  }
  const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  manifest.files[rel] = h;
  ok(`integrity: ${rel}  ${h.slice(0, 12)}…`);
}

if (issues.length) {
  fail('\n  ' + issues.join('\n  '));
}

const manifestPath = path.join(projRoot, 'manifest.sha256.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
ok(`integrity: wrote manifest.sha256.json`);

console.log('\n\x1b[32mAll pre-build checks passed. Starting electron-builder...\x1b[0m\n');
