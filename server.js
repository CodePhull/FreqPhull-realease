const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { spawn } = require('child_process');
const multer    = require('multer');

const PORT = process.env.PORT || 47891;
const RES  = process.env.RESOURCES_PATH || __dirname;
const DATA = process.env.USER_DATA || path.join(os.homedir(), '.freqphull');

// ── Server-side log ───────────────────────────────────────────────────────────
const logDir  = path.join(DATA, 'logs');
const logPath = path.join(logDir, 'server-' + new Date().toISOString().slice(0,10) + '.log');

function slog(msg) {
  const line = '[' + new Date().toISOString() + '] [server] ' + msg;
  process.stdout.write(line + '\n');
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
  } catch {}
}

slog('Server process starting');
slog('Node: ' + process.version);
slog('PORT: ' + PORT);
slog('RES: ' + RES);
slog('DATA: ' + DATA);
slog('__dirname: ' + __dirname);

// ── Integrity check ──────────────────────────────────────────────────────────
// Verify protected files match their build-time SHA-256 hashes. Tampered
// files cause the engine layer to refuse new jobs (analyzer + separator +
// transcribe), but the rest of the app keeps running so the user can still
// see the message and seek support.
let integrityState = { ok: true, status: 'unchecked', mismatches: [] };
try {
  const integrity = require('./integrity.js');
  integrityState = integrity.verifyIntegrity(__dirname, RES);
  if (integrityState.status === 'ok') {
    slog('integrity: verified');
  } else if (integrityState.status === 'missing-manifest') {
    slog('integrity: manifest not found (dev build?) — engine checks bypassed');
  } else {
    slog('integrity: FAILED status=' + integrityState.status);
    integrityState.mismatches.forEach(m => slog('  ' + m));
  }
} catch (e) {
  slog('integrity: check threw: ' + e.message + ' — engine checks bypassed');
  integrityState = { ok: true, status: 'check-error', mismatches: [String(e.message)] };
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });

// ── DB — starts AFTER server is listening ─────────────────────────────────────
let db = null;
const DB_PATH = path.join(DATA, 'freqphull.db');

async function initDB() {
  try {
    slog('DB init starting at: ' + DB_PATH);
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
    slog('sql.js loading...');
    const initSqlJs = require('sql.js');
    slog('sql.js loaded, initializing...');
    const sqlJs = await initSqlJs();
    slog('sql.js initialized');
    db = fs.existsSync(DB_PATH)
      ? new sqlJs.Database(fs.readFileSync(DB_PATH))
      : new sqlJs.Database();
    db.run(`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, channel TEXT, youtube_url TEXT,
      file_path TEXT, format TEXT, duration REAL,
      bpm REAL, key_note TEXT, key_mode TEXT,
      thumbnail TEXT, notes TEXT, transcript TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS separator_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      source_path TEXT,
      output_dir TEXT,
      stems TEXT,
      model TEXT,
      mode TEXT,
      quality TEXT,
      device TEXT,
      duration REAL,
      processing_time REAL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
    )`);

    // ── Stockpile organization tables ──────────────────────────────────────
    // Folders are the user's style buckets (Cali Trap, Detroit, etc.).
    // Each folder carries a comma-separated list of artist seeds and a
    // cached mood centroid that updates as tracks get tagged into it.
    db.run(`CREATE TABLE IF NOT EXISTS stockpile_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      artist_seeds TEXT,
      mood_centroid TEXT,
      track_count INTEGER DEFAULT 0,
      color TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
    )`);

    // Tag links between history entries and folders. A track can carry
    // multiple tags (rare but possible). The 'is_primary' flag marks which
    // folder the file moves into on stockpile commit.
    db.run(`CREATE TABLE IF NOT EXISTS stockpile_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      history_id INTEGER NOT NULL,
      folder_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 1,
      confidence REAL,
      source TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
      UNIQUE(history_id, folder_id)
    )`);

    // Per-track mood profile cache. Populated by analyze.py when a track is
    // analyzed; survives across sessions without re-running analysis.
    db.run(`CREATE TABLE IF NOT EXISTS track_mood (
      history_id INTEGER PRIMARY KEY,
      energy REAL, tonality REAL, density REAL, tempo_pos REAL,
      label TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
    )`);

    // Migration: add stockpile_committed column to history if missing.
    // Tracks whether a file has been moved into the stockpile folder structure.
    try {
      db.run(`ALTER TABLE history ADD COLUMN stockpile_committed INTEGER DEFAULT 0`);
      slog('DB migration: added history.stockpile_committed');
    } catch (e) {
      // Column already exists — that's fine, sqlite errors loudly otherwise
    }
    try {
      db.run(`ALTER TABLE history ADD COLUMN artists_detected TEXT`);
      slog('DB migration: added history.artists_detected');
    } catch (e) { /* already exists */ }
    // Favorites: per-track boolean. Tracks that are favorited get optionally
    // included in a "Favorites" stockpile folder. Heart icon in history +
    // mini player; the actual move to the favorites folder happens via the
    // same stockpile tag system, with auto-tag against a special folder.
    try {
      db.run(`ALTER TABLE history ADD COLUMN is_favorite INTEGER DEFAULT 0`);
      slog('DB migration: added history.is_favorite');
    } catch (e) { /* already exists */ }
    // Per-track notepad — quick freeform thoughts the user jots from the
    // mini player. Stored as plain text so it round-trips simply.
    try {
      db.run(`ALTER TABLE history ADD COLUMN user_notes TEXT`);
      slog('DB migration: added history.user_notes');
    } catch (e) { /* already exists */ }
    saveDB();
    slog('DB ready');
  } catch (e) {
    slog('DB init failed: ' + e.message);
    slog('DB stack: ' + e.stack);
  }
}

function saveDB() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { slog('DB save error: ' + e.message); }
}

function dbAll(sql, params = []) {
  if (!db) return [];
  try { const stmt = db.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; }
  catch (e) { slog('dbAll error: ' + e.message); return []; }
}

function dbRun(sql, params = []) {
  if (!db) return null;
  try { db.run(sql, params); const r = dbAll('SELECT last_insert_rowid() as id'); saveDB(); return r[0]?.id || null; }
  catch (e) { slog('dbRun error: ' + e.message); return null; }
}

// ── Binary resolution ─────────────────────────────────────────────────────────
function bin(name) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  // In a packaged Electron app:
  //   __dirname  = <install>\resources\app.asar     (asar virtual path)
  //   RES        = <install>\resources              (real folder, where extraResources land)
  //
  // The ".asar.unpacked" suffix is where electron-builder unpacks anything that
  // can't run from inside asar (ffmpeg/yt-dlp can't run from asar; we also keep
  // the extraResources copies as the primary source).
  const asarUnpacked = __dirname.replace(/[\\/]app\.asar([\\/]|$)/, (m, tail) => '/app.asar.unpacked' + tail);
  const candidates = [
    path.join(RES, 'bin', name + exe),
    path.join(RES, 'bin', name),
    path.join(__dirname, 'bin', name + exe),
    path.join(__dirname, 'bin', name),
    path.join(asarUnpacked, 'bin', name + exe),
  ];
  // Log every candidate and whether it exists — invaluable when packaged builds misbehave
  const checked = candidates.map(c => `${fs.existsSync(c) ? 'YES' : 'NO '}: ${c}`).join('\n  ');
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      slog('bin(' + name + ') -> ' + c);
      return c;
    }
  }
  // Bundled binary is missing — most common cause is Windows Defender quarantining
  // the .exe after first run (third-party binaries trigger heuristic detection).
  // Fall back to system PATH so the user isn't dead in the water. spawn() will
  // resolve "ffmpeg" / "yt-dlp" through PATH if it's installed system-wide.
  // We don't pre-validate the PATH lookup here because (a) it requires another
  // spawn just to test, and (b) the actual spawn will fail loudly with ENOENT
  // and the higher-level handler converts that into a user-visible message.
  slog('bin(' + name + ') NOT FOUND in any bundled location. Falling back to PATH lookup.');
  slog('  Searched:\n  ' + checked + '\n  RES=' + RES + ' __dirname=' + __dirname);
  slog('  HINT: bundled binary may have been quarantined by antivirus. Check Windows Defender exclusions.');
  return name + exe;
}

// Resolve a resource file (script, weights, etc.) across all the locations
// where electron-builder might have placed it. Returns the first that exists,
// or null if none. Pass relative path like 'stems.py' or 'installer/setup-engines.ps1'.
function getResourcePath(rel) {
  const asarUnpacked = __dirname.replace(/[\\/]app\.asar([\\/]|$)/, (m, tail) => '/app.asar.unpacked' + tail);
  const candidates = [
    path.join(__dirname, rel),
    path.join(RES, rel),
    path.join(asarUnpacked, rel),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  slog('getResourcePath(' + rel + ') NOT FOUND in: ' + candidates.join(' | '));
  return null;
}

// Read a UTF-8 file, transparently stripping any byte-order mark (BOM).
// PowerShell's Out-File -Encoding utf8 writes UTF-8-BOM by default, and
// JSON.parse rejects BOM, so any marker we wrote from PowerShell needs this.
function readUtf8(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

// On startup, if the engines marker exists with a BOM, rewrite it without one
// so JSON.parse stops failing for the rest of the session and on future reads.
// Existing users avoid having to re-run setup.
function repairMarkerOnce() {
  const markerPath = path.join(os.homedir(), 'AppData', 'Roaming', 'freqphull', 'engines-ready.json');
  try {
    if (!fs.existsSync(markerPath)) return;
    const raw = fs.readFileSync(markerPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) {
      const clean = raw.slice(1);
      // Validate it's parseable before overwriting
      JSON.parse(clean);
      fs.writeFileSync(markerPath, clean, 'utf8');
      slog('Repaired engines marker: stripped UTF-8 BOM');
    }
  } catch (e) {
    slog('repairMarkerOnce: ' + e.message);
  }
}
repairMarkerOnce();

// Read the engines marker file to get the Python command that setup verified.
// Falls back to 'python' if marker absent or unreadable.
function getPythonCmd() {
  const markerPath = path.join(os.homedir(), 'AppData', 'Roaming', 'freqphull', 'engines-ready.json');
  try {
    if (fs.existsSync(markerPath)) {
      const info = JSON.parse(readUtf8(markerPath));
      if (info && info.python) return info.python;
    }
  } catch (e) {
    slog('getPythonCmd: marker read failed: ' + e.message);
  }
  return 'python';
}

// Quick sanity check that the engine runtime is importable.
// We require the marker to contain a FULL PATH for python (not just "python")
// and a recent version stamp. Markers from older setups (which didn't verify
// torchaudio etc.) are treated as stale so the user gets prompted to re-setup.
function enginesReady() {
  // Tamper check first: if the build was modified after signing, refuse
  // to launch engines. We allow 'missing-manifest', 'check-error', AND
  // 'missing-files' to pass through — the first two are dev/unpacked
  // builds, and 'missing-files' usually indicates a packaging path issue
  // (e.g. asar.unpacked resolution) rather than an attack. Only an
  // explicit hash MISMATCH ('tampered') is treated as adversarial.
  if (integrityState && integrityState.status === 'tampered') {
    return false;
  }
  const markerPath = path.join(os.homedir(), 'AppData', 'Roaming', 'freqphull', 'engines-ready.json');
  if (!fs.existsSync(markerPath)) return false;
  try {
    const info = JSON.parse(readUtf8(markerPath));
    if (!info || !info.python) return false;
    // A bare "python" / "python3" / "py" command means the old setup script
    // wrote it before we tracked full paths. Force re-setup.
    const isFullPath = /[\\/]/.test(info.python) || info.python.toLowerCase().endsWith('.exe');
    if (!isFullPath) {
      slog('enginesReady: marker has bare python cmd "' + info.python + '" - treating as stale');
      return false;
    }
    // Verify the recorded Python actually still exists on disk
    if (!fs.existsSync(info.python)) {
      slog('enginesReady: marker python path does not exist: ' + info.python);
      return false;
    }
    // Markers below version 2.0 didn't verify torchaudio; treat as stale.
    // The setup script bumps this when its validation logic changes.
    const version = parseFloat(info.version || '0');
    if (version < 2.0) {
      slog('enginesReady: marker version "' + info.version + '" is below required 2.0 - treating as stale');
      return false;
    }
    return true;
  } catch (e) {
    slog('enginesReady: marker parse error: ' + e.message);
    return false;
  }
}



function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || 'Exit ' + code)));
    proc.on('error', e => reject(new Error('Cannot start ' + path.basename(cmd) + ': ' + e.message)));
  });
}

// ── ASCII-safe path workaround for Windows + ffmpeg ────────────────────
// On Windows, Node's spawn() passes argv through the ANSI code page
// (CP1252 by default). Filenames containing characters outside that
// page — full-width quotes "＂", French diacritics like "È", typographic
// chars "›", any cyrillic / cjk / emoji — get mangled before ffmpeg
// sees them. ffmpeg then errors with "Invalid data found when
// processing input" because the path it received doesn't point to a
// real file.
//
// Reliable fix: detect non-ASCII bytes in the path and, if any are
// present, copy the file to a temp file with an ASCII-only name first.
// Slight overhead (one disk copy) but works 100% of the time. ASCII
// paths are returned unchanged with no extra I/O.
//
// Returns { ffmpegPath, tempCopy }. Caller MUST `try { fs.unlinkSync(tempCopy) }
// catch {}` when done if tempCopy is non-null.
function asciiSafeFfmpegPath(filePath) {
  if (!/[^\x00-\x7F]/.test(filePath)) {
    return { ffmpegPath: filePath, tempCopy: null };
  }
  const ext = path.extname(filePath) || '.bin';
  const tempCopy = path.join(os.tmpdir(),
    'freqphull_in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
  fs.copyFileSync(filePath, tempCopy);
  slog('asciiSafeFfmpegPath: non-ASCII path detected, copied to ' + tempCopy);
  return { ffmpegPath: tempCopy, tempCopy };
}

// ── Temp file sweeper ───────────────────────────────────────────────────
// Every convert-wav/analyze/stems/mastering pass creates a few WAVs in
// the system temp dir (freqphull_*.wav, freqphull_in_*.wav, etc.) and
// tries to clean them up when it's done. But cleanup can fail silently —
// antivirus holding a file open, abrupt process exit, sendFile error
// mid-stream — and over months that leftover trickle adds up to GIGABYTES
// of orphaned temp data. We've seen 80GB in the wild.
//
// This sweep runs once on startup and again every 6h. It deletes files
// in os.tmpdir() that:
//   1. Are FILES (never directories — protects Electron's unpack folder,
//      Windows session folders, etc.)
//   2. Start with the strict prefix `freqphull_` or `freqphull-`
//   3. Are older than maxAgeHours (default 24h)
//
// We intentionally do NOT recurse into subfolders. The portable build
// of Electron unpacks itself to `Temp\<hash>\resources\...` and we
// must never touch that — if we wipe ffmpeg.exe out of there mid-session
// the app dies (the user has seen this happen via Windows' own Temp
// cleanup). Top-level files only.
function sweepOldTempFiles(maxAgeHours = 24) {
  const summary = { scanned: 0, deleted: 0, bytesFreed: 0, errors: 0 };
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp);
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    for (const name of entries) {
      // Strict prefix match — anything not starting with these is not ours
      if (!name.startsWith('freqphull_') && !name.startsWith('freqphull-')) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.lstatSync(full);  // lstat so symlinks don't deref
        // Skip directories. The portable Electron unpack uses
        // hash-named dirs that DON'T match our prefix anyway, but this
        // is defense in depth: never delete anything that isn't a flat file.
        if (!st.isFile()) continue;
        summary.scanned++;
        if (st.mtimeMs >= cutoff) continue;  // still fresh, leave alone
        const size = st.size;
        fs.unlinkSync(full);
        summary.deleted++;
        summary.bytesFreed += size;
      } catch {
        summary.errors++;
      }
    }
  } catch (e) {
    slog('sweepOldTempFiles failed: ' + e.message);
  }
  return summary;
}


// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  slog('Health check hit');
  res.json({
    status: 'ok',
    db: !!db,
    logPath,
    integrity: integrityState ? integrityState.status : 'unchecked',
  });
});

