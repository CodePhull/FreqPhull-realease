// Regression test for the Round 68 mic low-cut filter (RB_MIC_HIGHPASS_HZ).
//
// This is DSP wiring inside a live MediaStream/AudioContext graph
// (createMediaStreamSource, createBiquadFilter, real mic permission) -
// there's no headless Web Audio API in this environment to actually drive
// it end-to-end, the same limitation Round 59's tray-click fix hit. Same
// substitute used there: a static source-text guard confirming the filter
// node is actually created, wired in the right position (between the mic
// source and everything downstream, including the input-gain trim and the
// level meter), and torn down in all three places a mic graph gets built
// in this app (the full record graph, the standalone monitor-only graph,
// and the armed/preview-meter-only graph) - not just added and forgotten
// in one of the three.
//
// Added after a real report ("everything is too loud... its all wind...
// from the start") with an evidence WAV. Direct FFT analysis of that file
// found 74.2% of all spectral energy below 50Hz and 97.4% below 200Hz,
// checked at three separate points in the take (including the single
// loudest instant) - consistent, broadband sub-vocal rumble, not a digital
// gain problem (the file's peak measured -16.8dBFS, nowhere near
// clipping). No stage in the recording chain filtered this out.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'app.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── The constant itself: present, and a sane vocal low-cut value (not
// accidentally left at 0/disabled, and not so high it would eat real
// vocal fundamentals). ──
const constMatch = src.match(/const RB_MIC_HIGHPASS_HZ = (\d+);/);
check('RB_MIC_HIGHPASS_HZ is defined as a numeric constant',
  !!constMatch, 'found: ' + (constMatch ? constMatch[0] : 'nothing'));
if (constMatch) {
  const hz = parseInt(constMatch[1], 10);
  check('RB_MIC_HIGHPASS_HZ is a sane vocal low-cut value (between 40Hz and 150Hz)',
    hz >= 40 && hz <= 150, `value=${hz}`);
}

// ── All three mic graphs (full record, standalone monitor, armed/preview
// meter) create a highpass BiquadFilterNode using the shared constant. ──
const highpassCreations = (src.match(/\.type = 'highpass';/g) || []).length;
check('exactly 3 highpass filter nodes are created (record graph, monitor graph, armed/preview graph)',
  highpassCreations === 3, `found ${highpassCreations}`);

const usesSharedConstant = (src.match(/\.frequency\.value = RB_MIC_HIGHPASS_HZ;/g) || []).length;
check('all 3 highpass nodes use the shared RB_MIC_HIGHPASS_HZ constant (not 3 separate hardcoded numbers that could drift apart)',
  usesSharedConstant === 3, `found ${usesSharedConstant}`);

// ── Wiring order: the mic source connects INTO the highpass filter, and
// the highpass filter connects into the (pre-existing) gain trim - so
// gain staging, the level meter, channel safety, and autotune/reverb all
// downstream all see the filtered signal, not the raw rumble. ──
check('rbConnectRecordGraph: mic source feeds the highpass filter (not the raw gain node directly)',
  src.includes('rbMicSource.connect(rbMicHighpassNode);'));
check('rbConnectRecordGraph: the highpass filter feeds the input-gain trim',
  src.includes('rbMicHighpassNode.connect(rbInputGainNode);'));
check('rbArmMic (preview): armed mic source feeds the armed highpass filter',
  src.includes('rbArmedSource.connect(rbArmedHighpassNode);'));
check('rbArmMic (preview): the armed highpass filter feeds the armed gain trim',
  src.includes('rbArmedHighpassNode.connect(rbArmedGainNode);'));

// ── Teardown: every place a mic graph gets built also disconnects and
// nulls the highpass node when torn down, so repeated arm/record/monitor
// cycles don't leak WebAudio nodes. ──
const disconnectCount = (src.match(/if \(rbMicHighpassNode\) rbMicHighpassNode\.disconnect\(\);/g) || []).length
  + (src.match(/if \(rbArmedHighpassNode\) rbArmedHighpassNode\.disconnect\(\);/g) || []).length;
check('the highpass node is disconnected in teardown in all 3 places it gets created (record, monitor, armed preview)',
  disconnectCount === 3, `found ${disconnectCount} disconnect call(s)`);

// 2 initial `let ... = null;` declarations + 3 teardown resets (record,
// monitor, armed preview) = 5 total occurrences of the pattern.
const nullResetCount = (src.match(/rbMicHighpassNode = null;/g) || []).length
  + (src.match(/rbArmedHighpassNode = null;/g) || []).length;
check('the highpass node variable is reset to null in teardown in all 3 places, plus its 2 initial declarations (no stale references after a graph is torn down)',
  nullResetCount === 5, `found ${nullResetCount} occurrence(s)`);

console.log('');
if (fails) { console.log(`✗ ${fails} mic-highpass check(s) failed`); process.exit(1); }
console.log('✓ mic-highpass: all checks passed');
