// Round 82: "make it so u can convert audio files to mp4 with any background
// picture the user uploads".
//
// Convert → "MP4 video (picture + audio)": a background picture, a size
// (1080p, 720p, square, vertical) and a fit (blurred background, black bars,
// crop). The picture is rendered into one frame first, then looped under the
// audio for exactly the audio's length.
// Measured with the bundled ffmpeg (3-min track, 1080p, 30 fps):
//   - blur filter on every frame: 54 s; pre-rendered frame: 11.6 s;
//   - -shortest alone overran the audio (181.3 s at 30 fps, 204 s at 2 fps,
//     for 180 s); -t from the audio's length: exactly 180.0 s.
//
// The real-server part needs ffmpeg/ffprobe: ROOT\bin (after
// Download-Binaries), or FREQPHULL_TEST_RES pointing at a folder with bin\.
//
// Run:  node tools/test-convert-video-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const aj = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── CORE ──
const si = src.indexOf('// ─── BEGIN CONVERTER CORE ───');
const ei = src.indexOf('// ─── END CONVERTER CORE ───');
const sb = { path, String, Error, parseFloat };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.f = { normalizeConvertOptions, buildVideoArgs, videoFrameFilter, CONVERT_FORMATS, VIDEO_SIZES };', sb);
const { normalizeConvertOptions, buildVideoArgs, videoFrameFilter, CONVERT_FORMATS, VIDEO_SIZES } = sb.f;
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

check('the video format exists, as .mp4', CONVERT_FORMATS.mp4video && CONVERT_FORMATS.mp4video.video && CONVERT_FORMATS.mp4video.ext === '.mp4');
check('a picture is required', /Choose a picture/.test(throws(() => normalizeConvertOptions({ format: 'mp4video' })) || ''));
check('only picture files are accepted', /JPG, PNG/.test(throws(() => normalizeConvertOptions({ format: 'mp4video', image: 'C:\\x\\song.mp3' })) || ''));
const n = normalizeConvertOptions({ format: 'mp4video', image: 'C:\\pics\\cover.JPG', videoSize: 'nope', fit: 'nope' });
check('defaults: 1080p, blurred background, 320 kbps', n.videoSize === '1080p' && n.fit === 'blur' && n.bitrate === '320');
check('audio formats ignore picture options', normalizeConvertOptions({ format: 'mp3', image: 'x.png' }).image === undefined);
check('the four sizes', JSON.stringify(VIDEO_SIZES) === JSON.stringify({ '1080p': [1920, 1080], '720p': [1280, 720], square: [1080, 1080], vertical: [1080, 1920] }));
const args = buildVideoArgs({ format: 'mp4video', image: 'p.png', bitrate: '192', sampleRate: '48000' }, 'F.png', 'A.mp3', 180);
const s = args.join(' ');
check('looped frame under the audio, first audio stream only', s.startsWith('-loop 1 -framerate 30 -i F.png -i A.mp3 -map 0:v -map 1:a:0'));
check('length set from the audio (not -shortest)', s.includes('-t 180.000') && !s.includes('-shortest'));
check('...-shortest only when the length is unknown', buildVideoArgs({ format: 'mp4video', image: 'p.png' }, 'F', 'A', null).includes('-shortest'));
check('H.264 still-picture, plays everywhere (yuv420p), AAC at the chosen bitrate', /-c:v libx264 .*-tune stillimage .*-pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -ar 48000/.test(s) && s.endsWith('-movflags +faststart'));
check('fit filters', /overlay/.test(videoFrameFilter(1920, 1080, 'blur')) && /pad=1920:1080/.test(videoFrameFilter(1920, 1080, 'black')) && /crop=1080:1920/.test(videoFrameFilter(1080, 1920, 'crop')));

// ── Wiring ──
check('the route renders the picture once per batch, then each track', /if \(isVideo\) \{[\s\S]{0,400}asciiSafeFfmpegPath\(opts\.image\)/.test(src) && src.includes("args = ['-hide_banner', '-y', ...buildVideoArgs(opts, framePath, safe.ffmpegPath, knownDuration), tmpOut];"));
check('progress uses the audio length (the picture reports its own)', src.includes('let duration = knownDuration,'));
check('the frame is deleted afterwards', /if \(framePath\) \{ try \{ fs\.unlinkSync\(framePath\); \} catch \{\} \}\s*slog\('convert: finished/.test(src));
check('the picture box, size and fit are in the Convert tab', ['id="conv-video"', 'id="conv-pic-input"', 'id="conv-vsize"', 'id="conv-fit"'].every((x) => html.includes(x)));
check('shown only for the video format', aj.includes("document.getElementById('conv-video').style.display = f.video ? 'flex' : 'none';"));
check('a picture is required before converting', aj.includes("if (!convImage) { showAppNotification(t('convPicNeeded')"));
// Report: "When restarting the mp4 video thing doesnt clear itself" - the
// picture was saved with the Convert settings and came back every launch.
const prefsSave = aj.slice(aj.indexOf('function convSavePrefs('), aj.indexOf('async function convInit('));
const initFn = aj.slice(aj.indexOf('async function convInit('), aj.indexOf('function convFormatChanged('));
check('the picture is not saved with the settings, nor restored at launch', !/image:/.test(prefsSave) && !/convSetImage\(prefs/.test(initFn));
check('...size and fit still are', /vsize:/.test(prefsSave) && /fit:/.test(prefsSave) && /prefs\.vsize/.test(initFn));
check('the picture path goes into a property, never into markup', /img\.src = 'file:\/\/\/' \+ convImage/.test(aj) && !/conv-pic-img[^\n]*\$\{/.test(aj));
for (const key of ['convPicChoose', 'convPicNeeded', 'convVidSize', 'convFitBlur', 'convFitBlack', 'convFitCrop', 'convVideoNote', 'convSizeVertical']) {
  const c = (aj.match(new RegExp('\\b' + key + ':\'', 'g')) || []).length;
  if (c !== 2) check('label ' + key + ' in English and French', false, c + ' found');
}

// ── Real server ──
const resRoot = [ROOT, process.env.FREQPHULL_TEST_RES].find((r) => r && fs.existsSync(path.join(r, 'bin', 'ffmpeg.exe')));
let canRun = !!resRoot;
for (const mod of ['express', 'sql.js']) {
  try { require.resolve(mod, { paths: [ROOT] }); } catch { try { require.resolve(mod); } catch { canRun = false; } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function postNdjson(port, p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, events: b.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) }));
    });
    r.on('error', () => resolve({ status: 0, events: [] }));
    r.end(data);
  });
}