// ── Event broadcaster (server-sent events) ──────────────────────────────
// A single long-lived SSE channel that any renderer can subscribe to.
// When the backend mutates shared state (most importantly the history
// table) it calls broadcastEvent() and every connected client reacts.
// This is how a download finished in the Chrome extension — or in a
// second app window — makes the desktop app's History tab refresh
// automatically. SSE is the right tool here: one server → many clients,
// server-initiated, survives across requests, and works over plain HTTP
// without websockets.
const eventClients = new Set();

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // Allow the extension origin to subscribe too
    'Access-Control-Allow-Origin': '*',
  });
  // Initial comment to open the stream + flush headers immediately
  res.write(': connected\n\n');
  eventClients.add(res);
  slog('events: client connected (' + eventClients.size + ' total)');

  // Heartbeat every 25s so proxies / the browser don't time out the
  // idle connection. SSE comments (lines starting with ':') are ignored
  // by the client but keep the socket warm.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
    slog('events: client disconnected (' + eventClients.size + ' remaining)');
  });
});

// Push an event to every connected client. `type` becomes the SSE event
// name the client listens for; `data` is JSON-serialized. Safe to call
// even with zero clients — it just no-ops.
function broadcastEvent(type, data) {
  if (!eventClients.size) return;
  const payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  for (const client of eventClients) {
    try { client.write(payload); }
    catch { /* dead socket — will be cleaned up on its 'close' */ }
  }
}

// Detailed integrity report. Surface mismatches to the renderer for a
// banner. Doesn't include hash values — just file paths and the status.
app.get('/integrity', (_, res) => {
  res.json({
    status: integrityState.status,
    ok: integrityState.ok,
    mismatchCount: integrityState.mismatches.length,
    mismatches: integrityState.mismatches.map(m => m.split(':')[0]),
  });
});

// Check whether a file or directory exists. Used by the renderer to verify
// stem-history entries still point at real folders before invoking shell.
// Both files and folders are checked; we return the kind for context.
app.get('/path-exists', (req, res) => {
  const p = req.query.path || '';
  if (!p) return res.json({ exists: false, reason: 'no path' });
  try {
    const stat = fs.statSync(p);
    res.json({
      exists: true,
      kind: stat.isDirectory() ? 'dir' : 'file',
    });
  } catch {
    res.json({ exists: false });
  }
});

// Return the most recent log content for the in-app viewer.
// Includes server log (today) and the PowerShell setup log if it exists.
app.get('/logs', (req, res) => {
  const tailKB = Math.min(parseInt(req.query.kb) || 200, 2000);  // tail cap: 200KB default, 2MB max
  const out = { paths: { server: logPath, setup: null }, server: '', setup: '', errors: [] };

  // Server log — read last N KB
  try {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      const fd = fs.openSync(logPath, 'r');
      try {
        const tailBytes = Math.min(stat.size, tailKB * 1024);
        const start = Math.max(0, stat.size - tailBytes);
        const buf = Buffer.alloc(tailBytes);
        fs.readSync(fd, buf, 0, tailBytes, start);
        out.server = buf.toString('utf8');
        // Trim leading partial line if we tail-clipped mid-line
        if (start > 0) {
          const nl = out.server.indexOf('\n');
          if (nl >= 0) out.server = out.server.slice(nl + 1);
        }
      } finally { fs.closeSync(fd); }
    }
  } catch (e) {
    out.errors.push('server log read failed: ' + e.message);
  }

  // Setup log — full file (it's small)
  const setupLogPath = path.join(os.tmpdir(), 'freqphull-setup.log');
  out.paths.setup = setupLogPath;
  try {
    if (fs.existsSync(setupLogPath)) {
      out.setup = fs.readFileSync(setupLogPath, 'utf8');
      // Strip BOM if PowerShell wrote one
      if (out.setup.charCodeAt(0) === 0xFEFF) out.setup = out.setup.slice(1);
    }
  } catch (e) {
    out.errors.push('setup log read failed: ' + e.message);
  }

  res.json(out);
});

// Diagnostic — what binaries can we find? Used by Settings → "Diagnose paths" button
app.get('/diag-bin', (_, res) => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const asarUnpacked = __dirname.replace(/[\\/]app\.asar([\\/]|$)/, (m, tail) => '/app.asar.unpacked' + tail);
  const tools = ['ffmpeg', 'ffprobe', 'yt-dlp'];
  const result = { RES, __dirname, asarUnpacked, tools: {} };
  for (const t of tools) {
    const candidates = [
      path.join(RES, 'bin', t + exe),
      path.join(RES, 'bin', t),
      path.join(__dirname, 'bin', t + exe),
      path.join(asarUnpacked, 'bin', t + exe),
    ];
    result.tools[t] = {
      resolved: bin(t),
      candidates: candidates.map(c => ({ path: c, exists: fs.existsSync(c) })),
    };
  }
  // Check setup script & python script too
  result.scripts = {
    'stems.py':            { paths: [path.join(RES, 'stems.py'), path.join(__dirname, 'stems.py'), path.join(asarUnpacked, 'stems.py')] },
    'analyze.py':          { paths: [path.join(RES, 'analyze.py'), path.join(__dirname, 'analyze.py'), path.join(asarUnpacked, 'analyze.py')] },
    'mastering.py':        { paths: [path.join(RES, 'mastering.py'), path.join(__dirname, 'mastering.py'), path.join(asarUnpacked, 'mastering.py')] },
    'setup-engines.ps1':   { paths: [path.join(RES, 'installer', 'setup-engines.ps1'), path.join(__dirname, 'installer', 'setup-engines.ps1'), path.join(asarUnpacked, 'installer', 'setup-engines.ps1')] },
  };
  for (const k of Object.keys(result.scripts)) {
    result.scripts[k].paths = result.scripts[k].paths.map(p => ({ path: p, exists: fs.existsSync(p) }));
    result.scripts[k].resolved = getResourcePath(k === 'setup-engines.ps1' ? path.join('installer', k) : k);
  }
  // Engine status
  const markerPath = path.join(os.homedir(), 'AppData', 'Roaming', 'freqphull', 'engines-ready.json');
  result.engines = {
    markerPath,
    markerExists: fs.existsSync(markerPath),
    pythonCmd: getPythonCmd(),
  };
  if (result.engines.markerExists) {
    try { result.engines.markerContent = JSON.parse(readUtf8(markerPath)); }
    catch (e) { result.engines.markerError = e.message; }
  }
  res.json(result);
});

app.get('/info', async (req, res) => {
  const url = (req.query.url || '').trim();
  slog('Fetching info for: ' + url);
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const ytdlp = bin('yt-dlp');
    slog('Using yt-dlp: ' + ytdlp);
    const raw = await run(ytdlp, ['--dump-json', '--no-playlist', '--no-warnings', url]);
    const info = JSON.parse(raw);
    res.json({ title: info.title, channel: info.channel || info.uploader, duration: info.duration, thumbnail: info.thumbnail });
  } catch (e) {
    slog('Info error: ' + e.message);
    // Spawn-level failures (ENOENT etc) mean yt-dlp.exe is missing/blocked.
    // The single most common cause is Windows Defender quarantining it
    // because heuristic detection flags many download tools. Tell the user
    // explicitly instead of letting them stare at "Cannot start yt-dlp.exe:
    // spawn ... ENOENT" which they can't act on.
    let userMsg = e.message || 'yt-dlp failed';
    if (/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/.test(userMsg)) {
      userMsg = 'yt-dlp.exe is missing or blocked. ' +
                'This is usually caused by Windows Defender / antivirus quarantining the bundled binary on first run. ' +
                'Add the Freq.Phull install folder to your antivirus exclusions and restart the app, ' +
                'or install yt-dlp system-wide.';
    }
    res.status(400).json({ error: userMsg });
  }
});

app.get('/download', async (req, res) => {
  const url    = (req.query.url    || '').trim();
  const fmt    = (req.query.format || 'mp3').toLowerCase();
  const outDir = (req.query.outDir || path.join(os.homedir(), 'Downloads')).trim();
  slog('Download request: fmt=' + fmt + ' outDir=' + outDir);
  const ALLOWED = ['mp3', 'wav', 'flac', 'aac', 'm4a'];
  if (!url || !ALLOWED.includes(fmt)) return res.status(400).json({ error: 'Bad params' });
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = (ev, data) => res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n');

  const ytdlp = bin('yt-dlp');
  const ffDir = path.dirname(bin('ffmpeg'));
  slog('yt-dlp path: ' + ytdlp);
  slog('ffmpeg dir: ' + ffDir);

  const args = ['--no-playlist', '--no-warnings', '-x', '--audio-format', fmt, '--audio-quality', '0', '--ffmpeg-location', ffDir, '--newline', '-o', path.join(outDir, '%(title)s.%(ext)s'), url];
  if (fmt === 'wav') args.push('--postprocessor-args', 'ffmpeg:-acodec pcm_s16le -ar 44100');

  sse('status', { message: 'Starting download…' });
  const proc = spawn(ytdlp, args, { windowsHide: true });
  let stderr = '';

  proc.stdout.on('data', d => {
    const line = d.toString();
    const m = line.match(/\[download\]\s+([\d.]+)%/);
    if (m) sse('progress', { progress: parseFloat(m[1]) });
  });
  proc.stderr.on('data', d => { stderr += d; slog('yt-dlp stderr: ' + d.toString().trim()); });
  proc.on('close', async code => {
    slog('yt-dlp exit code: ' + code);
    if (code !== 0) { sse('error', { message: stderr.trim() || 'yt-dlp failed with code ' + code }); return res.end(); }

    const files = fs.readdirSync(outDir)
      .map(f => ({ name: f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .filter(f => f.name.toLowerCase().endsWith('.' + fmt))
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) { sse('error', { message: 'Output file not found in ' + outDir }); return res.end(); }

    const filename = files[0].name, fullPath = path.join(outDir, filename);
    slog('Downloaded to: ' + fullPath);

    let meta = {};
    try { meta = JSON.parse(await run(ytdlp, ['--dump-json', '--no-playlist', '--no-warnings', url])); } catch(e) { slog('Meta fetch error: ' + e.message); }

    let historyId = null;
    if (db) {
      historyId = dbRun(`INSERT INTO history (title,channel,youtube_url,file_path,format,duration,thumbnail) VALUES (?,?,?,?,?,?,?)`,
        [meta.title||filename, meta.channel||meta.uploader||'', url, fullPath, fmt, meta.duration||null, meta.thumbnail||'']);
      slog('Saved to history, id=' + historyId);
    }
    sse('done', { filename, fullPath, outDir, historyId });
    // Tell every connected renderer (this app, other windows, the Chrome
    // extension) that history gained a row, so their History tab can
    // refresh + pulse the new entry without a manual reload.
    broadcastEvent('history-changed', { reason: 'download', historyId });
    res.end();
  });
  proc.on('error', e => {
    slog('yt-dlp spawn error: ' + e.message);
    let userMsg = 'Cannot start yt-dlp: ' + e.message;
    if (/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/.test(e.message || '')) {
      // Two common causes: (1) antivirus quarantined yt-dlp.exe, OR
      // (2) the user (or Windows Storage Sense / a cleaner tool) wiped
      // Windows Temp, which is where portable builds unpack their
      // binaries on each launch. Mention both so the message is useful
      // regardless of which case the user is actually in.
      userMsg = 'yt-dlp.exe could not be found. Most likely causes:\n' +
                '• Windows Temp was cleared (e.g. CCleaner, Storage Sense, or "del Temp"). Portable builds re-extract on launch — close Freq.Phull completely (check Task Manager) and reopen.\n' +
                '• Windows Defender / antivirus quarantined the bundled binary. Add the Freq.Phull install folder to your antivirus exclusions and restart.\n' +
                '• Installing the NSIS version (not portable) puts binaries in C:\\Program Files where Temp-cleaners cannot touch them.';
    }
    sse('error', { message: userMsg });
    res.end();
  });
});

app.post('/history/:id/analysis', (req, res) => { const { bpm, key_note, key_mode } = req.body; dbRun('UPDATE history SET bpm=?,key_note=?,key_mode=? WHERE id=?', [bpm, key_note, key_mode, req.params.id]); res.json({ ok: true }); });
app.post('/history/:id/notes',    (req, res) => { dbRun('UPDATE history SET notes=? WHERE id=?', [req.body.notes, req.params.id]); res.json({ ok: true }); });
app.post('/history/:id/transcript',(req, res)=> { dbRun('UPDATE history SET transcript=? WHERE id=?', [req.body.transcript, req.params.id]); res.json({ ok: true }); });
// Favorites — toggle the is_favorite flag. Returns the new state so the
// client can update its UI without a separate read. When favorited, the
// front-end auto-tags into a "Favorites" stockpile folder (if one exists
// with that name); we don't enforce that server-side so the user can
// rename the folder freely.
app.post('/history/:id/favorite', (req, res) => {
  const id = req.params.id;
  const want = (req.body.favorite === undefined) ? null : (req.body.favorite ? 1 : 0);
  // If want is null, toggle. Otherwise set explicitly.
  const cur = dbAll('SELECT is_favorite FROM history WHERE id=?', [id]);
  if (!cur.length) return res.status(404).json({ error: 'Track not found' });
  const next = (want === null) ? (cur[0].is_favorite ? 0 : 1) : want;
  dbRun('UPDATE history SET is_favorite=? WHERE id=?', [next, id]);
  res.json({ ok: true, favorite: next === 1 });
});
// Per-track free-form notepad from the mini player. Replaces the notes
// column (already existed) with a more permissive POST.
app.post('/history/:id/user-notes', (req, res) => {
  const id = req.params.id;
  const notes = String(req.body.notes || '').slice(0, 10000);  // cap at 10KB
  dbRun('UPDATE history SET user_notes=? WHERE id=?', [notes, id]);
  res.json({ ok: true });
});
app.get('/history',  (_, res) => res.json(dbAll('SELECT * FROM history ORDER BY created_at DESC LIMIT 500')));
app.delete('/history/:id', (req, res) => { dbRun('DELETE FROM history WHERE id=?', [req.params.id]); broadcastEvent('history-changed', { reason: 'delete', historyId: req.params.id }); res.json({ ok: true }); });

// Move a file to a different folder and update its path in history
app.post('/history/:id/move', (req, res) => {
  const { dest_dir } = req.body;
  const id = req.params.id;
  if (!dest_dir) return res.status(400).json({ error: 'Missing dest_dir' });

  const row = dbAll('SELECT file_path FROM history WHERE id=?', [id]);
  if (!row.length || !row[0].file_path) return res.status(404).json({ error: 'Track not found' });

  const oldPath = row[0].file_path;
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found on disk: ' + oldPath });

  // Detect "already at destination" BEFORE doing anything. If the file is
  // already inside dest_dir (or a subfolder of it), there's nothing to
  // move. The previous version would silently no-op and report success,
  // which made it look like every selected track was sent even when some
  // were already in stockpile. We now return a distinct status so the
  // frontend can show an honest count.
  const normalize = (p) => path.resolve(p).toLowerCase();
  const oldNorm = normalize(oldPath);
  const destNorm = normalize(dest_dir);
  if (oldNorm.startsWith(destNorm + path.sep) || oldNorm === destNorm) {
    return res.json({ ok: true, status: 'already_at_destination', newPath: oldPath });
  }

  if (!fs.existsSync(dest_dir)) fs.mkdirSync(dest_dir, { recursive: true });

  const filename = path.basename(oldPath);
  let newPath = path.join(dest_dir, filename);

  // If the destination file already exists, avoid overwriting it — auto-
  // rename with a numeric suffix. This prevents the case where a user
  // moves a track called "song.mp3" to a folder that already has a
  // different "song.mp3", silently destroying the existing file.
  if (fs.existsSync(newPath)) {
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);
    let n = 2;
    while (fs.existsSync(path.join(dest_dir, `${stem} (${n})${ext}`))) {
      n++;
      if (n > 999) {
        return res.status(500).json({ error: 'Destination already has too many similarly-named files' });
      }
    }
    newPath = path.join(dest_dir, `${stem} (${n})${ext}`);
  }

  try {
    fs.renameSync(oldPath, newPath);
    dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, id]);
    slog('Moved: ' + oldPath + ' → ' + newPath);
    res.json({ ok: true, status: 'moved', newPath });
  } catch (e) {
    // renameSync fails across drives — fall back to copy+delete
    try {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, id]);
      slog('Moved (copy): ' + oldPath + ' → ' + newPath);
      res.json({ ok: true, status: 'moved', newPath });
    } catch (e2) {
      slog('Move failed: ' + e2.message);
      res.status(500).json({ error: 'Move failed: ' + e2.message });
    }
  }
});

