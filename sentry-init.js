// Sentry error reporting.
//
// Opt-in only. Disabled unless a DSN is present AND the user has
// enabled crash reporting in Settings (persisted in prefs).
//
// PII scrubbing strips absolute Windows paths (which leak the user's
// Windows account name) and any file:// URLs from the payload before
// it leaves the machine.
//
// Same module is required from main, renderer, and server processes.
// Each picks its own transport based on the available global.

'use strict';

// DSN resolution:
//   1. FREQPHULL_SENTRY_DSN env var (dev shells, CI builds)
//   2. sentry.config.json next to this file (production builds bake it in)
// Whichever is found first wins. Empty = Sentry disabled, init no-ops.
function _resolveDsn() {
  if (process.env.FREQPHULL_SENTRY_DSN) return process.env.FREQPHULL_SENTRY_DSN;
  try {
    const fs = require('fs');
    const path = require('path');
    // The example file is checked last on purpose: people reasonably edit
    // the file they can see rather than creating a copy of it, and a DSN
    // sitting there unused is a silently broken build. A real DSN there
    // is honoured; the placeholder is ignored.
    const candidates = [
      path.join(__dirname, 'sentry.config.json'),
      process.resourcesPath ? path.join(process.resourcesPath, 'sentry.config.json') : null,
      path.join(__dirname, 'sentry.config.example.json'),
      process.resourcesPath ? path.join(process.resourcesPath, 'sentry.config.example.json') : null,
    ].filter(Boolean);
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      const dsn = cfg && typeof cfg.dsn === 'string' ? cfg.dsn.trim() : '';
      // A usable DSN is https://KEY@HOST/PROJECT_ID. Placeholders in the
      // example file ("https://YOUR_KEY@...") are rejected by that test.
      if (/^https:\/\/[A-Za-z0-9]+@[\w.-]+\/\d+$/.test(dsn)) return dsn;
    }
  } catch { /* swallow */ }
  return '';
}
const SENTRY_DSN_ENV = _resolveDsn();

// Username / home-dir scrubber. Matches:
//   C:\Users\<name>\...     ->  C:\Users\<user>\...
//   /home/<name>/...        ->  /home/<user>/...
//   /Users/<name>/...       ->  /Users/<user>/...
//   file:///C:/Users/<name> ->  file:///C:/Users/<user>
const SCRUB_PATTERNS = [
  [/([A-Za-z]:\\Users\\)[^\\]+/g, '$1<user>'],
  [/(\/Users\/)[^/]+/g, '$1<user>'],
  [/(\/home\/)[^/]+/g, '$1<user>'],
  [/(file:\/\/\/[A-Za-z]:\/Users\/)[^/]+/gi, '$1<user>'],
];

function scrubString(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const [pat, repl] of SCRUB_PATTERNS) out = out.replace(pat, repl);
  return out;
}

function scrubObject(obj, depth = 0) {
  if (depth > 6 || obj == null) return obj;
  if (typeof obj === 'string') return scrubString(obj);
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = scrubObject(obj[k], depth + 1);
    return out;
  }
  return obj;
}

// beforeSend hook. Returns null to drop, the event to send.
function beforeSend(event /*, hint */) {
  if (!event) return null;
  if (event.message) event.message = scrubString(event.message);
  if (event.exception && event.exception.values) {
    for (const v of event.exception.values) {
      if (v.value) v.value = scrubString(v.value);
      if (v.stacktrace && v.stacktrace.frames) {
        for (const f of v.stacktrace.frames) {
          if (f.filename) f.filename = scrubString(f.filename);
          if (f.abs_path) f.abs_path = scrubString(f.abs_path);
        }
      }
    }
  }
  if (event.request && event.request.url) event.request.url = scrubString(event.request.url);
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubString(b.message);
      if (b.data) b.data = scrubObject(b.data);
    }
  }
  return event;
}

function commonOptions(release) {
  return {
    dsn: SENTRY_DSN_ENV,
    release,
    environment: process.env.NODE_ENV === 'development' ? 'dev' : 'prod',
    sampleRate: 1.0,
    // Don't transmit IPs.
    sendDefaultPii: false,
    // Drop noisy errors that aren't actionable.
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      /^EPIPE/,
    ],
    beforeSend,
    beforeBreadcrumb: (crumb) => {
      if (crumb.message) crumb.message = scrubString(crumb.message);
      if (crumb.data) crumb.data = scrubObject(crumb.data);
      return crumb;
    },
  };
}

// Each process initializes with its own runtime check. If the package
// isn't installed (optional dep) or the DSN is empty, we no-op.
function init(processKind, release, opts = {}) {
  if (!SENTRY_DSN_ENV) return null;
  if (opts.userOptOut) return null;

  try {
    let Sentry;
    if (processKind === 'main') Sentry = require('@sentry/electron/main');
    else if (processKind === 'renderer') Sentry = require('@sentry/electron/renderer');
    else if (processKind === 'node') Sentry = require('@sentry/node');
    else return null;

    Sentry.init(commonOptions(release));
    return Sentry;
  } catch (e) {
    // Package not installed or init failure - don't take the app down.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Sentry init skipped:', e && e.message);
    }
    return null;
  }
}

// Soft-error reporter. Used for failures that don't crash the process
// but represent real bugs we want to track (Python subprocess crashes,
// yt-dlp 403s after retry, setup-engines exit !=0, etc).
//
// Per-category rate limit prevents a single broken machine from
// hammering the Sentry quota: max 10 events per category per hour,
// per process. Sentry's own quota guard is the safety net but doesn't
// let us prioritize categories - this does.

const RATE_MAX = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const _rateLimits = new Map();