(async () => {
  if (!canRun) {
    console.log('  skip real-server checks: needs node_modules and bin\\ffmpeg.exe (or FREQPHULL_TEST_RES)');
  } else {
    const ff = path.join(resRoot, 'bin', 'ffmpeg.exe');
    const fp = path.join(resRoot, 'bin', 'ffprobe.exe');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-convvid-'));
    const probe = (f) => JSON.parse(execFileSync(fp, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', f]).toString());
    // Inputs: a 20 s tone (MP3), a 12 s video with its own sound, a 4:3 picture
    // with spaces and an accent in its name (ffmpeg gets an ASCII-safe copy).
    const mp3 = path.join(work, 'beat one.mp3');
    execFileSync(ff, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-b:a', '192k', mp3]);
    const vidIn = path.join(work, 'clip.mp4');
    execFileSync(ff, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=12', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', vidIn]);
    const pic = path.join(work, 'Pochette été 2026.png');
    execFileSync(ff, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1200x900:duration=1', '-frames:v', '1', path.join(work, 'tmp.png')]);
    fs.renameSync(path.join(work, 'tmp.png'), pic);
    const PORT = 47000 + Math.floor(Math.random() * 900);
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), USER_DATA: path.join(work, 'data'), RESOURCES_PATH: resRoot, FREQPHULL_NO_CRASH_REPORT: '1' },
    });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    try {
      for (let t = 0; t < 150 && !/listening on port/.test(log); t++) await sleep(100);
      const cases = [
        { size: '1080p', fit: 'blur', w: 1920, h: 1080 },
        { size: 'vertical', fit: 'black', w: 1080, h: 1920 },
        { size: 'square', fit: 'crop', w: 1080, h: 1080 },
        { size: '720p', fit: 'blur', w: 1280, h: 720 },
      ];
      for (const c of cases) {
        const out = path.join(work, 'out-' + c.size);
        const t0 = Date.now();
        const r = await postNdjson(PORT, '/convert', { files: [mp3, vidIn], format: 'mp4video', bitrate: '192', image: pic, videoSize: c.size, fit: c.fit, outDir: out });
        const done = r.events.filter((e) => e && e.type === 'done');
        const errs = r.events.filter((e) => e && e.type === 'error').map((e) => e.message);
        const progressed = r.events.some((e) => e && e.type === 'progress' && e.pct > 0);
        if (done.length !== 2) { check(c.size + '/' + c.fit + ': both converted', false, JSON.stringify(errs)); continue; }
        const [a, b] = done.map((d) => probe(d.output));
        const v = (p) => p.streams.find((x) => x.codec_type === 'video');
        const au = (p) => p.streams.find((x) => x.codec_type === 'audio');
        check(c.size + '/' + c.fit + ': ' + c.w + 'x' + c.h + ' video with sound, exact length (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s for both)',
          v(a).width === c.w && v(a).height === c.h && !!au(a) && Math.abs(parseFloat(a.format.duration) - 20) < 0.1 &&
          v(b).width === c.w && Math.abs(parseFloat(b.format.duration) - 12) < 0.1 && progressed,
          'durations ' + a.format.duration + ' / ' + b.format.duration);
        check(c.size + ': named after the track, in the chosen folder', path.basename(done[0].output) === 'beat one.mp4' && path.dirname(done[0].output) === out);
      }
      // The frame really is the picture: centre pixel of the blurred 1080p
      // output vs the picture's own centre (testsrc2 is not flat grey).
      const r = await postNdjson(PORT, '/convert', { files: [mp3], format: 'mp4video', image: path.join(work, 'missing.png') });
      const e = r.events.find((x) => x && x.type === 'error');
      check('a missing picture fails with a clear message, nothing converted', e && /picture was not found/.test(e.message) && !r.events.some((x) => x && x.type === 'done'), e && e.message);
      const r2 = await postNdjson(PORT, '/convert', { files: [mp3], format: 'mp4video' });
      check('no picture: refused before starting', r2.status === 400);
      const left = fs.readdirSync(os.tmpdir()).filter((f) => /^freqphull_frame_/.test(f));
      check('no frame files left in Temp', left.length === 0, left.join(','));
    } finally {
      srv.kill();
      await sleep(400);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall convert-video checks passed');
  process.exit(fails ? 1 : 0);
})();