// Bulk move — move multiple tracks at once
app.post('/history/bulk-move', (req, res) => {
  const { ids, dest_dir } = req.body;
  if (!ids || !ids.length || !dest_dir) return res.status(400).json({ error: 'Missing ids or dest_dir' });

  if (!fs.existsSync(dest_dir)) fs.mkdirSync(dest_dir, { recursive: true });

  let moved = 0, errors = [];
  for (const id of ids) {
    const row = dbAll('SELECT file_path FROM history WHERE id=?', [id]);
    if (!row.length || !row[0].file_path) { errors.push('ID ' + id + ': not found'); continue; }
    const oldPath = row[0].file_path;
    if (!fs.existsSync(oldPath)) { errors.push(path.basename(oldPath) + ': file missing'); continue; }
    const newPath = path.join(dest_dir, path.basename(oldPath));
    try {
      fs.renameSync(oldPath, newPath);
      dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, id]);
      moved++;
    } catch {
      try {
        fs.copyFileSync(oldPath, newPath);
        fs.unlinkSync(oldPath);
        dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, id]);
        moved++;
      } catch (e2) { errors.push(path.basename(oldPath) + ': ' + e2.message); }
    }
  }
  slog('Bulk move: ' + moved + '/' + ids.length + ' to ' + dest_dir);
  res.json({ ok: true, moved, total: ids.length, errors });
});

// ════════════════════════════════════════════════════════════════════════════
// Stockpile organization
// ════════════════════════════════════════════════════════════════════════════
//
// Two-stage flow:
//   1. Tag in history (cheap, reversible) — adds a row to stockpile_tags.
//      File stays at its current location. User can change tags freely.
//   2. Commit to stockpile (irreversible) — moves the file into
//      {stockpile_root}/{primary_folder_name}/. Sets history.stockpile_committed=1.
//
// The system suggests folders for untagged tracks based on:
//   - Filename artist detection (e.g. "Mozzy type beat" → folders with Mozzy seed)
//   - Mood profile distance to folder centroids
//
// Folders are user-created. The app never creates folders automatically.

// ── Fuzzy artist-seed matcher ───────────────────────────────────────────────
// Real-world filenames are inconsistent: "EBK Jaybo" vs "EBK Jaayboo",
// "Sleepy Hallow" vs "Sleepy_Hallow", "Drakeo" vs "Drakéo", typos, casing,
// "type beat" filler, etc. Substring match misses too much.
//
// Strategy: normalize both sides, then per-word fuzzy compare with a small
// edit-distance budget. Matches must cover ALL words in the seed (multi-word
// artist names like "Sleepy Hallow" only match if both words appear close
// to each other in the haystack — a "Sleepy" by itself is not a match).

// Strip diacritics, lowercase, replace separators with spaces, drop common
// filler ("type beat", "official", "music video", file extensions etc).
function normalizeForMatch(s) {
  if (!s) return '';
  let n = String(s).toLowerCase();
  // Strip diacritics (Drakéo → Drakeo)
  n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Replace separators with spaces
  n = n.replace(/[_\-.\(\)\[\]/\\]+/g, ' ');
  // Drop file extensions
  n = n.replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus|mp4|webm)\b/g, ' ');
  // Drop common filler that pollutes filenames
  n = n.replace(/\b(type beat|official|music video|audio|hd|hq|lyrics|lyric video|prod|prod by|prod\.|free|leak|loop|sample pack|clip officiel|clean|explicit|remix|extended|edit|version)\b/g, ' ');
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

// Levenshtein distance, capped — we only ever care about <=3 so we can short-circuit.
function levenshtein(a, b, maxDist) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost  // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1; // can't get below maxDist anymore
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// Allowed edit distance scales with word length — short words must match
// exactly (else "EBK" matches "ENB"), longer words tolerate more.
// We use the LONGER of the two words being compared so that haystack words
// with extra letters (e.g. "Jaayboo" vs seed "Jaybo") still get a fair budget.
function fuzzyWordEditBudget(seedWord, hayWord) {
  const len = Math.max(seedWord.length, (hayWord || '').length);
  if (len <= 3) return 0;          // exact only
  if (len <= 5) return 1;          // 1 typo
  if (len <= 8) return 2;          // 2 typos
  return 3;                        // long names: 3 typos
}

// Does any word in `hayWords` match `seedWord` within the budget?
// Also handles "glued" words like "MozzyType" where the seed starts the word.
function hayHasWordFuzzy(hayWords, seedWord) {
  // Exact word match always wins
  if (hayWords.includes(seedWord)) return true;

  for (const w of hayWords) {
    if (w === seedWord) return true;

    // Prefix containment in either direction. For seed "Mozzy":
    //   "MozzyType" starts with "Mozzy"            → match
    //   "Moz" is a prefix of "Mozzy" but too short → require min 4 chars
    // For seed "Jaybo" vs hayword "Jaayboo": handled by edit distance below,
    // not prefix (since neither starts with the other).
    if (seedWord.length >= 4) {
      if (w.startsWith(seedWord)) return true;
      if (seedWord.startsWith(w) && w.length >= 4) return true;
    }

    // Substring containment (seed inside a longer hayword): "ebkjaybo" in "ebkjaybooo"
    if (seedWord.length >= 4 && w.includes(seedWord)) return true;

    // Edit distance — use the longer-word budget so the haystack having
    // extra letters doesn't disqualify it.
    const budget = fuzzyWordEditBudget(seedWord, w);
    if (budget === 0) continue;
    if (Math.abs(w.length - seedWord.length) > budget) continue;
    if (levenshtein(w, seedWord, budget) <= budget) return true;
  }
  return false;
}

// Match a seed (potentially multi-word like "sleepy hallow" or "ebk jaybo")
// against a haystack. ALL seed words must appear as fuzzy matches in the
// haystack. Returns a confidence ratio: 1.0 = all words matched exactly,
// lower for fuzzy matches.
function matchSeed(haystackNorm, hayWords, seedNorm) {
  const seedWords = seedNorm.split(' ').filter(Boolean);
  if (!seedWords.length) return 0;
  let matched = 0;
  let exactMatches = 0;
  for (const sw of seedWords) {
    if (hayWords.includes(sw)) {
      matched++;
      exactMatches++;
    } else if (hayHasWordFuzzy(hayWords, sw)) {
      matched++;
    }
  }
  if (matched < seedWords.length) return 0;
  // Confidence: fully-exact = 1.0, fully-fuzzy = 0.85.
  // Sliding scale based on how many words were exact.
  const exactRatio = exactMatches / seedWords.length;
  return 0.85 + 0.15 * exactRatio;
}

// Top-level: given a haystack string and a list of seeds, return the best
// match info. { matched: bool, seed: string|null, confidence: 0..1 }
function findArtistMatch(rawHaystack, seeds) {
  const haystackNorm = normalizeForMatch(rawHaystack);
  const hayWords = haystackNorm.split(' ').filter(Boolean);
  let best = { matched: false, seed: null, confidence: 0 };
  for (const rawSeed of seeds) {
    const seedNorm = normalizeForMatch(rawSeed);
    if (!seedNorm) continue;
    const c = matchSeed(haystackNorm, hayWords, seedNorm);
    if (c > best.confidence) {
      best = { matched: true, seed: rawSeed, confidence: c };
    }
  }
  return best;
}