function _isRateLimited(category) {
  const now = Date.now();
  const arr = (_rateLimits.get(category) || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (arr.length >= RATE_MAX) {
    _rateLimits.set(category, arr);
    return true;
  }
  arr.push(now);
  _rateLimits.set(category, arr);
  return false;
}

function _requireSentry(processKind) {
  try {
    if (processKind === 'main') return require('@sentry/electron/main');
    if (processKind === 'renderer') return require('@sentry/electron/renderer');
    if (processKind === 'node') return require('@sentry/node');
  } catch { /* package not installed */ }
  return null;
}

// reportSoftError(processKind, category, error, context?)
//   processKind: 'main' | 'renderer' | 'node'
//   category:    short tag like 'bg-analyze.python-crash'
//   error:       Error object OR a string
//   context:     optional object of extra fields (will be scrubbed)
// ── Breadcrumbs ─────────────────────────────────────────────────────
// An isolated snapshot tells you what broke; a trail tells you why. Every
// server log line becomes a breadcrumb, so an event arrives with the
// sequence that led to it - which request ran, which file, which engine
// decision - instead of just the moment of failure. Sentry keeps the most
// recent hundred and attaches them automatically.
function addTrail(processKind, message, data) {
  try {
    const Sentry = _requireSentry(processKind);
    if (!Sentry || !Sentry.addBreadcrumb) return;
    Sentry.addBreadcrumb({
      category: 'app',
      level: 'info',
      message: String(message).slice(0, 300),
      data: data && typeof data === 'object' ? data : undefined,
    });
  } catch {}
}

// A stable, anonymous id per installation. Without it there is no way to
// tell one machine reporting four hundred times from four hundred
// machines reporting once - which is the difference between a nuisance
// and an emergency. It is a random identifier written beside the app's
// own data: no name, no account, nothing tied to a person.
let _installId = null;
function getInstallId(dataDir) {
  if (_installId) return _installId;
  try {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const dir = dataDir || path.join(require('os').homedir(), 'AppData', 'Roaming', 'freqphull');
    const file = path.join(dir, 'install-id');
    if (fs.existsSync(file)) {
      _installId = String(fs.readFileSync(file, 'utf8')).trim().slice(0, 40);
    }
    if (!_installId) {
      _installId = crypto.randomBytes(8).toString('hex');
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, _installId); } catch {}
    }
  } catch { _installId = 'unknown'; }
  return _installId;
}

// Anything that knows about live app state registers here, so every
// event carries the state at the moment it happened rather than a
// guess reconstructed later.
let _stateProvider = null;
function setStateProvider(fn) { _stateProvider = typeof fn === 'function' ? fn : null; }

function reportSoftError(processKind, category, error, context) {
  if (!SENTRY_DSN_ENV) return;
  const Sentry = _requireSentry(processKind);
  if (!Sentry || !Sentry.captureException) return;

  // Bail if Sentry didn't initialize successfully.
  try {
    const hub = Sentry.getCurrentHub && Sentry.getCurrentHub();
    if (!hub || !hub.getClient || !hub.getClient()) return;
  } catch { return; }

  if (_isRateLimited(category)) return;

  try {
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setTag('category', category);
      // Group by category, not by message - "exit 1" vs "exit 9009"
      // shouldn't fragment the dashboard into single-event issues.
      // Group by category so five exit codes make one issue rather than
      // five. A payload can add `_group` when the category is too broad
      // to be useful on its own - distinct Python exceptions deserve
      // separate issues even though they share a category.
      const group = context && context._group ? String(context._group).slice(0, 80) : null;
      scope.setFingerprint(group ? [category, group] : [category]);

      // Tags are what Sentry can filter and aggregate on, so the
      // dimensions worth asking "is this only on X?" about live here
      // rather than buried in the payload.
      try {
        const os = require('os');
        scope.setTag('os_release', os.release());
        scope.setTag('arch', os.arch());
        scope.setTag('cores', String(os.cpus().length));
        scope.setTag('ram_gb', String(Math.round(os.totalmem() / 1073741824)));
        scope.setTag('locale', process.env.LANG || process.env.LC_ALL ||
          (Intl.DateTimeFormat().resolvedOptions().locale || 'unknown'));
      } catch {}
      try { scope.setUser({ id: getInstallId() }); } catch {}

      // Live application state, supplied by whichever process knows it.
      try {
        if (_stateProvider) {
          const st = _stateProvider() || {};
          scope.setContext('app_state', st);
          // The few that are worth filtering on get promoted to tags.
          for (const key of ['engine_source', 'python_version', 'lite', 'packaged', 'engines_ok']) {
            if (st[key] !== undefined && st[key] !== null) scope.setTag(key, String(st[key]));
          }
        }
      } catch {}
      // Machine context on every event. Cheap to gather, and it's the
      // first thing you want when triaging a remote failure.
      try {
        const os = require('os');
        scope.setContext('machine', {
          os_release: os.release(),
          arch: os.arch(),
          cpu: (os.cpus()[0] || {}).model || 'unknown',
          cores: os.cpus().length,
          ram_gb: Math.round(os.totalmem() / 1073741824),
          free_ram_gb: Math.round(os.freemem() / 1073741824 * 10) / 10,
          uptime_s: Math.round(process.uptime()),
        });
      } catch {}
      if (context && typeof context === 'object') {
        for (const [k, v] of Object.entries(context)) {
          try { scope.setExtra(k, scrubObject(v)); } catch {}
        }
      }
      if (error instanceof Error) Sentry.captureException(error);
      else Sentry.captureMessage(scrubString(String(error)), 'warning');
    });
  } catch { /* never let reporting take the app down */ }
}

module.exports = { init, scrubString, scrubObject, reportSoftError,
  addTrail,
  getInstallId,
  setStateProvider,
};
