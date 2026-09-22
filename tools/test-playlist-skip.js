// Regression test for the Round 76 playlist skip.
//
// Requested as "when downloading a playlist it should bypass tracks already
// downloaded". They were not actually being re-downloaded - /download's
// persistent guard has refused them since Round 60 - but it refuses them as
// ERRORS: one SSE stream opened and one red failed row per track. Queue a
// 60-track playlist you mostly own and you get ~50 failures to scroll past,
// which reads like the grab broke rather than like it correctly did nothing.
//
// The fix moves the decision to playlist-expansion time in /info, so owned
// tracks never enter the queue at all. /download's guard stays exactly as it
// was - it is the backstop for anything that slips through (a track finishing
// between expansion and dequeue, an old client that ignores the new flag).
'use strict';
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── Server: flag owned entries during playlist expansion ──
check('Round 76: /info marks playlist entries already held in History',
  /alreadyHave: ownedIds\.has\(e\.id\)/.test(server));
check('Round 76: ownership is matched by VIDEO ID, not raw URL string (share and tracking-suffixed links for one video all differ as text)',
  /const vid = extractVideoId\(r\.youtube_url\)/.test(server));
check('Round 76: the lookup is scoped to the requested format (owning an mp3 does not make a wav request a duplicate)',
  /FROM history WHERE format = \?', \[plFmt\]/.test(server));
check('Round 76: a track is only "already had" if the file is still on disk - a deleted or moved file is the only copy, not a duplicate',
  /if \(fs\.existsSync\(r\.file_path\)\) ownedIds\.add\(vid\)/.test(server));
check('Round 76: the format comes from the request, falling back to the saved pref for older clients',
  /req\.query\.format \|\| getPref\('format'\)/.test(server));
check('Round 76: a failed lookup is non-fatal - /download\'s own guard still backstops it',
  /owned-track lookup failed \(non-fatal\)/.test(server));
check('Round 76: the response carries a count so the client can summarise it',
  /alreadyHaveCount/.test(server));

// The backstop must NOT have been removed in the process.
check('sanity: /download\'s persistent history guard is still in place as the backstop',
  /code: 'duplicate_history'/.test(server));

// ── Client: actually skip them, and count them separately ──
check('Round 76: the client skips entries flagged alreadyHave',
  /if \(e\.alreadyHave\) \{ owned\+\+; continue; \}/.test(app));
check('Round 76: already-owned is counted separately from already-in-queue (they mean different things)',
  /let added = 0, skipped = 0, owned = 0;/.test(app));
check('Round 76: the client sends the format with /info so the server checks the right one',
  /\/info\?url=' \+ encodeURIComponent\(url\) \+[\s\S]{0,120}format=/.test(app));

// A playlist where everything was already owned is a success, not a failure.
check('Round 76: a playlist with nothing left to do reports success rather than an error',
  /const nothingToDo = added === 0 && \(owned > 0 \|\| skipped > 0\)/.test(app));
check('Round 76: the summary distinguishes the two skip reasons',
  /plAlreadyHave/.test(app) && /plSkipped/.test(app));

// ── Strings exist in both shipped languages ──
for (const lang of ['already downloaded', 'déjà téléchargées']) {
  check('Round 76: plAlreadyHave is translated (' + lang + ')',
    app.includes("plAlreadyHave:'" + lang + "'"));
}

console.log('');
if (fails) { console.log(`✗ ${fails} playlist-skip check(s) failed`); process.exit(1); }
console.log('✓ playlist-skip: all checks passed');
