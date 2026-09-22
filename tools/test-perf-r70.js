// Regression tests for the Round 70 performance pass, filed against a
// direct report ("app feels slow and sluggy") from a user whose library
// screenshot showed 1849 tracks.
//
// These are static source guards rather than live benchmarks, for the
// same reason Round 59/68 used them: the costs here are Electron
// renderer costs (DOM, fetch, paint) and there is no headless browser in
// this environment to drive them end to end. What CAN be pinned down
// exactly - and what actually regressed before - is whether the specific
// wasteful patterns are still gone from the shipped source.
//
// The three fixes, all measured before being made:
//   1. The DB had NO indexes at all - every lookup a full table scan,
//      on hot paths (watch-folder per-file check, download dedup guard,
//      per-track tag strip).
//   2. /history shipped audio_hash - a 128-char hex string per row that
//      the renderer never reads (zero references in renderer/ and
//      extension/, checked directly). ~0.25 MB of a ~1.25 MB payload,
//      refetched from 30 call sites.
//   3. openMiniNotepad() downloaded the ENTIRE history list and .find()'d
//      one row, to read one short text field, when /history/:id/full
//      already existed for exactly that.
'use strict';
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. DB indexes exist on the columns that are actually queried ──
const idxBlockStart = serverSrc.indexOf('// ─── BEGIN DB INDEXES ───');
const idxBlockEnd = serverSrc.indexOf('// ─── END DB INDEXES ───');
check('Round 70: the DB index block is present in server.js',
  idxBlockStart !== -1 && idxBlockEnd > idxBlockStart);

const idxBlock = idxBlockStart !== -1 ? serverSrc.slice(idxBlockStart, idxBlockEnd) : '';
for (const [label, target] of [
  ['history.file_path (watch-folder known-path check, 8 queries)', 'history(file_path)'],
  ['history.created_at (9 ORDER BY sites, incl. the main list)',   'history(created_at)'],
  ['history.youtube_url (download duplicate guard)',               'history(youtube_url)'],
  ['history.audio_hash (duplicate grouping / library doctor)',     'history(audio_hash)'],
  ['stockpile_tags.history_id (9 queries, incl. the tag strip)',   'stockpile_tags(history_id)'],
  ['stockpile_tags.folder_id (folder filtering)',                  'stockpile_tags(folder_id)'],
]) {
  check('Round 70: an index is created on ' + label, idxBlock.includes(target), 'looking for ' + target);
}
check('Round 70: indexes use IF NOT EXISTS (safe to re-run on every launch)',
  idxBlock.includes('CREATE INDEX IF NOT EXISTS'));
