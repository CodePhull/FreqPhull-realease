// Round 81: Convert tab.
//
// 1. Headless: the CONVERTER CORE region of server.js (format table, option
//    validation, ffmpeg arguments, output naming) extracted with vm.
// 2. Real conversions with the bundled bin/ffmpeg.exe (skipped, not failed,
//    when the binaries aren't present - e.g. a fresh checkout before
//    Download-Binaries.bat): every format is produced from a 2 s stereo
//    44.1 kHz source and checked with ffprobe for codec, sample rate,
//    channels and duration. Includes an MP3 with embedded cover art, the case
//    where the stream mapping matters (without it M4A fails and OGG/FLAC gain
//    a video stream - measured while building this), and an MP4 video (H.264
//    + AAC), which must come out audio-only, plus a video with no audio track.
//    FREQPHULL_TEST_FFMPEG_DIR can point at another folder holding
//    ffmpeg.exe/ffprobe.exe when bin/ isn't downloaded.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const si = src.indexOf('// ─── BEGIN CONVERTER CORE ───');
const ei = src.indexOf('// ─── END CONVERTER CORE ───');
if (si < 0 || ei < 0) throw new Error('CONVERTER CORE markers not found in server.js');
const sb = { path: path.win32 };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.__c = { CONVERT_FORMATS, normalizeConvertOptions, buildConvertArgs, convertOutputDir, convertOutputName, parseFfmpegClock };', sb);
const C = sb.__c;

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const argStr = (o) => C.buildConvertArgs(o).join(' ');

// ── 1. Headless ──
let threw = false; try { C.normalizeConvertOptions({ format: 'exe' }); } catch { threw = true; }
check('unknown format is rejected', threw);
check('bad bitrate falls back to the best one', C.normalizeConvertOptions({ format: 'mp3', bitrate: '999' }).bitrate === '320');
check('opus is forced to 48 kHz', C.normalizeConvertOptions({ format: 'opus', sampleRate: '44100' }).sampleRate === '48000');
check('mp3 320 uses libmp3lame at 320k', /-c:a libmp3lame -b:a 320k/.test(argStr({ format: 'mp3', bitrate: '320' })));
check('wav 24-bit uses pcm_s24le', /-c:a pcm_s24le/.test(argStr({ format: 'wav', bitDepth: '24' })));
check('wav 32f uses pcm_f32le', /-c:a pcm_f32le/.test(argStr({ format: 'wav', bitDepth: '32f' })));
check('every format maps only the first audio stream', Object.keys(C.CONVERT_FORMATS).every(f => argStr({ format: f }).startsWith('-map 0:a:0 -vn')));
check('"keep" adds no -ar / -ac', !/-ar |-ac /.test(argStr({ format: 'flac' })));
check('sample rate and mono are applied', /-ar 48000 .*-ac 1/.test(argStr({ format: 'wav', sampleRate: '48000', channels: '1' })));
check('default output dir is a Converted folder next to the file',
  C.convertOutputDir('D:\\Beats\\R&B\\track.mp3', null) === 'D:\\Beats\\R&B\\Converted');
check('a chosen output folder is used as-is', C.convertOutputDir('D:\\Beats\\a.mp3', 'E:\\Out') === 'E:\\Out');
check('output name keeps the stem and swaps the extension',
  C.convertOutputName('D:\\x\\Beat “Quiétude” [120BPM D].wav', 'mp3') === 'Beat “Quiétude” [120BPM D].mp3');
check('ffmpeg clock parsing', C.parseFfmpegClock('Duration: 00:03:05.26,') === 185.26 && C.parseFfmpegClock('time=01:00:00.00') === 3600);

