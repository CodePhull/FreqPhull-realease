// Headless regression test for isFileKnownToHistory() - the watch-folder
// daemon's "have we already adopted this file?" check in server.js.
//
// Added Round 64 after a user-pasted app log showed the SAME physical
// file - "(FREE) TIF x Zamdane Type Beat - Évasif [103BPM F].wav"
// (duration 155.2853514739229s, identical every time) - getting
// "adopted" as a brand-new history row NINE times in about three
// minutes (ids 3039-3047), each time re-running a full BPM/key analysis
// pass and re-stamping tags. Root cause: the known-path check compared
// full.toLowerCase() (proper Unicode-aware JS folding) against SQL's
// LOWER(file_path) - and sql.js's LOWER() (bare SQLite, no ICU
// extension) only folds ASCII, leaving the accented "É" in "Évasif"
// untouched. The two strings never compared equal, so the check always
// reported "unknown", and write_tags.py rewriting the file in place
// after every analysis re-fired the watcher on the same path, driving
// an unbounded adopt -> analyze -> tag-write -> re-trigger loop.
//
// The fix (isFileKnownToHistory in server.js, between the
// WATCH-FOLDER KNOWN-PATH CHECK markers) stopped relying on SQL's
// LOWER() entirely and folds case in JS on both sides. This test
// extracts that exact function from server.js (so it can't silently
// drift from what ships) and drives it against a stub dbAll() that
// faithfully reproduces real SQLite/sql.js's ASCII-only LOWER() - the
// same behavior confirmed directly against the actual sql.js package
// during the investigation - so a regression back to SQL-side folding
// would be caught here, not just in production.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN WATCH-FOLDER KNOWN-PATH CHECK ───');
const ei = src.indexOf('// ─── END WATCH-FOLDER KNOWN-PATH CHECK ───');
if (si === -1 || ei === -1) throw new Error('isFileKnownToHistory markers not found in server.js');
const core = src.slice(si, ei);

const sandbox = { process };
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { isFileKnownToHistory };', sandbox);
const { isFileKnownToHistory } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// SQLite's LOWER() (no ICU extension - what both better-sqlite3 and
// sql.js give you out of the box) only folds ASCII A-Z. Mirrors the
// real behavior confirmed against the actual sql.js package.
function sqliteAsciiLower(s) {
  return String(s).replace(/[A-Z]/g, c => c.toLowerCase());
}

// Minimal dbAll stub good enough to drive both the fixed implementation
// (a plain "WHERE file_path IS NOT NULL" fetch, folded in JS) and, if
// someone regresses back to it, the original buggy "LOWER(file_path)=?"
// SQL-side form - so this test exercises the real bug class either way.
function makeDbAll(rows) {
  return function dbAll(sql, params = []) {
    if (/LOWER\(file_path\)\s*=\s*\?/.test(sql)) {
      const target = params[0];
      return rows
        .filter(r => r.file_path != null && sqliteAsciiLower(r.file_path) === target)
        .map(() => ({ '1': 1 }));
    }
    if (/WHERE\s+file_path\s*=\s*\?/.test(sql)) {
      const target = params[0];
      return rows.filter(r => r.file_path === target).map(() => ({ '1': 1 }));
    }
    // "SELECT ... FROM history WHERE file_path IS NOT NULL" (both the
    // old id-count probe and the new fixed fetch-and-fold-in-JS form).
    return rows.filter(r => r.file_path != null);
  };
}

function withPlatform(platform, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { fn(); } finally { Object.defineProperty(process, 'platform', orig); }
}

// ── The exact real-evidence case: accented uppercase letter in the path ──
withPlatform('win32', () => {
  const p = 'D:\\Last dl early 2024\\Fr Type beat\\(FREE) TIF x Zamdane Type Beat - Évasif [103BPM F].wav';
  const dbAll = makeDbAll([{ id: 3039, file_path: p }]);
  check('Round 64: a path with an accented uppercase letter (the real "Évasif" evidence file) is recognized as already known',
    isFileKnownToHistory(dbAll, p) === true);
});

// ── Ordinary ASCII paths still work (no regression for the common case) ──
withPlatform('win32', () => {
  const p = 'D:\\stockpile\\Some Track - Name.wav';
  const dbAll = makeDbAll([{ id: 1, file_path: p }]);
  check('Round 64: a plain ASCII path is still recognized as known (no regression)',
    isFileKnownToHistory(dbAll, p) === true);
});

// ── Case differences (e.g. drive letter or extension case) still match on Windows ──
withPlatform('win32', () => {
  const stored = 'D:\\stockpile\\Some Track - Name.WAV';
  const incoming = 'd:\\stockpile\\some track - name.wav';
  const dbAll = makeDbAll([{ id: 1, file_path: stored }]);
  check('Round 64: case-only differences (drive letter, extension) on Windows still match',
    isFileKnownToHistory(dbAll, incoming) === true);
});

// ── A genuinely new/unknown file is NOT reported as known ──
withPlatform('win32', () => {
  const dbAll = makeDbAll([{ id: 1, file_path: 'D:\\stockpile\\Other Track.wav' }]);
  check('Round 64: a genuinely new file (different path) is correctly reported as unknown',
    isFileKnownToHistory(dbAll, 'D:\\stockpile\\Brand New Track.wav') === false);
});

// ── Non-Windows: exact byte-for-byte match required (no case-folding at all) ──
withPlatform('linux', () => {
  const p = '/home/user/stockpile/Évasif.wav';
  const dbAll = makeDbAll([{ id: 1, file_path: p }]);
  check('Round 64: on non-Windows platforms an identical path still matches',
    isFileKnownToHistory(dbAll, p) === true);
});

// ── The regression this test exists to catch: if the SQL-side LOWER()
// form were reintroduced, an accented-uppercase path would go back to
// comparing unequal and never register as known. Prove the stub's
// ASCII-only LOWER() actually behaves like real SQLite first ──
{
  const p = 'Évasif [103BPM F].wav';
  check('sanity: the ascii-only LOWER() stub leaves accented letters untouched (matches real sql.js, confirmed during investigation)',
    sqliteAsciiLower(p) === 'Évasif [103bpm f].wav', sqliteAsciiLower(p));
}

console.log('');
if (fails) { console.log(`✗ ${fails} watch-folder-dedup check(s) failed`); process.exit(1); }
console.log('✓ watch-folder-dedup: all checks passed');
