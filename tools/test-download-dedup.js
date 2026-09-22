// Headless regression test for extractVideoId() - the video-ID
// normalization every duplicate-download guard in server.js relies on.
// Added Round 60 while investigating a "same track downloads over and
// over, survives an app restart" report - found this function only
// recognized ?v= and youtu.be/ URL forms, silently falling back to
// comparing the FULL RAW URL string for every other shape (Shorts,
// embed, live), which defeats deduplication for those forms.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN YTDLP VIDEO ID EXTRACT ───');
const ei = src.indexOf('// ─── END YTDLP VIDEO ID EXTRACT ───');
if (si === -1 || ei === -1) throw new Error('extractVideoId markers not found in server.js');
const core = src.slice(si, ei);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { extractVideoId };', sandbox);
const { extractVideoId } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const ID = 'dQw4w9WgXcQ';

// ── Recognized URL shapes all resolve to the same ID ──
const forms = {
  'standard watch': `https://www.youtube.com/watch?v=${ID}`,
  'watch with extra params before v': `https://www.youtube.com/watch?feature=share&v=${ID}&t=45s`,
  'youtu.be short link': `https://youtu.be/${ID}`,
  'youtu.be with query': `https://youtu.be/${ID}?t=12`,
  'shorts': `https://www.youtube.com/shorts/${ID}`,
  'shorts with query': `https://www.youtube.com/shorts/${ID}?feature=share`,
  'embed': `https://www.youtube.com/embed/${ID}`,
  'live': `https://www.youtube.com/live/${ID}`,
  'legacy /v/': `https://www.youtube.com/v/${ID}`,
};
for (const [label, url] of Object.entries(forms)) {
  check(`extractVideoId recognizes "${label}" and returns the bare video ID`,
    extractVideoId(url) === ID, `url="${url}" -> "${extractVideoId(url)}"`);
}

// ── The whole point: two URLs for the SAME video, differing only in
// tracking/share-suffix noise, must normalize to the identical ID so
// the duplicate guards actually catch them as the same video. ──
{
  const a = extractVideoId(`https://www.youtube.com/shorts/${ID}`);
  const b = extractVideoId(`https://www.youtube.com/shorts/${ID}?feature=share&si=abc123`);
  check('two Shorts links to the same video (with/without a share suffix) normalize identically',
    a === b && a === ID, `a="${a}" b="${b}"`);
}
{
  const a = extractVideoId(`https://www.youtube.com/watch?v=${ID}`);
  const b = extractVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLxyz&index=3`);
  check('a bare watch link and the same link with playlist context normalize identically',
    a === b && a === ID, `a="${a}" b="${b}"`);
}

// ── Genuinely unrecognized shapes still fall back to the raw string
// (not a crash, not silently returning something misleading) - and two
// DIFFERENT unrecognized URLs correctly do NOT collide. ──
{
  const weird = 'https://example.com/not-a-youtube-link';
  check('a non-YouTube URL falls back to the raw string unmodified',
    extractVideoId(weird) === weird, `got "${extractVideoId(weird)}"`);
}
{
  const a = extractVideoId('https://example.com/a');
  const b = extractVideoId('https://example.com/b');
  check('two different unrecognized URLs do not collide on the same fallback value', a !== b);
}
{
  check('empty/missing input does not throw', extractVideoId('') === '' && extractVideoId(undefined) === '');
}

console.log('');
if (fails) { console.log(`✗ ${fails} download-dedup check(s) failed`); process.exit(1); }
console.log('✓ download-dedup: all checks passed');
