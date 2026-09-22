// Headless regression test for server.js's classifyYtdlpError() -
// extracted via the same BEGIN/END-marker + vm pattern used by the
// DSP-core tests, applied here to a non-audio subsystem for the first
// time this session (the yt-dlp error-classification/translation logic
// added in Round 56).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN YTDLP ERROR CLASSIFY ───');
const ei = src.indexOf('// ─── END YTDLP ERROR CLASSIFY ───');
if (si === -1 || ei === -1) throw new Error('classifyYtdlpError markers not found in server.js');
const core = src.slice(si, ei);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { classifyYtdlpError };', sandbox);
const { classifyYtdlpError } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    fails++;
    console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

// The exact raw stderr text from the reported bug (private YouTube
// video, real yt-dlp wording) - this is the literal case that used to
// leak straight to the UI unmodified.
const PRIVATE_VIDEO_STDERR =
  "ERROR: [youtube] wrniepiuv0o: Private video. Sign in if you've been granted access to this video. " +
  "Use --cookies-from-browser or --cookies for the authentication. See " +
  "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp for how to manually pass cookies. " +
  "Also see https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies for tips on effectively exporting YouTube cookies";

{
  const r = classifyYtdlpError(PRIVATE_VIDEO_STDERR, 1);
  check('private-video stderr is translated to a plain-language message, not echoed raw',
    r.msg === 'This video is private.', `got "${r.msg}"`);
  check('private-video translation never leaks yt-dlp CLI flags into the user-facing message',
    !/--cookies|--cookies-from-browser/.test(r.msg), `msg="${r.msg}"`);
  check('private-video result carries an actionable hint (not null)',
    typeof r.hint === 'string' && r.hint.length > 0);
  check('private-video is classified as fatal (no pointless 403/sig retry)',
    r.isFatal === true);
  check('private-video is not misclassified as a 403', r.is403 === false);
}

{
  const r = classifyYtdlpError('ERROR: [youtube] xxxxx: Video unavailable. This video has been removed by the uploader', 1);
  check('removed-video stderr gets the distinct "no longer available" message (not the private-video one)',
    r.msg === 'This video is no longer available (deleted or removed).', `got "${r.msg}"`);
}

{
  const r = classifyYtdlpError("ERROR: This video is a members-only video. Join this channel to get access to members-only content", 1);
  check('members-only stderr is translated', r.msg.includes('members-only'), `got "${r.msg}"`);
  check('members-only is fatal (not retried)', r.isFatal === true);
}

{
  const r = classifyYtdlpError('ERROR: [youtube] xxxxx: This video is not available in your country (geo restricted)', 1);
  check('geo-restricted stderr is translated', r.msg.includes('geo-restricted'), `got "${r.msg}"`);
}

{
  const r = classifyYtdlpError('ERROR: [youtube] xxxxx: Sign in to confirm your age. This video may be age restricted', 1);
  check('age-restricted stderr is translated', r.msg.includes('age-restricted'), `got "${r.msg}"`);
}

{
  const r = classifyYtdlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden', 1);
  check('HTTP 403 stderr is classified is403=true (drives the android-client retry)', r.is403 === true);
  check('HTTP 403 is not treated as fatal (retry should be attempted)', r.isFatal === false);
}

{
  const r = classifyYtdlpError('ERROR: nsig extraction failed: Some formats may be missing', 1);
  check('signature-extraction-broken stderr is classified isSigBroken=true', r.isSigBroken === true);
  check('sig-broken is not treated as fatal (retry should be attempted)', r.isFatal === false);
}

{
  // A completely unrecognized failure should fall through to the raw
  // stderr rather than the classifier inventing a category for it.
  const raw = 'ERROR: some totally new yt-dlp failure mode nobody has seen yet';
  const r = classifyYtdlpError(raw, 1);
  check('unrecognized stderr falls back to the raw message unmodified (no invented category)',
    r.msg === raw, `got "${r.msg}"`);
  check('unrecognized stderr gets no hint (nothing actionable to say)', r.hint === null);
}

{
  // Empty/missing stderr (e.g. process died with no output) must not throw.
  const r = classifyYtdlpError('', 1);
  check('empty stderr does not throw and falls back to a generic exit-code message',
    r.msg === 'yt-dlp failed with code 1', `got "${r.msg}"`);
}


console.log('');
if (fails) { console.log(`✗ ${fails} ytdlp-error-classify check(s) failed`); process.exit(1); }
console.log('✓ ytdlp-error-classify: all checks passed');