// List all folders with track counts.
app.get('/stockpile/folders', (_, res) => {
  try {
    const rows = dbAll(`
      SELECT f.id, f.name, f.description, f.artist_seeds, f.mood_centroid,
             f.color, f.created_at,
             COALESCE((SELECT COUNT(*) FROM stockpile_tags t WHERE t.folder_id = f.id), 0) AS track_count
      FROM stockpile_folders f
      ORDER BY f.name COLLATE NOCASE
    `);
    res.json({ folders: rows });
  } catch (e) {
    slog('stockpile/folders failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create a new folder. Body: { name, description?, artist_seeds? (string or []), color? }
app.post('/stockpile/folders', (req, res) => {
  const { name, description, artist_seeds, color } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Folder name required' });
  }
  const seedsCsv = Array.isArray(artist_seeds)
    ? artist_seeds.join(',')
    : String(artist_seeds || '').trim();
  try {
    dbRun(
      `INSERT INTO stockpile_folders (name, description, artist_seeds, color) VALUES (?, ?, ?, ?)`,
      [String(name).trim(), description || null, seedsCsv || null, color || null]
    );
    const created = dbAll('SELECT * FROM stockpile_folders WHERE name=?', [String(name).trim()])[0];
    saveDB();
    slog('stockpile: created folder "' + name + '"');
    res.json({ ok: true, folder: created });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A folder with that name already exists' });
    }
    slog('stockpile/folders POST failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update folder metadata.
app.put('/stockpile/folders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description, artist_seeds, color, stockpile_root } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const seedsCsv = Array.isArray(artist_seeds) ? artist_seeds.join(',') : artist_seeds;
  try {
    // If the name is changing AND we have a stockpile root, also rename
    // the corresponding folder on disk. We do this BEFORE the DB update
    // so we can bail without inconsistency if the FS rename fails.
    let renameInfo = null;
    if (name !== undefined && stockpile_root) {
      const oldRows = dbAll('SELECT name FROM stockpile_folders WHERE id=?', [id]);
      const oldName = oldRows[0]?.name;
      const newName = String(name).trim();
      if (oldName && oldName !== newName) {
        const oldDir = path.join(stockpile_root, safeFolderName(oldName));
        const newDir = path.join(stockpile_root, safeFolderName(newName));
        if (fs.existsSync(oldDir) && oldDir !== newDir) {
          // Target may already exist if the new name collides with another
          // folder we didn't make — refuse rather than mix files
          if (fs.existsSync(newDir)) {
            return res.status(409).json({
              error: 'A folder named "' + newName + '" already exists on disk. ' +
                     'Rename or move it manually first.'
            });
          }
          try {
            fs.renameSync(oldDir, newDir);
            renameInfo = { oldDir, newDir };
            slog('folder rename on disk: ' + oldDir + ' -> ' + newDir);
            // Update all history rows that referenced files in the old path.
            // Simple string replace at the dir level — safe because we own
            // both paths and they share the same parent.
            const affected = dbAll(
              'SELECT id, file_path FROM history WHERE file_path LIKE ?',
              [oldDir + '%']
            );
            for (const row of affected) {
              const newFp = newDir + row.file_path.slice(oldDir.length);
              dbRun('UPDATE history SET file_path=? WHERE id=?', [newFp, row.id]);
            }
            if (affected.length) {
              slog('folder rename: updated ' + affected.length + ' file_path rows');
            }
          } catch (e) {
            slog('folder rename failed: ' + e.message);
            return res.status(500).json({ error: 'Folder rename failed: ' + e.message });
          }
        }
      }
    }

    const sets = [];
    const params = [];
    if (name !== undefined)         { sets.push('name=?');         params.push(String(name).trim()); }
    if (description !== undefined)  { sets.push('description=?');  params.push(description || null); }
    if (seedsCsv !== undefined)     { sets.push('artist_seeds=?'); params.push(seedsCsv || null); }
    if (color !== undefined)        { sets.push('color=?');        params.push(color || null); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);
    dbRun(`UPDATE stockpile_folders SET ${sets.join(', ')} WHERE id=?`, params);
    saveDB();
    if (renameInfo) {
      broadcastEvent('history-changed', { reason: 'folder-renamed', folderId: id });
    }
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A folder with that name already exists' });
    }
    slog('stockpile/folders PUT failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a folder. Tags pointing at it are removed; tracks themselves are
// preserved. If stockpile_root is supplied, files currently inside this
// folder on disk are moved back to the root so nothing gets orphaned
// (and the now-empty folder dir is removed).
app.delete('/stockpile/folders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  const stockpile_root = req.query.stockpile_root || null;
  try {
    // Find tracks that had THIS folder as their primary — they'll need
    // their next-oldest tag promoted (or moved back to root if no other tags).
    const affectedTracks = dbAll(`
      SELECT history_id FROM stockpile_tags WHERE folder_id=? AND is_primary=1
    `, [id]).map(r => r.history_id);

    // Remember the folder's name for FS cleanup BEFORE we delete the row
    const folderRow = dbAll('SELECT name FROM stockpile_folders WHERE id=?', [id])[0];

    dbRun('DELETE FROM stockpile_tags WHERE folder_id=?', [id]);
    dbRun('DELETE FROM stockpile_folders WHERE id=?', [id]);
    saveDB();

    // Re-commit each affected track to its new primary (or root)
    const commits = [];
    if (stockpile_root) {
      for (const histId of affectedTracks) {
        const r = commitTrackToPrimary(histId, stockpile_root);
        if (r && r.moved) commits.push({ historyId: histId, newPath: r.newPath });
      }
      // Clean up the now-empty folder directory if it exists. We do NOT
      // recursively delete — only remove if empty, to avoid surprises.
      if (folderRow) {
        const dir = path.join(stockpile_root, safeFolderName(folderRow.name));
        try {
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            slog('removed empty folder dir: ' + dir);
          }
        } catch {}
      }
    }
    if (commits.length) {
      broadcastEvent('history-changed', { reason: 'folder-deleted', folderId: id });
    }
    res.json({ ok: true, moved: commits.length });
  } catch (e) {
    slog('stockpile/folders DELETE failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// List tracks tagged into a folder.
app.get('/stockpile/folders/:id/tracks', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const rows = dbAll(`
      SELECT h.*, t.confidence, t.source AS tag_source, t.is_primary,
             m.energy, m.tonality, m.density, m.tempo_pos, m.label AS mood_label
      FROM stockpile_tags t
      JOIN history h ON h.id = t.history_id
      LEFT JOIN track_mood m ON m.history_id = h.id
      WHERE t.folder_id = ?
      ORDER BY h.created_at DESC
    `, [id]);
    res.json({ tracks: rows });
  } catch (e) {
    slog('stockpile folder tracks failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Preview which untagged tracks would auto-match a folder. Useful right
// after folder creation so the user can see "X tracks match — tag them all"
// before actually committing. Pass `?include_tagged=1` to also include tracks
// already tagged into other folders (re-tagging via this folder is allowed).
//
// Matching strategy:
//   - Strong match (artist seed in filename or title) → confidence 0.85
//   - Mood centroid match (only when folder has tagged tracks already) → up to 0.6
// We dedupe per track and return both kinds with `match_type` so the UI
// can group them.
app.get('/stockpile/folders/:id/matches', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const includeTagged = req.query.include_tagged === '1';
  const minConf = parseFloat(req.query.min_confidence || '0.4');

  try {
    const folderRows = dbAll('SELECT * FROM stockpile_folders WHERE id=?', [id]);
    if (!folderRows.length) return res.status(404).json({ error: 'Folder not found' });
    const folder = folderRows[0];

    const seeds = (folder.artist_seeds || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let centroid = null;
    try { if (folder.mood_centroid) centroid = JSON.parse(folder.mood_centroid); } catch {}

    // Pull candidate tracks. If !includeTagged, exclude tracks that already
    // have any tag in stockpile_tags. Either way, exclude tracks already in
    // THIS folder.
    let sql, params;
    if (includeTagged) {
      sql = `
        SELECT h.id, h.title, h.file_path, h.bpm, h.key_note, h.key_mode,
               m.energy, m.tonality, m.density, m.tempo_pos
        FROM history h
        LEFT JOIN track_mood m ON m.history_id = h.id
        WHERE NOT EXISTS (SELECT 1 FROM stockpile_tags t2 WHERE t2.history_id = h.id AND t2.folder_id = ?)
        ORDER BY h.created_at DESC
        LIMIT 1000
      `;
      params = [id];
    } else {
      sql = `
        SELECT h.id, h.title, h.file_path, h.bpm, h.key_note, h.key_mode,
               m.energy, m.tonality, m.density, m.tempo_pos
        FROM history h
        LEFT JOIN track_mood m ON m.history_id = h.id
        WHERE NOT EXISTS (SELECT 1 FROM stockpile_tags t2 WHERE t2.history_id = h.id)
        ORDER BY h.created_at DESC
        LIMIT 1000
      `;
      params = [];
    }
    const candidates = dbAll(sql, params);

    const matches = [];
    for (const c of candidates) {
      const rawHay = ((c.file_path || '') + ' ' + (c.title || ''));
      let confidence = 0;
      let matchType = null;
      let matchedSeed = null;

      // Strong: fuzzy artist seed match
      const am = findArtistMatch(rawHay, seeds);
      if (am.matched) {
        confidence = am.confidence;
        matchType = 'artist';
        matchedSeed = am.seed;
      }

      // Secondary: mood centroid distance (only if no artist match yet)
      if (!matchType && centroid && c.energy !== null && c.energy !== undefined) {
        const d = Math.sqrt(
          Math.pow((centroid.energy   ?? 0) - (c.energy   ?? 0), 2) +
          Math.pow((centroid.tonality ?? 0) - (c.tonality ?? 0), 2) +
          Math.pow((centroid.density  ?? 0) - (c.density  ?? 0), 2) +
          Math.pow((centroid.tempo_pos?? 0) - (c.tempo_pos?? 0), 2)
        );
        const moodConf = Math.max(0, 0.6 - (d * 0.3));
        if (moodConf > 0.2) {
          confidence = moodConf;
          matchType = 'mood';
        }
      }

      if (confidence >= minConf) {
        matches.push({
          id: c.id,
          title: c.title || (c.file_path || '').split(/[/\\]/).pop(),
          file_path: c.file_path,
          bpm: c.bpm, key_note: c.key_note, key_mode: c.key_mode,
          confidence: Math.round(confidence * 100) / 100,
          match_type: matchType,
          matched_seed: matchedSeed,
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);
    res.json({
      folder: { id: folder.id, name: folder.name, seeds, has_centroid: !!centroid },
      matches,
      counts: {
        artist: matches.filter(m => m.match_type === 'artist').length,
        mood:   matches.filter(m => m.match_type === 'mood').length,
        total:  matches.length,
      },
    });
  } catch (e) {
    slog('stockpile matches failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk-tag a list of tracks into a folder. Body: { history_ids: [], source?, override? }
// Skips tracks already tagged in this folder unless override=true.
// Used for the "Tag all matches" workflow.
app.post('/stockpile/folders/:id/bulk-tag', (req, res) => {
  const folderId = parseInt(req.params.id, 10);
  const { history_ids, source, override, confidences } = req.body || {};
  if (!folderId || !Array.isArray(history_ids) || !history_ids.length) {
    return res.status(400).json({ error: 'Missing folder_id or history_ids' });
  }
  const confMap = (confidences && typeof confidences === 'object') ? confidences : {};

  let tagged = 0;
  let skipped = 0;
  const errors = [];

  try {
    for (const hid of history_ids) {
      const id = parseInt(hid, 10);
      if (!id) { skipped++; continue; }
      const existing = dbAll('SELECT id FROM stockpile_tags WHERE history_id=? AND folder_id=?', [id, folderId]);
      if (existing.length && !override) { skipped++; continue; }

      // If this track has another primary, keep it primary unless this is its
      // first tag (then this becomes primary). User's expectation when bulk-
      // tagging: track gets the folder, but if the track was already in another
      // folder we don't yank its primary away silently.
      const otherTags = dbAll('SELECT is_primary FROM stockpile_tags WHERE history_id=?', [id]);
      const isPrimary = otherTags.length === 0 ? 1 : 0;

      const conf = (confMap[String(id)] !== undefined) ? confMap[String(id)] : null;

      if (existing.length) {
        dbRun(`UPDATE stockpile_tags SET source=?, confidence=? WHERE id=?`,
          [source || 'bulk-auto', conf, existing[0].id]);
      } else {
        dbRun(`INSERT INTO stockpile_tags (history_id, folder_id, is_primary, source, confidence)
               VALUES (?, ?, ?, ?, ?)`,
          [id, folderId, isPrimary, source || 'bulk-auto', conf]);
      }
      tagged++;
    }
    refreshFolderCentroid(folderId);
    saveDB();
    slog('stockpile bulk-tag: folder=' + folderId + ' tagged=' + tagged + ' skipped=' + skipped);
    res.json({ ok: true, tagged, skipped, errors });
  } catch (e) {
    slog('stockpile bulk-tag failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Tag a track into a folder. Body: { folder_id, is_primary?, source? }
// ── File-management helpers for tag-driven folder organization ──────────
// When you tag a track, its file should physically move into a folder
// named after the tag. Multiple tags? First one added wins (becomes
// "primary" and decides the location). These helpers handle the moves,
// collisions, error recovery, and DB updates so the rest of the code
// just says "make this track live in folder X."

// Strip filesystem-unsafe characters from a folder name. Reserved Windows
// names (CON, PRN, AUX...) are unlikely to come up for music genres but
// the regex covers them implicitly by replacing < > : " / \ | ? *
function safeFolderName(name) {
  return String(name || '').replace(/[<>:"/\\|?*]+/g, '_').trim() || 'Untitled';
}

// Resolve a destination path, suffixing "(2)", "(3)" if needed to avoid
// overwriting an existing file. Caps at 999 so a runaway loop can't
// hang. Returns null if even the cap is exhausted (very unlikely).
function uniqueDestPath(destDir, originalBase) {
  const ext = path.extname(originalBase);
  const stem = path.basename(originalBase, ext);
  let candidate = path.join(destDir, originalBase);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 2; i <= 999; i++) {
    candidate = path.join(destDir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Move a file across drives if needed. fs.renameSync fails with EXDEV on
// cross-drive moves on Windows — we fall back to copy+unlink in that case.
// Returns the actual destination path (after collision suffixing) or
// throws with a useful message.
function moveFileSafely(srcPath, destDir) {
  if (!fs.existsSync(srcPath)) {
    throw new Error('Source file missing: ' + srcPath);
  }
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const dest = uniqueDestPath(destDir, path.basename(srcPath));
  if (!dest) throw new Error('Could not find a non-colliding name in ' + destDir);
  // Same-folder no-op (rename to itself) — return early
  if (path.resolve(dest) === path.resolve(srcPath)) return srcPath;
  try {
    fs.renameSync(srcPath, dest);
  } catch (e) {
    // EXDEV (cross-drive) or other failures — copy then delete original
    fs.copyFileSync(srcPath, dest);
    try { fs.unlinkSync(srcPath); } catch {}
  }
  return dest;
}

// Move a track's file to wherever its primary tag says it should live.
// If `stockpileRoot` is provided AND the track has no primary tag, move
// it back to the stockpile root (used on untag-of-last-primary).
// Returns { moved: bool, newPath, reason } describing what happened.
// Never throws — errors are logged and reported in the return object,
// so callers (which run synchronously after tag mutations) can decide
// whether to surface them.
function commitTrackToPrimary(historyId, stockpileRoot) {
  try {
    const trackRows = dbAll('SELECT * FROM history WHERE id=?', [historyId]);
    if (!trackRows.length) return { moved: false, reason: 'track-not-found' };
    const track = trackRows[0];

    // Most-recent primary tag wins. If there are zero primaries but the
    // track has tags, we promote the oldest one (matches "first tag
    // added" priority rule from the spec).
    let primary = dbAll(`
      SELECT f.id, f.name FROM stockpile_tags t
      JOIN stockpile_folders f ON f.id = t.folder_id
      WHERE t.history_id = ? AND t.is_primary = 1
      ORDER BY t.created_at DESC LIMIT 1
    `, [historyId])[0];

    if (!primary) {
      // No primary marked — promote the first-added tag, if any
      const oldest = dbAll(`
        SELECT t.id, t.folder_id, f.name FROM stockpile_tags t
        JOIN stockpile_folders f ON f.id = t.folder_id
        WHERE t.history_id = ?
        ORDER BY t.created_at ASC LIMIT 1
      `, [historyId])[0];
      if (oldest) {
        dbRun('UPDATE stockpile_tags SET is_primary=0 WHERE history_id=?', [historyId]);
        dbRun('UPDATE stockpile_tags SET is_primary=1 WHERE id=?', [oldest.id]);
        primary = { id: oldest.folder_id, name: oldest.name };
      }
    }

    // No tags at all? Move file back to stockpile root if requested.
    if (!primary) {
      if (!stockpileRoot) return { moved: false, reason: 'no-primary-no-root' };
      if (!fs.existsSync(track.file_path)) {
        return { moved: false, reason: 'source-missing', path: track.file_path };
      }
      // If file is already at the stockpile root (not in a subfolder), nothing to do
      if (path.dirname(track.file_path) === path.resolve(stockpileRoot)) {
        return { moved: false, reason: 'already-at-root' };
      }
      const newPath = moveFileSafely(track.file_path, stockpileRoot);
      dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, historyId]);
      saveDB();
      return { moved: true, newPath, reason: 'untagged-to-root' };
    }

    // Has a primary — move into that folder
    if (!stockpileRoot) return { moved: false, reason: 'no-stockpile-root' };
    if (!fs.existsSync(track.file_path)) {
      return { moved: false, reason: 'source-missing', path: track.file_path };
    }
    const destDir = path.join(stockpileRoot, safeFolderName(primary.name));
    // Skip if already inside this folder (collision check uniqueDestPath
    // would otherwise rename it to "track (2).wav" needlessly)
    if (path.resolve(path.dirname(track.file_path)) === path.resolve(destDir)) {
      return { moved: false, reason: 'already-in-folder' };
    }
    const newPath = moveFileSafely(track.file_path, destDir);
    dbRun('UPDATE history SET file_path=?, stockpile_committed=1 WHERE id=?', [newPath, historyId]);
    saveDB();
    slog('auto-commit: ' + track.file_path + ' -> ' + newPath);
    return { moved: true, newPath, reason: 'committed-to-folder' };
  } catch (e) {
    slog('commitTrackToPrimary failed for id=' + historyId + ': ' + e.message);
    return { moved: false, reason: 'error', error: e.message };
  }
}


app.post('/stockpile/tracks/:historyId/tags', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  const { folder_id, is_primary, source, confidence, stockpile_root } = req.body || {};
  if (!historyId || !folder_id) return res.status(400).json({ error: 'Missing ids' });
  try {
    // First-tag-wins rule: if the track has no existing tags, this one
    // automatically becomes primary even if the caller didn't pass
    // is_primary. The renderer doesn't always know whether a track is
    // freshly tagged (auto-match batches in particular), so we infer.
    const hasExisting = dbAll('SELECT COUNT(*) AS n FROM stockpile_tags WHERE history_id=?', [historyId])[0].n > 0;
    const effectivePrimary = is_primary || !hasExisting;

    const existing = dbAll('SELECT id FROM stockpile_tags WHERE history_id=? AND folder_id=?', [historyId, folder_id]);
    if (existing.length) {
      dbRun(`UPDATE stockpile_tags SET is_primary=?, source=?, confidence=? WHERE id=?`,
        [effectivePrimary ? 1 : 0, source || 'manual', confidence || null, existing[0].id]);
    } else {
      // If this becomes the new primary, unset other primaries for this track.
      if (effectivePrimary) {
        dbRun('UPDATE stockpile_tags SET is_primary=0 WHERE history_id=?', [historyId]);
      }
      dbRun(`INSERT INTO stockpile_tags (history_id, folder_id, is_primary, source, confidence)
             VALUES (?, ?, ?, ?, ?)`,
        [historyId, folder_id, effectivePrimary ? 1 : 0, source || 'manual', confidence || null]);
    }
    // Update folder centroid using the tagged track's mood (if known).
    refreshFolderCentroid(folder_id);
    saveDB();

    // Auto-commit: if the renderer passed stockpile_root AND this tag is
    // (now) primary, move the file into its folder on disk. Non-primary
    // tag adds are virtual; only the primary changes the location.
    let commitResult = null;
    if (effectivePrimary && stockpile_root) {
      commitResult = commitTrackToPrimary(historyId, stockpile_root);
      if (commitResult && commitResult.moved) {
        broadcastEvent('history-changed', { reason: 'auto-commit', historyId });
      }
    }
    res.json({ ok: true, commit: commitResult });
  } catch (e) {
    slog('stockpile tag failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Remove a tag.
app.delete('/stockpile/tracks/:historyId/tags/:folderId', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  const folderId = parseInt(req.params.folderId, 10);
  // stockpile_root comes in as a query string param on DELETE — bodies
  // are awkward there. Renderer attaches it so we can re-commit after
  // the untag if the file needs to move.
  const stockpile_root = req.query.stockpile_root || null;
  try {
    // Check if the tag we're about to remove was the primary. If yes,
    // we'll need to promote another tag (or move the file back to root).
    const removed = dbAll(
      'SELECT is_primary FROM stockpile_tags WHERE history_id=? AND folder_id=?',
      [historyId, folderId]
    )[0];
    const wasPrimary = removed && removed.is_primary === 1;

    dbRun('DELETE FROM stockpile_tags WHERE history_id=? AND folder_id=?', [historyId, folderId]);

    // If we just removed the primary, the spec says: promote the next
    // remaining tag (oldest first — matches "first tag added" rule).
    // If no tags remain, the track goes back to the stockpile root.
    if (wasPrimary) {
      const next = dbAll(`
        SELECT id, folder_id FROM stockpile_tags
        WHERE history_id=? ORDER BY created_at ASC LIMIT 1
      `, [historyId])[0];
      if (next) {
        dbRun('UPDATE stockpile_tags SET is_primary=1 WHERE id=?', [next.id]);
      }
      // Else: no tags left, commitTrackToPrimary will move file to root
    }

    refreshFolderCentroid(folderId);
    saveDB();

    // Auto-commit the move (to new primary's folder, or back to root).
    let commitResult = null;
    if (wasPrimary && stockpile_root) {
      commitResult = commitTrackToPrimary(historyId, stockpile_root);
      if (commitResult && commitResult.moved) {
        broadcastEvent('history-changed', { reason: 'auto-recommit', historyId });
      }
    }
    res.json({ ok: true, commit: commitResult });
  } catch (e) {
    slog('stockpile untag failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Auto-match: scan a track against all folder seed-artists and auto-tag
// any folders whose seeds appear in the title/path with high confidence.
// Called after download completes. Returns the folders that were tagged
// so the client can show a notification ("→ Tagged into 2 folders").
//
// Threshold: 0.85 confidence (fuzzy match on artist name). This is high
// enough to avoid false positives like "Lil B" matching every track with
// "lil" in the title. Lower confidences still surface as suggestions in
// the UI but don't auto-tag.
app.post('/stockpile/tracks/:historyId/auto-match', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  const track = dbAll('SELECT title, file_path FROM history WHERE id=?', [historyId]);
  if (!track.length) return res.status(404).json({ error: 'Track not found' });
  const hay = ((track[0].file_path || '') + ' ' + (track[0].title || '')).toLowerCase();
  const folders = dbAll(`SELECT id, name, artist_seeds FROM stockpile_folders WHERE artist_seeds IS NOT NULL AND artist_seeds != ''`);
  const tagged = [];
  for (const f of folders) {
    const seeds = (f.artist_seeds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!seeds.length) continue;
    const m = findArtistMatch(hay, seeds);
    if (m.matched && m.confidence >= 0.85) {
      // Already tagged into this folder? Skip.
      const existing = dbAll('SELECT id FROM stockpile_tags WHERE history_id=? AND folder_id=?', [historyId, f.id]);
      if (existing.length) continue;
      dbRun(`INSERT INTO stockpile_tags (history_id, folder_id, is_primary, source, confidence)
             VALUES (?, ?, ?, ?, ?)`,
        [historyId, f.id, 0, 'auto-match-on-download', m.confidence]);
      tagged.push({ folder_id: f.id, folder_name: f.name, seed: m.seed, confidence: m.confidence });
      refreshFolderCentroid(f.id);
    }
  }
  if (tagged.length) saveDB();
  res.json({ ok: true, tagged });
});

// All tags for a track.
app.get('/stockpile/tracks/:historyId/tags', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  try {
    const rows = dbAll(`
      SELECT f.id AS folder_id, f.name, f.color, t.is_primary, t.confidence, t.source
      FROM stockpile_tags t
      JOIN stockpile_folders f ON f.id = t.folder_id
      WHERE t.history_id = ?
      ORDER BY t.is_primary DESC, f.name
    `, [historyId]);
    res.json({ tags: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk endpoint: returns ALL tags across ALL history rows grouped by
// history_id. Used by the History tab to avoid hammering the server with
// hundreds of single-row fetch() calls (which caused a visible reload
// jiggle as each row's tag strip painted asynchronously). One call
// returns everything in <50ms even with 1000+ tags.
app.get('/stockpile/tags-by-history', (_, res) => {
  try {
    const rows = dbAll(`
      SELECT t.history_id, f.id AS folder_id, f.name, f.color,
             t.is_primary, t.confidence, t.source
      FROM stockpile_tags t
      JOIN stockpile_folders f ON f.id = t.folder_id
      ORDER BY t.history_id, t.is_primary DESC, f.name
    `);
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.history_id]) grouped[row.history_id] = [];
      grouped[row.history_id].push({
        folder_id: row.folder_id,
        name: row.name,
        color: row.color,
        is_primary: row.is_primary,
        confidence: row.confidence,
        source: row.source,
      });
    }
    res.json({ tags_by_history: grouped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Suggest folders for a track. Combines filename artist detection + mood distance.
app.get('/stockpile/tracks/:historyId/suggestions', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  try {
    const trackRows = dbAll('SELECT id, title, file_path FROM history WHERE id=?', [historyId]);
    if (!trackRows.length) return res.status(404).json({ error: 'Track not found' });
    const track = trackRows[0];

    // Detect artists from filename + title
    const rawHay = ((track.file_path || '') + ' ' + (track.title || ''));
    const detectedArtists = [];

    const folders = dbAll(`SELECT id, name, description, artist_seeds, mood_centroid FROM stockpile_folders`);
    const moodRow = dbAll('SELECT energy, tonality, density, tempo_pos FROM track_mood WHERE history_id=?', [historyId]);
    const trackMood = moodRow.length ? moodRow[0] : null;

    // Build a per-folder description keyword list. The user can type things
    // like "ambient slow dark" in a folder's description and we treat each
    // word as an additional matching signal against the track's title/path.
    // Common stop words are skipped so "is the for of" doesn't false-match.
    const STOP_WORDS = new Set([
      'a','an','the','and','or','but','if','of','for','to','in','on','at','by',
      'with','from','as','is','it','this','that','these','those','beat','beats',
      'music','tracks','folder','collection','type'
    ]);
    const folderKeywords = {};
    for (const f of folders) {
      const desc = (f.description || '').toLowerCase();
      if (!desc) continue;
      folderKeywords[f.id] = desc
        .split(/[\s,.;:!?\-—()]+/)
        .map(w => w.trim())
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    }

    const hayLower = rawHay.toLowerCase();

    const suggestions = [];
    for (const f of folders) {
      let confidence = 0;
      const reasons = [];

      // Artist seed match — strong signal, fuzzy.
      if (f.artist_seeds) {
        const seeds = f.artist_seeds.split(',').map(s => s.trim()).filter(Boolean);
        const am = findArtistMatch(rawHay, seeds);
        if (am.matched) {
          confidence = Math.max(confidence, am.confidence);
          reasons.push('matches artist "' + am.seed + '"');
          if (!detectedArtists.includes(am.seed)) detectedArtists.push(am.seed);
        }
      }

      // Description keyword match — weaker but adds up. Each keyword
      // appearing in the track text contributes up to 0.18 confidence,
      // capped at 0.50 total from this source (so it can't dominate the
      // artist seed signal). Catches things like "ambient" or "dark"
      // in a folder description matching tracks with those words.
      const kw = folderKeywords[f.id];
      if (kw && kw.length) {
        const hits = kw.filter(w => hayLower.includes(w));
        if (hits.length) {
          const kwConf = Math.min(0.50, hits.length * 0.18);
          if (kwConf > confidence) confidence = kwConf;
          else confidence = Math.min(1.0, confidence + kwConf * 0.3);  // additive bonus
          reasons.push('description: ' + hits.slice(0, 3).join(', '));
        }
      }

      // Mood centroid distance — secondary signal.
      if (trackMood && f.mood_centroid) {
        try {
          const c = JSON.parse(f.mood_centroid);
          if (c && c.energy !== undefined) {
            const d = Math.sqrt(
              Math.pow((c.energy   ?? 0) - (trackMood.energy   ?? 0), 2) +
              Math.pow((c.tonality ?? 0) - (trackMood.tonality ?? 0), 2) +
              Math.pow((c.density  ?? 0) - (trackMood.density  ?? 0), 2) +
              Math.pow((c.tempo_pos?? 0) - (trackMood.tempo_pos?? 0), 2)
            );
            // d ranges 0 (identical) to ~2 (opposite). Map to 0..0.6 confidence.
            const moodConf = Math.max(0, 0.6 - (d * 0.3));
            if (moodConf > 0.15) {
              confidence = Math.max(confidence, moodConf);
              reasons.push('mood profile match');
            }
          }
        } catch {}
      }

      if (confidence > 0.15) {
        suggestions.push({
          folder_id: f.id, folder_name: f.name,
          confidence: Math.round(confidence * 100) / 100,
          reasons,
        });
      }
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    res.json({ suggestions: suggestions.slice(0, 5), detected_artists: detectedArtists });
  } catch (e) {
    slog('stockpile suggestions failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Untagged tracks — anything in history without any stockpile tag.
app.get('/stockpile/untagged', (_, res) => {
  try {
    const rows = dbAll(`
      SELECT h.* FROM history h
      WHERE NOT EXISTS (SELECT 1 FROM stockpile_tags t WHERE t.history_id = h.id)
      ORDER BY h.created_at DESC
      LIMIT 200
    `);
    res.json({ tracks: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Commit a tagged track to its primary folder on disk.
// Moves the file from its current location into {stockpile_root}/{folder_name}/
app.post('/stockpile/tracks/:historyId/commit', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  const { stockpile_root } = req.body || {};
  if (!stockpile_root) return res.status(400).json({ error: 'Missing stockpile_root' });

  try {
    const trackRows = dbAll('SELECT * FROM history WHERE id=?', [historyId]);
    if (!trackRows.length) return res.status(404).json({ error: 'Track not found' });
    const track = trackRows[0];

    const tagRows = dbAll(`
      SELECT f.name FROM stockpile_tags t
      JOIN stockpile_folders f ON f.id = t.folder_id
      WHERE t.history_id = ? AND t.is_primary = 1
      LIMIT 1
    `, [historyId]);
    if (!tagRows.length) return res.status(400).json({ error: 'Track has no primary tag' });

    const folderName = tagRows[0].name;
    if (!fs.existsSync(track.file_path)) {
      return res.status(404).json({ error: 'File missing on disk: ' + track.file_path });
    }

    // Sanitize folder name for filesystem use
    const safeName = folderName.replace(/[<>:"/\\|?*]+/g, '_').trim();
    const destDir = path.join(stockpile_root, safeName);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(track.file_path));

    if (destPath === track.file_path) {
      // Already in place
      dbRun('UPDATE history SET stockpile_committed=1 WHERE id=?', [historyId]);
      saveDB();
      return res.json({ ok: true, newPath: destPath, alreadyInPlace: true });
    }

    try {
      fs.renameSync(track.file_path, destPath);
    } catch {
      fs.copyFileSync(track.file_path, destPath);
      try { fs.unlinkSync(track.file_path); } catch {}
    }
    dbRun('UPDATE history SET file_path=?, stockpile_committed=1 WHERE id=?', [destPath, historyId]);
    saveDB();
    slog('stockpile commit: ' + track.file_path + ' → ' + destPath);
    res.json({ ok: true, newPath: destPath });
  } catch (e) {
    slog('stockpile commit failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── File-location repair tool ───────────────────────────────────────────
// Walks every tagged track and verifies its file_path lives inside its
// primary folder's dir. If a file is misplaced (left over from before
// auto-commit existed, or moved by something external), commit it now.
// Also handles "no primary but should have one" — promotes the first tag
// to primary and moves the file.
//
// Returns a summary so the renderer can show "moved 17 of 200 tracks"
// rather than just success/failure. Safe to re-run; idempotent.
app.post('/stockpile/repair-files', (req, res) => {
  const { stockpile_root } = req.body || {};
  if (!stockpile_root) return res.status(400).json({ error: 'Missing stockpile_root' });
  if (!fs.existsSync(stockpile_root)) {
    return res.status(400).json({ error: 'Stockpile root does not exist: ' + stockpile_root });
  }

  const report = { checked: 0, moved: 0, alreadyOk: 0, missing: 0, errors: 0, moves: [] };
  try {
    // All history rows that have at least one tag
    const tagged = dbAll(`
      SELECT DISTINCT h.id FROM history h
      JOIN stockpile_tags t ON t.history_id = h.id
    `).map(r => r.id);

    for (const historyId of tagged) {
      report.checked++;
      const result = commitTrackToPrimary(historyId, stockpile_root);
      if (!result) { report.errors++; continue; }
      switch (result.reason) {
        case 'committed-to-folder':
        case 'untagged-to-root':
          report.moved++;
          if (report.moves.length < 50) {  // cap log payload
            report.moves.push({ historyId, newPath: result.newPath });
          }
          break;
        case 'already-in-folder':
        case 'already-at-root':
          report.alreadyOk++;
          break;
        case 'source-missing':
          report.missing++;
          break;
        case 'error':
          report.errors++;
          slog('repair-files error on id=' + historyId + ': ' + (result.error || 'unknown'));
          break;
      }
    }
    if (report.moved) {
      broadcastEvent('history-changed', { reason: 'repair-files' });
    }
    slog('repair-files: checked=' + report.checked +
         ' moved=' + report.moved +
         ' alreadyOk=' + report.alreadyOk +
         ' missing=' + report.missing +
         ' errors=' + report.errors);
    res.json(report);
  } catch (e) {
    slog('repair-files failed: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/stockpile/tracks/:historyId/mood', (req, res) => {
  const historyId = parseInt(req.params.historyId, 10);
  const { energy, tonality, density, tempo_pos, label } = req.body || {};
  if (energy === undefined) return res.status(400).json({ error: 'Missing mood fields' });
  try {
    const existing = dbAll('SELECT history_id FROM track_mood WHERE history_id=?', [historyId]);
    if (existing.length) {
      dbRun(`UPDATE track_mood SET energy=?, tonality=?, density=?, tempo_pos=?, label=?,
             updated_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE history_id=?`,
        [energy, tonality, density, tempo_pos, label || null, historyId]);
    } else {
      dbRun(`INSERT INTO track_mood (history_id, energy, tonality, density, tempo_pos, label)
             VALUES (?, ?, ?, ?, ?, ?)`,
        [historyId, energy, tonality, density, tempo_pos, label || null]);
    }
    saveDB();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: recompute and cache the mood centroid for a folder. Called after
// any tag change so suggestions stay accurate.
function refreshFolderCentroid(folderId) {
  try {
    const moods = dbAll(`
      SELECT m.energy, m.tonality, m.density, m.tempo_pos
      FROM stockpile_tags t
      JOIN track_mood m ON m.history_id = t.history_id
      WHERE t.folder_id = ?
    `, [folderId]);
    if (!moods.length) {
      dbRun('UPDATE stockpile_folders SET mood_centroid=NULL WHERE id=?', [folderId]);
      return;
    }
    const c = {
      energy:    moods.reduce((s, m) => s + (m.energy    || 0), 0) / moods.length,
      tonality:  moods.reduce((s, m) => s + (m.tonality  || 0), 0) / moods.length,
      density:   moods.reduce((s, m) => s + (m.density   || 0), 0) / moods.length,
      tempo_pos: moods.reduce((s, m) => s + (m.tempo_pos || 0), 0) / moods.length,
    };
    dbRun('UPDATE stockpile_folders SET mood_centroid=? WHERE id=?', [JSON.stringify(c), folderId]);
  } catch (e) {
    slog('refreshFolderCentroid failed: ' + e.message);
  }
}

// Stockpile dashboard summary.
app.get('/stockpile/summary', (_, res) => {
  try {
    const folderCount = dbAll('SELECT COUNT(*) AS n FROM stockpile_folders')[0].n;
    const taggedCount = dbAll('SELECT COUNT(DISTINCT history_id) AS n FROM stockpile_tags')[0].n;
    const committedCount = dbAll('SELECT COUNT(*) AS n FROM history WHERE stockpile_committed=1')[0].n;
    const totalHistory = dbAll('SELECT COUNT(*) AS n FROM history')[0].n;
    res.json({
      folders: folderCount,
      tagged_tracks: taggedCount,
      committed_tracks: committedCount,
      total_history: totalHistory,
      untagged: totalHistory - taggedCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// End stockpile organization
// ════════════════════════════════════════════════════════════════════════════

// Professional audio analysis via librosa Python script
app.get('/analyze', async (req, res) => {
  const filePath = (req.query.path || '').trim();
  slog('analyze request: ' + filePath);

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found: ' + filePath });
  }

  // Find analyze.py — packaged in asar.unpacked, copy to temp first
  const scriptSrc = getResourcePath('analyze.py');
  if (!scriptSrc) {
    slog('analyze.py not found anywhere');
    return res.status(500).json({ error: 'analyze.py not found in app bundle — rebuild required' });
  }
  const scriptTmp = path.join(os.tmpdir(), 'freqphull_analyze.py');
  try {
    fs.copyFileSync(scriptSrc, scriptTmp);
  } catch(e) {
    slog('Failed to copy analyze.py: ' + e.message);
    return res.status(500).json({ error: 'Could not copy analyze.py: ' + e.message });
  }

  // Stream progress via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  sse('status', { message: 'Preparing audio…' });

  // Convert to WAV first — analyze.py uses wave module, can't read MP3/FLAC directly
  const wavTmp = path.join(os.tmpdir(), 'freqphull_analysis_' + Date.now() + '.wav');
  const ffmpegBin = bin('ffmpeg');
  slog('Converting to WAV for analysis: ' + filePath);

  // ASCII-safe input path — see asciiSafeFfmpegPath() comment above.
  // Files with non-ASCII characters in their names get copied to a temp
  // location with a clean name before ffmpeg touches them.
  let ffmpegInputForAnalyze, analyzeTempCopy;
  try {
    const safe = asciiSafeFfmpegPath(filePath);
    ffmpegInputForAnalyze = safe.ffmpegPath;
    analyzeTempCopy = safe.tempCopy;
  } catch (copyErr) {
    slog('analyze: ASCII-safe copy failed: ' + copyErr.message);
    sse('error', { message: 'Could not prepare file: ' + copyErr.message });
    res.end();
    return;
  }

  try {
    await run(ffmpegBin, ['-y', '-i', ffmpegInputForAnalyze, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', wavTmp]);
    slog('WAV ready: ' + wavTmp);
    // Clean up the input copy as soon as ffmpeg is done with it — we
    // don't need it past this point.
    if (analyzeTempCopy) { try { fs.unlinkSync(analyzeTempCopy); } catch {} }
  } catch(e) {
    if (analyzeTempCopy) { try { fs.unlinkSync(analyzeTempCopy); } catch {} }
    slog('ffmpeg conversion failed: ' + e.message);
    // Translate cryptic errors. ffmpeg prints a huge build-config banner
    // before the real error, so we never surface e.message raw.
    const errText = e.message || '';
    let userMsg;
    if (/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/.test(errText)) {
      userMsg = 'ffmpeg.exe is missing or blocked. ' +
                'This is usually caused by Windows Defender / antivirus quarantining the bundled binary on first run. ' +
                'Add the Freq.Phull install folder to your antivirus exclusions and restart the app, ' +
                'or install ffmpeg system-wide.';
    } else if (/Invalid data found when processing input/i.test(errText)) {
      userMsg = 'This file could not be decoded — it may be corrupt or ' +
                'incomplete despite its extension. Try re-downloading it, ' +
                'or open it in another player to confirm it still works.';
    } else {
      const lines = errText.split('\n').map(l => l.trim()).filter(Boolean);
      const tail = lines.slice(-3).join(' · ').slice(0, 220);
      userMsg = 'Could not prepare audio: ' + (tail || 'unknown error');
    }
    sse('error', { message: userMsg });
    res.end();
    return;
  }

  sse('status', { message: 'Running analysis engine…' });

  // Run Python with captured stderr for proper error reporting
  slog('Running: python ' + scriptTmp + ' ' + wavTmp);
  const { spawn } = require('child_process');
  const pythonCmd = getPythonCmd();
  slog('analyze: spawning ' + pythonCmd + ' ' + scriptTmp);
  const proc = spawn(pythonCmd, [scriptTmp, wavTmp], { windowsHide: true, env: process.env });

  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => {
    stderr += d.toString();
    d.toString().trim().split('\n').forEach(l => { if (l.trim()) slog('[py] ' + l.trim()); });
  });

  proc.on('close', code => {
    try { fs.unlinkSync(wavTmp); } catch {}
    slog('analyze.py exit=' + code + ' stdout_len=' + stdout.length + ' stderr_len=' + stderr.length);
    if (stdout.length > 0) slog('stdout preview: ' + stdout.slice(0, 200));
    if (stderr.length > 0) slog('stderr preview: ' + stderr.slice(0, 200));

    if (code !== 0) {
      const errMsg = stderr.trim() || stdout.trim() || 'Python exited with code ' + code;
      slog('ANALYSIS FAILED: ' + errMsg.slice(0, 500));
      sse('error', { message: errMsg.slice(0, 300), hint: 'Run AI Transcribe Setup.exe to install scipy/numpy' });
      res.end();
      return;
    }

    try {
      const result = JSON.parse(stdout.trim());
      if (result.error) {
        slog('analyze.py returned error: ' + result.error);
        sse('error', { message: result.error, hint: result.hint || '' });
      } else {
        slog('Analysis complete: BPM=' + result.bpm + ' Key=' + result.key + ' ' + result.mode);
        // If the renderer told us which history entry this analysis is for,
        // cache the mood profile so the stockpile can use it for suggestions
        // without re-running analyze on every interaction.
        const historyId = parseInt(req.query.historyId, 10);
        if (historyId && result.mood_profile) {
          try {
            const m = result.mood_profile;
            const existing = dbAll('SELECT history_id FROM track_mood WHERE history_id=?', [historyId]);
            if (existing.length) {
              dbRun(`UPDATE track_mood SET energy=?, tonality=?, density=?, tempo_pos=?, label=?,
                     updated_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE history_id=?`,
                [m.energy, m.tonality, m.density, m.tempo_pos, m.label || null, historyId]);
            } else {
              dbRun(`INSERT INTO track_mood (history_id, energy, tonality, density, tempo_pos, label)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                [historyId, m.energy, m.tonality, m.density, m.tempo_pos, m.label || null]);
            }
            saveDB();
          } catch (mErr) {
            slog('mood cache update failed: ' + mErr.message);
          }
        }
        sse('done', result);
      }
    } catch(e) {
      slog('JSON parse error. stdout was: ' + stdout.slice(0, 300));
      sse('error', { message: 'Invalid response from analyze.py: ' + e.message });
    }
    res.end();
  });

  proc.on('error', e => {
    try { fs.unlinkSync(wavTmp); } catch {}
    slog('Python spawn error: ' + e.message);
    sse('error', { message: 'Cannot run Python: ' + e.message, hint: 'Make sure Python is installed' });
    res.end();
  });
});


app.post('/convert-wav-upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inPath  = req.file.path;
  const outPath = path.join(os.tmpdir(), 'freqphull_' + Date.now() + '.wav');
  const cleanup = () => { try { fs.unlinkSync(inPath); } catch {} };
  slog('convert-wav-upload: ' + inPath);
  try {
    await run(bin('ffmpeg'), ['-y', '-i', inPath, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outPath]);
    cleanup();
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(outPath, err => {
      try { fs.unlinkSync(outPath); } catch {}
    });
  } catch(e) {
    cleanup(); try { fs.unlinkSync(outPath); } catch {}
    slog('convert-wav-upload error: ' + e.message);
    let userMsg = e.message;
    if (/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/.test(e.message || '')) {
      userMsg = 'ffmpeg.exe is missing or blocked. ' +
                'Antivirus may have quarantined it — add Freq.Phull to exclusions and restart.';
    }
    res.status(500).json({ error: userMsg });
  }
});

// Convert any audio file to PCM WAV for reliable browser decoding
app.get('/convert-wav', async (req, res) => {
  const filePath = (req.query.path || '').trim();
  slog('convert-wav request: ' + filePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found: ' + filePath });
  }
  const outPath = path.join(os.tmpdir(), 'freqphull_' + Date.now() + '.wav');
  const ffmpegBin = bin('ffmpeg');
  slog('ffmpeg path: ' + ffmpegBin);

  // ── Non-ASCII path workaround ──────────────────────────────────────
  // See asciiSafeFfmpegPath() — Windows mangles non-ASCII argv before
  // ffmpeg sees it. Helper copies the file to a temp ASCII path when
  // needed; returns the original path unchanged otherwise.
  let ffmpegInputPath, tempCopy;
  try {
    const safe = asciiSafeFfmpegPath(filePath);
    ffmpegInputPath = safe.ffmpegPath;
    tempCopy = safe.tempCopy;
  } catch (copyErr) {
    slog('convert-wav: ASCII-safe copy failed: ' + copyErr.message);
    return res.status(500).json({ error: 'Could not prepare file: ' + copyErr.message });
  }

  try {
    await run(ffmpegBin, [
      '-y', '-i', ffmpegInputPath,
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      outPath
    ]);
    slog('ffmpeg conversion done: ' + outPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(outPath, err => {
      try { fs.unlinkSync(outPath); } catch {}
      // Always clean up the input copy too if we made one
      if (tempCopy) { try { fs.unlinkSync(tempCopy); } catch {} }
      if (err) slog('sendFile error: ' + err.message);
    });
  } catch(e) {
    slog('convert-wav error: ' + e.message);
    try { fs.unlinkSync(outPath); } catch {}
    if (tempCopy) { try { fs.unlinkSync(tempCopy); } catch {} }
    // ffmpeg dumps 70+ lines of build configuration (--enable-this
    // --enable-that) BEFORE the actual error. Surfacing that raw to the
    // user is useless noise. Translate the common cases into a single
    // human sentence; for anything else, keep only the last few
    // meaningful lines of stderr (the real error is always at the end).
    const errText = e.message || '';
    let userMsg;
    if (/spawn (UNKNOWN|ENOENT|EPERM|EACCES)/.test(errText)) {
      userMsg = 'ffmpeg.exe could not be found. Most likely causes:\n' +
                '• Windows Temp was cleared (CCleaner, Storage Sense, "del Temp"). Portable builds re-extract on launch — close Freq.Phull completely (check Task Manager) and reopen.\n' +
                '• Windows Defender / antivirus quarantined the bundled binary. Add the install folder to exclusions and restart.\n' +
                '• Last resort: install ffmpeg system-wide and restart the app.';
    } else if (/Invalid data found when processing input/i.test(errText)) {
      // The file opened but ffmpeg couldn't decode it. The .wav extension
      // is misleading — the file is corrupt, truncated, or not actually
      // the format its extension claims.
      userMsg = 'This file could not be decoded — it may be corrupt or ' +
                'incomplete despite its extension. Try re-downloading it, ' +
                'or open it in another player to confirm it still works.';
    } else {
      // Generic: take only the last 3 non-empty lines, never the build dump
      const lines = errText.split('\n').map(l => l.trim()).filter(Boolean);
      const tail = lines.slice(-3).join(' · ').slice(0, 220);
      userMsg = 'ffmpeg conversion failed: ' + (tail || 'unknown error');
    }
    res.status(500).json({ error: userMsg });
  }
});

app.get('/file', (req, res) => {
  const p = (req.query.path || '').trim();
  const forceDownload = req.query.download === '1' || req.query.download === 'true';
  slog('Serving file: ' + p + (forceDownload ? ' (download)' : ' (inline)'));
  // Resolve to absolute path — sendFile requires it
  const absPath = path.resolve(p);
  try {
    if (!fs.existsSync(absPath)) {
      slog('File not found at: ' + absPath);
      return res.status(404).json({ error: 'Not found: ' + absPath });
    }
  } catch(e) {
    slog('fs.existsSync error (unicode path?): ' + e.message);
    return res.status(404).json({ error: 'Cannot access path: ' + e.message });
  }
  const filename = path.basename(absPath);
  // Sanitize filename for Content-Disposition (remove unicode problem chars)
  const safeName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  // Inline disposition lets <audio>/<video> elements stream the file. For
  // explicit downloads (drag-to-DAW, save-as), the caller passes ?download=1.
  res.setHeader('Content-Disposition',
    (forceDownload ? 'attachment' : 'inline') + '; filename="' + safeName + '"');
  res.sendFile(absPath, err => {
    if (err) slog('sendFile error: ' + err.message);
  });
});

// ── Find file — scans known folders for a filename ─────────────────────────
// Used when history has an old path but file was moved to stockpile
app.get('/find-file', (req, res) => {
  const filename = (req.query.filename || '').trim();
  const stockpile = (req.query.stockpile || '').trim();
  const historyId = req.query.id;

  if (!filename) return res.status(400).json({ error: 'Missing filename' });

  slog('find-file: looking for ' + filename);

  // Build list of folders to scan
  const searchDirs = [];
  if (stockpile && fs.existsSync(stockpile)) searchDirs.push(stockpile);
  searchDirs.push(path.join(os.homedir(), 'Downloads'));
  searchDirs.push(path.join(os.homedir(), 'Music'));
  searchDirs.push(path.join(os.homedir(), 'Desktop'));

  // Also check all unique directories from history entries
  try {
    const histPaths = dbAll('SELECT DISTINCT file_path FROM history WHERE file_path IS NOT NULL');
    const histDirs = new Set();
    for (const h of histPaths) {
      if (h.file_path) histDirs.add(path.dirname(h.file_path));
    }
    for (const d of histDirs) {
      if (!searchDirs.includes(d) && fs.existsSync(d)) searchDirs.push(d);
    }
  } catch {}

  // Scan each folder
  for (const dir of searchDirs) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      slog('find-file: FOUND at ' + candidate);
      // Update the history DB with the correct path
      if (historyId) {
        try {
          dbRun('UPDATE history SET file_path=? WHERE id=?', [candidate, historyId]);
          slog('find-file: updated DB for id=' + historyId);
        } catch {}
      }
      return res.json({ ok: true, found: true, path: candidate });
    }
  }

  // Also do a recursive scan of stockpile subfolders (one level deep)
  if (stockpile && fs.existsSync(stockpile)) {
    try {
      const subdirs = fs.readdirSync(stockpile, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(stockpile, d.name));
      for (const sub of subdirs) {
        const candidate = path.join(sub, filename);
        if (fs.existsSync(candidate)) {
          slog('find-file: FOUND in subfolder ' + candidate);
          if (historyId) {
            try { dbRun('UPDATE history SET file_path=? WHERE id=?', [candidate, historyId]); } catch {}
          }
          return res.json({ ok: true, found: true, path: candidate });
        }
      }
    } catch {}
  }

  slog('find-file: NOT FOUND');
  res.json({ ok: true, found: false });
});

// ── Repair history — smart multi-stage matcher ─────────────────────────────
// Walks stockpile + downloads recursively (3 levels), collects every audio file
// with its size + mtime, then for each broken history row tries:
//   Stage A: exact filename match (fast path, current behavior)
//   Stage B: normalized filename match (strip punctuation, lowercase)
//   Stage C: token-similarity (Jaccard) against the history TITLE — handles
//            cases where the file was renamed but the title is recognizable
//   Tiebreaker on multiple candidates: closest size to neighbors / newest mtime
// Auto-applies matches with confidence >= AUTO_APPLY_THRESHOLD; below that,
// returns candidates so the UI can show "needs review" with options.

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.wma']);
const AUTO_APPLY_THRESHOLD = 0.70;       // coverage above which we auto-link
const REVIEW_THRESHOLD     = 0.40;       // below this we don't even surface as a candidate

// Normalize a string for matching: lowercase, strip extension, remove
// common YouTube/release tags, collapse non-alphanumeric runs to single spaces.
function normalizeForMatch(s) {
  if (!s) return '';
  let v = String(s).toLowerCase();
  // Drop file extension if present
  v = v.replace(/\.[a-z0-9]{2,4}$/, '');
  // Strip common youtube/release tags
  v = v.replace(/\(official\s*(?:video|audio|lyrics?|music\s*video)?\)/g, '');
  v = v.replace(/\[official\s*(?:video|audio|lyrics?|music\s*video)?\]/g, '');
  v = v.replace(/\(lyrics?\)/g, '').replace(/\[lyrics?\]/g, '');
  v = v.replace(/\(audio\)/g, '').replace(/\[audio\]/g, '');
  v = v.replace(/\(hd\)|\(hq\)|\(4k\)|\(1080p?\)|\(720p?\)/g, '');
  v = v.replace(/\(prod\.?\s*by\s+[^)]+\)/g, '');
  v = v.replace(/\(feat\.?\s+[^)]+\)/g, '').replace(/\bft\.?\s+/g, ' ');
  // Collapse anything non-alphanumeric to single spaces
  v = v.replace(/[^a-z0-9]+/g, ' ').trim();
  return v;
}

// Tokenize for similarity scoring. Drops short tokens (<=1 char).
function tokenize(s) {
  return new Set(normalizeForMatch(s).split(' ').filter(t => t.length > 1));
}

// Token coverage: what fraction of the QUERY tokens appear in the candidate?
// This is much more forgiving than Jaccard for matching short YouTube titles
// against long descriptive filenames. Examples:
//   query  = "Drake One Dance"            -> tokens {drake, one, dance}
//   file   = "Drake_-_One_Dance_(Official_Audio).mp3"
//                                         -> tokens {drake, one, dance, official, audio}
//   Jaccard  = 3/5 = 0.60   (close to threshold)
//   Coverage = 3/3 = 1.00   (perfect, since every query token is present)
//
// Then we apply a small penalty for filename "noise" so an irrelevant long
// filename that happens to contain all the title words doesn't score 1.00.
function tokenCoverage(queryStr, candStr) {
  const tq = tokenize(queryStr);
  const tc = tokenize(candStr);
  if (tq.size === 0 || tc.size === 0) return 0;
  let inter = 0;
  for (const t of tq) if (tc.has(t)) inter++;
  const coverage = inter / tq.size;          // % of query tokens present
  // Light density factor: prefer files that aren't padded with a million extra tokens
  const density  = inter / Math.max(tc.size, tq.size);
  // 70/30 weighted blend: coverage matters most, density breaks ties
  return coverage * 0.70 + density * 0.30;
}

// Jaccard similarity (kept around for stage A/B since exact name matches
// don't need coverage logic).
function jaccard(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Recursively walk a directory up to maxDepth, collecting audio files.
// Returns array of { name, path, size, mtime } objects.
function walkAudio(rootDir, maxDepth = 3) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [{ dir: rootDir, depth: 0 }];
  let scanned = 0;
  const SCAN_LIMIT = 50000; // safety bound
  while (stack.length && scanned < SCAN_LIMIT) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      scanned++;
      if (scanned >= SCAN_LIMIT) break;
      const full = path.join(dir, ent.name);
      // Skip hidden folders / typical noise
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '$RECYCLE.BIN') continue;
      if (ent.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        try {
          const st = fs.statSync(full);
          out.push({
            name: ent.name,
            path: full,
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {}
      }
    }
  }
  return out;
}

app.post('/repair-history', (req, res) => {
  const stockpile = (req.body.stockpile || '').trim();
  const reviewMode = !!req.body.review; // if true, return candidates instead of auto-applying
  slog('repair-history: starting scan, stockpile=' + stockpile + ' review=' + reviewMode);

  const allRows = dbAll('SELECT id, file_path, title FROM history WHERE file_path IS NOT NULL');

  // ── Stage 0: build a recursive index of every audio file we know about ──
  const indexedFiles = [];
  const seenPaths = new Set();
  const addBatch = (arr) => {
    for (const f of arr) {
      if (!seenPaths.has(f.path)) { seenPaths.add(f.path); indexedFiles.push(f); }
    }
  };

  if (stockpile && fs.existsSync(stockpile)) {
    addBatch(walkAudio(stockpile, 3));
  }
  addBatch(walkAudio(path.join(os.homedir(), 'Downloads'), 1));
  addBatch(walkAudio(path.join(os.homedir(), 'Music'), 2));
  addBatch(walkAudio(path.join(os.homedir(), 'Desktop'), 1));

  // Also include directories that historic entries already point to
  const histDirs = new Set();
  for (const r of allRows) { if (r.file_path) histDirs.add(path.dirname(r.file_path)); }
  for (const d of histDirs) {
    if (!seenPaths.has(d) && fs.existsSync(d)) addBatch(walkAudio(d, 1));
  }

  slog('repair-history: indexed ' + indexedFiles.length + ' audio files across ' +
       (1 + histDirs.size) + ' roots');

  // Quick lookup maps
  const exactMap = new Map();        // lowercase filename -> file (newest mtime wins)
  const normalizedMap = new Map();   // normalized basename -> [files...]
  for (const f of indexedFiles) {
    const lc = f.name.toLowerCase();
    const existing = exactMap.get(lc);
    // Keep the newest one if we see duplicates
    if (!existing || f.mtime > existing.mtime) exactMap.set(lc, f);
    const norm = normalizeForMatch(f.name);
    if (norm) {
      if (!normalizedMap.has(norm)) normalizedMap.set(norm, []);
      normalizedMap.get(norm).push(f);
    }
  }

  // ── Per-row matching ──
  let repaired = 0, broken = 0, ok = 0;
  const reviewItems = [];

  for (const row of allRows) {
    if (fs.existsSync(row.file_path)) { ok++; continue; }
    broken++;

    const oldName = path.basename(row.file_path || '');
    const oldNameLower = oldName.toLowerCase();
    const oldNormalized = normalizeForMatch(oldName);
    const titleNormalized = normalizeForMatch(row.title || '');

    let bestMatch = null;     // { file, score, stage }
    let candidates = [];      // for review mode

    // Stage A: exact filename match — score 1.0
    if (exactMap.has(oldNameLower)) {
      bestMatch = { file: exactMap.get(oldNameLower), score: 1.0, stage: 'exact' };
    }

    // Stage B: normalized filename match — score 0.95
    if (!bestMatch && oldNormalized && normalizedMap.has(oldNormalized)) {
      const matches = normalizedMap.get(oldNormalized);
      // If multiple, pick the newest by mtime (most recently moved is most likely the right one)
      matches.sort((a, b) => b.mtime - a.mtime);
      bestMatch = { file: matches[0], score: 0.95, stage: 'normalized' };
    }

    // Stage C: fuzzy match - token coverage of title/oldName against indexed file names
    if (!bestMatch || bestMatch.score < AUTO_APPLY_THRESHOLD) {
      const titleTokens = tokenize(row.title || '');
      const oldTokens   = tokenize(oldName);
      // Combined query: title and old filename are both signal sources
      const queryStr = ((row.title || '') + ' ' + oldName).trim();
      const queryTokens = new Set([...titleTokens, ...oldTokens]);
      if (queryTokens.size > 0) {
        const scored = [];
        for (const f of indexedFiles) {
          const fileTokens = tokenize(f.name);
          // Cheap pre-filter: at least one token must overlap
          let anyShared = false;
          for (const t of queryTokens) {
            if (fileTokens.has(t)) { anyShared = true; break; }
          }
          if (!anyShared) continue;

          // Score: best of (title vs filename) and (old DB filename vs filename)
          const titleScore = tokenCoverage(row.title || '', f.name);
          const fnameScore = tokenCoverage(oldName, f.name);
          const score = Math.max(titleScore, fnameScore * 0.92);
          if (score >= REVIEW_THRESHOLD) {
            scored.push({ file: f, score, stage: 'fuzzy' });
          }
        }
        // Sort by score desc, then prefer newer mtime as tiebreak
        scored.sort((a, b) => {
          const ds = b.score - a.score;
          if (Math.abs(ds) > 0.001) return ds;
          return b.file.mtime - a.file.mtime;
        });
        if (scored.length > 0) {
          if (!bestMatch || scored[0].score > bestMatch.score) {
            bestMatch = scored[0];
          }
          candidates = scored.slice(0, 3);
        }
      }
    }

    if (bestMatch) {
      if (!reviewMode && bestMatch.score >= AUTO_APPLY_THRESHOLD) {
        // Auto-apply
        try {
          dbRun('UPDATE history SET file_path=? WHERE id=?', [bestMatch.file.path, row.id]);
          slog('repair[' + bestMatch.stage + ' ' + bestMatch.score.toFixed(2) + ']: ' +
               row.id + ' → ' + bestMatch.file.path);
          repaired++;
        } catch (e) {
          slog('repair update failed for id=' + row.id + ': ' + e.message);
        }
      } else if (bestMatch.score >= REVIEW_THRESHOLD) {
        // Below auto-apply threshold OR we're in review mode → surface for user to pick
        reviewItems.push({
          id: row.id,
          title: row.title,
          oldPath: row.file_path,
          oldName,
          candidates: candidates.length ? candidates.map(c => ({
            path: c.file.path,
            name: c.file.name,
            size: c.file.size,
            mtime: c.file.mtime,
            score: Math.round(c.score * 100) / 100,
            stage: c.stage,
          })) : [{
            path: bestMatch.file.path,
            name: bestMatch.file.name,
            size: bestMatch.file.size,
            mtime: bestMatch.file.mtime,
            score: Math.round(bestMatch.score * 100) / 100,
            stage: bestMatch.stage,
          }],
        });
      }
    }
  }

  slog('repair-history: done. ok=' + ok + ' broken=' + broken +
       ' repaired=' + repaired + ' needs-review=' + reviewItems.length);

  res.json({
    ok: true,
    total: allRows.length,
    alreadyOk: ok,
    broken,
    repaired,
    needsReview: reviewItems.length,
    reviewItems,
    indexed: indexedFiles.length,
  });
});

// User picks a specific candidate from the review list to apply
app.post('/repair-apply', (req, res) => {
  const id = req.body.id;
  const newPath = (req.body.path || '').trim();
  if (!id || !newPath) return res.status(400).json({ error: 'Missing id or path' });
  if (!fs.existsSync(newPath)) return res.status(404).json({ error: 'File not found at path' });
  try {
    dbRun('UPDATE history SET file_path=? WHERE id=?', [newPath, id]);
    slog('repair-apply: ' + id + ' → ' + newPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path, model = req.body.model || 'base', lang = req.body.language || 'auto';
  slog('Transcribe: model=' + model + ' lang=' + lang);
  const cleanup = () => { try { fs.unlinkSync(inputPath); } catch {} };
  try {
    const langArgs = lang === 'auto' ? [] : ['--language', lang];
    await run('python', ['-m', 'whisper', inputPath, '--model', model, '--output_format', 'txt', '--output_dir', os.tmpdir(), '--verbose', 'False', ...langArgs]);
    const txtPath = path.join(os.tmpdir(), path.basename(inputPath) + '.txt');
    if (!fs.existsSync(txtPath)) throw new Error('Whisper produced no output file');
    const text = fs.readFileSync(txtPath, 'utf8').trim();
    try { fs.unlinkSync(txtPath); } catch {}
    cleanup();
    res.json({ transcript: text });
  } catch (e) {
    slog('Transcribe error: ' + e.message);
    cleanup();
    res.status(500).json({ error: e.message, hint: 'Run AI Transcribe Setup.exe first' });
  }
});

// ── Stem separator ──────────────────────────────────────────────────────────
app.get('/stems', (req, res) => {
  const filePath = (req.query.path || '').trim();
  const mode     = (req.query.mode || '4').trim();
  const quality  = (req.query.quality || 'high').trim().toLowerCase();
  const direct   = req.query.direct === '1' || req.query.direct === 'true';
  // Lead-vocal sub-split — optional Stage 1.5 pass producing lead_vocal.wav
  // and back_vocal.wav alongside the regular vocals.wav. Adds ~30-60s CPU.
  const splitLead = req.query.splitLead === '1' || req.query.splitLead === 'true';
  // Force CPU even if GPU is available — for low-VRAM machines and users
  // who want to keep the GPU free for DAW plugins.
  const cpuOnly  = req.query.cpuOnly === '1' || req.query.cpuOnly === 'true';
  // Ensemble Stage 2: run a second model and average harmonic outputs.
  // ~30% slower but +0.3-0.8 dB SDR on piano/other/guitar. Quality bonus.
  const ensemble = req.query.ensemble === '1' || req.query.ensemble === 'true';
  // Vocal ensemble: run a second vocal isolation model and average outputs.
  // Targets Stage 1 (vocal split) specifically — different from `ensemble`
  // which targets Stage 2 (instrumental split). Cost: roughly doubles
  // Stage 1 runtime.
  const vocalEnsemble = req.query.vocalEnsemble === '1' || req.query.vocalEnsemble === 'true';
  // De-reverb: run UVR-DeEcho-DeReverb on the vocal stem after Stage 1
  // (or lead_vocal after Stage 1.5). Replaces the wet vocal with a dry one.
  const dereverb = req.query.dereverb === '1' || req.query.dereverb === 'true';

  // Fullness restoration controls. The user picks a preset in the
  // Separator's Quality Advanced panel, and can optionally override the
  // per-pass strengths from the expandable advanced sliders. Empty/missing
  // values fall through to the preset defaults inside stems.py.
  const fullnessPreset = (() => {
    const v = (req.query.fullnessPreset || 'balanced').toLowerCase();
    return ['subtle', 'balanced', 'aggressive'].includes(v) ? v : 'balanced';
  })();
  // Optional per-pass overrides. We forward the raw values; stems.py
  // clamps them defensively in case anything weird comes through.
  const fullnessSustain     = req.query.fullnessSustain;
  const fullnessDuckingDb   = req.query.fullnessDuckingDb;
  const fullnessTransientDb = req.query.fullnessTransientDb;
  const outDir   = (req.query.outDir || path.join(os.homedir(), 'Music', 'Freq.Phull Stems')).trim();

  slog('stems request: ' + filePath + ' mode=' + mode + ' quality=' + quality +
       ' direct=' + direct + ' splitLead=' + splitLead + ' cpuOnly=' + cpuOnly +
       ' ensemble=' + ensemble + ' dereverb=' + dereverb);

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found: ' + filePath });
  }
  if (!['4', '6'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }
  if (!['fast', 'high', 'ultra'].includes(quality)) {
    return res.status(400).json({ error: 'Invalid quality' });
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Proactive check: engines must be installed before we attempt separation
  if (!enginesReady()) {
    slog('stems request rejected: engines marker missing');
    return res.status(503).json({
      error: 'AI engines not installed',
      hint: 'Open Settings → AI Engines and run setup, or restart the app.',
      needs_setup: true,
    });
  }

  // Find stems.py and its sibling registry module — both need to be in the
  // same directory at runtime for the import to resolve.
  const scriptSrc = getResourcePath('stems.py');
  const regSrc = getResourcePath('_phull_internal.py');
  if (!scriptSrc) {
    slog('stems.py not found anywhere');
    return res.status(500).json({ error: 'Engine entry not found in app bundle — rebuild required' });
  }
  if (!regSrc) {
    slog('_phull_internal.py not found anywhere');
    return res.status(500).json({ error: 'Engine registry not found in app bundle — rebuild required' });
  }
  const scriptTmp = path.join(os.tmpdir(), 'freqphull_stems.py');
  const regTmp = path.join(os.tmpdir(), '_phull_internal.py');
  try {
    fs.copyFileSync(scriptSrc, scriptTmp);
    fs.copyFileSync(regSrc, regTmp);
  } catch (e) {
    slog('Failed to copy engine files: ' + e.message);
    return res.status(500).json({ error: 'Could not copy engine files: ' + e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  sse('status', { message: 'Starting separator…' });

  // ASCII-safe input path workaround. See asciiSafeFfmpegPath() — same
  // problem applies to Python subprocess on Windows: non-ASCII argv
  // gets mangled through CP1252 before stems.py / audio-separator
  // see it. We copy the input to a temp file with a clean ASCII name
  // and run the separator on that. Output paths inside the script use
  // the original filename for naming the stems, so the user's chosen
  // outDir still gets cleanly-named output files (we copy from temp
  // to the user's outDir at the end if outDir itself is non-ASCII).
  let stemsInputPath = filePath;
  let stemsTempInputCopy = null;
  try {
    const safe = asciiSafeFfmpegPath(filePath);
    stemsInputPath = safe.ffmpegPath;
    stemsTempInputCopy = safe.tempCopy;
  } catch (copyErr) {
    slog('stems: ASCII-safe copy failed: ' + copyErr.message);
    sse('error', { message: 'Could not prepare file: ' + copyErr.message });
    res.end();
    return;
  }

  const pythonCmd = getPythonCmd();
  const args = [scriptTmp, stemsInputPath, outDir, '--mode', mode, '--quality', quality];
  if (direct) args.push('--no-vocal-isolation');
  if (splitLead) args.push('--split-lead-vocal');
  if (cpuOnly) args.push('--cpu-only');
  if (ensemble) args.push('--ensemble');
  if (vocalEnsemble) args.push('--vocal-ensemble');
  if (dereverb) args.push('--dereverb');
  // Fullness controls — preset is always passed (it has a default in
  // stems.py too but being explicit avoids confusion in the logs). The
  // per-pass overrides are only pushed when actually set, so the python
  // defaults apply otherwise.
  args.push('--fullness-preset', fullnessPreset);
  if (fullnessSustain !== undefined && fullnessSustain !== '') {
    const v = parseFloat(fullnessSustain);
    if (isFinite(v)) args.push('--fullness-sustain', String(v));
  }
  if (fullnessDuckingDb !== undefined && fullnessDuckingDb !== '') {
    const v = parseFloat(fullnessDuckingDb);
    if (isFinite(v)) args.push('--fullness-ducking-db', String(v));
  }
  if (fullnessTransientDb !== undefined && fullnessTransientDb !== '') {
    const v = parseFloat(fullnessTransientDb);
    if (isFinite(v)) args.push('--fullness-transient-db', String(v));
  }
  slog('stems: spawning ' + pythonCmd + ' ' + scriptTmp);
  const proc = spawn(pythonCmd, args, { windowsHide: true, env: process.env });

  let buf = '';
  let lastDone = null;
  let stderrBuf = '';

  proc.stdout.on('data', d => {
    buf += d.toString();
    let lines = buf.split('\n');
    buf = lines.pop(); // last partial line stays in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'status') {
          sse('progress', msg);
        } else if (msg.type === 'warning') {
          // Non-fatal — surface to the renderer which shows it as a toast.
          // The pipeline keeps going after a warning.
          sse('warning', msg);
          slog('[stems-warn] ' + (msg.message || '') + (msg.hint ? ' · ' + msg.hint : ''));
        } else if (msg.type === 'done') {
          lastDone = msg;
          // Save to separator_history
          try {
            const baseName = path.basename(filePath, path.extname(filePath));
            dbRun(
              `INSERT INTO separator_history
               (title, source_path, output_dir, stems, model, mode, quality, device, duration, processing_time)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [
                baseName,
                filePath,
                msg.output_dir || '',
                JSON.stringify(msg.stems || []),
                msg.model || '',
                String(mode),
                quality,
                msg.device || '',
                msg.duration || null,
                msg.processing_time || null,
              ]
            );
          } catch (e) {
            slog('Failed to save separator_history: ' + e.message);
          }
          sse('done', msg);
        } else if (msg.type === 'error') {
          sse('error', { message: msg.message, hint: msg.hint || '' });
        }
      } catch {
        // Non-JSON line — log it for debugging
        slog('[stems-py] ' + trimmed);
      }
    }
  });

  proc.stderr.on('data', d => {
    const txt = d.toString();
    stderrBuf += txt;
    txt.trim().split('\n').forEach(l => { if (l.trim()) slog('[stems-err] ' + l.trim()); });
  });

  proc.on('close', code => {
    slog('stems.py exit=' + code);
    if (code !== 0 && !lastDone) {
      const errMsg = stderrBuf.trim().slice(-300) || 'Stem separation failed (exit ' + code + ')';
      sse('error', {
        message: errMsg,
        hint: 'Run: pip install torch torchaudio demucs',
      });
    }
    // Clean up the ASCII-safe temp input file if we made one
    if (stemsTempInputCopy) {
      try { fs.unlinkSync(stemsTempInputCopy); } catch {}
    }
    res.end();
  });

  proc.on('error', e => {
    slog('stems.py spawn error: ' + e.message);
    if (stemsTempInputCopy) {
      try { fs.unlinkSync(stemsTempInputCopy); } catch {}
    }
    sse('error', {
      message: 'Cannot start Python: ' + e.message,
      hint: 'Make sure Python is installed and on PATH.',
    });
    res.end();
  });

  // Kill the process if the client disconnects
  req.on('close', () => {
    if (!proc.killed) {
      try { proc.kill(); } catch {}
    }
  });
});

// ── Mastering ────────────────────────────────────────────────────────────
// Rule-based mastering of a single audio file (typically the original
// source after stem separation). Emits SSE progress events and a final
// 'done' with the output path + measured LUFS.
//
// Query params:
//   path     absolute path to input WAV/MP3/etc.
//   outDir   directory to write the mastered output (default: same dir
//            as the input, alongside it)
//   preset   one of 'loudness_normalize' | 'bright' | 'warm'
app.get('/master', (req, res) => {
  const filePath = (req.query.path || '').trim();
  const preset = (req.query.preset || 'loudness_normalize').trim();
  // Optional: reference track to match. When provided, the mastering
  // engine measures the reference's tonal balance + LUFS and aims the
  // EQ/loudness chain at those targets instead of the preset's fixed
  // values. Pair with preset=reference_match for honest UI labeling.
  const referencePath = (req.query.reference || '').trim();
  // 0..1 — how aggressively to match the reference. Default 0.5 (gentle).
  const matchStrengthRaw = parseFloat(req.query.strength);
  const matchStrength = isFinite(matchStrengthRaw)
    ? Math.max(0, Math.min(1, matchStrengthRaw)) : 0.5;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found: ' + filePath });
  }
  if (!['loudness_normalize', 'bright', 'warm', 'reference_match'].includes(preset)) {
    return res.status(400).json({ error: 'Invalid preset' });
  }
  if (referencePath && !fs.existsSync(referencePath)) {
    return res.status(404).json({ error: 'Reference file not found: ' + referencePath });
  }
  // Default output: alongside input with " (Mastered <preset>).wav" suffix.
  // The user can override with ?outDir= for explicit control.
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const inDir = path.dirname(filePath);
  const outDir = (req.query.outDir || inDir).trim();
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const presetSuffix = preset === 'loudness_normalize' ? 'Mastered'
                     : preset === 'bright' ? 'Mastered-Bright'
                     : preset === 'warm' ? 'Mastered-Warm'
                     : 'Mastered-Reference';
  const outPath = path.join(outDir, `${base} (${presetSuffix}).wav`);

  // Copy mastering.py to a temp location so it can run even when the app
  // bundle has the file inside app.asar. Same pattern as /stems.
  const scriptSrc = getResourcePath('mastering.py');
  if (!scriptSrc) {
    slog('mastering.py not found anywhere');
    return res.status(500).json({ error: 'Mastering engine not found in app bundle — rebuild required' });
  }
  const scriptTmp = path.join(os.tmpdir(), 'freqphull_mastering.py');
  try { fs.copyFileSync(scriptSrc, scriptTmp); }
  catch (e) {
    slog('Failed to copy mastering.py: ' + e.message);
    return res.status(500).json({ error: 'Could not copy mastering engine: ' + e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  sse('status', { message: 'Starting mastering…' });

  // ASCII-safe input + reference paths (see asciiSafeFfmpegPath helper).
  // Mastering reads via librosa/soundfile in Python, which CAN handle
  // unicode paths on Windows when Python decodes the argv correctly —
  // but Node spawn() mangles the argv first, so we still need the
  // copy-to-temp dance.
  let masterInput = filePath;
  let masterRef = referencePath;
  let masterInputCopy = null;
  let masterRefCopy = null;
  try {
    const safeIn = asciiSafeFfmpegPath(filePath);
    masterInput = safeIn.ffmpegPath;
    masterInputCopy = safeIn.tempCopy;
    if (referencePath) {
      const safeRef = asciiSafeFfmpegPath(referencePath);
      masterRef = safeRef.ffmpegPath;
      masterRefCopy = safeRef.tempCopy;
    }
  } catch (copyErr) {
    slog('master: ASCII-safe copy failed: ' + copyErr.message);
    sse('error', { message: 'Could not prepare file: ' + copyErr.message });
    res.end();
    return;
  }

  const pythonCmd = getPythonCmd();
  const args = [scriptTmp, masterInput, outPath, '--preset', preset];
  if (masterRef) {
    args.push('--reference', masterRef);
    args.push('--match-strength', String(matchStrength));
  }
  slog('master: spawning ' + pythonCmd + ' ' + scriptTmp + ' preset=' + preset +
       (referencePath ? ' ref=' + path.basename(referencePath) + ' strength=' + matchStrength : ''));
  const proc = spawn(pythonCmd, args, { windowsHide: true, env: process.env });

  let buf = '';
  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'status') sse('progress', msg);
        else if (msg.type === 'done') sse('done', msg);
        else if (msg.type === 'error') {
          sse('error', msg);
          slog('[master-err] ' + (msg.message || ''));
        }
      } catch (e) {
        slog('[master-stdout] ' + trimmed);
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrBuf += text;
    slog('[master-stderr] ' + text.trim());
  });
  proc.on('error', (err) => {
    if (masterInputCopy) { try { fs.unlinkSync(masterInputCopy); } catch {} }
    if (masterRefCopy)   { try { fs.unlinkSync(masterRefCopy);   } catch {} }
    sse('error', { message: 'Mastering process failed to start: ' + err.message });
    res.end();
  });
  proc.on('exit', (code) => {
    if (masterInputCopy) { try { fs.unlinkSync(masterInputCopy); } catch {} }
    if (masterRefCopy)   { try { fs.unlinkSync(masterRefCopy);   } catch {} }
    if (code !== 0) {
      sse('error', {
        message: 'Mastering process exited with code ' + code,
        detail: stderrBuf.slice(-500),
      });
    }
    res.end();
  });
  req.on('close', () => {
    if (!proc.killed) {
      try { proc.kill(); } catch {}
    }
  });
});

app.get('/separator-history', (_, res) => {
  res.json(dbAll('SELECT * FROM separator_history ORDER BY created_at DESC LIMIT 200'));
});

app.delete('/separator-history/:id', (req, res) => {
  dbRun('DELETE FROM separator_history WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── Engines setup ─────────────────────────────────────────────────────────
// Reports whether the AI engines (audio-separator + whisper) are installed
// by checking the marker file written by setup-engines.ps1
const ENGINES_MARKER = path.join(os.homedir(), 'AppData', 'Roaming', 'freqphull', 'engines-ready.json');

app.get('/engines-status', (_, res) => {
  const installed = enginesReady();
  let info = null;
  if (fs.existsSync(ENGINES_MARKER)) {
    try { info = JSON.parse(readUtf8(ENGINES_MARKER)); } catch {}
  }
  // installed=true means the marker is BOTH present AND valid (full path,
  // python exists). info.python may still be present even when installed=false
  // so we expose it for the Settings UI to explain why it's stale.
  res.json({ installed, info });
});

// SSE endpoint that runs setup-engines.ps1 and streams its JSON-line output.
//
// Setup takes 5-15 minutes. Browsers / proxies will drop idle SSE connections,
// and the user might switch tabs or reload the page. We DO NOT want to kill
// the PowerShell process when that happens - we want to keep it running and
// let the renderer reconnect via /setup-status polling.
//
// Architecture:
//   - First call to /setup-engines spawns the process and starts buffering events
//     into setupState. The SSE stream replays current state + future events.
//   - Subsequent calls (reconnect) pick up the buffered events from where they
//     left off, then continue streaming new events.
//   - /setup-status returns the current state without holding a connection,
//     so the renderer can poll it as a fallback.
//   - /setup-cancel explicitly kills the running setup if the user wants out.
let setupRunning = false;
let setupProc = null;
let setupState = {
  events: [],   // {type: 'progress'|'done'|'error', data: {...}}
  startedAt: null,
  endedAt: null,
};

function setupAddEvent(type, data) {
  setupState.events.push({ type, data, t: Date.now() });
  // Cap event log so it can't grow unbounded if something loops
  if (setupState.events.length > 500) {
    setupState.events = setupState.events.slice(-500);
  }
}

app.get('/setup-engines', (req, res) => {
  // If already running, just stream current state and pick up live events
  if (setupRunning && setupProc) {
    slog('setup-engines: client reconnected to running setup');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    // Replay buffered events so the UI catches up
    for (const e of setupState.events) sse(e.type, e.data);
    // Subscribe this connection to live events via a per-request listener
    const live = (ev, data) => {
      try { sse(ev, data); } catch {}
    };
    setupListeners.add(live);
    req.on('close', () => setupListeners.delete(live));
    return;
  }

  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'Auto-setup only available on Windows for now. Run: pip install audio-separator[cpu] openai-whisper' });
  }

  const scriptSrc = getResourcePath(path.join('installer', 'setup-engines.ps1'));
  if (!scriptSrc) {
    return res.status(500).json({ error: 'setup-engines.ps1 not found in app bundle' });
  }
  const scriptPath = path.join(os.tmpdir(), 'freqphull-setup-engines.ps1');
  try {
    fs.copyFileSync(scriptSrc, scriptPath);
  } catch (e) {
    slog('Failed to extract setup-engines.ps1: ' + e.message);
    return res.status(500).json({ error: 'Could not extract setup script: ' + e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  // Reset state for new run
  setupState = { events: [], startedAt: Date.now(), endedAt: null };
  setupRunning = true;
  slog('setup-engines: starting ' + scriptPath);

  // Helper to emit an event to BOTH the buffered state AND every connected listener
  const emit = (type, data) => {
    setupAddEvent(type, data);
    for (const fn of setupListeners) {
      try { fn(type, data); } catch {}
    }
  };
  emit('progress', { step: 'starting', progress: 0, message: 'Starting setup...' });

  // Run with stdio piped so we can capture output. detached: true on Windows
  // doesn't fully detach but does allow the process to outlive its parent
  // request - which is what we want.
  setupProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], { windowsHide: true });

  let buf = '';
  let stderrBuf = [];
  let lastErrorEmitted = false;

  setupProc.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'status') emit('progress', msg);
        else if (msg.type === 'done')  emit('done', msg);
        else if (msg.type === 'error') { emit('error', msg); lastErrorEmitted = true; }
      } catch {
        slog('[setup-stdout] ' + trimmed);
      }
    }
  });

  setupProc.stderr.on('data', d => {
    const txt = d.toString();
    txt.split(/\r?\n/).forEach(l => {
      const trimmed = l.trim();
      if (trimmed) {
        slog('[setup-stderr] ' + trimmed);
        stderrBuf.push(trimmed);
      }
    });
  });

  setupProc.on('close', code => {
    setupRunning = false;
    setupState.endedAt = Date.now();
    slog('setup-engines: exit ' + code);
    if (code !== 0 && !lastErrorEmitted) {
      const tail = stderrBuf.slice(-5).join(' | ').slice(-400);
      emit('error', {
        message: 'Setup ended unexpectedly (code ' + code + ')',
        hint: tail || 'See %TEMP%\\freqphull-setup.log for details',
      });
    }
    setupProc = null;
  });

  setupProc.on('error', e => {
    setupRunning = false;
    setupState.endedAt = Date.now();
    emit('error', { message: 'Cannot launch PowerShell: ' + e.message,
                    hint: 'Run installer manually: setup-engines.ps1' });
    setupProc = null;
  });

  // Subscribe THIS connection to events
  const live = (ev, data) => {
    try { sse(ev, data); } catch {}
  };
  setupListeners.add(live);

  // CRITICAL: when the client disconnects, just unsubscribe THIS listener.
  // Do NOT kill the PowerShell process - it must keep running so setup
  // completes even if the renderer disconnected (browser idle timeout,
  // user navigated away, etc). Use /setup-cancel for explicit cancellation.
  req.on('close', () => {
    setupListeners.delete(live);
    slog('setup-engines: client disconnected (setup keeps running)');
  });

  // Replay any events that already accumulated (e.g. the 'starting' progress)
  for (const e of setupState.events) sse(e.type, e.data);
});

// Tracks all SSE connections currently subscribed to setup events
const setupListeners = new Set();

// Status polling endpoint - lightweight alternative to holding an SSE
// connection open through 5-15 minutes of installation.
app.get('/setup-status', (_, res) => {
  const lastEvent = setupState.events[setupState.events.length - 1] || null;
  const lastError = setupState.events.slice().reverse().find(e => e.type === 'error') || null;
  res.json({
    running: setupRunning,
    startedAt: setupState.startedAt,
    endedAt: setupState.endedAt,
    eventCount: setupState.events.length,
    lastEvent,
    lastError: lastError ? lastError.data : null,
  });
});

// Explicit cancel - kills the running setup process (used by a Cancel button
// in the UI; routine disconnect from req.close() doesn't trigger this)
app.post('/setup-cancel', (_, res) => {
  if (setupProc) {
    try { setupProc.kill(); } catch {}
    setupProc = null;
  }
  setupRunning = false;
  res.json({ ok: true });
});

// Open a folder in the system file explorer (used by extension to reveal stems)
app.get('/open-folder', (req, res) => {
  const p = (req.query.path || '').trim();
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Path not found' });
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true });
  } catch (e) {
    slog('open-folder error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual temp-file cleanup. Returns the summary so the renderer can
// show "Freed X MB". maxAgeHours can be lowered via body for a more
// aggressive sweep (e.g. when the user clicks "Clean temp files now"
// after a heavy day, they want EVERY freqphull temp file gone).
app.post('/clean-temp-files', (req, res) => {
  const maxAge = (req.body && typeof req.body.maxAgeHours === 'number') ? req.body.maxAgeHours : 1;
  try {
    const sw = sweepOldTempFiles(maxAge);
    const mb = Math.round(sw.bytesFreed / 1024 / 1024 * 10) / 10;
    slog('temp-sweep manual: deleted ' + sw.deleted + ' files (' + mb + ' MB freed) maxAge=' + maxAge + 'h');
    res.json({ ok: true, ...sw, mbFreed: mb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start: bind port first, THEN init DB ──────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  slog('Server listening on port ' + PORT + ' — ready!');
  // Log file location so user can find it
  slog('Log file: ' + logPath);
  // Init DB in background — does not block startup
  initDB();
  // Clean up orphaned temp files from previous sessions. Files older
  // than 24h are leftovers — every legitimate conversion/analysis
  // completes in seconds. Run again every 6h so a long-running session
  // doesn't accumulate either.
  try {
    const sw = sweepOldTempFiles(24);
    if (sw.deleted > 0) {
      const mb = Math.round(sw.bytesFreed / 1024 / 1024 * 10) / 10;
      slog('temp-sweep startup: deleted ' + sw.deleted + ' files (' + mb + ' MB freed)');
    } else {
      slog('temp-sweep startup: nothing to clean (scanned ' + sw.scanned + ')');
    }
  } catch (e) {
    slog('temp-sweep startup failed: ' + e.message);
  }
  setInterval(() => {
    try {
      const sw = sweepOldTempFiles(24);
      if (sw.deleted > 0) {
        const mb = Math.round(sw.bytesFreed / 1024 / 1024 * 10) / 10;
        slog('temp-sweep periodic: deleted ' + sw.deleted + ' files (' + mb + ' MB freed)');
      }
    } catch (e) {
      slog('temp-sweep periodic failed: ' + e.message);
    }
  }, 6 * 3600 * 1000);
});

process.on('uncaughtException', e => slog('UNCAUGHT: ' + e.message + '\n' + e.stack));
process.on('unhandledRejection', e => slog('UNHANDLED REJECTION: ' + e));