// ── 2. Real conversions ──
const binDir = process.env.FREQPHULL_TEST_FFMPEG_DIR || path.join(ROOT, 'bin');
const ff = path.join(binDir, 'ffmpeg.exe'), fp = path.join(binDir, 'ffprobe.exe');
if (!fs.existsSync(ff) || !fs.existsSync(fp)) {
  console.log('  skip real conversions: ffmpeg.exe or ffprobe.exe not present in ' + binDir);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-conv-'));
  try {
    const run = (exe, args) => spawnSync(exe, args, { encoding: 'utf8' });
    const plain = path.join(dir, 'src.wav'), cover = path.join(dir, 'cover.mp3'), png = path.join(dir, 'c.png');
    const video = path.join(dir, 'clip.mp4'), silentVideo = path.join(dir, 'noaudio.mp4');
    run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100', '-ac', '2', plain]);
    run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', png]);
    run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', plain, '-i', png, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png', '-disposition:v', 'attached_pic', '-id3v2_version', '3', cover]);
    run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x120:d=2:r=25', '-i', plain,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', video]);
    run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x120:d=1:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo]);
    const probe = (f) => {
      const r = run(fp, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels:format=duration', '-of', 'json', f]);
      try { return JSON.parse(r.stdout); } catch { return null; }
    };
    const expectCodec = { mp3: 'mp3', wav: 'pcm_s16le', flac: 'flac', aiff: 'pcm_s16be', alac: 'alac', m4a: 'aac', mp4: 'aac', ogg: 'vorbis', opus: 'opus' };
    const vp = probe(video);
    check('test MP4 video was built with a video and an audio stream', vp && vp.streams.some(s => s.codec_type === 'video') && vp.streams.some(s => s.codec_type === 'audio'));
    for (const input of [plain, cover, video]) {
      for (const fmt of Object.keys(C.CONVERT_FORMATS)) {
        const out = path.join(dir, path.basename(input, path.extname(input)) + '_' + fmt + C.CONVERT_FORMATS[fmt].ext);
        const r = run(ff, ['-hide_banner', '-y', '-i', input, ...C.buildConvertArgs({ format: fmt }), out]);
        const p = r.status === 0 ? probe(out) : null;
        const streams = p ? p.streams : [];
        const a = streams.find(s => s.codec_type === 'audio');
        const dur = p ? parseFloat(p.format.duration) : 0;
        // AAC-in-MP4 sources come back up to ~0.05 s longer (encoder priming).
        const good = r.status === 0 && streams.length === 1 && a && a.codec_name === expectCodec[fmt] &&
          +a.channels === 2 && Math.abs(dur - 2) < 0.1 &&
          (+a.sample_rate === (fmt === 'opus' ? 48000 : 44100));
        check(path.basename(input) + ' -> ' + fmt, good,
          r.status !== 0 ? 'ffmpeg exit ' + r.status + ': ' + (r.stderr || '').trim().split('\n').pop()
            : (streams.map(s => s.codec_type + ':' + s.codec_name).join(',') + ' ' + (a ? a.sample_rate + 'Hz ' + a.channels + 'ch ' : '') + dur.toFixed(2) + 's'));
      }
    }
    // A video with no audio track fails cleanly (the route turns this ffmpeg
    // message into "This file has no audio track.").
    const nr = run(ff, ['-hide_banner', '-y', '-i', silentVideo, ...C.buildConvertArgs({ format: 'mp3' }), path.join(dir, 'noaudio.mp3')]);
    check('video without audio fails with "matches no streams"', nr.status !== 0 && /matches no streams/i.test(nr.stderr || ''));
    check('route maps that to a plain message', src.includes("else if (/matches no streams/i.test(msg)) msg = 'This file has no audio track.';"));

    // Options actually reach the file.
    const o2 = path.join(dir, 'opt.wav');
    run(ff, ['-hide_banner', '-y', '-i', plain, ...C.buildConvertArgs({ format: 'wav', bitDepth: '24', sampleRate: '48000', channels: '1' }), o2]);
    const a2 = (probe(o2) || { streams: [] }).streams[0] || {};
    check('wav 24-bit / 48 kHz / mono options are applied', a2.codec_name === 'pcm_s24le' && +a2.sample_rate === 48000 && +a2.channels === 1,
      a2.codec_name + ' ' + a2.sample_rate + 'Hz ' + a2.channels + 'ch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
