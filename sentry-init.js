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

const SENTRY_DSN_ENV = process.env.FREQPHULL_SENTRY_DSN || '';

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
    // Package not installed or init failure — don't take the app down.
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
// let us prioritize categories — this does.

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

module.exports = { init, scrubString, scrubObject, reportSoftError };