check('Round 70: each index creation is individually guarded so one failure cannot gate the rest',
  /try\s*\{[\s\S]*?db\.run\('CREATE INDEX IF NOT EXISTS '[\s\S]*?\}\s*catch\s*\(/.test(idxBlock));
// `id` is already the PRIMARY KEY - indexing it again would be dead weight.
check('Round 70: no redundant index on history(id) - it is already the PRIMARY KEY',
  !idxBlock.includes('history(id)'));

// ── 2. The list payload no longer carries audio_hash ──
const colsMatch = serverSrc.match(/const HISTORY_LIST_COLUMNS =\s*([\s\S]*?);/);
check('HISTORY_LIST_COLUMNS is still defined', !!colsMatch);
if (colsMatch) {
  const cols = colsMatch[1];
  check('Round 70: audio_hash is no longer shipped in the /history list payload',
    !/\baudio_hash\b/.test(cols), 'columns=' + cols.replace(/\s+/g, ' ').trim());
  // ...but the columns the list genuinely renders must all still be there.
  for (const needed of ['id', 'title', 'channel', 'file_path', 'format', 'duration',
                        'bpm', 'key_note', 'key_mode', 'thumbnail', 'created_at',
                        'is_favorite', 'user_notes']) {
    check('Round 70: the list payload still includes ' + needed + ' (the renderer uses it)',
      new RegExp('\\b' + needed + '\\b').test(cols));
  }
}
// The renderer must genuinely not want audio_hash - this is the check that
// makes dropping it safe, and would catch someone starting to use it later.
check('sanity: the renderer still makes zero use of audio_hash (what makes dropping it safe)',
  !/\baudio_hash\b/.test(appSrc));
// Server-side consumers must keep working - they read it straight from the DB.
check('Round 70: server-side duplicate detection still reads audio_hash from the DB',
  /audio_hash/.test(serverSrc.slice(idxBlockEnd)));
check('Round 70: /history/:id/full still exists to serve every column when one row is opened',
  serverSrc.includes("app.get('/history/:id/full'"));

// ── 3. The mini notepad fetches one row, not the whole library ──
check('Round 70: openMiniNotepad fetches the single row via /history/:id/full',
  appSrc.includes("fetch(API + '/history/' + historyId + '/full')"));
check('Round 70: openMiniNotepad no longer downloads the whole list and .find()s one row',
  !/const all = await r\.json\(\);\s*const row = all\.find\(h => h\.id === historyId\);/.test(appSrc));

// ── 4. The perf instrumentation is wired so the next report comes with numbers ──
check('Round 70: loadHistory records a perf entry (rows, payload, fetch/render split, DOM nodes)',
  appSrc.includes('_perfNote(') && /payloadKB/.test(appSrc) && /renderMs/.test(appSrc) && /domNodes/.test(appSrc));
check('Round 70: perf history is capped so it cannot grow unbounded over a long session',
  /p\.history\.length > 50/.test(appSrc));
check('Round 70: render timing is taken inside a rAF (renderHistory is rAF-coalesced, so a synchronous number would be misleading)',
  /requestAnimationFrame\(\(\) => \{[\s\S]{0,600}renderMs/.test(appSrc));
check('Round 70: only genuinely slow refreshes are written to the diagnostic log (a fast one is noise)',
  /entry\.totalMs > 250/.test(appSrc));

// ── 5. Shuffle "follow/anchor" off-by-one ──
// Reported: "in history when on shuffle the anchor (following) option
// doesn't follow - it goes to the track you just played when you skip it,
// making it always one step late."
//
// Root cause: globalPlayerNext/Prev kicked off loadFromHistory() (async -
// it awaits a disk read before loadAudioBuffer() assigns currentHistId)
// and then scrolled from inside a bare requestAnimationFrame. The frame
// lands ~16ms later; the read does not. So the scroll helper read the
// PREVIOUS track's id every time. Invisible in sequential play (the stale
// row is the neighbour, usually still inside the no-scroll comfort band),
// glaring on shuffle (the stale row is far away and off-screen).
check('Round 70: the scroll helper accepts an explicit target id (no longer depends only on racy global state)',
  /function _scrollActiveRowIntoView\(explicitId\)/.test(appSrc));
check('Round 70: the explicit id takes priority, with the old globals kept only as a fallback',
  /let id = explicitId \|\| null;[\s\S]{0,240}if \(!id\) \{[\s\S]{0,240}currentHistId/.test(appSrc));

// The actual off-by-one: the async load must be awaited before scrolling.
check('Round 70: mirror-mode NEXT awaits the async load before following',
  /await loadFromHistory\(nextTrack\.id, \{ skipTabSwitch: true \}\)/.test(appSrc));
check('Round 70: mirror-mode PREV awaits the async load before following',
  /await loadFromHistory\(prevTrack\.id, \{ skipTabSwitch: true \}\)/.test(appSrc));
check('Round 70: mirror-mode NEXT follows the track it navigated TO, by explicit id',
  appSrc.includes('_scrollActiveRowIntoView(nextTrack.id)'));
check('Round 70: mirror-mode PREV follows the track it navigated TO, by explicit id',
  appSrc.includes('_scrollActiveRowIntoView(prevTrack.id)'));

// The specific broken pattern must be gone: a bare rAF wrapping the helper
// with no argument is exactly what produced the stale read.
check('Round 70: no caller still scrolls from a bare requestAnimationFrame with no target id (the original bug shape)',
  !/requestAnimationFrame\(_scrollActiveRowIntoView\)/.test(appSrc));

// Both navigation entry points must be async now, or the awaits above are
// a syntax error rather than a fix.
check('Round 70: globalPlayerNext is async (required for the await above)',
  /async function globalPlayerNext\(\)/.test(appSrc));
check('Round 70: globalPlayerPrev is async (required for the await above)',
  /async function globalPlayerPrev\(\)/.test(appSrc));

// A failed load should not scroll to a track that never loaded.
check('Round 70: a load failure skips the follow instead of scrolling to a track that never loaded',
  /catch \(e\) \{ return; \}\s*_scrollActiveRowIntoView\(nextTrack\.id\)/.test(appSrc));

// Second, separate bug found while fixing the first.
check('Round 70: the legacy (non-mirror) NEXT path now follows too - it previously had no follow call at all while PREV did',
  /playTrack\(nextTrack, \{ \.\.\.ctx, index: nextIdx \}\);\s*(\/\/[^\n]*\n\s*)*_scrollActiveRowIntoView\(nextTrack && nextTrack\.id\)/.test(appSrc));

console.log('');
if (fails) { console.log(`✗ ${fails} perf-r70 check(s) failed`); process.exit(1); }
console.log('✓ perf-r70: all checks passed');
