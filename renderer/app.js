/* Freq.Phull — Renderer */
const API = 'http://127.0.0.1:47891';
let fmt='mp3',outDir=null,currentHistId=null,backendOnline=false;
let lastFilePath = null; // track path for WAV fallback

// Single point of truth for lastFilePath so dependent UI (e.g. Send to Separator) can react.
function setLastFilePath(p, displayName) {
  lastFilePath = p;
  // Enable/disable the "Send to Separator" button on the analyze page
  const btn = document.getElementById('btn-send-stems');
  if (btn) btn.disabled = !p;
  // Remember a friendly name for the separator drop card
  if (p && displayName) sepLastSourceName = displayName;
}
let sepLastSourceName = null;
let audioCtx=null,audioBuf=null,srcNode=null,gainNode=null;
// Source-generation counter. Each startAudio bumps it; stale srcNodes
// (whose onended fires async after their .stop()) check it to know if
// they're still the active source. Without this, stale end-handlers
// could reset playing/pauseOff while a fresh srcNode is playing.
let _srcGen = 0;
let playing=false,startT=0,pauseOff=0,rafId=null,pitchVal=0;
let currentKey=null,currentMode=null,currentBpm=null;
let noteTimer=null,histData=[];
let metroOn=false,metroACtx=null,metroBeat=0,metroId=null,metroBpm=120;
let taps=[],volumeLevel=0.501,muted=false;

// ── Stem separator state ──────────────────────────────────────────────────────
let sepSourcePath = null;
// Separator queue (0.1.1): jobs run serially through the existing
// startSeparation() engine. Each entry: {id, path, name, status} with
// status 'waiting'|'running'|'done'|'error'. Batch-select in History can
// dump 10 tracks here and walk away.
let sepQueue = [];
let sepQueueRunning = false;
let _sepQueueSeq = 1;
let sepSourceName = null;
let sepMode = '4';        // '4' or '6'
let sepQuality = 'high';  // 'fast' | 'high' | 'ultra'
let sepDirectMode = false; // when true, skips Stage 1 (vocal isolation)
let sepEvtSource = null;  // active EventSource, so we can abort
let sepCurrent = null;    // last completed result {stems, output_dir, ...}
let sepAudioMap = {};     // path → { audio: HTMLAudioElement, raf: number }

// ── Download queue ────────────────────────────────────────────────────────────
// Each item: { id, url, fmt, outDir, title, thumb, status, progress, error, finishedAt, filename, fullPath, historyId }
// status: 'waiting' | 'downloading' | 'done' | 'error'
// Items stay in the array AFTER they finish (status='done'/'error') so the
// visual queue can show them as completed entries — solves the "double-
// download because I missed the toast" problem. Done items can be cleared
// via the "Clear completed" button. The active processing always targets
// the FIRST item with status='waiting' (or 'downloading' if it's a
// re-entry during refresh).
let dlQueue = [];
let dlProcessing = false;
let dlNextId = 1;

// Helper: find the index of the first item still in flight
function _dlActiveIndex() {
  return dlQueue.findIndex(q => q.status === 'waiting' || q.status === 'downloading');
}
// Helper: pop the active item index for processing
function _dlMarkDownloading(idx) {
  if (idx >= 0 && idx < dlQueue.length) {
    dlQueue[idx].status = 'downloading';
    dlQueue[idx].progress = 0;
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────
let fpSettings = JSON.parse(localStorage.getItem('fp_settings') || '{}');
function getSetting(key, def) { return fpSettings[key] !== undefined ? fpSettings[key] : def; }
function setSetting(key, val) { fpSettings[key] = val; localStorage.setItem('fp_settings', JSON.stringify(fpSettings)); }

// Language: 'en' or 'fr'
let lang = getSetting('lang', 'en');
// Auto-switch to analyze after download
let autoAnalyze = getSetting('autoAnalyze', true);

// ── History scroll preservation ──────────────────────────────────────────────
let historyScrollTop = 0;

function diagLog(msg, cls) {
  const d = document.getElementById('diag');
  if (!d) return;
  const el = document.createElement('div');
  el.className = cls || 'info';
  el.textContent = new Date().toLocaleTimeString() + ' ' + msg;
  d.appendChild(el);
  // Cap at 200 entries — long sessions used to accumulate thousands of <div>s
  // in the diagnostic pane, which both eats memory and slows scrollTop. Drop
  // the oldest entries past the cap.
  while (d.childElementCount > 200) {
    d.removeChild(d.firstElementChild);
  }
  d.scrollTop = d.scrollHeight;
  // Also send to main process log
  try { api.log(msg); } catch {}
}

// Map raw log messages to short friendly status text
function setStatus(msg) {
  const el = document.getElementById('load-status');
  if (el) el.textContent = msg;
}

function updateStatus(msg) {
  const m = msg.toLowerCase();
  if (m.includes('app ready'))                      setStatus('App ready…');
  else if (m.includes('protocol handler'))          setStatus('Setting up protocols…');
  else if (m.includes('creating window'))           setStatus('Building interface…');
  else if (m.includes('starting backend'))          setStatus('Starting engine…');
  else if (m.includes('server process starting'))   setStatus('Starting engine…');
  else if (m.includes('forked') || m.includes('pid=')) setStatus('Engine running…');
  else if (m.includes('sql.js loaded'))             setStatus('Loading database…');
  else if (m.includes('sql.js initialized'))        setStatus('Database ready…');
  else if (m.includes('db ready'))                  setStatus('Database loaded ✓');
  else if (m.includes('listening on port'))         setStatus('Backend online ✓');
  else if (m.includes('page loaded'))               setStatus('Interface ready…');
  else if (m.includes('bin dir'))                   setStatus('Checking tools…');
  else if (m.includes('yt-dlp') && m.includes('exists')) setStatus('Found yt-dlp ✓');
}

window.addEventListener('DOMContentLoaded', () => {
  diagLog('Renderer loaded', 'ok');

  // Listen for log messages from main process — map to friendly status
  api.onLog(msg => {
    diagLog('[main] ' + msg, 'info');
    updateStatus(msg);
  });

  // Get log file path
  api.getLogPath().then(p => {
    const el = document.getElementById('log-path-txt');
    if (el && p) el.textContent = p;
  }).catch(() => {});

  // Listen for backend-ready from main process
  api.onBackendReady(() => {
    diagLog('backend-ready signal received!', 'ok');
    onBackendReady();
  });

  diagLog('Starting backend poll...', 'info');
  pollBackend();

  api.getDownloads().then(p => {
    outDir = p;
    const el = document.getElementById('folder-lbl');
    if (el) el.textContent = p;
    diagLog('Downloads path: ' + p, 'info');
  }).catch(e => diagLog('getDownloads error: ' + e.message, 'err'));

  setupDrops();
  setupWaveformDrag();
  renderRef();
  applyLang(); // Apply saved language on startup
  // Wire the spectrum hover crosshair from app load — the spectrum canvas
  // lives in the always-visible meter panel now (it replaced the old
  // Spectral Balance bars). Wiring here means hover works even before
  // any audio has played. The function is idempotent (guarded by a flag)
  // so calling it again from startLiveSpectrum/paintSpectrumAnalyzer is fine.
  if (typeof _wireSpectrumHover === 'function') _wireSpectrumHover();
  // Paint an empty spectrum background so the user sees the grid + freq
  // labels from app start instead of a blank black rectangle. Updates again
  // when audio plays (live curve overlays this).
  if (typeof _paintEmptySpectrum === 'function') _paintEmptySpectrum();
  const urlIn = document.getElementById('url-in');
  if (urlIn) urlIn.addEventListener('keydown', e => { if (e.key === 'Enter') fetchInfo(); });
  // app-ready is marked later in onBackendReady() — after the first history
  // render completes — so the user never sees the empty-then-populated
  // history list flash. Anti-FOUC is layered: body opacity stays 0 until
  // we have content to show. Hard fallback: if onBackendReady hasn't
  // marked us ready within 2.5s (e.g. slow server boot), show the UI
  // anyway so the user isn't staring at a black screen.
  setTimeout(() => {
    if (!document.body.classList.contains('app-ready')) {
      document.body.classList.add('app-ready');
    }
  }, 2500);

  // Wire the auto-updater event stream → banner UI.
  // The main process drives the lifecycle; renderer just reacts. All state
  // is tracked in the closure of _setupUpdater so a stray IPC event after
  // an unrelated install can't corrupt anything.
  if (typeof _setupUpdater === 'function') _setupUpdater();
});

let pollCount = 0;
function pollBackend() {
  if (backendOnline) return;
  pollCount++;
  diagLog('Poll #' + pollCount + ' → ' + API + '/health', 'info');
  if (pollCount === 1) setStatus('Launching engine…');
  else if (pollCount === 2) setStatus('Loading modules…');
  else if (pollCount === 3) setStatus('Almost there…');
  else setStatus('Still starting… (' + pollCount + ')');

  fetch(API + '/health', { signal: AbortSignal.timeout(1500) })
    .then(r => r.json())
    .then(d => {
      diagLog('Health response: ' + JSON.stringify(d), 'ok');
      onBackendReady();
    })
    .catch(e => {
      diagLog('Poll failed: ' + e.message, 'err');
      if (!backendOnline) setTimeout(pollBackend, 800);
    });
}

function onBackendReady() {
  if (backendOnline) return;
  backendOnline = true;
  diagLog('Backend is ready! Hiding loading screen.', 'ok');
  setStatus('Ready — loading app…');
  setTimeout(() => {
    const loading = document.getElementById('loading');
    if (loading) { loading.style.opacity = '0'; setTimeout(() => { loading.style.display = 'none'; }, 400); }
    const dot = document.getElementById('tb-dot');
    const txt = document.getElementById('tb-txt');
    if (dot) dot.className = 'tb-dot ready';
    if (txt) txt.textContent = 'Ready';
  }, 300);
  // Critical-path: load history immediately so the History tab is populated
  // when the user might switch to it. Other init runs deferred so the first
  // paint isn't blocked by checks the user doesn't see yet.
  loadHistory().then(() => {
    // First history render is done — safe to fade the UI in. Two RAFs so
    // styles, fonts, and the freshly-rendered list all paint before the
    // body opacity transitions to 1.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.add('app-ready');
    }));
  });
  // Subscribe to live server events so history refreshes itself when a
  // download finishes anywhere (this window, another window, or the
  // Chrome extension). Done here because it needs the backend online.
  subscribeToServerEvents();
  // Defer secondary work to idle / next-tick so primary paint is smooth.
  // requestIdleCallback isn't always available on Electron's older engine,
  // so we fall back to setTimeout. The key is yielding the main thread.
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
  idle(() => repairHistory(true));
  idle(() => checkEnginesStatus());
  idle(() => checkIntegrity());
}

async function checkIntegrity() {
  try {
    const r = await fetch(API + '/integrity', { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    // Only show banner on true hash mismatch ('tampered'). 'missing-files'
    // typically means the asar.unpacked path didn't resolve — that's a
    // packaging quirk, not malice, and engines still run.
    if (d.status === 'tampered') {
      showTamperBanner(d, 'tampered');
    }
  } catch (e) {
    // Silent: integrity is best-effort. Server unreachable = no banner.
  }
}

function showTamperBanner(info, mode) {
  // Persistent banner at the top of the app. Two modes:
  //  - 'tampered': hash mismatch (genuine adversarial signal). Engines off.
  //  - any other future failure mode: informational only.
  const existing = document.getElementById('tamper-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'tamper-banner';
  banner.className = 'tamper-banner';
  if (mode !== 'tampered') banner.classList.add('soft');
  const isTampered = mode === 'tampered';
  const headline = isTampered ? '⚠ Build verification failed' : 'ℹ Build check note';
  const body = isTampered
    ? 'This Freq.Phull build does not match the signed manifest. AI engines have been disabled to protect your data. Reinstall from the official source to restore full functionality.'
    : 'A non-critical packaging check did not match. Engines remain available; this is informational only.';
  banner.innerHTML = `
    <strong>${headline}</strong>
    <span>${body}</span>
    <span class="tamper-banner-files">${info.mismatchCount} file${info.mismatchCount === 1 ? '' : 's'}</span>
    <button class="tamper-banner-x" title="Dismiss" onclick="this.parentElement.remove()">×</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
}

// ── Tab scroll memory ─────────────────────────────────────────────────────
// #main is the single scroll container. Switching tabs toggles display:none
// on panes, which loses scroll position. We remember scrollTop per tab and
// restore it on re-entry — both for normal switches AND after async loads
// (history, separator history) repaint the list.
const tabScrollMemory = {};
let lastTab = null;

// ── Tab navigation history (back/forward like a browser) ────────────────────
// Maintains a linear stack of visited tabs so the user can step backward
// and forward through their navigation. When the user navigates forward via
// showTab() (not via the back/forward buttons), any "future" history is
// discarded — standard browser-history semantics. Suppress flag stops the
// internal forward/back from polluting the history with their own entries.
let tabHistory = [];
let tabHistoryIdx = -1;
let tabHistorySuppress = false;

function pushTabHistory(tab) {
  if (tabHistorySuppress) return;
  // Don't push the same tab twice in a row
  if (tabHistory[tabHistoryIdx] === tab) return;
  // Discard anything after the current index — we're branching from here
  tabHistory = tabHistory.slice(0, tabHistoryIdx + 1);
  tabHistory.push(tab);
  tabHistoryIdx = tabHistory.length - 1;
  updateTabHistoryButtons();
}

function updateTabHistoryButtons() {
  const back = document.getElementById('tb-back');
  const fwd = document.getElementById('tb-forward');
  if (back) back.disabled = tabHistoryIdx <= 0;
  if (fwd)  fwd.disabled  = tabHistoryIdx >= tabHistory.length - 1;
}

function tabHistoryBack() {
  if (tabHistoryIdx <= 0) return;
  tabHistoryIdx--;
  const tab = tabHistory[tabHistoryIdx];
  const btn = document.querySelector('.nav-btn[data-tab="' + tab + '"]');
  if (btn) {
    tabHistorySuppress = true;
    showTab(btn);
    tabHistorySuppress = false;
  }
  updateTabHistoryButtons();
}

function tabHistoryForward() {
  if (tabHistoryIdx >= tabHistory.length - 1) return;
  tabHistoryIdx++;
  const tab = tabHistory[tabHistoryIdx];
  const btn = document.querySelector('.nav-btn[data-tab="' + tab + '"]');
  if (btn) {
    tabHistorySuppress = true;
    showTab(btn);
    tabHistorySuppress = false;
  }
  updateTabHistoryButtons();
}

function showTab(btn) {
  // Save current tab's scroll position before swapping
  const main = document.getElementById('main');
  if (lastTab && main) tabScrollMemory[lastTab] = main.scrollTop;

  // Note: the global mini player keeps playing across tab switches now —
  // it's not folder-scoped anymore.

  // Accessibility (0.2.2): aria-current marks the active nav item so
  // screen readers announce the current page.
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.remove('on');
    b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('on'));
  btn.classList.add('on');
  btn.setAttribute('aria-current', 'page');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('on');

  const newTab = btn.dataset.tab;
  lastTab = newTab;
  // Track this in the tab history stack (skips if invoked from back/forward)
  pushTabHistory(newTab);

  // Mini player compact mode on Analyze tab. When the user is on Analyze,
  // the Analyzer view already exposes the time labels, seek bar, volume,
  // and stop button — the mini player would be redundant. Collapse it to
  // just thumb, title, transport (shuffle/prev/play/next), favorite, and
  // notepad. The CSS transition takes care of the slide-and-shrink.
  // On any other tab, mini player goes back to full width.
  const mini = document.getElementById('sp-fv-mini-player');
  if (mini) {
    // We only run the compact treatment in mirror mode — i.e. when the
    // Analyzer actually owns the audio. In legacy mode (mini player owns
    // the audio) we want the full controls everywhere.
    if (newTab === 'analyze' && analyzeMirrorActive) {
      mini.classList.add('compact');
    } else {
      mini.classList.remove('compact');
    }
  }

  // Restore scroll position immediately for tabs that don't reload async content
  // (history/stems re-render their lists, so we restore after the load promise)
  const restoreScroll = () => {
    if (main) main.scrollTop = tabScrollMemory[newTab] || 0;
  };

  if (newTab === 'history') {
    loadHistory().then(() => {
      // Wait one tick so the rendered list has its real height
      setTimeout(restoreScroll, 30);
    });
  } else if (newTab === 'stems') {
    loadSepHistory();
    setTimeout(restoreScroll, 30);
  } else if (newTab === 'stockpile') {
    // If a folder view is currently open (e.g. user clicked 🎵 to analyze
    // a track and is now coming back), preserve it and just refresh the
    // track list. Otherwise show the dashboard.
    if (spFvFolder) {
      // Refresh the track list silently — tags or commits may have changed
      fetch(API + '/stockpile/folders/' + spFvFolder.id + '/tracks')
        .then(r => r.json())
        .then(j => {
          spFvTracks = j.tracks || [];
          renderFolderTracks();
        })
        .catch(() => {});
    } else {
      loadStockpile();
    }
    setTimeout(restoreScroll, 30);
  } else if (newTab === 'settings') {
    renderSettings();
    setTimeout(restoreScroll, 0);
  } else {
    // Synchronous tabs: download, analyze, transcribe, tools — restore immediately
    setTimeout(restoreScroll, 0);
  }
}
function setFmt(btn) { document.querySelectorAll('.fmt').forEach(b => b.classList.remove('on')); btn.classList.add('on'); fmt = btn.dataset.fmt; }
function dlSt(txt, type) {
  const status = document.getElementById('dl-status');
  if (!status) return;
  // Empty text = "clear the status." Hide directly instead of showing an
  // empty pill with a stray dot. Pre-13z this leaked a visible-but-empty
  // bar when called with ('', '').
  if (!txt) {
    status.classList.add('hidden');
    if (window._dlIdleHide) { clearTimeout(window._dlIdleHide); window._dlIdleHide = null; }
    return;
  }
  status.classList.remove('hidden');
  document.getElementById('dl-dot').className = 'dot ' + (type||'');
  document.getElementById('dl-txt').textContent = txt;
  // Reset any pending idle-hide; the new state will decide when to hide.
  if (window._dlIdleHide) { clearTimeout(window._dlIdleHide); window._dlIdleHide = null; }
  // Auto-hide after success or error states settle. Spinner/working states
  // stay visible.
  if (type === 'ok' || type === 'err') {
    window._dlIdleHide = setTimeout(() => {
      const s = document.getElementById('dl-status');
      if (s) s.classList.add('hidden');
    }, 4500);
  }
}
function trSt(txt, type) { document.getElementById('trans-dot').className = 'dot ' + (type||''); document.getElementById('trans-txt').textContent = txt; }

async function fetchInfo() {
  const url = document.getElementById('url-in').value.trim();
  if (!url) return;
  dlSt('Fetching info…', 'spin');
  document.getElementById('btn-fetch').disabled = true;
  document.getElementById('vid-card').classList.add('hidden');
  try {
    const r = await fetch(API + '/info?url=' + encodeURIComponent(url));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    document.getElementById('vid-thumb').src = d.thumbnail || '';
    document.getElementById('vid-title').textContent = d.title || '(no title)';
    document.getElementById('vid-sub').textContent = [d.channel, d.duration ? fmt2time(d.duration) : ''].filter(Boolean).join(' · ');
    document.getElementById('vid-card').classList.remove('hidden');
    dlSt('Ready — choose a format and download', 'ok');

    // ── Auto-queue (0.1.4) ────────────────────────────────────────
    // Saves a second click: as soon as the info comes back, drop the
    // track into the download queue using the currently-selected
    // format. The user can still cancel from the queue if needed.
    // We re-enable the Fetch button BEFORE calling startDownload so
    // the input doesn't appear frozen if startDownload pops a confirm
    // (e.g. duplicate-this-session dialog).
    document.getElementById('btn-fetch').disabled = false;
    // Fire-and-forget — startDownload handles its own UI feedback.
    startDownload().catch(()=>{});
    return;
  } catch(e) { dlSt('Error: ' + e.message, 'err'); }
  finally { document.getElementById('btn-fetch').disabled = false; }
}

async function pickFolder() {
  const p = await api.pickFolder();
  if (p) { outDir = p; document.getElementById('folder-lbl').textContent = p; }
}

async function startDownload() {
  const url = document.getElementById('url-in').value.trim();
  if (!url) return;

  // Normalize URLs for duplicate detection — strip trailing slashes,
  // params order doesn't matter for the same video ID. We're not trying
  // to be perfect, just catch the obvious "same URL pasted twice" case.
  const norm = (u) => {
    try {
      const x = new URL(u);
      return (x.host + x.pathname + (x.searchParams.get('v') || '')).toLowerCase();
    } catch { return u.toLowerCase(); }
  };
  const normUrl = norm(url);

  // ── Duplicate detection: already in queue OR already done this session
  // The old code only checked the queue. Now we also check completed
  // downloads from this session, so users get a clear warning before
  // re-downloading a file they already have. This is the main fix for
  // the "I missed the toast and downloaded it twice" complaint.
  const existing = dlQueue.find(q => norm(q.url) === normUrl);
  if (existing) {
    if (existing.status === 'waiting' || existing.status === 'downloading') {
      showAppNotification(t('alreadyInQueue'), 'info');
      _dlPulseItem(existing.id);
      return;
    }
    if (existing.status === 'done') {
      // Already downloaded this session. Pulse the existing row and
      // confirm before adding a second copy. Use the friendliest
      // possible language — "already downloaded" not "duplicate."
      _dlPulseItem(existing.id);
      const when = existing.finishedAt
        ? Math.max(1, Math.round((Date.now() - existing.finishedAt) / 60000))
        : null;
      const whenStr = when ? (when < 60 ? when + ' min ago' : Math.round(when/60) + 'h ago') : 'this session';
      // Styled modal instead of native confirm() — native dialogs in
      // Electron show "freqphull" in the title bar and look very out
      // of place against the app's dark theme.
      const ok = await confirmModal({
        title: 'Already downloaded',
        message: `You already downloaded this ${whenStr}. Download again anyway?`,
        detail: `${(existing.title || 'Track').slice(0, 80)}\nFormat: ${(existing.fmt || 'mp3').toUpperCase()}`,
        okLabel: 'Download again',
        cancelLabel: 'Cancel',
      });
      if (!ok) {
        // User cancelled — focus the existing row so they can find the file
        showAppNotification('Already downloaded — see queue list', 'info');
        return;
      }
      // Fall through to re-download as a new item
    }
    // status='error' just falls through and gets re-added — error retries
    // are expected behavior.
  }

  const title = document.getElementById('vid-title')?.textContent || 'YouTube audio';
  const thumb = document.getElementById('vid-thumb')?.src || '';
  const item = {
    id: dlNextId++,
    url, fmt, outDir, title, thumb,
    status: 'waiting',
    progress: 0,
    addedAt: Date.now(),
  };

  dlQueue.push(item);
  updateDlQueueUI();
  showAppNotification(t('addedToQueue') + ' (' + dlQueue.filter(q => q.status === 'waiting' || q.status === 'downloading').length + ' ' + t('pending') + ')', 'info');

  if (!dlProcessing) processDlQueue();
}

// Briefly pulse a queue row to draw the user's attention to it. Used when
// they paste a URL that's already downloaded — the visual cue is much
// stronger than a toast alone.
function _dlPulseItem(id) {
  // Wait for next paint so the row exists if we just added it
  setTimeout(() => {
    const row = document.querySelector(`.dl-queue-item[data-id="${id}"]`);
    if (!row) return;
    row.classList.remove('duplicate-pulse');
    // Force reflow so the animation re-fires even if the class was
    // already present from a previous pulse
    void row.offsetWidth;
    row.classList.add('duplicate-pulse');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => row.classList.remove('duplicate-pulse'), 5000);
  }, 50);
}

function updateDlQueueUI() {
  const btn = document.getElementById('btn-dl');
  const card = document.getElementById('dl-queue-card');
  const itemsEl = document.getElementById('dl-queue-items');
  const countEl = document.getElementById('dl-queue-count');

  // Pending = items NOT yet finished. Used for the Download button label
  // and the "Already downloaded" detection in startDownload().
  const pending = dlQueue.filter(q => q.status === 'waiting' || q.status === 'downloading').length;

  // Download button label tracks pending count, never disables — clicking
  // it always tries to add the current URL (subject to duplicate check).
  if (btn) {
    btn.disabled = false;
    const downloadSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> ';
    btn.innerHTML = pending > 0
      ? downloadSvg + 'Add to Queue (' + pending + ')'
      : downloadSvg + 'Download';
  }

  if (!card || !itemsEl) return;
  if (dlQueue.length === 0) {
    // No queue items at all — hide the panel
    card.classList.add('hidden');
    itemsEl.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    return;
  }
  card.classList.remove('hidden');
  if (countEl) countEl.textContent = String(dlQueue.length);

  // Order: active items (waiting/downloading) at the top, finished at
  // the bottom. Insertion order preserved within each group.
  const active = dlQueue.filter(q => q.status === 'waiting' || q.status === 'downloading');
  const finished = dlQueue.filter(q => q.status === 'done' || q.status === 'error');
  const ordered = [...active, ...finished];
  itemsEl.innerHTML = ordered.map(q => _dlRenderQueueRow(q)).join('');

  // Wire up the per-row action buttons. Delegated handlers via onclick on
  // each row would also work, but keeping the handlers explicit makes the
  // wiring obvious. Cost of re-binding is negligible — at most a handful
  // of rows in practice.
  for (const q of ordered) {
    const cancelBtn = document.getElementById('dl-qi-cancel-' + q.id);
    if (cancelBtn) cancelBtn.onclick = () => removeDlItem(q.id);
    const openBtn = document.getElementById('dl-qi-open-' + q.id);
    if (openBtn && q.fullPath) {
      openBtn.onclick = (e) => {
        e.preventDefault();
        // Open the containing folder in OS file explorer. We try
        // showInFolder (highlights the file) first, fall back to opening
        // the folder if that's not available in this Electron build.
        if (api.showInFolder) api.showInFolder(q.fullPath);
        else if (api.openPath) api.openPath(q.fullPath.split(/[/\\]/).slice(0, -1).join('/'));
      };
    }
    const analyzeBtn = document.getElementById('dl-qi-analyze-' + q.id);
    if (analyzeBtn && q.fullPath && q.filename) {
      analyzeBtn.onclick = async () => {
        try {
          const result = await api.readFile(q.fullPath);
          if (!result.ok) throw new Error(result.error);
          setLastFilePath(q.fullPath, q.filename);
          showTab(document.querySelector('[data-tab="analyze"]'));
          await loadAudioBuffer(result.data, q.filename, q.historyId);
        } catch (e) {
          showAppNotification('Could not load: ' + e.message, 'err');
        }
      };
    }
  }
}

// Render a single queue row. Pure HTML string, no event wiring — that
// happens in updateDlQueueUI after innerHTML is set.
function _dlRenderQueueRow(q) {
  // Status-specific SVG icon for the left dot
  const STATUS_ICONS = {
    waiting:    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    downloading:'<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
    done:       '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };
  const statusLabel = {
    waiting:    'Waiting',
    downloading: 'Downloading… ' + Math.round(q.progress || 0) + '%',
    done:       'Downloaded ✓',
    error:      'Failed' + (q.error ? ' — ' + q.error.slice(0, 40) : ''),
  }[q.status];

  // Right-side action buttons. Different per status:
  //   waiting → cancel
  //   downloading → none (can't cancel mid-flight cleanly)
  //   done → open-in-analyze + show-in-folder
  //   error → none (Download button can be used to retry by re-pasting)
  let actions = '';
  if (q.status === 'waiting') {
    actions = `<button class="dl-qi-action danger" id="dl-qi-cancel-${q.id}" title="Remove from queue">✕</button>`;
  } else if (q.status === 'done' && q.fullPath) {
    actions = `
      <button class="dl-qi-action" id="dl-qi-analyze-${q.id}" title="Open in Analyze">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
      </button>
      <button class="dl-qi-action" id="dl-qi-open-${q.id}" title="Show in folder">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </button>
    `;
  }

  const titleShown = (q.title || 'Track').slice(0, 60);
  const progPct = q.status === 'downloading' ? (q.progress || 0) : 0;
  return `
    <div class="dl-queue-item ${q.status}" data-id="${q.id}">
      <div class="dl-qi-status ${q.status}">${STATUS_ICONS[q.status]}</div>
      <div class="dl-qi-info">
        <div class="dl-qi-name">${escapeHtml(titleShown)}</div>
        <div class="dl-qi-meta">
          <span class="dl-qi-fmt-pill">${escapeHtml((q.fmt || 'mp3').toUpperCase())}</span>
          <span>${escapeHtml(statusLabel)}</span>
        </div>
      </div>
      <div class="dl-qi-actions">${actions}</div>
      <div class="dl-qi-bar" style="width:${progPct}%"></div>
    </div>
  `;
}

function removeDlItem(id) {
  // Remove a queue item by id. Refuses to remove an in-flight download
  // because the SSE stream still needs to finish or error cleanly.
  const idx = dlQueue.findIndex(q => q.id === id);
  if (idx < 0) return;
  if (dlQueue[idx].status === 'downloading') {
    showAppNotification('Cannot remove an item that\'s currently downloading', 'info');
    return;
  }
  dlQueue.splice(idx, 1);
  updateDlQueueUI();
}

// Legacy entry point kept for backwards compatibility with any code that
// still uses index-based removal. Routes through the new id-based API.
function removeDlQueue(idx) {
  if (idx >= 0 && idx < dlQueue.length) removeDlItem(dlQueue[idx].id);
}

// Wipe done/error rows from the queue. Pending and active items stay.
// Called from the "Clear completed" button in the queue header.
function clearCompletedDownloads() {
  dlQueue = dlQueue.filter(q => q.status === 'waiting' || q.status === 'downloading');
  updateDlQueueUI();
}

// ── Auto-clear completed downloads ──────────────────────────────────────
// Drops done/error entries from the visible queue after a chosen
// duration so the user doesn't have to manually clean up. Stored as
// hours in localStorage; 0 = off. Default 24h. Sweep runs every minute
// AND on every queue UI update so newly-stale items disappear promptly.
//
// We only auto-clear items with status='done' or 'error'. Active items
// (waiting/downloading) are NEVER auto-cleared — they need to either
// complete or be manually cancelled.
let dlAutoclearHours = (() => {
  const raw = localStorage.getItem('freqphull.dlAutoclearHours');
  const n = raw === null ? 24 : parseFloat(raw);
  return isFinite(n) && n >= 0 ? n : 24;
})();

function setDlAutoclear(hours) {
  const n = parseFloat(hours);
  dlAutoclearHours = isFinite(n) && n >= 0 ? n : 0;
  try { localStorage.setItem('freqphull.dlAutoclearHours', String(dlAutoclearHours)); } catch {}
  // Sweep immediately when the user changes the setting — gives instant
  // feedback if there are items the new setting would clear.
  _sweepStaleDownloads();
}

function _sweepStaleDownloads() {
  if (dlAutoclearHours <= 0) return;       // off
  if (!dlQueue.length) return;
  const cutoff = Date.now() - dlAutoclearHours * 3600 * 1000;
  const before = dlQueue.length;
  dlQueue = dlQueue.filter(q => {
    // Always keep active items
    if (q.status === 'waiting' || q.status === 'downloading') return true;
    // For finished items, keep if recent enough (or if no timestamp,
    // which shouldn't happen but is a safe fallback)
    if (!q.finishedAt) return true;
    return q.finishedAt >= cutoff;
  });
  if (dlQueue.length !== before) updateDlQueueUI();
}

// Run the sweep every minute. Light enough that the cost is invisible,
// frequent enough that items don't linger beyond a minute past their
// expiration time. Started on first DOMContentLoaded below.
let _dlSweepInterval = null;

async function processDlQueue() {
  // Find the next item to process — first one with status 'waiting'. Done
  // and errored items stay in the array so the UI keeps showing them.
  const idx = dlQueue.findIndex(q => q.status === 'waiting');
  if (idx < 0) {
    dlProcessing = false;
    updateDlQueueUI();
    return;
  }
  dlProcessing = true;
  const item = dlQueue[idx];
  _dlMarkDownloading(idx);
  updateDlQueueUI();

  document.getElementById('dl-prog-wrap').classList.remove('hidden');
  document.getElementById('dl-fill').style.width = '0%';
  document.getElementById('dl-prog-lbl').textContent = 'Starting…';
  dlSt('Downloading: ' + item.title.slice(0, 35) + '…', 'spin');

  const params = new URLSearchParams({ url: item.url, format: item.fmt });
  if (item.outDir) params.set('outDir', item.outDir);
  const es = new EventSource(API + '/download?' + params);

  es.addEventListener('progress', e => {
    const p = JSON.parse(e.data).progress;
    item.progress = p;
    document.getElementById('dl-fill').style.width = Math.round(p) + '%';
    document.getElementById('dl-prog-lbl').textContent = Math.round(p) + '%';
    // Update only this row's progress bar without re-rendering the whole
    // queue panel. Avoids click target jitter on the action buttons.
    const bar = document.querySelector(`.dl-queue-item[data-id="${item.id}"] .dl-qi-bar`);
    if (bar) bar.style.width = Math.round(p) + '%';
    const meta = document.querySelector(`.dl-queue-item[data-id="${item.id}"] .dl-qi-meta`);
    if (meta) {
      const fmt = meta.querySelector('.dl-qi-fmt-pill');
      const txt = meta.querySelector('span:not(.dl-qi-fmt-pill)');
      if (txt) txt.textContent = 'Downloading… ' + Math.round(p) + '%';
    }
  });
  es.addEventListener('status', e => dlSt(JSON.parse(e.data).message, 'spin'));

  es.addEventListener('done', async e => {
    es.close();
    const { filename, fullPath, historyId } = JSON.parse(e.data);
    document.getElementById('dl-fill').style.width = '100%';
    document.getElementById('dl-prog-lbl').textContent = '✓ ' + filename;
    dlSt('Saved — ' + filename, 'ok');
    currentHistId = historyId;

    // Update item state in place — keep it in the queue so the user can
    // see it's done, open the folder, etc.
    item.status = 'done';
    item.progress = 100;
    item.finishedAt = Date.now();
    item.filename = filename;
    item.fullPath = fullPath;
    item.historyId = historyId;

    try {
      const result = await api.readFile(fullPath);
      if (!result.ok) throw new Error(result.error);
      setLastFilePath(fullPath, filename);

      // Only auto-switch to analyze tab if setting is on
      if (autoAnalyze) {
        showTab(document.querySelector('[data-tab="analyze"]'));
      }
      await loadAudioBuffer(result.data, filename, historyId);

      // Notification with BPM/key — click to jump to analyze
      showAppNotification('✓ ' + filename.slice(0, 30) + ' — ' + (currentBpm || '?') + ' BPM · ' + (currentKey || '?') + ' ' + (currentMode || ''), 'done', () => {
        showTab(document.querySelector('[data-tab="analyze"]'));
      });
    } catch(err) {
      dlSt('Saved — open Analyze tab to load manually', 'ok');
      showAppNotification('✓ Downloaded: ' + filename.slice(0, 35), 'done');
    }

    // Re-render the queue UI so the done item picks up its new actions
    // (Open in Analyze, Show in folder)
    updateDlQueueUI();
    setTimeout(() => document.getElementById('dl-prog-wrap')?.classList.add('hidden'), 2000);

    // Auto-refresh the History tab so the new track shows up immediately
    // even if the user isn't there yet.
    refreshUIForAction('track-downloaded', { historyId });

    // Auto-match seed artists. If any folder's seed artist appears in the
    // track title with high confidence, auto-tag the track into that folder.
    // Best-effort — failures are silent (we don't want to noise the user
    // about a feature they may not have set up yet).
    if (historyId && autoTagEnabled()) {
      try {
        // "Auto-send to detected folder": when the setting is on, ask the
        // server to also promote the best match to primary and move the
        // file into place — one motion from download to organized.
        // Gated on autoTagEnabled() above — if the user opted out of
        // automatic tagging, skip the whole thing.
        const autoSend = localStorage.getItem('freqphull.autoSend') === '1';
        const am = await fetch(API + '/stockpile/tracks/' + historyId + '/auto-match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit: autoSend,
            stockpile_root: (autoSend && stockpileFolder) ? stockpileFolder : undefined,
          }),
        });
        const amJ = await am.json();
        if (amJ.committed && amJ.committed.moved) {
          showAppNotification('📦 ' + t('sentTo') + ' ' + (amJ.committed.folder_name || ''), 'done');
          refreshUIForAction('tag-changed', { historyId });
        } else if (amJ.tagged && amJ.tagged.length) {
          const names = amJ.tagged.map(t => t.folder_name).join(', ');
          showAppNotification('✓ ' + t('autoMatched') + ': ' + names, 'ok');
          // Refresh tag chips on the new history row
          refreshUIForAction('tag-changed', { historyId });
        }
      } catch {}
    }

    // Process next waiting item if any
    if (dlQueue.some(q => q.status === 'waiting')) {
      setTimeout(processDlQueue, 1000);
    } else {
      dlProcessing = false;
      updateDlQueueUI();
    }
  });

  es.addEventListener('error', e => {
    es.close();
    let msg = 'Download failed';
    try { msg = JSON.parse(e.data).message; } catch {}
    dlSt('Error: ' + msg, 'err');
    showAppNotification('✕ ' + msg.slice(0, 40), 'err');

    // Mark this item errored, keep it in the queue
    item.status = 'error';
    item.error = msg;
    item.finishedAt = Date.now();

    updateDlQueueUI();
    document.getElementById('dl-prog-wrap')?.classList.add('hidden');
    if (dlQueue.some(q => q.status === 'waiting')) {
      setTimeout(processDlQueue, 1000);
    } else {
      dlProcessing = false;
      updateDlQueueUI();
    }
  });
}

// ── App notifications (modern stack) ────────────────────────────────────
//
// API: showAppNotification(message, type, onClick, durationMs)
//   message       string  — shown inside the toast (HTML safe; we set as text)
//   type          string  — 'ok' | 'err' | 'info' | 'warn'. Legacy aliases
//                           'done' → 'ok', 'pending' → 'info', 'unknown' →
//                           'info' supported so we don't break older callers.
//   onClick       fn      — optional. Fired if user clicks the body (not X).
//                           Notification dismisses either way.
//   durationMs    number  — defaults 5500. Pass 0 to make sticky (no auto-
//                           dismiss; user must click X). Pass smaller for
//                           low-importance ack toasts.
//
// Behavior:
//   • Stacks vertically top-right (newest first)
//   • Slides in from right with spring easing
//   • Auto-dismisses with a progress bar; hovering the stack pauses ALL timers
//   • Click body → onClick + dismiss; click X → just dismiss
//   • prefers-reduced-motion users get instant fades instead of springs
//
// Icons:
//   ok   ✓ check    err  ✕ x    info  i    warn  !
//
// Backwards-compatible with the old (msg, type, onClick) signature.

const _NOTIF_TYPE_MAP = {
  ok: 'ok', done: 'ok',
  err: 'err', error: 'err',
  info: 'info', pending: 'info', unknown: 'info',
  warn: 'warn', warning: 'warn',
};

const _NOTIF_ICONS = {
  ok:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  err:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  info: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6.5" r="1.6"/><rect x="10.5" y="10" width="3" height="9" rx="1.2"/></svg>',
  warn: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="10.6" y="6" width="2.8" height="8" rx="1.2"/><circle cx="12" cy="17.4" r="1.5"/></svg>',
};

// Module-scope state. _notifTimers holds per-toast dismiss timers so they
// can be cancelled (dismiss early on click, or refreshed on hover-pause).
let _notifStack = null;     // the container div
let _notifPaused = false;   // hover-pause flag
const _notifTimers = new WeakMap(); // toast el → { timeout, startedAt, remainingMs }

// Keep the toast stack out of the update banner's face. Both live in the
// top-right corner; the stack has the higher z-index, so without this it
// covered the banner's Install/Later buttons whenever a toast fired (the
// manual update check fires one immediately — guaranteed collision).
// Debounced window-resize broadcaster. Several pieces of UI use measured
// dimensions (notification stack, mini player thumb position, banner
// underlay). Listening once and firing a single rAF on changes keeps
// the handlers cheap and 60fps. Triggered by both real window resize
// AND ResizeObserver on the viewport so it also reacts when the dev
// tools dock changes size.
(function installResizeRelay(){
  if (window._fpResizeInstalled) return;
  window._fpResizeInstalled = true;
  let pending = false;
  function fire(){
    pending = false;
    try { if (typeof _repositionNotifStack === 'function') _repositionNotifStack(); } catch {}
    try { window.dispatchEvent(new CustomEvent('fp-layout-refresh')); } catch {}
  }
  function schedule(){
    if (pending) return;
    pending = true;
    requestAnimationFrame(fire);
  }
  window.addEventListener('resize', schedule, { passive: true });
  // Layout can change without a window resize (sidebar collapse via
  // breakpoint, Electron window state). Observe the body too.
  try {
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
  } catch {}
})();

function _repositionNotifStack() {
  if (!_notifStack) return;
  const banner = document.getElementById('update-banner');
  const visible = banner && !banner.classList.contains('hidden') && !banner.classList.contains('out');
  if (visible) {
    const r = banner.getBoundingClientRect();
    _notifStack.style.top = Math.round(r.bottom + 10) + 'px';
  } else {
    _notifStack.style.top = ''; // back to the CSS default (62px)
  }
}

function _getNotifStack() {
  if (_notifStack && _notifStack.isConnected) { _repositionNotifStack(); return _notifStack; }
  _notifStack = document.createElement('div');
  _notifStack.id = 'app-notif-stack';
  _notifStack.className = 'app-notif-stack';
  document.body.appendChild(_notifStack);
  // Hover anywhere on the stack pauses every visible toast's auto-dismiss.
  // This is the iOS/macOS gesture — gives users time to read longer notifs.
  _notifStack.addEventListener('mouseenter', () => {
    _notifPaused = true;
    for (const el of _notifStack.querySelectorAll('.app-notif')) {
      _pauseNotifTimer(el);
    }
  });
  _notifStack.addEventListener('mouseleave', () => {
    _notifPaused = false;
    for (const el of _notifStack.querySelectorAll('.app-notif')) {
      _resumeNotifTimer(el);
    }
  });
  _repositionNotifStack();
  return _notifStack;
}

// ── Styled confirm modal ───────────────────────────────────────────────────
// Native browser confirm() looks like a Windows 95 dialog when triggered
// inside an Electron renderer — it visibly says "freqphull" in the title
// bar and has chrome-looking buttons. We replace it with a styled modal
// that matches the rest of the app. Returns a Promise<boolean> so callers
// can `const ok = await confirmModal(...)` with the same ergonomics as
// the native confirm(), just async.
//
// Options:
//   title       - bold header line
//   message     - main body text (single line OR multiline w/ \n)
//   detail      - optional secondary line (smaller, muted) — useful for
//                 surfacing filenames, formats, or anything that helps
//                 the user identify which thing they're confirming
//   okLabel     - text on the confirm button (default "OK")
//   cancelLabel - text on the cancel button (default "Cancel")
//   danger      - if true, OK button gets a red accent (use for destructive
//                 actions like delete; not appropriate for "re-download")
function confirmModal({ title, message, detail, okLabel, cancelLabel, danger } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // Build inner HTML. Detail uses pre-wrap so multi-line content (like
    // a track title we want to show on its own line) renders properly.
    const okClass = danger ? 'btn sm danger' : 'btn sm pri';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:440px">
        ${title ? `<div class="modal-title">${escapeHtml(title)}</div>` : ''}
        ${message ? `<div class="modal-body">${escapeHtml(message).replace(/\n/g,'<br/>')}</div>` : ''}
        ${detail ? `<div class="modal-detail">${escapeHtml(detail).replace(/\n/g,'<br/>')}</div>` : ''}
        <div class="modal-actions">
          <button class="btn sm" id="cm-cancel">${escapeHtml(cancelLabel || 'Cancel')}</button>
          <button class="${okClass}" id="cm-ok">${escapeHtml(okLabel || 'OK')}</button>
        </div>
      </div>
    `;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    // Esc cancels, Enter confirms — standard dialog ergonomics
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    document.addEventListener('keydown', onKey);
    // Click outside the card cancels — matches the tag picker pattern
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.body.appendChild(overlay);
    overlay.querySelector('#cm-ok').addEventListener('click', () => close(true));
    overlay.querySelector('#cm-cancel').addEventListener('click', () => close(false));
    // Focus the OK button so Enter works immediately without tabbing.
    // Done in a microtask so the element is actually in the DOM.
    Promise.resolve().then(() => overlay.querySelector('#cm-ok')?.focus());
  });
}

function showAppNotification(msg, type, onClick, durationMs) {
  const stack = _getNotifStack();
  const t = _NOTIF_TYPE_MAP[type] || 'info';
  const duration = (typeof durationMs === 'number') ? durationMs : 5500;

  const el = document.createElement('div');
  el.className = 'app-notif ' + t;
  el.setAttribute('role', t === 'err' ? 'alert' : 'status');
  el.setAttribute('aria-live', t === 'err' ? 'assertive' : 'polite');

  // Build innerHTML in two steps so the message text is set via textContent
  // (no XSS risk from any caller-supplied content). Everything else is
  // trusted markup.
  el.innerHTML =
    '<div class="app-notif-icon">' + (_NOTIF_ICONS[t] || _NOTIF_ICONS.info) + '</div>' +
    '<div class="app-notif-body"><div class="app-notif-msg"></div></div>' +
    '<button class="app-notif-close" type="button" aria-label="Dismiss">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>' +
    '</button>' +
    (duration > 0
      ? '<div class="app-notif-timer"><div class="app-notif-timer-fill" style="animation-duration:' + duration + 'ms"></div></div>'
      : '');
  el.querySelector('.app-notif-msg').textContent = String(msg == null ? '' : msg);

  // Click handling: body click runs onClick + dismisses; X dismisses only.
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.app-notif-close')) {
      _dismissNotif(el);
      return;
    }
    _dismissNotif(el);
    if (typeof onClick === 'function') {
      try { onClick(); } catch {}
    }
  });

  stack.insertBefore(el, stack.firstChild); // newest on top
  // Spring-in on next frame so the initial CSS state (transform off-screen)
  // is applied first.
  requestAnimationFrame(() => {
    el.classList.add('show');
  });

  // Auto-dismiss with timer. duration=0 means sticky (no auto-dismiss).
  if (duration > 0) {
    _scheduleNotifTimer(el, duration);
    // If stack is already hover-paused, reflect that on the new toast too
    if (_notifPaused) _pauseNotifTimer(el);
  }

  // Cap stack at 5; older toasts get politely retired so memory + screen
  // real estate don't blow up if some loop spams notifications.
  const all = stack.querySelectorAll('.app-notif');
  if (all.length > 5) {
    for (let i = 5; i < all.length; i++) _dismissNotif(all[i]);
  }
}

function _scheduleNotifTimer(el, ms) {
  const startedAt = performance.now();
  const timeout = setTimeout(() => _dismissNotif(el), ms);
  _notifTimers.set(el, { timeout, startedAt, remainingMs: ms, totalMs: ms });
}

function _pauseNotifTimer(el) {
  const info = _notifTimers.get(el);
  if (!info) return;
  clearTimeout(info.timeout);
  info.remainingMs = Math.max(0, info.remainingMs - (performance.now() - info.startedAt));
  el.classList.add('paused');
}

function _resumeNotifTimer(el) {
  const info = _notifTimers.get(el);
  if (!info || info.remainingMs <= 0) return;
  el.classList.remove('paused');
  info.startedAt = performance.now();
  info.timeout = setTimeout(() => _dismissNotif(el), info.remainingMs);
}

function _dismissNotif(el) {
  if (!el || el.classList.contains('out')) return;
  const info = _notifTimers.get(el);
  if (info) { clearTimeout(info.timeout); _notifTimers.delete(el); }
  el.classList.add('out');
  // Remove from DOM after the CSS exit transition completes
  setTimeout(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }, 340);
}

function setupDrops() {
  makeDrop('drop-analyze', f => readForAnalysis(f));
  makeDrop('drop-trans', f => startTranscribeFile(f));
}
function makeDrop(id, handler) {
  const z = document.getElementById(id); if (!z) return;
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('over'); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
}

// ── Waveform drag-out: drag the waveform to export WAV ───────────────────────
// Renders a smooth frosted-glass ghost icon with mini waveform + filename
function setupWaveformDrag() {
  const wrap = document.getElementById('wave-wrap');
  if (!wrap) return;

  wrap.setAttribute('draggable', 'true');

  wrap.addEventListener('dragstart', async (e) => {
    if (!audioBuf) { e.preventDefault(); return; }

    // If WAV not ready yet, encode now
    if (!dragReady || !dragTempPath) {
      await prepareDragWav();
    }

    if (dragReady && dragTempPath) {
      e.preventDefault(); // prevent default HTML drag

      // Render the smooth drag ghost icon
      const ghostDataURL = renderDragGhost();
      api.startDrag(dragTempPath, ghostDataURL);
      wrap.classList.add('dragging');
      diagLog('Drag started with smooth ghost: ' + dragTempPath, 'info');
    } else {
      e.preventDefault();
      diagLog('Drag cancelled — WAV not ready', 'err');
    }
  });

  wrap.addEventListener('dragend', () => {
    wrap.classList.remove('dragging');
  });

  // Show drag hint on hover when audio is loaded
  wrap.addEventListener('mouseenter', () => {
    if (audioBuf && !playing) {
      let hint = document.getElementById('drag-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'drag-hint';
        hint.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7-7 7 7"/></svg> Drag to export WAV';
        wrap.appendChild(hint);
      }
      hint.classList.add('visible');
    }
  });

  wrap.addEventListener('mouseleave', () => {
    const hint = document.getElementById('drag-hint');
    if (hint) hint.classList.remove('visible');
  });
}

// ── Render smooth drag ghost as PNG data URL ──────────────────────────────────
// Creates a polished frosted-glass card with mini waveform + filename
// Returns a data:image/png;base64 string for Electron's nativeImage
function renderDragGhost() {
  const DPR = 2; // render at 2x for crispness
  const W = 240, H = 56;
  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // ── Background: rounded rect with frosted dark glass ──
  const radius = 12;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(W - radius, 0);
  ctx.quadraticCurveTo(W, 0, W, radius);
  ctx.lineTo(W, H - radius);
  ctx.quadraticCurveTo(W, H, W - radius, H);
  ctx.lineTo(radius, H);
  ctx.quadraticCurveTo(0, H, 0, H - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();

  // Dark gradient fill
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, 'rgba(18, 18, 18, 0.94)');
  grad.addColorStop(1, 'rgba(28, 28, 28, 0.90)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Clip for inner content
  ctx.save();
  ctx.clip();

  // ── Mini waveform ──
  if (audioBuf) {
    const wX = 14, wY = 10, wW = 110, wH = 36;
    const data = audioBuf.getChannelData(0);
    const step = Math.ceil(data.length / wW);

    // Waveform background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    roundRect(ctx, wX, wY, wW, wH, 5);
    ctx.fill();

    // Draw waveform bars
    for (let i = 0; i < wW; i++) {
      let mn = 1, mx = -1;
      for (let j = 0; j < step; j++) {
        const s = data[i * step + j] || 0;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      const amp = Math.abs(mx - mn);
      const alpha = 0.2 + amp * 0.65;
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(wX + i, wY + ((1 + mn) / 2) * wH);
      ctx.lineTo(wX + i, wY + ((1 + mx) / 2) * wH);
      ctx.stroke();
    }
  }

  // ── Text: filename + format badge ──
  const textX = 132;
  const name = (document.getElementById('player-name')?.textContent || 'audio').trim();

  // Truncate filename
  ctx.font = '600 11px Inter, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  let displayName = name;
  if (ctx.measureText(displayName).width > 94) {
    while (ctx.measureText(displayName + '…').width > 94 && displayName.length > 3) {
      displayName = displayName.slice(0, -1);
    }
    displayName += '…';
  }
  ctx.fillText(displayName, textX, 26);

  // WAV badge
  ctx.font = '600 9px Inter, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fillText('WAV EXPORT', textX, 40);

  // ── Subtle inner glow along top edge ──
  const glowGrad = ctx.createLinearGradient(0, 0, 0, 8);
  glowGrad.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
  glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, W, 8);

  ctx.restore();

  return canvas.toDataURL('image/png');
}

// Helper: draw a rounded rect path
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function loadAnalyzeFile(e) { if (e.target.files[0]) readForAnalysis(e.target.files[0]); }
function readForAnalysis(file) {
  currentHistId = null;
  // In Electron, dropped/selected files have a .path property with the real disk path
  // This is needed for Python analysis — without it we fall back to JS only
  if (file.path) {
    setLastFilePath(file.path, file.name);
    diagLog('File path captured: ' + file.path, 'info');
  } else {
    setLastFilePath(null, null);
    diagLog('No file.path available (browser mode) — will use JS analysis', 'info');
  }
  const rd = new FileReader();
  rd.onload = ev => loadAudioBuffer(ev.target.result, file.name, null);
  rd.readAsArrayBuffer(file);
}

async function loadAudioBuffer(arrayBuf, name, histId) {
  diagLog('loadAudioBuffer: ' + name + ' size=' + (arrayBuf?.byteLength || arrayBuf?.length || '?'), 'info');

  // STOP the global mini player if running — they share output and would
  // play in parallel otherwise (the duplicate-playback bug). If the mini
  // player is currently on the same track, this is a sync transition: the
  // user is opening it in the Analyzer to look at it more deeply.
  if (typeof globalPlayer !== 'undefined' && globalPlayer.audio && !globalPlayer.audio.paused) {
    try {
      // Capture currentTime + playback state so we can seek the analyzer to
      // the same spot AND auto-resume there. Without _handoffWasPlaying the
      // transition feels like the audio cut out mid-listen — we want it to
      // continue seamlessly.
      globalPlayer._handoffTime = globalPlayer.audio.currentTime || 0;
      globalPlayer._handoffWasPlaying = true;
      globalPlayer.audio.pause();
    } catch {}
  }

  // IPC sends Uint8Array (survives transfer). FileReader gives ArrayBuffer. Handle both.
  let safeBuffer;
  try {
    if (arrayBuf instanceof ArrayBuffer && arrayBuf.byteLength > 0) {
      // Fresh copy to avoid detached buffer issues
      safeBuffer = arrayBuf.slice(0);
    } else if (arrayBuf instanceof Uint8Array || ArrayBuffer.isView(arrayBuf)) {
      // From IPC: copy into fresh ArrayBuffer
      safeBuffer = arrayBuf.buffer.slice(arrayBuf.byteOffset, arrayBuf.byteOffset + arrayBuf.byteLength);
    } else if (arrayBuf && typeof arrayBuf === 'object' && arrayBuf.byteLength !== undefined) {
      safeBuffer = arrayBuf.slice ? arrayBuf.slice(0) : arrayBuf;
    } else {
      throw new Error('Unknown buffer type: ' + Object.prototype.toString.call(arrayBuf));
    }
    if (!safeBuffer || safeBuffer.byteLength === 0) throw new Error('Buffer is empty or detached');
    diagLog('Buffer OK, byteLength=' + safeBuffer.byteLength, 'ok');
  } catch(e) {
    diagLog('Buffer error: ' + e.message, 'err');
    dlSt('Buffer error: ' + e.message, 'err');
    return;
  }

  // Create/resume AudioContext — must happen after user gesture
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      diagLog('AudioContext created, state=' + audioCtx.state, 'info');
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
      diagLog('AudioContext resumed', 'info');
    }
  } catch(e) {
    diagLog('AudioContext error: ' + e.message, 'err');
    dlSt('AudioContext error: ' + e.message, 'err');
    return;
  }

  if (playing) stopAudio();
  // Reset gain node for fresh connection
  if (gainNode) { try { gainNode.disconnect(); } catch {} gainNode = null; }
  pauseOff = 0; pitchVal = 0;
  document.getElementById('pitch-sl').value = 0;
  document.getElementById('pitch-lbl').textContent = '0';
  document.getElementById('metrics-wrap').classList.remove('hidden');
  document.getElementById('player-card').classList.remove('hidden');
  document.getElementById('player-name').textContent = name;
  // Track id changed → old row should stop showing as playing; new row will
  // get marked when startAudio fires below. We refresh BOTH on assignment
  // and (via startAudio's own refresh) on play, so the transition is clean.
  const _prevHistId = currentHistId;
  currentHistId = histId;
  if (_prevHistId !== histId && typeof _refreshHistoryRowPlayState === 'function') {
    _refreshHistoryRowPlayState();
  }
  document.getElementById('hist-lbl').textContent = histId ? 'Linked to history' : '';
  ['bpm','key','dur'].forEach(id => { const el = document.getElementById(id); el.textContent = '…'; el.className = 'm-val dim'; });
  document.getElementById('key-mode').textContent = '—';
  document.getElementById('chord-list').innerHTML = '<div style="font-size:12px;color:var(--hint)">Analyzing…</div>';
  document.getElementById('cam-grid').innerHTML = '<div style="font-size:12px;color:var(--hint)">—</div>';
  // Zero all live meters on file load — nothing is playing yet
  ['live-sub','live-bass','live-low-mid','live-mid','live-high-mid','live-high'].forEach(function(id){
    var el=document.getElementById(id); if(el){el.style.width='0%';el.style.background='#4caf50';}
  });
  ['meter-l','meter-r'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.width='0%';});
  ['peak-l','peak-r'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.left='0%';});
  ['stat-lufs','stat-short','stat-mom','stat-peak','stat-rms'].forEach(function(id){var el=document.getElementById(id);if(el)el.textContent='-∞';});
  var drEl=document.getElementById('stat-dr');if(drEl)drEl.textContent='—';
  document.getElementById('pitch-key').textContent = '—';
  document.getElementById('notes-box').value = '';
  if (histId) { const row = histData.find(h => h.id == histId); if (row?.notes) document.getElementById('notes-box').value = row.notes; }

  diagLog('Calling decodeAudioData...', 'info');
  try {
    dlSt('Converting audio…', 'spin');

    // Find file path
    let filePath = lastFilePath;
    if (!filePath && currentHistId) {
      const row = histData.find(h => h.id == currentHistId);
      if (row?.file_path) filePath = row.file_path;
    }

    let wavBuf;
    if (filePath) {
      diagLog('Converting via server path: ' + filePath, 'info');
      const r = await fetch(API + '/convert-wav?path=' + encodeURIComponent(filePath));
      if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Conversion failed'); }
      wavBuf = await r.arrayBuffer();
    } else {
      diagLog('No file path, uploading buffer for conversion', 'info');
      const fd = new FormData();
      fd.append('audio', new Blob([safeBuffer]), name);
      const r = await fetch(API + '/convert-wav-upload', { method: 'POST', body: fd });
      if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Upload conversion failed'); }
      wavBuf = await r.arrayBuffer();
    }

    diagLog('Got WAV, byteLength=' + wavBuf.byteLength + ', parsing PCM...', 'info');

    // Parse WAV manually — avoids decodeAudioData which hangs in packaged Electron
    audioBuf = parseWAV(wavBuf, audioCtx);
    diagLog('PCM parse success! duration=' + audioBuf.duration.toFixed(2) + 's channels=' + audioBuf.numberOfChannels, 'ok');
    // Decode succeeded — hide the status pill entirely. Calling dlSt('', '')
    // would leave a visible-but-empty bar (grey dot, no text) because dlSt
    // only auto-hides on 'ok' or 'err' types. Just hide directly.
    const dlStatus = document.getElementById('dl-status');
    if (dlStatus) dlStatus.classList.add('hidden');
    if (window._dlIdleHide) { clearTimeout(window._dlIdleHide); window._dlIdleHide = null; }
  } catch(e) {
    diagLog('Decode failed: ' + e.message, 'err');
    dlSt('Could not decode audio: ' + e.message, 'err');
    // Show the actionable error as a notification too, so users see it even
    // when the diag panel is collapsed. Truncate the technical bits.
    const msg = e.message || 'Unknown error';
    if (typeof showAppNotification === 'function') {
      const short = msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
      showAppNotification('✕ ' + short, 'err', null, 8000);
    }
    // CRITICAL: release the transition lock + handoff flags so the user can
    // retry without the app being permanently "locked into loading." Without
    // this, a single ffmpeg failure leaves the player frozen forever.
    if (typeof globalPlayer !== 'undefined') {
      globalPlayer._transitionLock = false;
      globalPlayer._handoffTime = null;
      globalPlayer._handoffWasPlaying = false;
    }
    return;
  }

  // Draw waveform + player immediately
  drawWaveform(audioBuf);
  prepareDragWav(); // Pre-encode WAV for drag-out export
  // If the mini player was playing this same track, seek the analyzer to
  // where the mini player was — continuity instead of jumping back to 0.
  // The handoff field is set in the entry of this function (above) when
  // we paused the global player.
  // The handoff bridge tells us TWO things:
  //   1. Whether to seek to a specific time (_handoffTime — may be 0 for
  //      fresh "play from start" requests from history rows)
  //   2. Whether to auto-resume playback (_handoffWasPlaying — independent
  //      of the time; you can absolutely want to autoplay starting at 0)
  // Critically: these two flags are INDEPENDENT. Reading _handoffWasPlaying
  // only when _handoffTime > 0 was the bug that made history-row play fail
  // to autoplay — history sends time=0 and wasPlaying=true, but the old
  // code only saw the time=0 and skipped both.
  let _handoffWasPlaying = false;
  if (typeof globalPlayer !== 'undefined') {
    _handoffWasPlaying = globalPlayer._handoffWasPlaying === true;
    // Apply the seek time only when it's >0 and inside the buffer.
    // Zero means "start from the beginning" — pauseOff is already 0 from
    // its default, so no action needed.
    if (globalPlayer._handoffTime != null &&
        isFinite(globalPlayer._handoffTime) &&
        globalPlayer._handoffTime > 0 &&
        globalPlayer._handoffTime < audioBuf.duration - 0.5) {
      pauseOff = globalPlayer._handoffTime;
    }
  }
  // Consume the handoff (one-shot)
  if (typeof globalPlayer !== 'undefined') {
    globalPlayer._handoffTime = null;
    globalPlayer._handoffWasPlaying = false;
  }
  document.getElementById('ttime').textContent = fmt2time(pauseOff || 0) + ' / ' + fmt2time(audioBuf.duration);

  // If the mini player was playing when the user opened in Analyzer, keep
  // it playing — start Analyzer from the same timestamp. Without this, the
  // handoff lands paused and feels like the audio "cut out" mid-listen.
  // We defer one frame so the waveform/UI render first, then resume.
  if (_handoffWasPlaying) {
    requestAnimationFrame(() => {
      if (typeof startAudio === 'function' && !playing) {
        try { startAudio(); } catch {}
      }
      // Release the transition lock once Analyzer is actually playing.
      if (typeof globalPlayer !== 'undefined') globalPlayer._transitionLock = false;
    });
  } else {
    // No handoff — Analyzer loaded paused. Release lock now.
    if (typeof globalPlayer !== 'undefined') globalPlayer._transitionLock = false;
  }
  setM('dur', Math.round(audioBuf.duration), '100%');

  // Show analyzing state while Python runs
  ['bpm','key'].forEach(id => { const el = document.getElementById(id); el.textContent = '…'; el.className = 'm-val dim'; });
  document.getElementById('key-mode').textContent = 'analyzing…';
  document.getElementById('chord-list').innerHTML = '<div style="font-size:13px;color:var(--hint)">Analyzing…</div>';
  document.getElementById('cam-grid').innerHTML = '<div style="font-size:13px;color:var(--hint)">…</div>';

  // Show loading placeholder in pro-metrics panel
  let proPanel = document.getElementById('pro-metrics');
  if (!proPanel) {
    proPanel = document.createElement('div');
    proPanel.id = 'pro-metrics';
    proPanel.className = 'card mt2';
    const wrap = document.getElementById('pro-metrics-wrap');
    if (wrap) wrap.appendChild(proPanel);
    else document.getElementById('metrics-wrap').appendChild(proPanel);
  }
  proPanel.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0">
      <div class="dot spin"></div>
      <span style="font-size:14px;color:var(--muted)">Running professional analysis… (5–10 seconds)</span>
    </div>`;

  // Get file path — needed for Python analysis
  let analysisPath = lastFilePath;
  if (!analysisPath && histId) {
    const row = histData.find(h => h.id == histId);
    if (row?.file_path) analysisPath = row.file_path;
  }

  if (analysisPath) {
    diagLog('Starting Python analysis engine…', 'info');
    runPythonAnalysis(analysisPath, histId);
  } else {
    // No file path available — use JS fallback
    diagLog('No path for Python analysis, using JS fallback', 'info');
    const [bpmR, keyR] = await Promise.all([detectBPM(audioBuf), Promise.resolve(detectKey(audioBuf))]);
    applyAnalysisResult({ bpm: Math.round(bpmR.bpm), key: keyR.key, mode: keyR.mode, confidence: keyR.confidence }, histId);
  }
}

let _lastAnalyzedPath = null;
let _lastAnalyzedHistId = null;

function setM(id, val, conf) { const el = document.getElementById(id); el.textContent = val; el.className = 'm-val'; document.getElementById(id+'-conf').style.width = conf||'80%'; }
function setKeyM(note, mode, conf) { document.getElementById('key').textContent = note; document.getElementById('key').className = 'm-val'; document.getElementById('key-mode').textContent = mode; document.getElementById('key-conf').style.width = conf||'80%'; }

// Seek the Analyzer playback to a section start. Two transports exist:
// the Analyzer's own loaded element(s) and the mirroring global player —
// nudge whichever is live.
function seekAnalyzerTo(t_s) {
  let done = false;
  try {
    if (typeof loaded !== 'undefined' && Array.isArray(loaded) && loaded.length) {
      loaded.forEach(e => { try { e.audio.currentTime = t_s; done = true; } catch {} });
    }
  } catch {}
  if (!done && typeof globalPlayer !== 'undefined' && globalPlayer && globalPlayer.audio) {
    try { globalPlayer.audio.currentTime = t_s; done = true; } catch {}
  }
  if (!done) showAppNotification(t('bsLoadFirst'), 'info', null, 2500);
}

// Forced beat-switch pass (?deep=1 → lower novelty threshold). Used when
// the normal pass found nothing but the user insists there's a switch.
function reanalyzeDeepSections() {
  if (!_lastAnalyzedPath) return;
  showAppNotification('⚡ ' + t('bsForcing'), 'info', null, 3000);
  runPythonAnalysis(_lastAnalyzedPath, _lastAnalyzedHistId, true);
}

// ── Python analysis engine ────────────────────────────────────────────────────
function runPythonAnalysis(filePath, histId, deep) {
  const params = new URLSearchParams({ path: filePath });
  if (deep) params.set('deep', '1'); // beat-switch deep mode
  _lastAnalyzedPath = filePath;      // for the manual re-detect button
  _lastAnalyzedHistId = histId || null;
  const es = new EventSource(API + '/analyze?' + params);

  es.addEventListener('status', e => {
    const msg = JSON.parse(e.data).message;
    diagLog(msg, 'info');
    const panel = document.getElementById('pro-metrics');
    if (panel) panel.innerHTML = `<div style="display:flex;align-items:center;gap:12px;padding:8px 0"><div class="dot spin"></div><span style="font-size:14px;color:var(--muted)">${msg}</span></div>`;
  });

  es.addEventListener('done', e => {
    es.close();
    const result = JSON.parse(e.data);
    diagLog('Python analysis done: ' + result.bpm + ' BPM, ' + result.key + ' ' + result.mode + ' (engine: ' + result.engine + ')', 'ok');
    applyAnalysisResult(result, histId);
  });

  es.addEventListener('error', e => {
    es.close();
    let errMsg = 'Python analysis failed';
    try {
      const err = JSON.parse(e.data);
      errMsg = err.message || errMsg;
      diagLog('Python error: ' + errMsg, 'err');
      if (err.hint) diagLog('Hint: ' + err.hint, 'info');
    } catch {
      diagLog('Python analysis error (no detail)', 'err');
    }
    // Show the actual error in the pro panel so user can see it
    const panel = document.getElementById('pro-metrics');
    if (panel) panel.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;padding:4px 0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e84040" stroke-width="2" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="#e84040"/></svg>
        <div>
          <div style="font-size:13px;color:#e84040;font-weight:600;margin-bottom:4px">Analysis failed — check Diagnostic Log</div>
          <div style="font-size:12px;color:var(--muted);word-break:break-all">${errMsg.slice(0,200)}</div>
          <div style="font-size:12px;color:var(--hint);margin-top:6px">Run <b style="color:var(--off)">AI Transcribe Setup.exe</b> if scipy/numpy not installed</div>
        </div>
      </div>`;
    // Still do JS fallback for BPM/key
    diagLog('Falling back to JS analysis for BPM/key', 'info');
    Promise.all([detectBPM(audioBuf), Promise.resolve(detectKey(audioBuf))]).then(([bpmR, keyR]) => {
      applyAnalysisResult({ bpm: Math.round(bpmR.bpm), key: keyR.key, mode: keyR.mode, confidence: keyR.confidence }, histId);
    });
  });

  // Handle connection-level error (server not running etc)
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    diagLog('EventSource connection failed — server may be starting up', 'err');
  };
}

function applyAnalysisResult(result, histId) {
  currentBpm  = result.bpm;
  currentKey  = result.key;
  currentMode = result.mode;

  const conf = result.key_confidence ? Math.round(result.key_confidence * 100) + '%' : '80%';
  setM('bpm', currentBpm, conf);
  setKeyM(currentKey, currentMode, conf);
  renderChords(currentKey, currentMode);
  renderCamelot(currentKey, currentMode);
  updatePitchKey(0);

  metroBpm = Math.round(currentBpm);
  document.getElementById('metro-num').textContent = metroBpm;
  document.getElementById('metro-sl').value = metroBpm;

  // Show engine badge + Camelot + content type
  const histLbl = document.getElementById('hist-lbl');
  if (histLbl) {
    const contentBadge = result.is_melodic === true ? ' · 🎤 Melodic' : result.is_melodic === false ? ' · 🔊 Bass-heavy' : '';
    histLbl.textContent = result.engine && result.engine.startsWith('freq.phull')
      ? `✓ Professional analysis  ·  Camelot ${result.camelot || '—'}${contentBadge}`
      : `Camelot ${result.camelot || '—'}`;
  }

  // Show top 3 key candidates if confidence is low — critical for autotune
  const candidates = result.key_candidates || [];
  const keyConf = result.key_confidence || 0;
  const candEl = document.getElementById('key-candidates');
  if (candEl) {
    if (candidates.length > 1 && keyConf < 0.5) {
      candEl.innerHTML = `<div style="font-size:11px;color:var(--hint);margin-top:6px;margin-bottom:3px">LOW CONFIDENCE — verify before using autotune:</div>` +
        candidates.map((c,i) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;background:${i===0?'var(--white)':'var(--bg4)'};color:${i===0?'#080808':'var(--muted)'};border:1px solid ${i===0?'transparent':'var(--border2)'}">
          ${c.key} ${c.mode} <span style="font-size:10px;opacity:0.7">${c.camelot}</span></span>`).join('');
      candEl.style.display = 'block';
    } else {
      candEl.style.display = 'none';
    }
  }

  // Beat markers on waveform
  if (result.beat_times && audioBuf) drawBeatMarkers(result.beat_times);

  // ── Professional metrics panel — injected above Track Notes ──────────────
  let panel = document.getElementById('pro-metrics');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pro-metrics';
    panel.className = 'card mt2';
    const wrap = document.getElementById('pro-metrics-wrap');
    if (wrap) wrap.appendChild(panel);
    else document.getElementById('metrics-wrap').appendChild(panel);
  }

  // If Python analysis didn't run, show install prompt
  if (!result.engine || !result.engine.startsWith('freq.phull')) {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;padding:4px 0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="#f59e0b"/>
        </svg>
        <div>
          <div style="font-size:14px;color:var(--off);font-weight:500">Professional analysis unavailable</div>
          <div style="font-size:13px;color:var(--muted);margin-top:3px">
            Run <strong style="color:var(--off)">AI Transcribe Setup.exe</strong> to install scipy &amp; numpy,
            then reload the track for full Loudness / Spectral Balance data.
          </div>
        </div>
      </div>`;
    // Still save to history
    if (histId) {
      const notagsParam = (localStorage.getItem('freqphull.writeTags') === '0') ? '?notags=1' : '';
      fetch(API + '/history/' + histId + '/analysis' + notagsParam, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ bpm: currentBpm, key_note: currentKey, key_mode: currentMode })
      }).catch(()=>{});
      loadHistory();
    }
    return;
  }

  const sb = result.spectral_balance || {};

  // ── Beat switch card ─────────────────────────────────────────────
  // Multi-section tracks get a timeline + per-section BPM/key/energy.
  // One global BPM on a beat-switch track is a lie; this shows the truth.
  let bsHTML = '';
  const bs = result.beat_switch;
  if (bs && bs.detected && bs.sections && bs.sections.length > 1) {
    const dur = result.duration || bs.sections[bs.sections.length - 1].end_s || 1;
    const COLORS = ['#6ab0ff', '#ffb84d', '#7ed982', '#d98bff', '#ff8585'];
    const tl = bs.sections.map((sc, i) => {
      const w = Math.max(2, ((sc.end_s - sc.start_s) / dur) * 100);
      return `<div class="bs-tl-seg" style="width:${w}%;background:${COLORS[i % COLORS.length]}22;border-top:2px solid ${COLORS[i % COLORS.length]}" onclick="seekAnalyzerTo(${sc.start_s})" title="${fmt2time(sc.start_s)} – ${fmt2time(sc.end_s)}"></div>`;
    }).join('');
    const rows = bs.sections.map((sc, i) => `
      <div class="bs-row" onclick="seekAnalyzerTo(${sc.start_s})">
        <span class="bs-dot" style="background:${COLORS[i % COLORS.length]}"></span>
        <span class="bs-name">${t('bsSection')} ${i + 1}</span>
        <span class="bs-time">${fmt2time(sc.start_s)} – ${fmt2time(sc.end_s)}</span>
        <span class="bs-chip">${sc.bpm ? Math.round(sc.bpm) + ' BPM' : '—'}</span>
        <span class="bs-chip">${sc.key ? sc.key + ' ' + (sc.mode || '') + ' · ' + sc.camelot : '—'}</span>
        <span class="bs-db">${sc.rms_db} dB</span>
      </div>`).join('');
    const marks = (bs.switches || []).map(sw => {
      const ch = (sw.changes || []).map(c => t('bsChange_' + c)).join(' + ');
      return `<div class="bs-switch-note">⚡ ${t('bsSwitchAt')} <b onclick="seekAnalyzerTo(${sw.time_s})" style="cursor:pointer;text-decoration:underline">${fmt2time(sw.time_s)}</b>${ch ? ' — ' + ch : ''} <span style="opacity:.6">(${Math.round(sw.confidence * 100)}%)</span></div>`;
    }).join('');
    bsHTML = `
      <div class="bs-card">
        <div class="bs-head">⚡ ${t('bsTitle')}</div>
        ${marks}
        <div class="bs-timeline">${tl}</div>
        ${rows}
      </div>`;
  } else if (bs && !bs.detected && _lastAnalyzedPath) {
    // Nothing found at the normal threshold — offer the forced pass.
    bsHTML = `
      <div class="bs-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span style="font-size:12px;color:var(--hint)">${t('bsNone')}</span>
        <button class="btn xs" onclick="reanalyzeDeepSections()">⚡ ${t('bsForceBtn')}</button>
      </div>`;
  }

  const sec = (result.sections || []).map(s =>
    `<div class="section-row">
      <span class="sec-lbl">${s.label}</span>
      <span class="sec-time">${fmt2time(s.start_s)} – ${fmt2time(s.end_s)}</span>
      <div class="sec-bar-wrap"><div class="sec-bar" style="width:${Math.max(0,Math.min(100,(s.rms_db+60)/60*100))}%"></div></div>
      <span class="sec-db">${s.rms_db} dB</span>
    </div>`
  ).join('');

  const bandBar = (val) => {
    // dBFS range: -80 (silent) to -10 (loud) = 0% to 100%
    const pct = Math.max(0, Math.min(100, (val + 80) / 70 * 100));
    const col = pct > 85 ? '#e84040' : pct > 65 ? '#f59e0b' : '#4caf50';
    return `<div class="sb-track"><div class="sb-fill" style="width:${pct}%;background:${col}"></div></div>`;
  };

  panel.innerHTML = `
    ${bsHTML}
    <div class="pro-grid">

      <div class="pro-section">
        <div class="pro-title">Loudness</div>
        <div class="pro-stats">
          <div class="pro-stat">
            <div class="pro-stat-lbl">Integrated</div>
            <div class="pro-stat-val">${result.lufs_integrated ?? '—'}</div>
            <div class="pro-stat-unit">LUFS</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">Short-term</div>
            <div class="pro-stat-val">${result.lufs_short_term ?? '—'}</div>
            <div class="pro-stat-unit">LUFS</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">Momentary</div>
            <div class="pro-stat-val">${result.lufs_momentary ?? '—'}</div>
            <div class="pro-stat-unit">LUFS</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">LRA</div>
            <div class="pro-stat-val">${result.loudness_range ?? '—'}</div>
            <div class="pro-stat-unit">LU</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">True Peak</div>
            <div class="pro-stat-val ${(result.true_peak_dbtp ?? -144) > -1 ? 'pro-red' : ''}">${result.true_peak_dbtp ?? '—'}</div>
            <div class="pro-stat-unit">dBTP</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">Peak</div>
            <div class="pro-stat-val">${result.peak_dbfs ?? '—'}</div>
            <div class="pro-stat-unit">dBFS</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">Crest</div>
            <div class="pro-stat-val">${result.crest_factor_db ?? '—'}</div>
            <div class="pro-stat-unit">dB</div>
          </div>
          <div class="pro-stat">
            <div class="pro-stat-lbl">Dyn Range</div>
            <div class="pro-stat-val">${result.dynamic_range ?? '—'}</div>
            <div class="pro-stat-unit">DR</div>
          </div>
        </div>
        <div class="pro-hint">
          Target: −14 LUFS (streaming) · −9 LUFS (loud master) · True Peak below −1 dBTP
        </div>
      </div>

      <!-- The live spectrum analyzer used to live here but has been promoted
           to the always-visible meter panel (sits where Spectral Balance bars
           used to be). Showing it here too would mean two canvases competing
           for the same #pro-spectrum-canvas id. The meter-panel placement is
           also strictly better: spectrum stays visible across all tabs while
           audio plays, not just the Analyze tab. -->
      ${0 ? `<div class="pro-section">
        ${JSON.stringify(sb)}
      </div>` : ''}

      ${sec ? `<div class="pro-section" style="grid-column:1/-1">
        <div class="pro-title">Section Energy</div>
        ${sec}
      </div>` : ''}

    </div>`;

  // Paint the spectrum analyzer canvas now that the DOM is in place
  paintSpectrumAnalyzer(sb);

  // Save to history
  if (histId) {
    const notagsParam = (localStorage.getItem('freqphull.writeTags') === '0') ? '?notags=1' : '';
    fetch(API + '/history/' + histId + '/analysis' + notagsParam, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ bpm: currentBpm, key_note: currentKey, key_mode: currentMode })
    }).catch(() => {});
    loadHistory();
  }
}

// FabFilter Pro-Q style spectrum analyzer. Takes 6 band measurements in
// dBFS (approx -80 to 0 range) and renders a smooth filled curve on a
// log-frequency axis. Used as a static snapshot when no audio is playing;
// the live version below (paintLiveSpectrum) takes over while playing.
function paintSpectrumAnalyzer(sb) {
  if (!sb) return;
  // If audio is currently playing, the live version is already running on
  // the canvas — don't overwrite it.
  if (typeof playing !== 'undefined' && playing && _liveSpectrumRaf) return;
  const canvas = document.getElementById('pro-spectrum-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 280;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  // Also resize the hover overlay to match
  const hoverEl = document.getElementById('pro-spectrum-hover');
  if (hoverEl) {
    hoverEl.width = Math.floor(W * dpr);
    hoverEl.height = Math.floor(H * dpr);
    hoverEl.style.width = W + 'px';
    hoverEl.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  drawSpectrumBackground(ctx, W, H);

  // Wire hover even when no audio is playing — readout still works
  // (just shows freq/dB/note at cursor without an audio reading).
  _wireSpectrumHover();

  // Build the smooth curve through the 6 band points
  const bandFreqs = { sub:35, bass:155, low_mid:375, mid:1250, high_mid:4000, high:13000 };
  const FMIN = 20, FMAX = 22000;
  const xFor = (f) => {
    const logMin = Math.log10(FMIN);
    const logMax = Math.log10(FMAX);
    const logF = Math.log10(Math.max(FMIN, Math.min(FMAX, f)));
    return ((logF - logMin) / (logMax - logMin)) * W;
  };
  const dbToY = (db) => {
    const clamped = Math.max(-72, Math.min(12, db));
    return H - ((clamped + 72) / 84) * H;
  };
  const points = [
    { f: FMIN,  db: (sb.sub ?? -60) - 10 },
    ...['sub','bass','low_mid','mid','high_mid','high'].map(k => ({
      f: bandFreqs[k],
      db: sb[k] ?? -60,
    })),
    { f: FMAX,  db: (sb.high ?? -60) - 12 },
  ];
  const screenPts = points.map(p => ({ x: xFor(p.f), y: dbToY(p.db) }));
  drawSpectrumCurve(ctx, screenPts, W, H);
}

// Shared background grid for both static + live spectrum.
// dB range: -72..+12 (matches the live paint function). Frequency axis is
// log scale with octave shading + standard freq labels + musical reference
// notes (A2/A3/A4/A5/A6) for producers locating fundamentals.
function drawSpectrumBackground(ctx, W, H) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0a0a');
  bg.addColorStop(1, '#141414');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const FMIN = 20, FMAX = 22000;
  const logMin = Math.log10(FMIN);
  const logMax = Math.log10(FMAX);
  const xFor = (f) => {
    const logF = Math.log10(Math.max(FMIN, Math.min(FMAX, f)));
    return ((logF - logMin) / (logMax - logMin)) * W;
  };

  // Subtle octave-band shading — alternating very-dark bars between octaves.
  // Helps the eye parse where each octave starts.
  ctx.fillStyle = 'rgba(255,255,255,0.012)';
  for (let oct = 0; oct < 11; oct++) {
    if (oct % 2 === 0) continue;
    const f1 = Math.max(FMIN, 27.5 * Math.pow(2, oct));      // A0 ladder
    const f2 = 27.5 * Math.pow(2, oct + 1);
    if (f1 > FMAX) break;
    const x1 = xFor(f1);
    const x2 = xFor(Math.min(FMAX, f2));
    ctx.fillRect(x1, 0, x2 - x1, H);
  }

  // Vertical frequency gridlines + labels
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.font = '10px Inter,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = xFor(f);
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, H - 16);
    ctx.stroke();
    ctx.fillText(f >= 1000 ? (f/1000) + 'k' : String(f), x + 3, H - 4);
  }

  // Reference note markers — A2 (110), A3 (220), A4 (440), A5 (880), A6 (1760)
  // Dimmer than freq labels but useful for producers. Drawn at top.
  ctx.font = '9px Inter,sans-serif';
  ctx.fillStyle = 'rgba(180, 200, 255, 0.35)';
  for (const [hz, lbl] of [[110,'A2'],[220,'A3'],[440,'A4'],[880,'A5'],[1760,'A6'],[3520,'A7']]) {
    const x = xFor(hz);
    ctx.fillText(lbl, x + 3, 11);
  }

  // Horizontal dB gridlines + labels. Range matches paintLiveSpectrumFrame:
  // -72..+12 dB, with 0 dB as the bold reference line.
  const dbToY = (db) => {
    const clamped = Math.max(-72, Math.min(12, db));
    return H - ((clamped + 72) / 84) * H;
  };
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  for (const db of [12, 6, 0, -6, -12, -24, -36, -48, -60]) {
    const y = dbToY(db);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W - 30, y);
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
    ctx.stroke();
    ctx.fillText((db > 0 ? '+' : '') + db, W - 26, y + 3);
  }
}

// Shared curve drawing (filled spline + outlined orange line + 0dB ref).
function drawSpectrumCurve(ctx, screenPts, W, H) {
  if (!screenPts.length) return;
  const fillGrad = ctx.createLinearGradient(0, 0, 0, H);
  fillGrad.addColorStop(0, 'rgba(245, 158, 11, 0.32)');
  fillGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.15)');
  fillGrad.addColorStop(1, 'rgba(245, 158, 11, 0.04)');

  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(screenPts[0].x, screenPts[0].y);
  for (let i = 0; i < screenPts.length - 1; i++) {
    const p1 = screenPts[i], p2 = screenPts[i + 1];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
  }
  const last = screenPts[screenPts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 0; i < screenPts.length - 1; i++) {
    const p1 = screenPts[i], p2 = screenPts[i + 1];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
  }
  ctx.lineTo(last.x, last.y);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(245,158,11,0.5)';
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const dbToY = (db) => {
    const clamped = Math.max(-72, Math.min(12, db));
    return H - ((clamped + 72) / 84) * H;
  };
  const zeroY = dbToY(0);
  ctx.beginPath();
  ctx.moveTo(0, zeroY); ctx.lineTo(W - 30, zeroY);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── Live spectrum analyzer ──────────────────────────────────────────────────
// Reads frequency data from analyserL (already in the Analyzer's audio
// graph as a metering tap — see startAudio). Bins the FFT output by log
// frequency, smooths over time, paints to the same canvas as the static
// spectrum. Runs while audio plays, stops on pause. Peak-hold trails
// linger after the active level drops, like a real analyzer.
let _liveSpectrumRaf = null;
let _liveSpectrumBins = null;      // smoothed amplitudes per bin (fast attack/slow release)
let _liveSpectrumAvg = null;       // slowly-averaged amplitudes (~2s window) — dim "average" curve
let _liveSpectrumPeaks = null;     // peak-hold (decays slowly)
let _liveSpectrumPeakAge = null;   // frames since peak was set (for hold-then-decay)
let _liveSpectrumFftMap = null;    // pre-computed FFT-bin → visual-bin mapping
let _liveSpectrumFftData = null;   // reusable buffer for getFloatFrequencyData
let _liveSpectrumTmpMax = null;    // reusable per-frame max accumulator (was alloc'd every frame)
let _liveSpectrumPaintCount = 0;   // throttles paint to 30fps while keeping state @ 60fps
let _liveSpectrumNumBins = 192;    // visual resolution — 192 for Pro-Q3-feel detail

function startLiveSpectrum() {
  // If no analyser is connected yet, bail — analysers are created in
  // startVU which fires alongside startAudio, but in some race conditions
  // (rapid play/pause/play) they may not exist for one frame.
  if (!analyserL) return;
  if (_liveSpectrumRaf) cancelAnimationFrame(_liveSpectrumRaf);

  // Flag the live indicator dot
  const dot = document.getElementById('pro-spectrum-live-dot');
  if (dot) dot.classList.add('live');

  const canvas = document.getElementById('pro-spectrum-canvas');
  if (!canvas) return;

  // Bump FFT size for finer low-end resolution. Default 2048 at 48kHz =
  // ~23Hz bin width — too coarse for sub-bass. 8192 gives ~6Hz bins which
  // resolves kicks/subs cleanly. Cheap on modern hardware.
  if (analyserL.fftSize < 8192) {
    try { analyserL.fftSize = 8192; } catch {}
    if (analyserR && analyserR !== analyserL && analyserR.fftSize < 8192) {
      try { analyserR.fftSize = 8192; } catch {}
    }
  }

  const NUM_BINS = _liveSpectrumNumBins;
  if (!_liveSpectrumBins || _liveSpectrumBins.length !== NUM_BINS) {
    _liveSpectrumBins = new Float32Array(NUM_BINS).fill(-90);
    _liveSpectrumAvg = new Float32Array(NUM_BINS).fill(-90);
    _liveSpectrumPeaks = new Float32Array(NUM_BINS).fill(-90);
    _liveSpectrumPeakAge = new Uint16Array(NUM_BINS);
    _liveSpectrumTmpMax = new Float32Array(NUM_BINS);
  }

  // Pre-compute the FFT-bin → visual-bin mapping. The FFT gives us linear-
  // frequency bins; we map each linear bin to a log-frequency visual bin.
  const sr = audioCtx.sampleRate;
  const N = analyserL.frequencyBinCount;  // = fftSize / 2
  const FMIN = 20, FMAX = Math.min(22000, sr / 2);
  const logMin = Math.log10(FMIN);
  const logMax = Math.log10(FMAX);
  const fftToVisual = new Int16Array(N);  // index into visual bins, or -1
  for (let i = 0; i < N; i++) {
    const freq = (i / N) * (sr / 2);
    if (freq < FMIN) { fftToVisual[i] = -1; continue; }
    if (freq > FMAX) { fftToVisual[i] = -1; continue; }
    const logF = Math.log10(freq);
    const vb = Math.floor(((logF - logMin) / (logMax - logMin)) * NUM_BINS);
    fftToVisual[i] = Math.max(0, Math.min(NUM_BINS - 1, vb));
  }
  _liveSpectrumFftMap = fftToVisual;
  _liveSpectrumFftData = new Float32Array(N);

  // Wire up the hover crosshair (one-time per session — guarded by data attr)
  _wireSpectrumHover();

  const tick = () => {
    if (!playing || !analyserL) {
      _liveSpectrumRaf = null;
      return;
    }
    analyserL.getFloatFrequencyData(_liveSpectrumFftData);

    // Reuse the preallocated tmpMax buffer instead of `new Float32Array().fill()`
    // every frame. At 60fps × 192 bins, that's 11k Float32Array allocations
    // per minute purely for a scratchpad — pure GC pressure.
    const tmpMax = _liveSpectrumTmpMax;
    for (let b = 0; b < NUM_BINS; b++) tmpMax[b] = -Infinity;
    for (let i = 0; i < N; i++) {
      const vb = _liveSpectrumFftMap[i];
      if (vb < 0) continue;
      const v = _liveSpectrumFftData[i];
      if (v > tmpMax[vb]) tmpMax[vb] = v;
    }
    // Interpolate empty bins from neighbors (rare at NUM_BINS=192 but happens
    // at very low frequencies where FFT resolution is sparse)
    for (let b = 0; b < NUM_BINS; b++) {
      if (!isFinite(tmpMax[b])) {
        const prev = b > 0 ? tmpMax[b - 1] : -80;
        tmpMax[b] = isFinite(prev) ? prev : -80;
      }
    }

    // Temporal smoothing — three layers (state updates 60fps so motion is
    // smooth even at throttled paint):
    //   1. Instant curve: fast attack (peaks rise immediately), slow release
    //      (smooth decay). This is what the eye tracks for transients.
    //   2. Average curve: slow exponential moving avg (~2s window). Shows
    //      the "tonal balance" of the track — flat = balanced mix.
    //   3. Peak hold: tracks highest point per bin, decays after ~25 frames.
    for (let b = 0; b < NUM_BINS; b++) {
      const v = tmpMax[b];
      // Instant curve
      if (v > _liveSpectrumBins[b]) _liveSpectrumBins[b] = v;
      else _liveSpectrumBins[b] = _liveSpectrumBins[b] * 0.82 + v * 0.18;
      // Long average — useful for spotting tonal imbalances over time
      _liveSpectrumAvg[b] = _liveSpectrumAvg[b] * 0.985 + v * 0.015;
      // Peak hold
      if (_liveSpectrumBins[b] > _liveSpectrumPeaks[b]) {
        _liveSpectrumPeaks[b] = _liveSpectrumBins[b];
        _liveSpectrumPeakAge[b] = 0;
      } else {
        _liveSpectrumPeakAge[b]++;
        if (_liveSpectrumPeakAge[b] > 25) {
          _liveSpectrumPeaks[b] -= 0.8;
          if (_liveSpectrumPeaks[b] < _liveSpectrumBins[b]) {
            _liveSpectrumPeaks[b] = _liveSpectrumBins[b];
          }
        }
      }
    }

    // Throttle the canvas paint to ~30fps. The paint is the expensive part
    // (canvas clear + background grid + 3 curves with quadratic splines +
    // gradient fill + peak line + shadow blur). 30fps is visually identical
    // to 60fps for spectrum analyzers — humans can't distinguish above ~24fps
    // for smooth waveforms. State still updates 60fps so when paint fires,
    // the data is fresh and motion stays fluid.
    _liveSpectrumPaintCount++;
    if ((_liveSpectrumPaintCount & 1) === 0) {
      paintLiveSpectrumFrame();
    }
    _liveSpectrumRaf = requestAnimationFrame(tick);
  };
  _liveSpectrumRaf = requestAnimationFrame(tick);
}

function stopLiveSpectrum() {
  if (_liveSpectrumRaf) {
    cancelAnimationFrame(_liveSpectrumRaf);
    _liveSpectrumRaf = null;
  }
  const dot = document.getElementById('pro-spectrum-live-dot');
  if (dot) dot.classList.remove('live');
  // Decay the bars to silent over a few frames so the transition to the
  // static spectrum isn't jarring. Done via a separate decay loop.
  if (!_liveSpectrumBins) return;
  const decayTick = () => {
    let allDecayed = true;
    for (let b = 0; b < _liveSpectrumBins.length; b++) {
      if (_liveSpectrumBins[b] > -75) {
        _liveSpectrumBins[b] -= 2.5;
        allDecayed = false;
      }
      if (_liveSpectrumPeaks[b] > -75) {
        _liveSpectrumPeaks[b] -= 2.0;
        allDecayed = false;
      }
    }
    paintLiveSpectrumFrame();
    if (!allDecayed && !playing) {
      requestAnimationFrame(decayTick);
    }
  };
  requestAnimationFrame(decayTick);
}

function paintLiveSpectrumFrame() {
  // Skip paint entirely when the window/tab is hidden — the user can't see
  // it, and browser RAFs already throttle hard when hidden, but this saves
  // the wasted canvas work for the cases where RAF still fires.
  if (document.hidden) return;
  const canvas = document.getElementById('pro-spectrum-canvas');
  if (!canvas || !_liveSpectrumBins) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 280;
  // Only resize the canvas if dimensions actually changed — resizing every
  // frame clears the buffer state and tanks performance.
  if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    // Also resize the hover overlay to match
    const hover = document.getElementById('pro-spectrum-hover');
    if (hover) {
      hover.width = Math.floor(W * dpr);
      hover.height = Math.floor(H * dpr);
      hover.style.width = W + 'px';
      hover.style.height = H + 'px';
    }
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  drawSpectrumBackground(ctx, W, H);

  const NUM_BINS = _liveSpectrumBins.length;
  // Bin index → x coordinate (linear across NUM_BINS, which is already log-mapped)
  const bx = (b) => (b / NUM_BINS) * W;
  const dbToY = (db) => {
    const clamped = Math.max(-72, Math.min(12, db));
    return H - ((clamped + 72) / 84) * H;
  };

  // ── Slow-average curve (dim, in the background) ────────────────────────
  // Shows the "tonal balance" of the track — flat = balanced mix.
  if (_liveSpectrumAvg) {
    ctx.beginPath();
    for (let b = 0; b < NUM_BINS; b++) {
      const x = bx(b);
      const y = dbToY(_liveSpectrumAvg[b]);
      if (b === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(180, 180, 200, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ── Instant filled curve with frequency-mapped color gradient ──────────
  // Pro-Q3 uses a single color, but producers benefit from quickly seeing
  // WHERE energy lives — purple bass, green mids, yellow highs. Gradient
  // is applied as a horizontal fill across the spectrum.
  const screenPts = [];
  for (let b = 0; b < NUM_BINS; b++) {
    screenPts.push({ x: bx(b), y: dbToY(_liveSpectrumBins[b]) });
  }
  // Horizontal gradient: purple → blue → green → yellow → orange → red
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0.00, 'rgba(130, 90, 220, 0.55)');   // sub
  grad.addColorStop(0.18, 'rgba(80, 130, 230, 0.50)');   // bass
  grad.addColorStop(0.38, 'rgba(80, 200, 160, 0.45)');   // low mid
  grad.addColorStop(0.58, 'rgba(220, 200, 80, 0.50)');   // mid
  grad.addColorStop(0.78, 'rgba(245, 150, 60, 0.55)');   // high mid
  grad.addColorStop(1.00, 'rgba(230, 90, 100, 0.55)');   // air
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(screenPts[0].x, screenPts[0].y);
  for (let i = 0; i < screenPts.length - 1; i++) {
    const p1 = screenPts[i], p2 = screenPts[i + 1];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
  }
  const last = screenPts[screenPts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Outline on top — single warm color so the eye reads it as one curve.
  // Visual glow comes from two passes (wide soft + crisp inner) instead of
  // ctx.shadowBlur, which is one of the most expensive Canvas2D ops. Two
  // strokes are ~10× cheaper than a shadowBlur stroke and look identical.
  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 0; i < screenPts.length - 1; i++) {
    const p1 = screenPts[i], p2 = screenPts[i + 1];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
  }
  ctx.lineTo(last.x, last.y);
  // Soft outer glow — wide stroke, low alpha
  ctx.strokeStyle = 'rgba(248,165,72,0.20)';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Crisp inner line
  ctx.strokeStyle = '#f8a548';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // ── Peak-hold line ─────────────────────────────────────────────────────
  ctx.beginPath();
  for (let b = 0; b < NUM_BINS; b++) {
    const x = bx(b);
    const y = dbToY(_liveSpectrumPeaks[b]);
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255, 235, 210, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── Hover crosshair + readout ──────────────────────────────────────────────
// Mouse over the spectrum to see frequency + dB at that point, plus the
// nearest musical note (A2, A3 etc) — helpful for producers tracking
// resonant peaks or fundamentals.

// Paint a fresh empty grid into the spectrum canvas. Used on app init so
// the grid + freq labels are visible even before any audio plays — without
// this the canvas looked like a black rectangle until you ran an analysis.
function _paintEmptySpectrum() {
  const canvas = document.getElementById('pro-spectrum-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap || !wrap.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 280;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const hoverEl = document.getElementById('pro-spectrum-hover');
  if (hoverEl) {
    hoverEl.width = Math.floor(W * dpr);
    hoverEl.height = Math.floor(H * dpr);
    hoverEl.style.width = W + 'px';
    hoverEl.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  drawSpectrumBackground(ctx, W, H);
}

let _spectrumHoverWired = false;
let _spectrumHoverPendingX = -1;
let _spectrumHoverPendingY = -1;
let _spectrumHoverRaf = 0;
function _wireSpectrumHover() {
  if (_spectrumHoverWired) return;
  const wrap = document.getElementById('pro-spectrum');
  const hover = document.getElementById('pro-spectrum-hover');
  if (!wrap || !hover) return;
  _spectrumHoverWired = true;
  // Mouse can fire hundreds of mousemove events per second. We coalesce
  // them to one paint per animation frame — the user can't perceive faster
  // updates than that anyway. This drops hover CPU from ~5% to ~0.5% on
  // a fast mouse sweep.
  wrap.addEventListener('mousemove', (e) => {
    const rect = wrap.getBoundingClientRect();
    _spectrumHoverPendingX = e.clientX - rect.left;
    _spectrumHoverPendingY = e.clientY - rect.top;
    if (!_spectrumHoverRaf) {
      _spectrumHoverRaf = requestAnimationFrame(() => {
        _spectrumHoverRaf = 0;
        if (_spectrumHoverPendingX >= 0) {
          _paintSpectrumHover(_spectrumHoverPendingX, _spectrumHoverPendingY);
        }
      });
    }
  });
  wrap.addEventListener('mouseleave', () => {
    _spectrumHoverPendingX = -1;
    if (_spectrumHoverRaf) { cancelAnimationFrame(_spectrumHoverRaf); _spectrumHoverRaf = 0; }
    const ctx = hover.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, hover.width, hover.height);
    const readout = document.getElementById('pro-spectrum-readout');
    if (readout) readout.textContent = '';
  });
}
function _paintSpectrumHover(mx, my) {
  const hover = document.getElementById('pro-spectrum-hover');
  if (!hover) return;
  const wrap = document.getElementById('pro-spectrum');
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = 280;
  // Resize hover overlay if needed (matches main canvas)
  if (hover.width !== Math.floor(W * dpr) || hover.height !== Math.floor(H * dpr)) {
    hover.width = Math.floor(W * dpr);
    hover.height = Math.floor(H * dpr);
    hover.style.width = W + 'px';
    hover.style.height = H + 'px';
  }
  const ctx = hover.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, hover.width, hover.height);
  ctx.scale(dpr, dpr);
  // Convert x → frequency (log scale, matches the spectrum)
  const FMIN = 20, FMAX = 22000;
  const logMin = Math.log10(FMIN);
  const logMax = Math.log10(FMAX);
  const frac = Math.max(0, Math.min(1, mx / W));
  const freq = Math.pow(10, logMin + frac * (logMax - logMin));
  // Convert y → dB (inverse of dbToY in paint)
  const dbAtCursor = ((1 - (my / H)) * 84) - 72;
  // Nearest musical note (A4 = 440Hz)
  const noteName = _freqToNoteName(freq);
  // Vertical crosshair
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(mx, 0); ctx.lineTo(mx, H);
  ctx.stroke();
  // Horizontal crosshair
  ctx.beginPath();
  ctx.moveTo(0, my); ctx.lineTo(W, my);
  ctx.stroke();
  ctx.setLineDash([]);
  // Readout in the section title
  const readout = document.getElementById('pro-spectrum-readout');
  if (readout) {
    const freqStr = freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : Math.round(freq) + ' Hz';
    readout.textContent = freqStr + '  ·  ' + dbAtCursor.toFixed(1) + ' dB  ·  ' + noteName;
  }
}
// Convert frequency to nearest musical note name (e.g. 440 → A4, 261.63 → C4)
function _freqToNoteName(freq) {
  if (freq < 20) return '—';
  const A4 = 440;
  const noteNum = 12 * Math.log2(freq / A4) + 69;  // MIDI number
  const rounded = Math.round(noteNum);
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const octave = Math.floor(rounded / 12) - 1;
  const name = names[((rounded % 12) + 12) % 12];
  const cents = Math.round((noteNum - rounded) * 100);
  const centsStr = cents === 0 ? '' : (cents > 0 ? ' +' : ' ') + cents + '¢';
  return name + octave + centsStr;
}

function drawWaveform(buf) {
  const canvas = document.getElementById('waveform'), wrap = document.getElementById('wave-wrap');
  // If wrap has no size yet (tab hidden), defer one frame until layout is complete
  if (!wrap.offsetWidth) { requestAnimationFrame(() => drawWaveform(buf)); return; }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.offsetWidth * dpr; canvas.height = wrap.offsetHeight * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const data = buf.getChannelData(0), W = wrap.offsetWidth, H = wrap.offsetHeight, step = Math.ceil(data.length / W);
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < W; i++) {
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) { const s = data[i*step+j]||0; if(s<mn)mn=s; if(s>mx)mx=s; }
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.12 + Math.abs(mx-mn)*0.35) + ')';
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(i, ((1+mn)/2)*H); ctx.lineTo(i, ((1+mx)/2)*H); ctx.stroke();
  }
}

// Draw beat markers on waveform canvas
function drawBeatMarkers(beatTimes) {
  if (!audioBuf) return;
  const canvas = document.getElementById('waveform');
  const wrap   = document.getElementById('wave-wrap');
  const dpr    = window.devicePixelRatio || 1;
  const ctx    = canvas.getContext('2d');
  const W = wrap.offsetWidth, H = wrap.offsetHeight;

  ctx.save();
  ctx.scale(dpr, dpr);
  beatTimes.forEach(t => {
    const x = (t / audioBuf.duration) * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Playback ──────────────────────────────────────────────────────────────────

function togglePlay() {
  if (!audioBuf) return;
  playing ? stopAudio() : startAudio();
}

function startAudio() {
  if (!audioBuf) return;
  // Stop the global mini player if it's running — both share the audio output
  // device. Letting them run in parallel was causing rapid range-request
  // ECANCELED errors and (rarely) a renderer freeze.
  if (globalPlayer.audio && !globalPlayer.audio.paused) {
    try { stopGlobalPlay(); } catch {}
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();

  // Bump the source-generation token. Stale srcNodes (whose .stop() was
  // called moments ago but whose onended fires async) check this token in
  // their end-handler and bail if they're not the active source. Without
  // this guard, the stale onended runs after a fresh startAudio has set
  // playing=true and resets playing/pauseOff — making the UI show "stopped"
  // even though the new srcNode is happily ringing.
  _srcGen++;
  const myGen = _srcGen;

  srcNode = audioCtx.createBufferSource();
  srcNode._gen = myGen;
  srcNode.buffer = audioBuf;
  srcNode.playbackRate.value = Math.pow(2, pitchVal / 12);

  // Build clean chain: source → gain → destination
  // Analysers TAP off gain node (not in-line) so they can't break audio
  gainNode = audioCtx.createGain();
  gainNode.gain.value = muted ? 0 : volumeLevel;
  gainNode.connect(audioCtx.destination);
  srcNode.connect(gainNode);
  srcNode.start(0, pauseOff % audioBuf.duration);
  startT = audioCtx.currentTime;
  playing = true;

  document.getElementById('play-ico').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  // Flag distinguishing natural end-of-track from manual stop. Web Audio's
  // onended fires for both — without this flag we'd hide the mirror player
  // every time the user just hits pause, which is wrong.
  let _wasManuallyStopped = false;
  srcNode._endHandler = () => {
    // If a newer srcNode has been created since this one started, this is a
    // stale event from the old node's .stop() — ignore it completely.
    // This is THE fix for the "seek stops the analyzer but audio keeps
    // playing" bug: stale end-handlers were resetting playing/pauseOff to
    // false/0 while the new srcNode was still ringing.
    if (myGen !== _srcGen) return;
    const wasNaturalEnd = playing && !_wasManuallyStopped;
    if (playing) {
      playing = false; pauseOff = 0; resetProg(); setPlayIco(); stopVU();
      // Reset the history row's play button — track is no longer playing
      if (typeof _refreshHistoryRowPlayState === 'function') _refreshHistoryRowPlayState();
    }

    // Natural end in mirror mode → honor shuffle / loop:
    //   - loop=track → restart same track from 0
    //   - shuffle on → globalPlayerNext picks a random track
    //   - normal → globalPlayerNext advances by 1 (loops to start if loop=playlist)
    // globalPlayerNext already encapsulates all of this for mirror mode.
    if (wasNaturalEnd && analyzeMirrorActive && analyzePlaylist &&
        analyzePlaylist.tracks && analyzePlaylist.tracks.length > 0) {
      if (loopMode === 'track') {
        // Restart same track. _handoffWasPlaying = true triggers autoplay
        // after loadAudioBuffer (already loaded), but since the same id is
        // already in currentHistId, the fast path will just restart audio.
        if (typeof globalPlayer !== 'undefined') {
          globalPlayer._handoffWasPlaying = true;
          globalPlayer._handoffTime = 0;
        }
        if (typeof startAudio === 'function') {
          requestAnimationFrame(() => { try { startAudio(); } catch {} });
        }
        return;
      }
      // Try to advance. If we're at the end with no loop, globalPlayerNext
      // will bail with a notification — fall through to hideAnalyzeMirror.
      const atEnd = analyzePlaylist.index >= analyzePlaylist.tracks.length - 1;
      const canAdvance = shuffleMode && analyzePlaylist.tracks.length > 1 ||
                         !atEnd ||
                         loopMode === 'playlist';
      if (canAdvance) {
        globalPlayerNext();
        return;
      }
    }

    // Only hide mirror on natural completion. Pause keeps the mirror visible
    // so the user can resume or seek without losing the mini-player.
    if (analyzeMirrorActive && !_wasManuallyStopped && pauseOff === 0) {
      hideAnalyzeMirror();
    }
  };
  srcNode.onended = srcNode._endHandler;
  // Expose the manual-stop flag so stopAudio() can set it before stopping
  srcNode._setManualStop = (v) => { _wasManuallyStopped = v; };

  rafLoop();
  startVU();
  // Live spectrum analyzer reuses the VU's analyserL (created inside
  // startVU) — must be called AFTER startVU so the analyser node exists.
  startLiveSpectrum();
  // Surface the mini player in mirror mode so the user can see playback
  // info and control it from anywhere in the app.
  showAnalyzeMirror();
  // Flip the currently-playing history row's button to ⏸
  if (typeof _refreshHistoryRowPlayState === 'function') _refreshHistoryRowPlayState();
}

function stopAudio() {
  // Mark the stop as manual (pause) so the onended handler doesn't hide
  // the mirror player. Without this, hitting pause makes the mini player
  // vanish — confusing and unwanted.
  if (srcNode && srcNode._setManualStop) srcNode._setManualStop(true);
  // Clear the onended handler completely so the .stop() below can't
  // trigger any stale state mutations even if the gen-token check is bypassed.
  // Belt-and-suspenders: the generation check in startAudio's handler is
  // the primary defense, this is a secondary one.
  if (srcNode) {
    try { srcNode.onended = null; } catch {}
  }
  try { srcNode?.stop(); } catch {}
  // Disconnect immediately. Even though stop() is supposed to be sample-
  // accurate, on some Windows audio drivers there's a brief window where
  // the source keeps producing samples until the audio thread catches up.
  // Disconnecting guarantees no audio reaches the destination — critical
  // when stopAudio() is followed within the same frame by startAudio() or
  // by the global player starting (the duplicate-audio scenario).
  try { srcNode?.disconnect(); } catch {}
  try { gainNode?.disconnect(); } catch {}
  pauseOff += audioCtx.currentTime - startT;
  playing = false;
  cancelAnimationFrame(rafId);
  setPlayIco();
  stopVU();
  stopLiveSpectrum();  // graceful decay then stops
  // Update mirror state if shown — pause icon, no auto-hide so seek still works
  if (analyzeMirrorActive) {
    const svg = document.getElementById('sp-fv-mini-toggle-svg');
    if (svg) svg.innerHTML = '<polygon points="7,5 7,19 19,12"/>'; // play triangle (paused state)
  }
  // Flip the history row's play button back to ▶ if visible
  if (typeof _refreshHistoryRowPlayState === 'function') _refreshHistoryRowPlayState();
}

// ── Analyze ↔ Mini Player bridge ───────────────────────────────────────────
// When the Analyze view plays audio, we surface the global mini player in
// "mirror mode". The mini player's UI reflects analyze state but doesn't
// own the audio — controls (play/pause, seek, volume) are forwarded back
// to the Analyze functions. This avoids the dual-stream conflict that
// caused freezes while still giving the user a persistent control surface
// across tabs.
let analyzeMirrorActive = false;
let analyzeMirrorRaf = null;
// Analyzer playlist context. When the user plays a history row, we capture
// the visible history list as a playlist on the ANALYZER (the actual audio
// source in mirror mode). Mini player prev/next then walks this list and
// loads the prev/next track into the Analyzer — keeping the audio source
// consistent (no global <audio> involvement).
let analyzePlaylist = null;   // { tracks: [{id, file_path, title, ...}], index: 0 }

function showAnalyzeMirror() {
  analyzeMirrorActive = true;
  const player = document.getElementById('sp-fv-mini-player');
  if (!player) return;
  player.classList.remove('hidden');
  player.setAttribute('data-mirror', 'analyze');
  // Compact treatment when surfacing while user is already on Analyze tab.
  // The CSS transition handles the slide-shrink smoothly even when going
  // from hidden → visible with compact class set in one shot.
  if (lastTab === 'analyze') {
    player.classList.add('compact');
  } else {
    player.classList.remove('compact');
  }
  const switchToAnalyzer = () => {
    const tab = document.querySelector('.nav-btn[data-tab="analyze"]');
    if (tab) showTab(tab);
  };
  // Title from current Analyze track
  const titleEl = document.getElementById('sp-fv-mini-title');
  const subEl = document.getElementById('sp-fv-mini-sub');
  const thumbWrap = document.getElementById('sp-fv-mini-thumb');
  if (titleEl) {
    titleEl.textContent = (document.getElementById('player-name')?.textContent) || '—';
    titleEl.style.cursor = 'pointer';
    titleEl.title = t('spJumpToAnalyze') || 'Open in Analyzer';
    titleEl.onclick = switchToAnalyzer;
  }
  if (subEl) {
    const bpm = document.getElementById('bpm')?.textContent || '';
    const key = document.getElementById('key')?.textContent || '';
    const mode = document.getElementById('key-mode')?.textContent || '';
    subEl.textContent = [
      bpm && bpm !== '…' && bpm !== '—' ? bpm + ' BPM' : null,
      key && key !== '—' && key !== '…' ? (key + (mode && mode !== '—' ? ' ' + mode : '')) : null,
      t('spInAnalyzer') || 'in Analyzer',
    ].filter(Boolean).join(' · ');
    subEl.style.cursor = 'pointer';
    subEl.onclick = switchToAnalyzer;
  }
  if (thumbWrap) {
    thumbWrap.style.cursor = 'pointer';
    thumbWrap.onclick = switchToAnalyzer;
    thumbWrap.title = t('spJumpToAnalyze') || 'Open in Analyzer';
  }
  if (thumbWrap) {
    let url = '';
    if (currentHistId) {
      const row = histData.find(h => h.id == currentHistId);
      if (row && row.thumbnail) url = row.thumbnail;
    }
    thumbWrap.innerHTML = url
      ? '<img src="' + url.replace(/"/g, '&quot;') + '"/>'
      : '<span class="sp-fv-mini-thumb-fallback">♪</span>';
  }
  // Play icon → pause (since we're playing)
  const svg = document.getElementById('sp-fv-mini-toggle-svg');
  if (svg) svg.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'; // pause bars
  // Prev/Next walk the Analyzer playlist (analyzePlaylist) — enabled when
  // a playlist context exists. Shuffle/Loop don't make sense in mirror mode
  // since they're really mini-player playback modes; keep them disabled.
  const prev = document.getElementById('sp-fv-mini-prev');
  const next = document.getElementById('sp-fv-mini-next');
  const shuf = document.getElementById('sp-fv-mini-shuffle');
  const loop = document.getElementById('sp-fv-mini-loop');
  const hasPlaylist = analyzePlaylist && analyzePlaylist.tracks && analyzePlaylist.tracks.length > 1;
  if (prev) {
    prev.disabled = !hasPlaylist;
    prev.classList.toggle('disabled-mirror', !hasPlaylist);
  }
  if (next) {
    next.disabled = !hasPlaylist;
    next.classList.toggle('disabled-mirror', !hasPlaylist);
  }
  // Shuffle + loop are now wired through to analyzePlaylist when in mirror
  // mode (see globalPlayerNext / pickNextTrackAfterEnd). Previously these
  // were force-disabled here because the mirror flow had no concept of
  // playlist-end handling — that's been added, so the buttons work again.
  for (const btn of [shuf, loop]) {
    if (btn) {
      btn.disabled = !hasPlaylist;
      btn.classList.toggle('disabled-mirror', !hasPlaylist);
    }
  }
  // Refresh on/off classes from current state (button might have been
  // re-rendered between sessions)
  if (typeof applyModeButtonStates === 'function') applyModeButtonStates();
  // Heart reflects the displayed track's favorite state immediately —
  // covers playing a track that was already favorited from History.
  syncMiniFavHeart();
  // Wire seek handlers in mirror mode
  spFvSeekDragSetup();
  spFvVolumeDragSetup();
  // Volume slider reflects analyze volume
  // Volume bar reflects Analyzer volume. Use the slider's raw 0-100 value
  // — NOT volumeLevel, which is the post-taper linear gain (~0.01 at slider
  // 50, ~1.0 at slider 100). Reading volumeLevel into a percent would show
  // a wrong position for any slider value below 100. The slider's value
  // attribute is the source of truth for what the user actually selected.
  const sliderEl = document.getElementById('vol-slider');
  const sliderVal = sliderEl ? parseFloat(sliderEl.value) : (volumeLevel * 100);
  _syncMiniPlayerVolumeBar(sliderVal);
  // Drive time updates. Cache DOM refs once instead of getElementById'ing
  // four times per frame at 60fps. Also: text updates throttled to ~10fps
  // since seconds-precision time labels look identical to humans above ~6fps.
  if (analyzeMirrorRaf) cancelAnimationFrame(analyzeMirrorRaf);
  const mFill  = document.getElementById('sp-fv-mini-seek-fill');
  const mThumb = document.getElementById('sp-fv-mini-seek-thumb');
  const mCur   = document.getElementById('sp-fv-mini-time-cur');
  const mDur   = document.getElementById('sp-fv-mini-time-dur');
  let mirrorFrame = 0;
  let lastCurText = '', lastDurText = '';
  const tick = () => {
    if (!analyzeMirrorActive) return;
    if (audioBuf && playing) {
      const cur = (pauseOff + (audioCtx.currentTime - startT)) % audioBuf.duration;
      const dur = audioBuf.duration;
      // Time labels: every 6th frame (~10fps), and only when the displayed
      // string actually changed. fmtSec rounds to seconds so most frames
      // produce the same text — no point hitting textContent every time.
      if ((mirrorFrame++ % 6) === 0) {
        if (mCur) {
          const s = fmtSec(cur);
          if (s !== lastCurText) { mCur.textContent = s; lastCurText = s; }
        }
        if (mDur) {
          const s = fmtSec(dur);
          if (s !== lastDurText) { mDur.textContent = s; lastDurText = s; }
        }
      }
      // Seek bar — keep at 60fps so the playhead motion is smooth.
      if (!spFvSeekDragging && mFill && dur > 0) {
        const pct = (cur / dur) * 100;
        mFill.style.width = pct + '%';
        if (mThumb) mThumb.style.left = pct + '%';
      }
    }
    analyzeMirrorRaf = requestAnimationFrame(tick);
  };
  analyzeMirrorRaf = requestAnimationFrame(tick);
}

function hideAnalyzeMirror() {
  analyzeMirrorActive = false;
  if (analyzeMirrorRaf) { cancelAnimationFrame(analyzeMirrorRaf); analyzeMirrorRaf = null; }
  const player = document.getElementById('sp-fv-mini-player');
  if (player) {
    player.classList.add('hidden');
    player.classList.remove('compact');
    player.removeAttribute('data-mirror');
  }
  // Re-enable all buttons that mirror mode disabled
  for (const id of ['sp-fv-mini-prev', 'sp-fv-mini-next', 'sp-fv-mini-shuffle', 'sp-fv-mini-loop']) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('disabled-mirror');
    }
  }
  // Restore title click behavior to default
  const titleEl = document.getElementById('sp-fv-mini-title');
  if (titleEl) { titleEl.onclick = null; titleEl.style.cursor = ''; titleEl.title = ''; }
}

// ── Volume ────────────────────────────────────────────────────────────────────
// Slider range:
//   0       →   -∞ dB  (true silence)
//   1..100  →  -40 dB to 0 dB  (legacy taper for soft listening)
//   100..130 →   0 dB to +6 dB (boost zone for quiet sources)
// The Web Audio gain node is a linear multiplier so +6 dB = ×2.0. The DAW's
// limiter + hard-clipper chain still protects against speaker damage so
// users can't clip the output even at max.
function setVolume(val) {
  val = parseInt(val);
  if (val === 0) {
    volumeLevel = 0;
  } else if (val <= 100) {
    // -40 dB to 0 dB across slider 1..100
    const db = (val / 100) * 40 - 40;
    volumeLevel = Math.pow(10, db / 20);
  } else {
    // 0 dB to +6 dB across slider 100..130 (the boost zone)
    const db = ((val - 100) / 30) * 6;
    volumeLevel = Math.pow(10, db / 20);
  }
  muted = false;
  if (gainNode) gainNode.gain.value = volumeLevel;
  // Move the analyzer slider DOM too. When this function is called
  // programmatically (e.g. from the mini-player or toggle-mute), the
  // slider thumb wouldn't move otherwise — only direct user-drags on the
  // slider would update it. Setting .value here keeps both controls in
  // visual lockstep regardless of who triggered the change.
  const sliderEl = document.getElementById('vol-slider');
  if (sliderEl && parseFloat(sliderEl.value) !== val) {
    sliderEl.value = String(val);
  }
  // Display in dB
  let dispDb;
  if (val === 0) dispDb = '-∞ dB';
  else if (val === 100) dispDb = '0 dB';
  else if (val < 100) dispDb = (((val/100)*40-40)).toFixed(1) + ' dB';
  else dispDb = '+' + (((val-100)/30)*6).toFixed(1) + ' dB';
  document.getElementById('vol-db').textContent = dispDb;
  updateVolIcon(val);
  // Also reflect the change in the mini-player's volume bar so the two
  // stay synchronized. Without this, dragging the Analyzer slider left
  // the mini-player bar showing a stale level. We only update visuals
  // here — the actual audio gain is already applied via `gainNode` above,
  // and in mirror mode the mini player and Analyzer share the same audio
  // path so there's no second gain to set.
  _syncMiniPlayerVolumeBar(val);
}

// Updates only the mini-player's volume bar fill + thumb + icon to match
// the given 0-130 value. Pulled out so both directions of sync (mini→
// analyzer and analyzer→mini) can use it; the actual audio level is
// controlled exclusively by the Analyzer's gainNode in mirror mode.
//
// Volume domain is 0-130 (where 100 = unity, 130 = +6 dB boost). The
// visible bar maps that to 0-100% width so the thumb still travels across
// the full bar. Above 100 the bar tints slightly red to signal boost
// mode is active (perceptually >0 dBFS line equivalent).
function _syncMiniPlayerVolumeBar(val) {
  const fill = document.getElementById('sp-fv-mini-volume-fill');
  const thumb = document.getElementById('sp-fv-mini-volume-thumb');
  const icon = document.getElementById('sp-fv-mini-vol-icon');
  const v = Math.max(0, Math.min(130, val));
  const pct = (v / 130) * 100;  // visual fill 0-100% across the bar
  if (fill) {
    fill.style.width = pct + '%';
    // Boost-zone tint when >100: fade from accent to a warm orange so
    // users see they're driving above unity. Below 100 keep neutral.
    fill.style.background = v > 100 ? '#ffb84d' : '';
  }
  if (thumb) thumb.style.left = pct + '%';
  if (icon) {
    // Match the Analyzer's volume icon states so the visual cue is
    // identical on both controls.
    icon.innerHTML = v === 0
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
      : v < 50
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
  }
}
function toggleMute() {
  muted = !muted;
  if (gainNode) gainNode.gain.value = muted ? 0 : volumeLevel;
  updateVolIcon(muted ? 0 : parseInt(document.getElementById('vol-slider').value));
}
function updateVolIcon(val) {
  const ico = document.getElementById('vol-ico'); if (!ico) return;
  if (muted || val === 0)
    ico.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="1.8"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="1.8"/>';
  else if (val < 40)
    ico.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
  else
    ico.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
}

// ── Professional metering engine ─────────────────────────────────────────────
// Correct signal processing:
// - PPM bars: true peak per AnalyserNode frame (fast, accurate)
// - LUFS: proper 400ms integrated block accumulation with EBU R128 gating
// - RMS: 300ms sliding window
// - True Peak: max sample seen (display-only — Python gives exact 4x oversampled value)
// - DR: proper peak/RMS crest factor

// K-weighting biquad state (run in JS for real-time LUFS approximation)
// Implements both stages of ITU-R BS.1770-4 K-weighting filter
class KWeightFilter {
  constructor(sr) {
    // Stage 1: high-shelf
    const Vh=1.58489319458372, Vb=1.25892541179417, f0=1681.974450955533, Q=0.7071752369554196;
    const K=Math.tan(Math.PI*f0/sr), d=1+K/Q+K**2;
    this.b1=[( Vh+Vb*K/Q+K**2)/d, 2*(K**2-Vh)/d,    (Vh-Vb*K/Q+K**2)/d];
    this.a1=[1,                     2*(K**2-1)/d,       (1-K/Q+K**2)/d];
    // Stage 2: high-pass RLB
    const f2=38.13547087602444, Q2=0.5003270373238773;
    const K2=Math.tan(Math.PI*f2/sr), d2=1+K2/Q2+K2**2;
    this.b2=[1/d2, -2/d2, 1/d2];
    this.a2=[1, 2*(K2**2-1)/d2, (1-K2/Q2+K2**2)/d2];
    this.z1=[0,0,0,0]; // filter state [s1_x1,s1_x2, s2_x1,s2_x2]
  }
  process(x) {
    // Stage 1
    const y1 = this.b1[0]*x  + this.z1[0];
    this.z1[0] = this.b1[1]*x - this.a1[1]*y1 + this.z1[1];
    this.z1[1] = this.b1[2]*x - this.a1[2]*y1;
    // Stage 2
    const y2 = this.b2[0]*y1 + this.z1[2];
    this.z1[2] = this.b2[1]*y1 - this.a2[1]*y2 + this.z1[3];
    this.z1[3] = this.b2[2]*y1 - this.a2[2]*y2;
    return y2;
  }
  processBlock(samples) {
    const out = new Float32Array(samples.length);
    for (let i=0; i<samples.length; i++) out[i] = this.process(samples[i]);
    return out;
  }
}

let kwL = null, kwR = null; // K-weighting filter instances
let analyserL = null, analyserR = null;
let vuRafId = null;

// Sliding window accumulators
let lufsBlocks = [];          // 400ms mean-square blocks
let rmsWindow  = [];          // 300ms sample squares
let peakHoldL  = -144, peakHoldR = -144, peakHoldTimer = 0;
let truePeakMax = -144;
let framesSinceBlock = 0;     // to know when to commit a 400ms block
let BLOCK_FRAMES = 0;         // set in startVU based on actual sr/fps

function startVU() {
  cancelAnimationFrame(vuRafId);
  lufsBlocks = []; rmsWindow = []; truePeakMax = -144;
  peakHoldL = -144; peakHoldR = -144; peakHoldTimer = 0; framesSinceBlock = 0;

  if (!gainNode || !audioCtx) return;

  const sr = audioCtx.sampleRate;
  kwL = new KWeightFilter(sr);
  kwR = new KWeightFilter(sr);

  const isStereo = audioBuf && audioBuf.numberOfChannels >= 2;

  // Build metering taps
  analyserL = audioCtx.createAnalyser();
  analyserL.fftSize = 2048;
  analyserL.smoothingTimeConstant = 0; // raw — we do our own smoothing

  if (isStereo) {
    // Stereo: splitter feeds separate analysers
    // Each analyser must connect to destination (even silently) to be active
    const splitter = audioCtx.createChannelSplitter(2);
    gainNode.connect(splitter);
    analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 2048;
    analyserR.smoothingTimeConstant = 0;
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    // Connect analysers to destination — required for Web Audio graph to process them
    // Use a silent gain (0) merger so we don't double the audio output
    const merger = audioCtx.createChannelMerger(2);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    analyserL.connect(merger, 0, 0);
    analyserR.connect(merger, 0, 1);
    merger.connect(silentGain);
    silentGain.connect(audioCtx.destination);
  } else {
    // Mono: single analyser, connect to destination silently
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    gainNode.connect(analyserL);
    analyserL.connect(silentGain);
    silentGain.connect(audioCtx.destination);
    analyserR = analyserL;
  }

  const N = analyserL.fftSize;
  const fps = 60; // approximate — requestAnimationFrame
  // 400ms block = how many rAF frames we need to accumulate
  BLOCK_FRAMES = Math.round(0.4 * fps);

  // Accumulators for the current 400ms block
  let blockSumL = 0, blockSumR = 0, blockCount = 0;
  // Spectral data for frequency display
  const freqBuf = new Float32Array(N/2 + 1);
  const timeBufL = new Float32Array(N);
  const timeBufR = new Float32Array(N);
  let frameCount = 0;

  // Ring buffer for RMS over the last ~300ms of frames. Old impl used a
  // regular array with .shift() (O(n)) + .reduce() (O(n)) every frame —
  // dominant cost in the VU loop on long playback. Ring buffer + running
  // sum is O(1) per frame.
  const RMS_FRAMES = Math.round(0.3 * fps);
  const rmsRing = new Float32Array(RMS_FRAMES);
  let rmsRingIdx = 0;
  let rmsRingFilled = 0;
  let rmsRunningSum = 0;

  // Cache the DOM elements the stats panel writes to — getElementById in a
  // hot loop is cheap individually but adds up at 60fps × 8 stats × N seconds.
  const elStatLufs  = document.getElementById('stat-lufs');
  const elStatShort = document.getElementById('stat-short');
  const elStatMom   = document.getElementById('stat-mom');
  const elStatPeak  = document.getElementById('stat-peak');
  const elStatDr    = document.getElementById('stat-dr');
  const elStatRms   = document.getElementById('stat-rms');
  // Per-channel meter elements + value labels — written every frame for L/R
  // PPM display. updateMeter() used to getElementById these on each call;
  // now we pass the refs in and it just writes styles.
  const elMeterL = document.getElementById('meter-l');
  const elMeterR = document.getElementById('meter-r');
  const elPeakL  = document.getElementById('peak-l');
  const elPeakR  = document.getElementById('peak-r');
  const elValL   = document.getElementById('val-l');
  const elValR   = document.getElementById('val-r');

  function tick() {
    if (!playing) return;
    vuRafId = requestAnimationFrame(tick);
    frameCount++;

    // ── Read raw samples ──────────────────────────────────────────────────
    analyserL.getFloatTimeDomainData(timeBufL);
    analyserR.getFloatTimeDomainData(timeBufR);

    // ── K-weight for LUFS ─────────────────────────────────────────────────
    const kwBufL = kwL.processBlock(timeBufL);
    const kwBufR = kwR.processBlock(timeBufR);

    // ── Per-sample calculations ───────────────────────────────────────────
    let peakL=0, peakR=0, sumSqL=0, sumSqR=0, kwSumL=0, kwSumR=0;
    for (let i=0; i<N; i++) {
      const al=Math.abs(timeBufL[i]), ar=Math.abs(timeBufR[i]);
      if(al>peakL) peakL=al;
      if(ar>peakR) peakR=ar;
      sumSqL += timeBufL[i]*timeBufL[i];
      sumSqR += timeBufR[i]*timeBufR[i];
      kwSumL += kwBufL[i]*kwBufL[i];
      kwSumR += kwBufR[i]*kwBufR[i];
    }

    // ── PPM levels (dBFS) ─────────────────────────────────────────────────
    const dbL = peakL > 0 ? Math.max(-60, 20*Math.log10(peakL)) : -60;
    const dbR = peakR > 0 ? Math.max(-60, 20*Math.log10(peakR)) : -60;

    // ── RMS (300ms sliding window) — O(1) ring buffer ─────────────────────
    // Subtract the oldest frame from the running sum, overwrite with the new
    // frame, add to running sum. No allocations, no array shifts, no reduce.
    const framePower = (sumSqL + sumSqR) / 2 / N;
    if (rmsRingFilled === RMS_FRAMES) {
      rmsRunningSum -= rmsRing[rmsRingIdx];
    } else {
      rmsRingFilled++;
    }
    rmsRing[rmsRingIdx] = framePower;
    rmsRunningSum += framePower;
    rmsRingIdx = (rmsRingIdx + 1) % RMS_FRAMES;
    const avgRmsPow = rmsRunningSum / rmsRingFilled;
    const rmsDb = avgRmsPow > 1e-10 ? Math.max(-60, 10*Math.log10(avgRmsPow)) : -60;

    // ── True peak tracking ────────────────────────────────────────────────
    const tp = Math.max(peakL, peakR);
    if (tp > Math.pow(10, truePeakMax/20)) truePeakMax = 20*Math.log10(tp);
    const truePeakDb = truePeakMax;

    // ── LUFS block accumulation (EBU R128) ────────────────────────────────
    // Accumulate K-weighted power into 400ms blocks
    blockSumL += kwSumL / N;
    blockSumR += kwSumR / N;
    blockCount++;
    framesSinceBlock++;

    if (framesSinceBlock >= BLOCK_FRAMES) {
      // Commit this 400ms block
      const blockPower = (blockSumL + blockSumR) / 2 / blockCount;
      if (blockPower > 1e-10) lufsBlocks.push(blockPower);
      if (lufsBlocks.length > 150) lufsBlocks.shift(); // keep last 60s
      blockSumL = 0; blockSumR = 0; blockCount = 0; framesSinceBlock = 0;
    }

    // Momentary LUFS = last 400ms block
    const momLufs = lufsBlocks.length > 0
      ? -0.691 + 10*Math.log10(lufsBlocks[lufsBlocks.length-1])
      : null;

    // Short-term LUFS = last 3s (7-8 blocks)
    const shortBlocks = lufsBlocks.slice(-8);
    const shortLufs = shortBlocks.length > 1
      ? -0.691 + 10*Math.log10(shortBlocks.reduce((a,b)=>a+b,0)/shortBlocks.length)
      : null;

    // Integrated LUFS = all blocks with dual-gate
    let intLufs = null;
    if (lufsBlocks.length >= 4) {
      const abs_gate = Math.pow(10, -70/10);
      const g1 = lufsBlocks.filter(p => p > abs_gate);
      if (g1.length) {
        const mean1 = g1.reduce((a,b)=>a+b,0)/g1.length;
        const rel_gate = mean1 * Math.pow(10, -10/10);
        const g2 = g1.filter(p => p > rel_gate);
        if (g2.length) intLufs = -0.691 + 10*Math.log10(g2.reduce((a,b)=>a+b,0)/g2.length);
      }
    }

    // ── Dynamic Range (crest factor: peak vs RMS) ──────────────────────────
    const drVal = rmsDb > -60 && truePeakDb > -144
      ? Math.round(truePeakDb - rmsDb)
      : null;

    // ── Peak hold ─────────────────────────────────────────────────────────
    if (dbL > peakHoldL) { peakHoldL = dbL; peakHoldTimer = 0; }
    if (dbR > peakHoldR) { peakHoldR = dbR; peakHoldTimer = 0; }
    peakHoldTimer++;
    if (peakHoldTimer > 90) {
      peakHoldL -= 0.3; peakHoldR -= 0.3; // 0.3dB/frame decay after hold
      if (peakHoldL < -60) peakHoldL = -60;
      if (peakHoldR < -60) peakHoldR = -60;
    }

    // ── Update meters — inline writes against cached element refs ────────
    // Skips two function calls per frame and ~6 getElementById lookups.
    // The cached refs are captured once when vuStart runs.
    {
      const pctL = Math.max(0, Math.min(100, (dbL + 60) / 60 * 100));
      const pctR = Math.max(0, Math.min(100, (dbR + 60) / 60 * 100));
      const pkPctL = Math.max(0, Math.min(100, (peakHoldL + 60) / 60 * 100));
      const pkPctR = Math.max(0, Math.min(100, (peakHoldR + 60) / 60 * 100));
      if (elMeterL) {
        elMeterL.style.width = pctL + '%';
        elMeterL.style.background = dbL > -3 ? '#e84040' : dbL > -12 ? '#f59e0b' : '#4caf50';
      }
      if (elMeterR) {
        elMeterR.style.width = pctR + '%';
        elMeterR.style.background = dbR > -3 ? '#e84040' : dbR > -12 ? '#f59e0b' : '#4caf50';
      }
      if (elPeakL) {
        elPeakL.style.left = pkPctL + '%';
        elPeakL.style.background = peakHoldL > -3 ? '#e84040' : peakHoldL > -12 ? '#f59e0b' : '#ffffff';
      }
      if (elPeakR) {
        elPeakR.style.left = pkPctR + '%';
        elPeakR.style.background = peakHoldR > -3 ? '#e84040' : peakHoldR > -12 ? '#f59e0b' : '#ffffff';
      }
    }

    if (elValL) elValL.textContent = dbL <= -59.9 ? '-∞' : dbL.toFixed(1)+' dB';
    if (elValR) elValR.textContent = dbR <= -59.9 ? '-∞' : dbR.toFixed(1)+' dB';

    // Stats — update every 6 frames (~10fps) for readability. Text changes
    // faster than ~10fps are imperceptible anyway, and toFixed/string concat
    // is non-trivial when done 6 times per frame at 60fps.
    if (frameCount % 6 === 0) {
      if (elStatLufs)  elStatLufs.textContent  = intLufs != null   ? intLufs.toFixed(1)  : '-∞';
      if (elStatShort) elStatShort.textContent = shortLufs != null ? shortLufs.toFixed(1): '-∞';
      if (elStatMom)   elStatMom.textContent   = momLufs != null   ? momLufs.toFixed(1)  : '-∞';
      if (elStatPeak)  elStatPeak.textContent  = truePeakDb > -144 ? truePeakDb.toFixed(1) : '-∞';
      if (elStatDr)    elStatDr.textContent    = drVal != null     ? drVal                : '—';
      if (elStatRms)   elStatRms.textContent   = rmsDb <= -59.9    ? '-∞'                 : rmsDb.toFixed(1);

      // ── Live spectral balance bars REMOVED ─────────────────────────────
      // The 6 horizontal-bar version has been replaced by the live spectrum
      // analyzer (Pro-Q-style curve, much higher resolution). That curve is
      // driven by startLiveSpectrum() on its own RAF loop (~60fps), not from
      // here. Leaving this code path empty so we don't waste CPU on a
      // computation whose outputs no element renders.
    }
  }
  tick();
}

function updateMeter(ch, db, peakDb) {
  const fill = document.getElementById('meter-' + ch);
  const peak = document.getElementById('peak-' + ch);
  if (!fill || !peak) return;
  const pct   = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  const pkPct = Math.max(0, Math.min(100, (peakDb + 60) / 60 * 100));
  fill.style.width = pct + '%';
  // Colour changes based on actual level — not a baked gradient
  fill.style.background = db > -3 ? '#e84040' : db > -12 ? '#f59e0b' : '#4caf50';
  peak.style.left       = pkPct + '%';
  peak.style.background = peakDb > -3 ? '#e84040' : peakDb > -12 ? '#f59e0b' : '#ffffff';
}

function stopVU(){
  cancelAnimationFrame(vuRafId);
  ['l','r'].forEach(ch=>{
    const f=document.getElementById('meter-'+ch),p=document.getElementById('peak-'+ch),v=document.getElementById('val-'+ch);
    if(f)f.style.width='0%'; if(p)p.style.left='0%'; if(v)v.textContent='-∞';
  });
  ['stat-lufs','stat-short','stat-mom','stat-peak','stat-rms'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent='-∞';});
  const dr=document.getElementById('stat-dr'); if(dr)dr.textContent='—';
  // Old live-spectral-balance bars (live-sub, live-bass, ...) were removed
  // when the spectrum analyzer canvas took their slot. Nothing to reset here.
  lufsBlocks=[]; rmsWindow=[]; truePeakMax=-144;
}
function setPlayIco() { document.getElementById('play-ico').innerHTML = '<polygon points="5,3 19,12 5,21"/>'; }
function resetProg() { document.getElementById('seek-fill').style.width='0%'; document.getElementById('playbar').style.left='0%'; if(audioBuf) document.getElementById('ttime').textContent='0:00 / '+fmt2time(audioBuf.duration); setPlayIco(); }

// In-place updater: surface playback state on history rows without
// re-rendering the whole list. Re-rendering scrolls the user, recreates
// IntersectionObservers, and flashes lazy thumbs. This walks the existing
// .hist-row nodes and toggles .playing class + swaps the SVG icon on the
// one (if any) whose data-id matches the currently-playing track.
//
// Called from:
//   • startAudio()  → flip the row to "playing"
//   • stopAudio()   → flip the row back to "paused"
//   • when currentHistId changes (new track loaded into Analyzer)
//   • when globalPlayer.track changes (legacy mode)
//
// Idempotent and cheap — runs through ~500 rows in <1ms on the test machine.
const PLAY_SVG  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,5 7,19 19,12"/></svg>';
const PAUSE_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
function _refreshHistoryRowPlayState() {
  // Two separate signals: which track is LOADED (the row stays
  // highlighted while loaded, even when paused) and which is PLAYING
  // (the button icon switches between pause-bars and play-triangle).
  let activeId = null;
  if (analyzeMirrorActive && currentHistId) {
    activeId = currentHistId;
  } else if (globalPlayer && globalPlayer.track && globalPlayer.track.id) {
    activeId = globalPlayer.track.id;
  }
  const audioPlaying = (
    (globalPlayer && globalPlayer.audio && !globalPlayer.audio.paused) ||
    (analyzeMirrorActive && typeof playing !== 'undefined' && playing)
  );
  const rows = document.querySelectorAll('.hist-row');
  for (const row of rows) {
    const id = parseInt(row.dataset.id, 10);
    const btn = row.querySelector('.hist-play');
    if (!btn) continue;
    const shouldActive = (id === activeId);
    const shouldPlay = shouldActive && audioPlaying;
    if (shouldActive !== btn.classList.contains('active')) btn.classList.toggle('active', shouldActive);
    if (shouldPlay !== btn.classList.contains('playing')) {
      btn.classList.toggle('playing', shouldPlay);
      btn.innerHTML = shouldPlay ? PAUSE_SVG : PLAY_SVG;
    }
  }
}
// rafLoop draws the Analyzer's main playhead + time display while audio
// plays. Cached element refs + a "last seconds rendered" tracker mean we
// only touch textContent when the visible seconds actually change (about
// once per second), instead of every frame.
let _rafSeekFill = null, _rafPlaybar = null, _rafTtime = null;
let _rafLastSec = -1, _rafLastDur = -1;
function rafLoop() {
  if(!playing) return;
  if (!_rafSeekFill) _rafSeekFill = document.getElementById('seek-fill');
  if (!_rafPlaybar)  _rafPlaybar  = document.getElementById('playbar');
  if (!_rafTtime)    _rafTtime    = document.getElementById('ttime');
  const elapsed = (audioCtx.currentTime - startT) + pauseOff;
  const pct = Math.min(elapsed/audioBuf.duration,1)*100;
  if (_rafSeekFill) _rafSeekFill.style.width = pct+'%';
  if (_rafPlaybar)  _rafPlaybar.style.left   = pct+'%';
  // Time text only changes once per second — guard textContent writes by it.
  const sec = elapsed | 0;
  const dur = audioBuf.duration | 0;
  if (_rafTtime && (sec !== _rafLastSec || dur !== _rafLastDur)) {
    _rafTtime.textContent = fmt2time(elapsed)+' / '+fmt2time(audioBuf.duration);
    _rafLastSec = sec; _rafLastDur = dur;
  }
  rafId = requestAnimationFrame(rafLoop);
}
function seekWave(e) { seekEl(e, document.getElementById('wave-wrap')); }
function seekBar(e)  { seekEl(e, document.getElementById('seek-bar')); }
function seekEl(e, el) {
  if(!audioBuf) return;
  const r = el.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const newPos = pct * audioBuf.duration;

  if (playing) {
    // NULL onended FIRST — prevents old node firing after new node starts
    if (srcNode) { srcNode.onended = null; try { srcNode.stop(); } catch {} srcNode = null; }
    playing = false;
    cancelAnimationFrame(rafId);
    stopVU();
    pauseOff = newPos;
    startAudio();
  } else {
    pauseOff = newPos;
    document.getElementById('seek-fill').style.width = (pct*100)+'%';
    document.getElementById('playbar').style.left = (pct*100)+'%';
    document.getElementById('ttime').textContent = fmt2time(pauseOff)+' / '+fmt2time(audioBuf.duration);
  }
}
function setPitch(v) { pitchVal=parseInt(v); document.getElementById('pitch-lbl').textContent=v>0?'+'+v:v; if(srcNode)srcNode.playbackRate.value=Math.pow(2,pitchVal/12); updatePitchKey(pitchVal); }
function updatePitchKey(st) { if(!currentKey)return; const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']; const nk=N[((N.indexOf(currentKey)+st)%12+12)%12]; document.getElementById('pitch-key').textContent=nk+' '+(currentMode||'')+(st!==0?' (transposed)':''); }

async function detectBPM(buf) {
  const sr = buf.sampleRate, data = buf.getChannelData(0);
  // Analyze 15s segment starting at 5s (skip intro), fallback to start if short
  const startSec = data.length > sr * 20 ? 5 : 0;
  const durSec = 20;
  const s0 = Math.floor(startSec * sr);
  const s1 = Math.min(s0 + Math.floor(durSec * sr), data.length);
  const samples = data.slice(s0, s1);
  if (samples.length < sr * 3) return { bpm: 120, confidence: 0.3 };

  // Onset detection: spectral flux on windowed frames
  const fSize = 1024, hop = 256;
  const prev = new Float32Array(fSize / 2 + 1);
  const onsets = [];
  for (let i = 0; i + fSize < samples.length; i += hop) {
    // Apply Hann window + FFT (approximate via energy in sub-bands)
    let flux = 0;
    const mag = new Float32Array(fSize / 2 + 1);
    // Simple DFT magnitude estimation using 4 sub-bands
    for (let b = 0; b < fSize / 2 + 1; b++) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * b / fSize;
      // Downsample the DFT: only compute every 4th bin for speed
      if (b % 4 !== 0 && b < fSize / 2) continue;
      for (let n = 0; n < fSize; n++) {
        const win = 0.5 * (1 - Math.cos(2 * Math.PI * n / (fSize - 1)));
        re += samples[i + n] * win * Math.cos(w * n);
        im -= samples[i + n] * win * Math.sin(w * n);
      }
      mag[b] = Math.sqrt(re * re + im * im);
      flux += Math.max(0, mag[b] - prev[b]);
      prev[b] = mag[b];
    }
    onsets.push(flux);
  }

  if (onsets.length < 20) return { bpm: 120, confidence: 0.3 };
  const fps = sr / hop;

  // Adaptive threshold
  const onset = new Float32Array(onsets);
  const medW = Math.floor(fps * 0.5) | 1;
  for (let i = 0; i < onset.length; i++) {
    const lo = Math.max(0, i - Math.floor(medW / 2));
    const hi = Math.min(onset.length, i + Math.floor(medW / 2) + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += onsets[j];
    const local = sum / (hi - lo);
    onset[i] = Math.max(0, onsets[i] - local * 1.3);
  }

  // Normalize
  let mx = 0;
  for (let i = 0; i < onset.length; i++) if (onset[i] > mx) mx = onset[i];
  if (mx > 0) for (let i = 0; i < onset.length; i++) onset[i] /= mx;

  // Autocorrelation at 0.5 BPM steps
  let bestBpm = 120, bestSc = -1;
  for (let b2 = 120; b2 <= 400; b2++) { // 60.0 to 200.0 in 0.5 steps
    const b = b2 / 2;
    const period = fps * 60 / b;
    const pi = Math.floor(period);
    if (pi + 1 >= onset.length) continue;
    const frac = period - pi;
    let sc = 0;
    const nAc = onset.length - pi - 1;
    for (let i = 0; i < nAc; i++) {
      sc += onset[i] * (onset[pi + i] * (1 - frac) + onset[pi + i + 1] * frac);
    }
    if (sc > bestSc) { bestSc = sc; bestBpm = b; }
  }

  // Octave check: test half and double, bias toward 70-160 range
  for (const cand of [bestBpm * 2, bestBpm / 2]) {
    if (cand < 55 || cand > 210) continue;
    const period = fps * 60 / cand;
    const pi = Math.floor(period);
    if (pi + 1 >= onset.length) continue;
    const frac = period - pi;
    let sc = 0;
    const nAc = onset.length - pi - 1;
    for (let i = 0; i < nAc; i++) {
      sc += onset[i] * (onset[pi + i] * (1 - frac) + onset[pi + i + 1] * frac);
    }
    const rangeBonus = (cand >= 70 && cand <= 160) ? 1.05 : 0.95;
    if (sc * rangeBonus > bestSc) { bestSc = sc; bestBpm = cand; }
  }

  return { bpm: Math.round(bestBpm * 10) / 10, confidence: 0.75 };
}

function detectKey(buf) {
  const sr = buf.sampleRate, data = buf.getChannelData(0);
  const len = Math.min(data.length, sr * 30);
  const fftSize = 8192, hop = 4096;
  const chroma = new Float64Array(12);
  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // Proper FFT-based chroma extraction with Hann windowing
  const hann = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
  const binHz = sr / fftSize;
  const loIdx = Math.max(1, Math.floor(60 / binHz));
  const hiIdx = Math.min(fftSize / 2 - 1, Math.ceil(2000 / binHz));
  let frameCount = 0;

  for (let pos = 0; pos + fftSize <= len; pos += hop) {
    const frame = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) frame[i] = data[pos + i] * hann[i];

    // Compute DFT for bins in 60-2000Hz range
    for (let k = loIdx; k <= hiIdx; k++) {
      const freq = k * binHz;
      if (freq < 60 || freq > 2000) continue;
      let re = 0, im = 0;
      const w = 2 * Math.PI * k / fftSize;
      for (let n = 0; n < fftSize; n++) {
        re += frame[n] * Math.cos(w * n);
        im -= frame[n] * Math.sin(w * n);
      }
      const mag = Math.sqrt(re * re + im * im) / fftSize;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag * mag;
    }
    frameCount++;
  }

  if (frameCount === 0) return { key: 'C', mode: 'major', confidence: 0.1 };

  // Normalize
  const norm = a => { const s = a.reduce((x, y) => x + y, 1e-12); return a.map(v => v / s); };
  const cn = norm(Array.from(chroma));

  // Multi-profile Pearson correlation (matches Python engine)
  const profiles = [
    { maj: [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
      min: [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17], w: 1.0 }, // KK
    { maj: [0.2410,0,0.1473,0,0.1708,0,0,0.2228,0,0.1303,0,0.1551],
      min: [0.2362,0,0.1336,0.1737,0,0.1569,0,0.2245,0,0,0,0.1619], w: 1.8 }, // BGATE
    { maj: [0.2257,0.0015,0.1419,0.0045,0.1599,0.0789,0.0026,0.2104,0.0030,0.1139,0.0027,0.1489],
      min: [0.2222,0.0025,0.1245,0.1624,0.0012,0.1477,0.0021,0.2152,0.0813,0.0031,0.0854,0.1522], w: 1.5 }, // EDMA
  ];

  function pearson(a, b) {
    const n = a.length;
    let sumA = 0, sumB = 0;
    for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
    const mA = sumA / n, mB = sumB / n;
    let num = 0, dA = 0, dB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - mA, db = b[i] - mB;
      num += da * db; dA += da * da; dB += db * db;
    }
    const d = Math.sqrt(dA) * Math.sqrt(dB);
    return d > 1e-10 ? num / d : 0;
  }

  const scores = {};
  let totalW = 0;
  for (const prof of profiles) totalW += prof.w * 2;

  for (const prof of profiles) {
    for (const [p, mode] of [[prof.maj, 'major'], [prof.min, 'minor']]) {
      const pn = norm(p);
      for (let r = 0; r < 12; r++) {
        const rotated = norm([...pn.slice(12 - r), ...pn.slice(0, 12 - r)]);
        const k = NOTES[r] + ' ' + mode;
        scores[k] = (scores[k] || 0) + pearson(cn, rotated) * prof.w / totalW;
      }
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestKey, bestMode] = sorted[0][0].split(' ');
  const gap = sorted[0][1] - (sorted[1] ? sorted[1][1] : 0);
  const range = sorted[0][1] - sorted[sorted.length - 1][1];
  const conf = Math.min(0.95, Math.max(0.15, gap / (range + 1e-10)));

  const candidates = sorted.slice(0, 3).map(([k, s]) => {
    const [key, mode] = k.split(' ');
    const CAM = {'C major':'8B','G major':'9B','D major':'10B','A major':'11B','E major':'12B','B major':'1B','F# major':'2B','C# major':'3B','G# major':'4B','D# major':'5B','A# major':'6B','F major':'7B','A minor':'8A','E minor':'9A','B minor':'10A','F# minor':'11A','C# minor':'12A','G# minor':'1A','D# minor':'2A','A# minor':'3A','F minor':'4A','C minor':'5A','G minor':'6A','D minor':'7A'};
    return { key, mode, score: Math.round(s * 1000) / 1000, camelot: CAM[k] || '?' };
  });

  return { key: bestKey, mode: bestMode, confidence: conf, candidates };
}
function renderChords(key,mode) {
  const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],root=N.indexOf(key);
  const majD=[0,2,4,5,7,9,11],minD=[0,2,3,5,7,8,10],majQ=[1,0,0,1,1,0,0],minQ=[0,0,1,0,0,1,1];
  const degs=mode==='major'?majD:minD,qs=mode==='major'?majQ:minQ;
  const progs=mode==='major'?[[0,3,4,0,'I–IV–V–I'],[0,5,3,4,'I–vi–IV–V'],[0,4,5,3,'I–V–vi–IV']]:[[0,3,4,0,'i–iv–v–i'],[0,6,2,4,'i–VII–III–v'],[0,5,6,3,'i–VI–VII–iv']];
  document.getElementById('chord-list').innerHTML=progs.map(([a,b,c,d,lbl])=>`<div class="chord-row">${[a,b,c,d].map(i=>`<span class="chord-pill">${N[(root+degs[i])%12]}${qs[i]?'':'m'}</span>`).join('')}<span class="chord-role">${lbl}</span></div>`).join('');
}
const CAM={'C major':'8B','G major':'9B','D major':'10B','A major':'11B','E major':'12B','B major':'1B','F# major':'2B','C# major':'3B','G# major':'4B','D# major':'5B','A# major':'6B','F major':'7B','A minor':'8A','E minor':'9A','B minor':'10A','F# minor':'11A','C# minor':'12A','G# minor':'1A','D# minor':'2A','A# minor':'3A','F minor':'4A','C minor':'5A','G minor':'6A','D minor':'7A'};
function renderCamelot(key,mode) {
  const self=CAM[key+' '+mode];if(!self){document.getElementById('cam-grid').innerHTML='<div style="font-size:12px;color:var(--hint)">—</div>';return;}
  const n=parseInt(self),l=self.slice(-1),compat=new Set([self,((n-2+12)%12+1)+l,(n%12+1)+l,n+(l==='A'?'B':'A')]);
  document.getElementById('cam-grid').innerHTML=Object.entries(CAM).map(([name,code])=>`<div class="cam-key ${code===self?'self':compat.has(code)?'match':''}" title="${name}">${code}<span>${name.split(' ')[0]}</span></div>`).join('');
}
function scheduleNoteSave() {
  clearTimeout(noteTimer);document.getElementById('notes-saved').textContent='Saving…';
  noteTimer=setTimeout(async()=>{if(!currentHistId){document.getElementById('notes-saved').textContent='';return;}await fetch(API+'/history/'+currentHistId+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:document.getElementById('notes-box').value})});document.getElementById('notes-saved').textContent='Saved ✓';},1200);
}
function startTranscribe(e){if(e.target.files[0])startTranscribeFile(e.target.files[0]);}
async function startTranscribeFile(file){
  trSt('Transcribing… this may take a minute','spin');document.getElementById('trans-card').classList.remove('hidden');document.getElementById('transcript-out').value='';
  const fd=new FormData();fd.append('audio',file);fd.append('model',document.getElementById('wmodel').value);fd.append('language',document.getElementById('wlang').value);
  try{const r=await fetch(API+'/transcribe',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.hint?'\n\n'+d.hint:''));document.getElementById('transcript-out').value=d.transcript;trSt('Transcription complete','ok');if(currentHistId)fetch(API+'/history/'+currentHistId+'/transcript',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transcript:d.transcript})});}
  catch(e){trSt('Error: '+e.message,'err');}
}
function copyTranscript(){navigator.clipboard.writeText(document.getElementById('transcript-out').value);}
function saveTranscript(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([document.getElementById('transcript-out').value],{type:'text/plain'}));a.download='transcript.txt';a.click();}

async function loadHistory(){try{histData=await(await fetch(API+'/history')).json();}catch{histData=[];}renderHistory();}

// ── Live server events ──────────────────────────────────────────────────
// Subscribe once to the backend's /events SSE channel. When the server
// broadcasts 'history-changed' (a download finished here, in another
// window, or in the Chrome extension) we refresh the history list. The
// renderHistory() pulse logic then flashes any newly-arrived rows green.
//
// Auto-reconnects: EventSource retries on its own if the connection
// drops, but we also guard against double-subscription with the flag.
let _eventsSubscribed = false;
function subscribeToServerEvents() {
  if (_eventsSubscribed) return;
  _eventsSubscribed = true;
  try {
    const es = new EventSource(API + '/events');
    es.addEventListener('history-changed', async () => {
      // Refresh the in-memory history then re-render. We only repaint if
      // the History tab exists in the DOM; renderHistory itself is cheap
      // and the pulse only shows for genuinely new ids, so this is safe
      // to call even when the user is on another tab.
      try {
        histData = await (await fetch(API + '/history')).json();
      } catch { return; }
      renderHistory();
    });

    // Background analysis worker (0.2.2) — surface its state in a small
    // pill near the History header so users see "Analyzing 5 tracks…"
    // happening live as bulk downloads catch up. The pill auto-hides
    // when the worker goes idle.
    es.addEventListener('bg-analyze', e => {
      try {
        const d = JSON.parse(e.data);
        renderBgAnalyzePill(d);
      } catch {}
    });
    es.onerror = () => {
      // EventSource reconnects automatically; nothing to do. We don't
      // flip _eventsSubscribed back because the same es object retries.
    };
  } catch (e) {
    // SSE unavailable — fall back to no live updates. Not fatal; the
    // user can still refresh manually by revisiting the tab.
    _eventsSubscribed = false;
  }
}

let selectMode = false;
let selectedIds = new Set();
let stockpileFolder = localStorage.getItem('fp_stockpile') || '';

// Init stockpile display
(function initStockpile(){
  const el = document.getElementById('stockpile-path');
  if (el) el.textContent = stockpileFolder || 'Not set — click to choose';
})();

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedIds.clear();
  const btn = document.getElementById('hist-select-btn');
  const lbl = document.getElementById('hist-select-lbl');
  const batch = document.getElementById('hist-batch');
  const stockRow = document.getElementById('hist-stockpile-row');
  if (selectMode) {
    // Update only the text label — leave the SVG icon intact. Using
    // btn.textContent would nuke the inline <svg>.
    if (lbl) lbl.textContent = 'Cancel';
    btn.classList.add('pri');
    batch.classList.remove('hidden');
    if (stockRow) stockRow.classList.remove('hidden');
  } else {
    if (lbl) lbl.textContent = 'Select';
    btn.classList.remove('pri');
    batch.classList.add('hidden');
    if (stockRow) stockRow.classList.add('hidden');
    // Also hide move progress when leaving select mode
    const prog = document.getElementById('move-progress');
    if (prog) prog.classList.add('hidden');
  }
  updateBatchActions();
  renderHistory();
}

function toggleCheckAll(checked) {
  const q = (document.getElementById('hist-search')?.value || '').toLowerCase();
  const rows = histData.filter(h => !q || (h.title || '').toLowerCase().includes(q) || (h.channel || '').toLowerCase().includes(q));
  if (checked) {
    rows.forEach(h => selectedIds.add(h.id));
  } else {
    selectedIds.clear();
  }
  renderHistory();
  updateSelCount();
  updateBatchActions();
}

function toggleRowSelect(id, e) {
  if (e) e.stopPropagation();
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  updateSelCount();
  updateBatchActions();
  // Update visual
  const row = document.querySelector(`.hist-row[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', selectedIds.has(id));
  const cb = row?.querySelector('.hist-check');
  if (cb) cb.checked = selectedIds.has(id);
}

function updateSelCount() {
  const el = document.getElementById('hist-sel-count');
  if (el) el.textContent = selectedIds.size + ' selected';
}

function updateBatchActions() {
  const moveActions = document.getElementById('batch-move-actions');
  if (moveActions) {
    if (selectedIds.size > 0) moveActions.classList.remove('hidden');
    else moveActions.classList.add('hidden');
  }
}

async function pickStockpileFolder() {
  const folder = await api.pickFolder();
  if (folder) {
    stockpileFolder = folder;
    localStorage.setItem('fp_stockpile', folder);
    const el = document.getElementById('stockpile-path');
    if (el) el.textContent = folder;
    syncPrefsToServer();
  }
}

// Push the prefs the SERVER needs to know about (watch-folder daemon,
// auto-send for extension downloads). Fire-and-forget; server restarts
// its watcher on every prefs POST.
function syncPrefsToServer() {
  try {
    fetch(API + '/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stockpile_root: stockpileFolder || '',
        auto_send: localStorage.getItem('freqphull.autoSend') === '1' ? '1' : '0',
        watch_folder: localStorage.getItem('freqphull.watchFolder') === '1' ? '1' : '0',
        // '1' or '0'; absent in localStorage means ON (default)
        auto_tag: autoTagEnabled() ? '1' : '0',
      }),
    }).catch(() => {});
  } catch {}
}

function toggleWatchFolder(checked) {
  localStorage.setItem('freqphull.watchFolder', checked ? '1' : '0');
  syncPrefsToServer();
  showAppNotification(checked ? t('watchOnNotif') : t('watchOffNotif'), 'info', null, 3000);
}

// yt-dlp self-update — settings row actions
async function refreshYtdlpStatus() {
  const el = document.getElementById('ytdlp-status-desc');
  if (!el) return;
  try {
    const j = await fetch(API + '/ytdlp/status').then(r => r.json());
    const inst = j.installed || '?';
    const latest = j.latest;
    if (latest && inst !== latest) el.textContent = 'v' + inst + ' → v' + latest + ' ' + t('ytdlpAvail');
    else if (latest) el.textContent = 'v' + inst + ' — ' + t('ytdlpUpToDate');
    else el.textContent = 'v' + inst;
  } catch { el.textContent = t('backendOffline'); }
}

async function manualUpdateYtdlp() {
  const btn = document.getElementById('btn-ytdlp-update');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('checkingBtn'); }
  try {
    const j = await fetch(API + '/ytdlp/update', { method: 'POST' }).then(r => r.json());
    if (j.lastResult === 'updated') showAppNotification('✓ yt-dlp → v' + j.installed, 'done');
    else if (j.lastResult === 'up-to-date') showAppNotification('✓ ' + t('ytdlpUpToDate'), 'info');
    else if (j.lastResult === 'system-install') showAppNotification(t('ytdlpSystem'), 'warn');
    else showAppNotification('yt-dlp: ' + (j.lastResult || '?'), 'warn');
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ ' + t('btnCheckNow'); }
    refreshYtdlpStatus();
  }
}

async function bulkMoveSelected(mode) {
  if (!selectedIds.size) return;
  let destDir = '';
  if (mode === 'stockpile') {
    if (!stockpileFolder) {
      await pickStockpileFolder();
      if (!stockpileFolder) return;
    }
    destDir = stockpileFolder;
  } else {
    destDir = await api.pickFolder();
    if (!destDir) return;
  }

  // ── Filter out tracks that are already in the destination ──────────
  // If a user does "Select All" and then "Send to Stockpile," we should
  // ONLY move items that aren't already in stockpile. Previously every
  // selected track was sent, including ones whose file path was already
  // inside the stockpile folder — those silently no-op'd on the backend
  // and the user saw "X/X moved" without knowing some weren't really
  // sent. Cleaner UX: detect those locally first so the count and
  // progress reflect actual work being done.
  //
  // Path comparison is case-insensitive (Windows is case-insensitive
  // and the same file can show up with either casing in history rows).
  const normalize = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
  const destNorm = normalize(destDir).replace(/\/$/, '');
  const allIds = Array.from(selectedIds);
  const idsToMove = [];
  const alreadyThere = [];
  for (const id of allIds) {
    const track = histData.find(h => h.id === id);
    if (!track || !track.file_path) {
      // No file path on this track — can't move it. Include it anyway
      // so the backend returns a clear error.
      idsToMove.push(id);
      continue;
    }
    const filePathNorm = normalize(track.file_path);
    if (filePathNorm.startsWith(destNorm + '/') || filePathNorm === destNorm) {
      alreadyThere.push({ id, title: track.title || 'Track #' + id });
    } else {
      idsToMove.push(id);
    }
  }

  // If everything was already at destination, tell the user and stop —
  // no need to show a progress bar that does nothing.
  if (idsToMove.length === 0) {
    showAppNotification(
      alreadyThere.length === 1
        ? 'Already in stockpile — nothing to move'
        : 'All ' + alreadyThere.length + ' selected tracks are already in stockpile',
      'info'
    );
    return;
  }

  const total = idsToMove.length;
  const folderName = destDir.split(/[/\\]/).pop();

  // Show progress bar, disable buttons
  const prog = document.getElementById('move-progress');
  const fill = document.getElementById('move-fill');
  const status = document.getElementById('move-status');
  const count = document.getElementById('move-count');
  const current = document.getElementById('move-current');
  const btnStock = document.getElementById('btn-stockpile');
  const btnMove = document.getElementById('btn-moveto');

  prog.classList.remove('hidden');
  fill.style.width = '0%';
  // Mention skipped count up front so the user understands why total
  // might be lower than the visible selection count
  const skippedHint = alreadyThere.length
    ? ' (' + alreadyThere.length + ' already there, skipped)'
    : '';
  status.textContent = 'Moving to ' + folderName + skippedHint + '…';
  count.textContent = '0/' + total;
  current.textContent = '';
  if (btnStock) btnStock.disabled = true;
  if (btnMove) btnMove.disabled = true;

  let moved = 0;
  let alreadyAtDest = 0;   // backend reported already_at_destination
  let errors = [];
  let movedIds = [];       // for post-move success styling / refresh

  for (let i = 0; i < idsToMove.length; i++) {
    const id = idsToMove[i];
    // Find the track title for display
    const track = histData.find(h => h.id === id);
    const title = track?.title || 'Track #' + id;
    current.textContent = title;
    count.textContent = (i + 1) + '/' + total;

    try {
      const r = await fetch(API + '/history/' + id + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest_dir: destDir })
      });
      const d = await r.json();
      if (d.ok) {
        // Backend now returns status='moved' or 'already_at_destination'
        // so we count them separately. Pre-15n backends just returned
        // {ok:true} without status — treat those as moved for compat.
        if (d.status === 'already_at_destination') {
          alreadyAtDest++;
        } else {
          moved++;
          movedIds.push(id);
          // Update local file_path so subsequent operations + the UI
          // both reflect the new location immediately
          if (track && d.newPath) track.file_path = d.newPath;
        }
      } else {
        errors.push(title + ': ' + (d.error || 'failed'));
      }
    } catch (e) {
      errors.push(title + ': ' + e.message);
    }

    // Update progress bar
    const pct = Math.round(((i + 1) / total) * 100);
    fill.style.width = pct + '%';
  }

  // Done — honest summary of what actually happened
  fill.style.width = '100%';
  // Build the status line. We want it to reflect REALITY: what was
  // actually moved vs what was skipped or already there or errored.
  const totalSkipped = alreadyThere.length + alreadyAtDest;
  let summary = moved + '/' + total + ' moved to ' + folderName;
  if (totalSkipped) summary += ' · ' + totalSkipped + ' already there';
  if (errors.length) summary += ' · ' + errors.length + ' failed';
  status.textContent = summary;
  current.textContent = errors.length ? errors.length + ' error(s)' : '✓ Complete';
  count.textContent = '';

  if (errors.length) {
    showAppNotification('✕ ' + errors.length + ' file(s) could not be moved', 'err');
  } else if (moved > 0) {
    // Honest success toast — distinguishes "all done" from "some already
    // there." Old version only showed errors, so the user got NO feedback
    // when moves succeeded — they'd just see the progress bar disappear.
    const skipNote = totalSkipped ? ' · ' + totalSkipped + ' already there' : '';
    showAppNotification('✓ ' + moved + ' moved to ' + folderName + skipNote, 'ok');
  } else if (totalSkipped > 0) {
    // Nothing moved because everything was already at destination
    showAppNotification('All selected tracks were already in ' + folderName, 'info');
  }

  // Re-enable buttons, clear selection, refresh
  if (btnStock) btnStock.disabled = false;
  if (btnMove) btnMove.disabled = false;
  selectedIds.clear();
  updateSelCount();
  await loadHistory();

  // Hide progress after a moment
  setTimeout(() => {
    prog.classList.add('hidden');
    fill.style.width = '0%';
  }, 3000);
}

// ── Bulk operations on selected history rows ────────────────────────────
// Each bulk handler walks selectedIds and dispatches one request per item
// rather than building a single batch endpoint. Reasoning: the per-item
// endpoints already handle every edge case (file-not-found, primary-tag
// promotion, on-disk move on commit), and a batch endpoint would have to
// re-implement all of that. The cost is N HTTP requests instead of 1, but
// for typical selections (10-50 tracks) the total wall time is under a
// second and we get the right behavior for free.
//
// All handlers do the same dance: snapshot selectedIds, show progress,
// run sequentially (so we can show "x of y" without races), reload the
// affected views at the end, exit select mode.

// Batch action: queue every selected track for stem separation. Tracks
// without a file on disk are skipped with a count in the toast.
function bulkSendToSeparator() {
  if (!selectedIds.size) return;
  let added = 0, skipped = 0;
  for (const id of selectedIds) {
    const h = histData.find(x => x.id === id);
    if (h && h.file_path) { if (enqueueSeparation(h.file_path, h.title)) added++; else skipped++; }
    else skipped++;
  }
  showAppNotification('🎛 ' + t('sepqAdded').replace('{n}', added) + (skipped ? ' · ' + skipped + ' ' + t('sepqSkipped') : ''), 'done');
  toggleSelectMode();
  showTab(document.querySelector('[data-tab="stems"]'));
}

async function bulkTagSelected() {
  if (!selectedIds.size) return;
  // Need a folder to tag into. Prompt with the existing folder list.
  let folders;
  try {
    const r = await fetch(API + '/stockpile/folders');
    const j = await r.json();
    folders = j.folders || [];
  } catch (e) {
    showAppNotification('Failed to load folders: ' + e.message, 'err');
    return;
  }
  if (!folders.length) {
    showAppNotification('Create a Stockpile folder first', 'warn');
    return;
  }
  // Modal to pick a folder. Built ad-hoc since this is a rare path.
  const pickedFolderId = await new Promise(resolve => {
    let modal = document.getElementById('bulk-tag-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bulk-tag-modal';
      modal.className = 'setup-modal';
      modal.style.display = 'none';
      document.body.appendChild(modal);
    }
    const optsHTML = folders.map(f => `
      <button class="btn" style="width:100%;justify-content:flex-start;margin-bottom:6px;text-align:left"
              onclick="window._bulkTagResolve(${f.id})">
        <span class="sp-fc-color" ${f.color ? `style="background:${escapeHtml(f.color)};display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px"` : 'style="display:none"'}></span>
        ${escapeHtml(f.name)} <span style="opacity:.6;font-size:11px;margin-left:auto">${f.track_count || 0} tracks</span>
      </button>`).join('');
    modal.innerHTML = `
      <div class="setup-card" style="max-width:480px;max-height:80vh;display:flex;flex-direction:column;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div>
            <div class="setup-title" style="font-size:22px;text-align:left;margin-bottom:2px">🏷️ Tag ${selectedIds.size} track${selectedIds.size === 1 ? '' : 's'}</div>
            <div style="font-size:12px;color:var(--muted)">Pick a folder — selected tracks will be tagged into it</div>
          </div>
          <button class="btn xs" onclick="window._bulkTagResolve(null)">✕</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding-right:4px">
          ${optsHTML}
        </div>
      </div>`;
    modal.style.display = 'flex';
    window._bulkTagResolve = (id) => {
      modal.style.display = 'none';
      delete window._bulkTagResolve;
      resolve(id);
    };
  });
  if (!pickedFolderId) return;

  const ids = Array.from(selectedIds);
  let ok = 0, fail = 0;
  const prog = document.getElementById('move-progress');
  const fill = document.getElementById('move-fill');
  const status = document.getElementById('move-status');
  const count = document.getElementById('move-count');
  if (prog) prog.classList.remove('hidden');
  if (status) status.textContent = 'Tagging…';

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const r = await fetch(API + '/stockpile/tracks/' + id + '/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: pickedFolderId,
          source: 'bulk-manual',
          stockpile_root: stockpileFolder || undefined,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ok++;
    } catch {
      fail++;
    }
    if (fill) fill.style.width = Math.round(((i + 1) / ids.length) * 100) + '%';
    if (count) count.textContent = (i + 1) + '/' + ids.length;
  }

  showAppNotification(`✓ ${t('aoTaggedOk')} ${ok}${fail ? ' · ' + fail + ' ' + t('failedWord') : ''}`, fail ? 'warn' : 'done');
  setTimeout(() => { if (prog) prog.classList.add('hidden'); if (fill) fill.style.width = '0%'; }, 1500);
  // Refresh views and exit select mode
  selectedIds.clear();
  if (typeof loadHistory === 'function') await loadHistory();
  if (typeof window.histTagsByHistoryId !== 'undefined') window.histTagsByHistoryId = {};
  toggleSelectMode();
}

async function bulkFavoriteSelected(makeFav) {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      const cur = histData.find(h => h.id === id);
      const alreadyMatches = cur && !!cur.is_favorite === !!makeFav;
      if (alreadyMatches) { ok++; continue; }
      // /history/:id/favorite toggles. To force a desired state we only
      // hit it when current state differs.
      const r = await fetch(API + '/history/' + id + '/favorite', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ok++;
    } catch {
      fail++;
    }
  }
  showAppNotification(
    `✓ ${makeFav ? 'Favorited' : 'Unfavorited'} ${ok}${fail ? ' · ' + fail + ' failed' : ''}`,
    fail ? 'warn' : 'done'
  );
  selectedIds.clear();
  await loadHistory();
  toggleSelectMode();
}

async function bulkDeleteSelected() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  const ok = await confirmModal({
    title: `Delete ${n} track${n === 1 ? '' : 's'} from history?`,
    message: `This removes ${n === 1 ? 'the entry' : 'these entries'} from your history list. The actual audio file${n === 1 ? '' : 's'} on disk ${n === 1 ? 'is' : 'are'} NOT deleted — only the history record. To delete files on disk, use your file manager.`,
    okLabel: 'Delete',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;

  const ids = Array.from(selectedIds);
  let okN = 0, fail = 0;
  for (const id of ids) {
    try {
      const r = await fetch(API + '/history/' + id, { method: 'DELETE' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      okN++;
    } catch {
      fail++;
    }
  }
  showAppNotification(`✓ Deleted ${okN} from history${fail ? ' · ' + fail + ' failed' : ''}`, fail ? 'warn' : 'done');
  selectedIds.clear();
  await loadHistory();
  toggleSelectMode();
}

async function bulkReanalyzeSelected() {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  const ok = await confirmModal({
    title: `Re-analyze ${ids.length} track${ids.length === 1 ? '' : 's'}?`,
    message: 'Runs BPM/key/loudness analysis on each track. May take 5-15 seconds per track depending on length. Existing analysis values will be overwritten with the new results.',
    okLabel: 'Re-analyze',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;

  let done = 0, fail = 0;
  const prog = document.getElementById('move-progress');
  const fill = document.getElementById('move-fill');
  const status = document.getElementById('move-status');
  const count = document.getElementById('move-count');
  const curEl = document.getElementById('move-current');
  if (prog) prog.classList.remove('hidden');
  if (status) status.textContent = 'Analyzing…';

  // Sequential — analyze.py uses CPU and parallelizing would just thrash.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const track = histData.find(h => h.id === id);
    if (!track || !track.file_path) { fail++; continue; }
    if (curEl) curEl.textContent = track.title || '(untitled)';

    try {
      // /analyze is SSE — we just need the final "done" event with bpm/key
      const result = await new Promise((resolve, reject) => {
        const es = new EventSource(API + '/analyze?path=' + encodeURIComponent(track.file_path));
        let final = null;
        es.addEventListener('result', e => { try { final = JSON.parse(e.data); } catch {} });
        es.addEventListener('done', () => { es.close(); resolve(final); });
        es.addEventListener('error', e => { es.close(); reject(new Error('SSE error')); });
        // Hard timeout — 60s per track is generous
        setTimeout(() => { try { es.close(); } catch {}; reject(new Error('timeout')); }, 60000);
      });

      if (result && (result.bpm || result.key_note)) {
        // Save back to history (this triggers ID3 tag write too if enabled)
        const notagsParam = (localStorage.getItem('freqphull.writeTags') === '0') ? '?notags=1' : '';
        await fetch(API + '/history/' + id + '/analysis' + notagsParam, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bpm: result.bpm || null,
            key_note: result.key_note || null,
            key_mode: result.key_mode || null,
          }),
        });
        done++;
      } else {
        fail++;
      }
    } catch {
      fail++;
    }
    if (fill) fill.style.width = Math.round(((i + 1) / ids.length) * 100) + '%';
    if (count) count.textContent = (i + 1) + '/' + ids.length;
  }

  showAppNotification(`✓ Re-analyzed ${done}${fail ? ' · ' + fail + ' failed' : ''}`, fail ? 'warn' : 'done');
  setTimeout(() => { if (prog) prog.classList.add('hidden'); if (fill) fill.style.width = '0%'; if (curEl) curEl.textContent = ''; }, 1500);
  selectedIds.clear();
  await loadHistory();
  toggleSelectMode();
}

// ── Auto-organize untagged tracks ───────────────────────────────────────
// Calls the backend's /stockpile/auto-organize-suggestions endpoint to
// get a folder suggestion per untagged track, then shows a modal where
// the user can confirm/reject each suggestion before applying.
//
// Design choice: rather than auto-applying suggestions silently (which
// would feel magic-but-scary), we always require explicit confirmation.
// Users keep control; they accept the high-confidence ones with one
// click and reject the bad ones.
async function openAutoOrganize() {
  if (!backendOnline) {
    showAppNotification('Backend offline', 'err');
    return;
  }
  // Show loading modal
  let modal = document.getElementById('auto-organize-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'auto-organize-modal';
    modal.className = 'setup-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="setup-card" style="max-width:720px;max-height:80vh;display:flex;flex-direction:column;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="setup-title" style="font-size:22px;text-align:left;margin-bottom:2px">✨ ${t('aoTitle')}</div>
          <div style="font-size:12px;color:var(--muted)">${t('aoScanningSub')}</div>
        </div>
        <button class="btn xs" onclick="closeAutoOrganize()">✕</button>
      </div>
      <div id="auto-organize-body" style="flex:1;overflow-y:auto;padding-right:4px;text-align:center;padding-top:40px;color:var(--hint)">
        ${t('aoLooking')}
      </div>
    </div>`;
  modal.style.display = 'flex';

  try {
    const r = await fetch(API + '/stockpile/auto-organize-suggestions?min_confidence=0.35&limit=1000');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderAutoOrganize(data);
  } catch (e) {
    const body = document.getElementById('auto-organize-body');
    if (body) body.innerHTML = `<div style="color:var(--err);padding:24px">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

function closeAutoOrganize() {
  const modal = document.getElementById('auto-organize-modal');
  if (modal) modal.style.display = 'none';
}

function renderAutoOrganize(data) {
  const body = document.getElementById('auto-organize-body');
  if (!body) return;
  const suggestions = data.suggestions || [];

  if (data.folders_count === 0) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--hint)">' + t('aoNoFolders') + '</div>';
    return;
  }
  if (data.untagged_count === 0) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--hint)">' + t('aoNoUntagged') + '</div>';
    return;
  }
  if (!suggestions.length) {
    body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--hint)">${t('aoNoneMatched').replace('{n}', data.untagged_count)}</div>`;
    return;
  }

  const rowsHTML = suggestions.map((s, i) => {
    const confPct = Math.round(s.confidence * 100);
    const confColor = confPct >= 70 ? '#7ed982' : (confPct >= 50 ? '#f59e0b' : '#999');
    const meta = [
      s.bpm ? `${Math.round(s.bpm)} BPM` : '',
      s.key_note ? `${s.key_note} ${s.key_mode || ''}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="auto-org-row" data-i="${i}" style="display:grid;grid-template-columns:1fr auto auto;gap:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;align-items:center">
        <div style="min-width:0">
          <div style="font-size:13px;color:var(--white);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.title || '(untitled)')}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${meta} ${s.reason ? '· ' + escapeHtml(s.reason) : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--white)">
          <span style="opacity:.6">→</span>
          <span class="sp-fc-color" ${s.suggested_folder_color ? `style="background:${escapeHtml(s.suggested_folder_color)};display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0"` : 'style="display:none"'}></span>
          ${escapeHtml(s.suggested_folder_name)}
          <span style="color:${confColor};font-size:11px;margin-left:4px">${confPct}%</span>
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="auto-org-cb-${i}" checked style="cursor:pointer"/>
          <span style="font-size:11px;color:var(--hint)">Apply</span>
        </label>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div style="margin-bottom:12px;padding:10px 12px;background:var(--bg);border-radius:6px;border:1px solid var(--border);font-size:12px;color:var(--muted)">
      ${t('aoFound').replace('{x}', suggestions.length).replace('{y}', data.untagged_count)}
    </div>
    <div style="margin-bottom:10px;display:flex;gap:8px">
      <button class="btn xs" onclick="autoOrganizeCheckAll(true)">${t('aoSelectAll')}</button>
      <button class="btn xs" onclick="autoOrganizeCheckAll(false)">${t('aoClearSel')}</button>
      <button class="btn xs" onclick="autoOrganizeCheckByConfidence(0.70)">${t('aoConf70')}</button>
      <button class="btn pri sm" style="margin-left:auto" onclick="applyAutoOrganize()">${t('aoApply')}</button>
    </div>
    ${rowsHTML}`;
  // Cache the suggestions so the apply step can read them by index
  window._autoOrgSuggestions = suggestions;
}

function autoOrganizeCheckAll(state) {
  (window._autoOrgSuggestions || []).forEach((_, i) => {
    const cb = document.getElementById('auto-org-cb-' + i);
    if (cb) cb.checked = state;
  });
}

function autoOrganizeCheckByConfidence(threshold) {
  (window._autoOrgSuggestions || []).forEach((s, i) => {
    const cb = document.getElementById('auto-org-cb-' + i);
    if (cb) cb.checked = s.confidence >= threshold;
  });
}

async function applyAutoOrganize() {
  const suggestions = window._autoOrgSuggestions || [];
  const picked = suggestions
    .map((s, i) => ({ s, i, on: document.getElementById('auto-org-cb-' + i)?.checked }))
    .filter(x => x.on);
  if (!picked.length) {
    showAppNotification(t('aoNothing'), 'warn');
    return;
  }

  let ok = 0, fail = 0;
  // Show a small progress overlay inside the modal
  const body = document.getElementById('auto-organize-body');
  if (body) body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--hint)" id="auto-org-prog">${t('aoApplying')} 0/${picked.length}…</div>`;

  for (let i = 0; i < picked.length; i++) {
    const { s } = picked[i];
    try {
      const r = await fetch(API + '/stockpile/tracks/' + s.history_id + '/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: s.suggested_folder_id,
          source: 'auto-organize',
          confidence: s.confidence,
          stockpile_root: stockpileFolder || undefined,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ok++;
    } catch {
      fail++;
    }
    const prog = document.getElementById('auto-org-prog');
    if (prog) prog.textContent = `${t('aoApplying')} ${i + 1}/${picked.length}…`;
  }

  showAppNotification(`✓ ${t('aoTaggedOk')} ${ok}${fail ? ' · ' + fail + ' ' + t('failedWord') : ''}`, fail ? 'warn' : 'done');
  closeAutoOrganize();
  // Refresh stockpile + history views
  if (typeof loadFolders === 'function') await loadFolders();
  if (typeof loadHistory === 'function') await loadHistory();
  if (typeof renderStockpileUntagged === 'function') renderStockpileUntagged();
}

// ── Duplicate finder ────────────────────────────────────────────────────
// Opens a modal that fetches /history/duplicates and presents groups of
// near-identical tracks. The user can preview each, see which is oldest
// (the "original"), and bulk-delete the rest with one click per group.
//
// If many tracks lack fingerprints (existing library predating this
// feature), shows a "Backfill" button that kicks off background hashing.
async function openDuplicateFinder() {
  if (!backendOnline) {
    showAppNotification('Backend offline', 'err');
    return;
  }
  let modal = document.getElementById('duplicate-finder-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'duplicate-finder-modal';
    modal.className = 'setup-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="setup-card" style="max-width:760px;max-height:84vh;display:flex;flex-direction:column;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="setup-title" style="font-size:22px;text-align:left;margin-bottom:2px">🔁 ${t('dupName')}</div>
          <div style="font-size:12px;color:var(--muted)">${t('dupSub')}</div>
        </div>
        <button class="btn xs" onclick="closeDuplicateFinder()">✕</button>
      </div>
      <div id="duplicate-finder-body" style="flex:1;overflow-y:auto;padding-right:4px;text-align:center;padding-top:40px;color:var(--hint)">
        Scanning…
      </div>
    </div>`;
  modal.style.display = 'flex';

  try {
    const r = await fetch(API + '/history/duplicates?threshold=50');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderDuplicateFinder(data);
  } catch (e) {
    const body = document.getElementById('duplicate-finder-body');
    if (body) body.innerHTML = `<div style="color:var(--err);padding:24px">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

function closeDuplicateFinder() {
  const modal = document.getElementById('duplicate-finder-modal');
  if (modal) modal.style.display = 'none';
}

function renderDuplicateFinder(data) {
  const body = document.getElementById('duplicate-finder-body');
  if (!body) return;
  const totalTracks = histData.length;
  const hashed = data.total_hashed || 0;
  const missing = totalTracks - hashed;

  // If most of the library is unhashed, offer to backfill before showing
  // anything else — the duplicate detection is useless without coverage.
  const backfillBanner = (missing > 5) ? `
    <div style="margin-bottom:14px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--white)">
      <div style="margin-bottom:6px"><strong>${t('dupBackfillHead').replace('{n}', missing)}</strong></div>
      <div style="color:var(--hint);margin-bottom:8px">${t('dupBackfillDesc')}</div>
      <button class="btn pri xs" onclick="startFingerprintBackfill()">⚡ ${t('dupBackfillBtn').replace('{n}', missing)}</button>
      <span id="dup-backfill-progress" style="margin-left:10px;font-size:11px;color:var(--hint)"></span>
    </div>` : '';

  const groups = data.groups || [];
  if (groups.length === 0) {
    body.innerHTML = backfillBanner + `<div style="text-align:center;padding:40px;color:var(--hint)">${t('dupNoneFound').replace('{n}', hashed)} ${missing > 0 ? t('dupNotScanned').replace('{n}', missing) : ''}</div>`;
    return;
  }

  // NOTE: the inner map's track parameter used to be named `t`, which
  // shadowed the t() translation function — any t('key') inside the row
  // template would have crashed. Renamed to `tr` and translations are
  // captured before the loop.
  const keepLbl = t('dupKeep');
  const delLbl = t('delete');
  const groupsHTML = groups.map((g, gi) => {
    // Oldest track in the group is shown first; user-facing this is the
    // "original" they probably want to keep.
    const rowsHTML = g.tracks.map((tr, ti) => {
      const meta = [
        tr.format ? tr.format.toUpperCase() : '',
        tr.duration ? Math.round(tr.duration) + 's' : '',
        tr.created_at ? tr.created_at.slice(0, 10) : '',
      ].filter(Boolean).join(' · ');
      const tagLabel = ti === 0
        ? '<span style="color:#7ed982;font-size:10px;font-weight:600">' + keepLbl + '</span>'
        : `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:var(--hint)">
             <input type="checkbox" class="dup-cb-g${gi}" data-id="${tr.id}" checked style="cursor:pointer"/>
             ${delLbl}
           </label>`;
      return `
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:8px 10px;background:var(--bg);border-radius:4px;align-items:center;margin-bottom:4px">
          <div style="min-width:0">
            <div style="font-size:12px;color:var(--white);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(tr.title || '(untitled)')}</div>
            <div style="font-size:10px;color:var(--hint)">${meta}${tr.channel ? ' · ' + escapeHtml(tr.channel) : ''}</div>
          </div>
          ${tagLabel}
        </div>`;
    }).join('');
    return `
      <div style="margin-bottom:14px;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:12px;color:var(--muted)">${t('dupGroupWord')} ${gi + 1} — ${g.count} ${g.count === 1 ? t('dupOne') : t('dupMany')}</div>
          <button class="btn xs danger" onclick="deleteDuplicateGroup(${gi})">🗑️ ${t('dupDeleteChecked')}</button>
        </div>
        ${rowsHTML}
      </div>`;
  }).join('');

  body.innerHTML = `
    ${backfillBanner}
    <div style="margin-bottom:14px;padding:10px 12px;background:var(--bg);border-radius:6px;border:1px solid var(--border);font-size:12px;color:var(--muted)">
      ${t('dupFoundSummary').replace('{x}', groups.length).replace('{g}', groups.length === 1 ? t('dupGroupOne') : t('dupGroupMany')).replace('{n}', hashed)}
    </div>
    ${groupsHTML}`;

  window._dupGroups = groups;
}

async function deleteDuplicateGroup(gi) {
  const groups = window._dupGroups || [];
  const g = groups[gi];
  if (!g) return;
  const cbs = Array.from(document.querySelectorAll('.dup-cb-g' + gi));
  const idsToDelete = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.id, 10));
  if (!idsToDelete.length) {
    showAppNotification(t('dupNothingChecked'), 'warn');
    return;
  }
  const ok = await confirmModal({
    title: t('dupDeleteTitle').replace('{n}', idsToDelete.length).replace('{w}', idsToDelete.length === 1 ? t('dupOne') : t('dupMany')),
    message: t('dupDeleteMsg'),
    okLabel: t('delete'),
    cancelLabel: t('spCancel'),
  });
  if (!ok) return;
  let okN = 0, fail = 0;
  for (const id of idsToDelete) {
    try {
      const r = await fetch(API + '/history/' + id, { method: 'DELETE' });
      if (r.ok) okN++; else fail++;
    } catch { fail++; }
  }
  showAppNotification(`✓ ${t('deletedWord')} ${okN}${fail ? ' · ' + fail + ' ' + t('failedWord') : ''}`, fail ? 'warn' : 'done');
  // Refresh and re-render duplicates
  await loadHistory();
  openDuplicateFinder();
}

// ── Find similar (0.1.1) ────────────────────────────────────────────
// "More like this" from the ≈ button on any history row. Server blends
// fingerprint, mood, BPM (half/double aware) and key compatibility.
async function openSimilarTracks(historyId) {
  let modal = document.getElementById('similar-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'similar-modal';
    modal.className = 'setup-modal';
    document.body.appendChild(modal);
  }
  const base = histData.find(h => h.id === historyId);
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="setup-card" style="max-width:620px;max-height:80vh;display:flex;flex-direction:column;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div class="setup-title" style="font-size:22px;text-align:left;margin-bottom:2px">≈ ${t('simTitle')}</div>
          <div style="font-size:12px;color:var(--muted);max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(base ? base.title : '')}</div>
        </div>
        <button class="btn xs" onclick="document.getElementById('similar-modal').style.display='none'">✕</button>
      </div>
      <div id="similar-body" style="flex:1;overflow-y:auto;padding-right:4px;text-align:center;padding-top:30px;color:var(--hint)">${t('simLooking')}</div>
    </div>`;
  try {
    const r = await fetch(API + '/tracks/' + historyId + '/similar?limit=15');
    const j = await r.json();
    const body = document.getElementById('similar-body');
    if (!body) return;
    if (!j.results || !j.results.length) {
      body.innerHTML = '<div style="padding:30px">' + t('simNone') + '</div>';
      return;
    }
    body.style.textAlign = 'left';
    body.style.paddingTop = '0';
    body.innerHTML = j.results.map(rr => {
      const pct = Math.round(rr.similarity * 100);
      const reasons = (rr.reasons || []).map(x => t('simReason_' + x)).join(' · ');
      const badges = [rr.bpm ? Math.round(rr.bpm) + ' BPM' : '', rr.key_note ? rr.key_note + ' ' + (rr.key_mode || '') : ''].filter(Boolean).join(' · ');
      return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border-radius:6px;margin-bottom:5px">
        <img src="${resolveThumb(rr.thumbnail)}" onerror="window._thumbFail(this)" loading="lazy" decoding="async" style="width:42px;height:30px;object-fit:cover;border-radius:4px" alt=""/>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--white);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(rr.title || '(untitled)')}</div>
          <div style="font-size:10px;color:var(--hint)">${badges}${reasons ? ' · ' + reasons : ''}</div>
        </div>
        <span style="font-size:12px;font-weight:600;color:${pct >= 70 ? '#7ed982' : 'var(--muted)'}">${pct}%</span>
        <button class="btn xs" onclick="playFromHistory(${rr.id})" title="${t('histFavorite') ? '' : ''}▶">▶</button>
        <button class="btn xs" onclick="document.getElementById('similar-modal').style.display='none';loadFromHistory(${rr.id})">${t('simOpen')}</button>
      </div>`;
    }).join('');
  } catch (e) {
    const body = document.getElementById('similar-body');
    if (body) body.innerHTML = '<div style="padding:30px">✕ ' + escapeHtml(e.message) + '</div>';
  }
}

async function startFingerprintBackfill() {
  try {
    const r = await fetch(API + '/history/fingerprint-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1000 }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const prog = document.getElementById('dup-backfill-progress');
    if (prog) prog.textContent = `Started — ${j.queued} queued`;
    showAppNotification(`Fingerprint backfill started — ${j.queued} tracks queued`, 'info');
    // Subscribe to SSE progress events. The /events channel already exists
    // from patch 15s for history updates.
    if (window._backfillES) { try { window._backfillES.close(); } catch {} }
    const es = new EventSource(API + '/events');
    window._backfillES = es;
    es.addEventListener('fingerprint-backfill', e => {
      try {
        const data = JSON.parse(e.data);
        if (data.state === 'progress' || data.state === 'start') {
          if (prog) prog.textContent = `${data.done}/${data.total} hashed…`;
        } else if (data.state === 'complete') {
          if (prog) prog.textContent = `✓ Complete — ${data.done}/${data.total}`;
          showAppNotification(`Fingerprint backfill complete — ${data.done} tracks hashed`, 'done');
          es.close();
          window._backfillES = null;
          // Auto-refresh the duplicate finder to show new matches
          setTimeout(() => openDuplicateFinder(), 800);
        }
      } catch {}
    });
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// ── Background analysis pill (0.2.2) ──────────────────────────────
// Drawn into #bg-analyze-pill (added to index.html, lives next to the
// History header). Three visible states:
//   • hidden — worker idle, queue empty (the normal state)
//   • active — "Analyzing 5 tracks… (current title)"
//   • done   — brief "All caught up" flash, auto-hides after 4s
function renderBgAnalyzePill(d) {
  let pill = document.getElementById('bg-analyze-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'bg-analyze-pill';
    pill.className = 'bg-pill';
    pill.addEventListener('click', () => fetch(API + '/bg-analyze/run', { method: 'POST' }).catch(()=>{}));
    pill.title = 'Click to re-run / retry failed';
    // Mount in the document body so it floats in the corner regardless
    // of which tab is active.
    document.body.appendChild(pill);
  }
  if (!d) return;
  if (d.state === 'progress' && d.current) {
    pill.classList.add('active');
    pill.classList.remove('hidden', 'done');
    const title = (d.current.title || '').slice(0, 38);
    pill.innerHTML = '<span class="bg-pill-spin">⟳</span> ' +
      t('bgAnalyzing') + ' ' + d.remaining + ' · ' + escapeHtml(title);
  } else if (d.state === 'idle') {
    if (d.remaining > 0) {
      // Worker stopped but rows still pending — usually all hit retry cap
      pill.classList.add('active');
      pill.classList.remove('hidden');
      pill.innerHTML = '⚠ ' + d.remaining + ' ' + t('bgPending');
    } else {
      pill.classList.add('done');
      pill.classList.remove('active');
      pill.textContent = '✓ ' + t('bgCaughtUp');
      setTimeout(() => { if (pill.classList.contains('done')) pill.classList.add('hidden'); }, 4000);
    }
  }
}

// Boot: query status once so the pill shows up if there's already a
// backlog from a previous session (watch folder ran while desktop was
// closed, etc.).
setTimeout(async () => {
  try {
    const j = await fetch(API + '/bg-analyze/status').then(r => r.json());
    if (j && (j.running || j.remaining > 0)) {
      renderBgAnalyzePill({
        state: j.running ? 'progress' : 'idle',
        current: j.current, remaining: j.remaining,
      });
    }
  } catch {}
}, 3000);

// v0.2.5: rAF-coalesced re-render. A playlist of 30 grabs lands as 30
// history-changed + 30 bg-analyze SSE events; without this wrapper each
// one triggered a full _renderHistoryImpl() (innerHTML rewrite of the
// whole list). Now: any number of requestRenderHistory() calls inside
// one frame collapse to a single render before paint.
let _renderHistoryQueued = false;
function requestRenderHistory(){
  if (_renderHistoryQueued) return;
  _renderHistoryQueued = true;
  requestAnimationFrame(() => {
    _renderHistoryQueued = false;
    try { _renderHistoryImpl(); } catch (e) { console.error('renderHistory crashed:', e); }
  });
}
// Keep the public name backward-compatible so existing call sites
// (and any future ones) just work. Anything that needs a guaranteed
// synchronous render can still call _renderHistoryImpl() directly.
function renderHistory() { requestRenderHistory(); }

// v0.2.8: HK-logo fallback as inline SVG. Used whenever a thumbnail URL
// is missing OR fails to load. Generated once at module load; cheap.
const HK_FALLBACK_THUMB = 'data:image/svg+xml;base64,' + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">' +
  '<rect width="100" height="100" fill="#161616"/>' +
  '<g transform="translate(50,50)" fill="none" stroke="#3a3a3a" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M -22 -22 L -22 22 M -22 0 L 4 0 M 4 -22 L 4 22 M 4 0 L 22 -22 M 4 0 L 22 22"/>' +
  '</g></svg>'
);

function resolveThumb(url) {
  if (!url || typeof url !== 'string') return HK_FALLBACK_THUMB;
  const t = url.trim();
  if (!t || t === 'null' || t === 'undefined') return HK_FALLBACK_THUMB;
  return t;
}

// Global onerror: <img onerror="window._thumbFail(this)"> swaps to the
// HK fallback. Self-clears handler so a broken fallback can't loop.
window._thumbFail = function(img) {
  if (img && img.src !== HK_FALLBACK_THUMB) {
    img.src = HK_FALLBACK_THUMB;
    img.classList.add('thumb-fallback');
    img.onerror = null;
  }
};


function _renderHistoryImpl(){
  const q=(document.getElementById('hist-search')?.value||'').toLowerCase(),list=document.getElementById('hist-list');
  // Category filter — drives a virtual subset of histData based on the
  // user's selection in the "Filter by folder" dropdown. Supported values:
  //   all              → no filter (default)
  //   untagged         → only tracks with no folder tags
  //   favorites        → only is_favorite=true
  //   folder:<id>      → only tracks tagged with the given folder
  // The tags map is cached on window.histTagsByHistoryId (populated by
  // hydrateAllHistoryTags). If the cache isn't ready yet, "untagged" and
  // folder filters fall through to "all" gracefully rather than showing
  // nothing — better UX than blanking the list on a transient state.
  const filterVal = document.getElementById('hist-filter')?.value || 'all';
  const tagsByHist = window.histTagsByHistoryId || {};
  const matchesFilter = (h) => {
    if (filterVal === 'all') return true;
    if (filterVal === 'favorites') return !!h.is_favorite;
    if (filterVal === 'untagged') {
      const tags = tagsByHist[h.id] || [];
      return tags.length === 0;
    }
    if (filterVal.startsWith('folder:')) {
      const folderId = parseInt(filterVal.slice(7), 10);
      const tags = tagsByHist[h.id] || [];
      return tags.some(t => t.folder_id === folderId);
    }
    return true;
  };
  const matchesSearch = (h) =>
    !q || (h.title || '').toLowerCase().includes(q) || (h.channel || '').toLowerCase().includes(q);
  const rows = histData.filter(h => matchesSearch(h) && matchesFilter(h));
  // Pulse detection: rows whose id is newer than the highest id we'd
  // rendered before. On the first render we just set the baseline (no
  // pulse — otherwise every row would flash on app open). After that,
  // any id above the baseline gets a brief green pulse so downloads
  // that arrived from the extension / another window are noticeable.
  const prevSeenHistId = window._lastSeenHistId || 0;
  const maxHistId = histData.reduce((m, h) => Math.max(m, h.id || 0), 0);
  if (!rows.length) {
    // Tailor the empty message to what the user is doing — searching,
    // filtering, or just has no history yet. Easier to diagnose.
    let empty = 'No history yet — download a track to get started';
    if (q && filterVal !== 'all') empty = 'No matching tracks in this filter';
    else if (q) empty = 'No matching tracks';
    else if (filterVal === 'untagged') empty = 'All tracks are tagged. Nice!';
    else if (filterVal === 'favorites') empty = 'No favorites yet — click the heart on a track';
    else if (filterVal.startsWith('folder:')) empty = 'No tracks in this folder yet';
    list.innerHTML = '<div class="hist-empty">' + empty + '</div>';
    return;
  }
  // v0.2.8: row-level DOM reconciliation to eliminate the refresh
  // stutter. Previously list.innerHTML = ... destroyed every row on
  // every render, throwing away decoded image bitmaps and forcing
  // tags to lazy-load all over again. Now we build the row HTML the
  // same way (template literal below) but apply it surgically.
  function buildHistoryRowHTML(h){
    const checked = selectedIds.has(h.id);
    const checkbox = selectMode ? `<input type="checkbox" class="hist-check" ${checked?'checked':''} onclick="toggleRowSelect(${h.id},event)"/>` : '';
    const rowClass = 'hist-row' + (checked ? ' selected' : '');
    // Click behavior on the row:
    //   • Select mode: single-click toggles selection (touch-friendly, no
    //     ambiguity with the play button — play btn is hidden in select mode)
    //   • Normal mode: DOUBLE-CLICK opens the track in Analyze. Single
    //     click does nothing on purpose — users frequently miss the small
    //     play button by a few pixels and would land on the row outline,
    //     accidentally opening Analyze and interrupting whatever they
    //     were doing. Requiring a double-click eliminates the misfire
    //     while keeping the row itself useful as a target.
    const onclick = selectMode
      ? `onclick="toggleRowSelect(${h.id})"`
      : `ondblclick="loadFromHistory(${h.id})"`;
    // Play button — routes through global player so the mini player surfaces
    // and prev/next walks the visible history list.
    //
    // "Is this row's track currently playing?" — must check BOTH modes:
    //   • Legacy mode → globalPlayer.track.id matches
    //   • Mirror mode → currentHistId matches AND Web Audio `playing` is true
    // Without the mirror check, history rows never light up because the
    // play-from-history flow goes through the Analyzer, leaving
    // globalPlayer.track null.
    // v0.2.5: distinguish ACTIVE (track loaded) from PLAYING (audio
    // actually advancing). Mirror mode used to drop the row highlight
    // as soon as the user paused — visually you "lost your place" the
    // moment you hit stop. Now the row stays lit while the track is
    // loaded (matches legacy mode's pre-existing behavior); the icon
    // alone flips between pause-bars and play-triangle.
    const isActive = (
      (globalPlayer && globalPlayer.track && globalPlayer.track.id === h.id) ||
      (analyzeMirrorActive && currentHistId === h.id)
    );
    const isPlaying = isActive && (
      (globalPlayer && globalPlayer.audio && !globalPlayer.audio.paused) ||
      (analyzeMirrorActive && typeof playing !== 'undefined' && playing)
    );
    const playIcon = isPlaying
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,5 7,19 19,12"/></svg>';
    const playBtn = selectMode ? '' : `<button class="hist-play ${isActive ? 'active' : ''} ${isPlaying ? 'playing' : ''}" tabindex="-1" onmousedown="this.blur()" onclick="event.stopPropagation();playFromHistory(${h.id});this.blur()" title="Preview">${playIcon}</button>`;
    // Favorite heart — filled when favorited. Click toggles. The toggle
    // optimistically updates h.is_favorite then sends to the server so
    // there's no perceptible delay.
    const heartIcon = h.is_favorite
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="#ff5555" stroke="#ff5555" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    const favBtn = selectMode ? '' : `<button class="hist-fav ${h.is_favorite ? 'on' : ''}" tabindex="-1" onmousedown="this.blur()" onclick="event.stopPropagation();toggleFavorite(${h.id});this.blur()" title="${t('histFavorite') || 'Favorite'}">${heartIcon}</button>`;
    // Tag strip — populated lazily after render to avoid blocking the list draw.
    const tagStrip = `<div class="hist-tag-row" id="hist-tags-${h.id}" onclick="event.stopPropagation()"></div>`;
    // Title attribute gives users a hover hint about the double-click
    // requirement so the behavior isn't a mystery on first try. Only set
    // in normal mode — in selectMode it'd contradict the actual single-click
    // selection behavior.
    const rowTitle = selectMode ? '' : ' title="Double-click to open in Analyze"';
    // Pulse rows that arrived since the last render (and only when this
    // isn't the first render). The class is removed after the animation
    // by the cleanup pass below so subsequent re-renders don't re-flash.
    const isNew = prevSeenHistId > 0 && (h.id || 0) > prevSeenHistId;
    const pulseClass = isNew ? ' row-pulse' : '';
    return `<div class="${rowClass}${pulseClass}" data-id="${h.id}"${rowTitle} ${onclick} draggable="true" ondragstart="dragHistoryRowToExternal(event, ${h.id})">${checkbox}${playBtn}<img class="hist-thumb" loading="lazy" decoding="async" src="${resolveThumb(h.thumbnail)}" onerror="window._thumbFail(this)" alt=""/>${favBtn}<div class="hist-info"><div class="hist-title">${h.title||'(untitled)'}</div><div class="hist-meta">${[h.channel,h.created_at?.slice(0,16),fmtSec(h.duration)].filter(Boolean).join(' · ')}</div>${tagStrip}</div><div class="hist-badges">${h.bpm?`<span class="badge bpm">${Math.round(h.bpm)} BPM</span>`:''}${h.key_note?`<span class="badge key">${h.key_note} ${h.key_mode||''}</span>`:''}${h.format?`<span class="badge">${h.format.toUpperCase()}</span>`:''}</div>${selectMode?'':`<button class="btn xs" tabindex="-1" onmousedown="this.blur()" onclick="event.stopPropagation();openSimilarTracks(${h.id});this.blur()" title="${t('simBtn')}">≈</button><button class="btn xs danger" onclick="event.stopPropagation();deleteHistory(${h.id})">Remove</button>`}</div>`;
  } // end buildHistoryRowHTML

  // Build a fingerprint for each row so we can detect which ones
  // actually changed since last render. Cheap (~30 char digest).
  function rowFingerprint(h){
    return [h.id, h.title, h.bpm, h.key_note, h.key_mode, h.format,
            h.thumbnail, h.duration, h.is_favorite, h.channel,
            (tagsByHist[h.id]||[]).map(tg=>tg.folder_id).join(','),
            isActiveFor(h.id), isPlayingFor(h.id), selectedIds.has(h.id), selectMode
           ].join('|');
  }
  function isActiveFor(id){
    return ((globalPlayer && globalPlayer.track && globalPlayer.track.id === id) ||
            (analyzeMirrorActive && currentHistId === id));
  }
  function isPlayingFor(id){
    if (!isActiveFor(id)) return false;
    return ((globalPlayer && globalPlayer.audio && !globalPlayer.audio.paused) ||
            (analyzeMirrorActive && typeof playing !== 'undefined' && playing));
  }

  // First render of this list, or massive change → fall back to full
  // innerHTML rewrite (faster than 100s of individual mutations).
  const existing = Array.from(list.children).filter(el => el.classList && el.classList.contains('hist-row'));
  const FULL_REWRITE_THRESHOLD = 80;
  if (!existing.length || Math.abs(existing.length - rows.length) > FULL_REWRITE_THRESHOLD) {
    list.innerHTML = rows.map(buildHistoryRowHTML).join('');
  } else {
    // Reconcile by data-id. Build a map of current DOM rows.
    const domMap = new Map();
    for (const el of existing) domMap.set(parseInt(el.dataset.id, 10), el);
    const newIds = new Set(rows.map(h => h.id));

    // Remove rows that are no longer present (fade out then drop)
    for (const [id, el] of domMap) {
      if (!newIds.has(id)) {
        el.classList.add('hist-row-leaving');
        setTimeout(() => el.remove(), 180);
      }
    }

    // Walk the new ordering: insert new rows, move/patch existing ones.
    let prevEl = null;
    for (const h of rows) {
      const existingEl = domMap.get(h.id);
      const fp = rowFingerprint(h);

      if (existingEl) {
        // Row exists. Only rewrite if its fingerprint changed.
        if (existingEl.dataset.fp !== fp) {
          // Patch contents in place — <img> nodes get swapped only when
          // src actually differs (browsers preserve the decoded image
          // for same-src). This is what kills the flash.
          const tmp = document.createElement('div');
          tmp.innerHTML = buildHistoryRowHTML(h);
          const fresh = tmp.firstElementChild;
          if (fresh) {
            existingEl.className = fresh.className;
            existingEl.setAttribute('title', fresh.getAttribute('title') || '');
            existingEl.setAttribute('draggable', 'true');
            // Replace children but preserve thumbs whose src is unchanged
            const oldThumb = existingEl.querySelector('.hist-thumb');
            const newThumb = fresh.querySelector('.hist-thumb');
            const thumbSrcSame = oldThumb && newThumb && oldThumb.src === resolveThumb(h.thumbnail);
            existingEl.innerHTML = fresh.innerHTML;
            if (thumbSrcSame) {
              const replacedThumb = existingEl.querySelector('.hist-thumb');
              if (replacedThumb && oldThumb.complete) {
                // Reuse the already-decoded bitmap by swapping nodes
                replacedThumb.replaceWith(oldThumb);
              }
            }
            existingEl.dataset.fp = fp;
          }
        }
        // Ensure ordering — only touch DOM if position changed
        if (prevEl ? existingEl.previousElementSibling !== prevEl
                   : list.firstElementChild !== existingEl) {
          if (prevEl) prevEl.after(existingEl); else list.prepend(existingEl);
        }
        prevEl = existingEl;
      } else {
        // New row — insert with pulse animation
        const tmp = document.createElement('div');
        tmp.innerHTML = buildHistoryRowHTML(h);
        const fresh = tmp.firstElementChild;
        if (fresh) {
          fresh.dataset.fp = fp;
          fresh.classList.add('row-pulse');
          if (prevEl) prevEl.after(fresh); else list.prepend(fresh);
          prevEl = fresh;
        }
      }
    }
  }

  // Update the pulse baseline + clean up the pulse class after it plays
  window._lastSeenHistId = maxHistId;
  setTimeout(() => {
    list.querySelectorAll('.hist-row.row-pulse').forEach(r => r.classList.remove('row-pulse'));
  }, 3600);
  // Lazy-load tags for visible rows via ONE bulk endpoint. The old code
  // fired a separate fetch() per history row which caused a visible reload
  // jiggle as each row's tag strip arrived async and re-flowed the layout.
  // One request returns all tags grouped by history_id in <50ms.
  hydrateAllHistoryTags(rows);
}

// Bulk version of hydrateHistoryTags — fetches all tags once and populates
// all visible rows synchronously.
async function hydrateAllHistoryTags(rows) {
  try {
    const r = await fetch(API + '/stockpile/tags-by-history');
    const j = await r.json();
    const byId = j.tags_by_history || {};
    // Cache so renderHistory() can filter by folder without an extra
    // round-trip. We rebuild this whenever history loads (and whenever a
    // tag changes via refreshUIForAction('tag-changed', ...) — see below
    // where we invalidate it).
    window.histTagsByHistoryId = byId;
    populateHistoryFilterDropdown();
    for (const h of rows) {
      const cell = document.getElementById('hist-tags-' + h.id);
      if (!cell) continue;
      const tags = byId[h.id] || [];
      const chips = tags.map(tag => `
        <span class="hist-tag-chip ${tag.is_primary ? 'primary' : ''}" title="${escapeHtml(tag.source || '')}">
          ${escapeHtml(tag.name)}
          <span class="hist-tag-x" onclick="event.stopPropagation();untagFromHistory(${h.id}, ${tag.folder_id})">×</span>
        </span>
      `).join('');
      const addBtn = `<button class="hist-tag-add" onclick="event.stopPropagation();openTagPicker(${h.id})">+ ${t('spTagBtn')}</button>`;
      cell.innerHTML = chips + addBtn;
    }
  } catch (e) {
    // Silent fallback — tags just won't show, but the history list works fine
  }
}

// Build the History → "Filter by folder" dropdown options from spFolders.
// Lazy-loads spFolders if the user hasn't visited Stockpile yet (same
// pattern as openTagPicker in patch 15k). Preserves the user's current
// selection across re-renders.
async function populateHistoryFilterDropdown() {
  const sel = document.getElementById('hist-filter');
  if (!sel) return;
  // Lazy-load folders if cache empty
  if (!Array.isArray(spFolders) || spFolders.length === 0) {
    try {
      const r = await fetch(API + '/stockpile/folders');
      const j = await r.json();
      spFolders = j.folders || [];
    } catch { /* leave empty — dropdown will only have built-in options */ }
  }
  const prev = sel.value || 'all';
  // Sort folders alphabetically so they're scannable
  const folders = (spFolders || []).slice().sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  // Built-in option groups: All, Untagged, Favorites, Recent (built-ins),
  // then user folders. "Untagged" is a useful pseudo-filter for cleanup
  // workflows ("what haven't I tagged yet?").
  sel.innerHTML =
    '<option value="all">All tracks</option>' +
    '<option value="untagged">Untagged</option>' +
    '<option value="favorites">★ Favorites</option>' +
    (folders.length ? '<optgroup label="Folders">' +
      folders.map(f => `<option value="folder:${f.id}">${escapeHtml(f.name)} (${f.track_count || 0})</option>`).join('') +
      '</optgroup>' : '');
  // Restore previous selection if it's still valid
  if (Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
}

// Play a history track via the global player. Builds a context with the
// currently visible (filtered) history list so prev/next walks that order.
function playFromHistory(historyId) {
  const tr = histData.find(h => h.id === historyId);
  if (!tr || !tr.file_path) {
    showAppNotification('✕ ' + (t('spFileMissing') || 'File path missing'), 'err');
    return;
  }
  const q = (document.getElementById('hist-search')?.value || '').toLowerCase();
  const visible = histData.filter(h => !q ||
    (h.title || '').toLowerCase().includes(q) ||
    (h.channel || '').toLowerCase().includes(q));
  const idx = visible.findIndex(h => h.id === historyId);
  // Set the Analyzer playlist context BEFORE loading. The mini player's
  // prev/next will walk this list to navigate, keeping all playback in the
  // Analyzer (single audio source).
  analyzePlaylist = { tracks: visible, index: idx >= 0 ? idx : 0 };

  // FAST PATH: this track is already loaded in the Analyzer. Just toggle
  // playback — don't reload the file (that would reset pauseOff to 0 and
  // kill the running position). Three cases:
  //   - Already playing → pause it
  //   - Paused mid-track → resume from pauseOff
  //   - Just loaded, never played → start from 0
  if (historyId === currentHistId && audioBuf) {
    if (playing) {
      if (typeof stopAudio === 'function') stopAudio();
    } else {
      if (typeof startAudio === 'function') startAudio();
    }
    return;
  }

  // Otherwise: fresh load. Force play state for the handoff so Analyzer
  // auto-resumes after load. skipTabSwitch keeps the user on History.
  if (typeof globalPlayer !== 'undefined') {
    globalPlayer._handoffWasPlaying = true;
    globalPlayer._handoffTime = 0;
  }
  loadFromHistory(historyId, { skipTabSwitch: true });
}

// ── Favorites ─────────────────────────────────────────────────────────────
// Toggle the is_favorite flag on a history track. Two side effects:
//   1. The heart icon flips state in the row and (if visible) the mini player
//   2. If a stockpile folder named "Favorites" exists, the track is tagged
//      into it on favorite / untagged on unfavorite. The folder is created
//      lazily on first favorite, so users never see an empty "Favorites".
async function toggleFavorite(historyId) {
  const row = histData.find(h => h.id === historyId);
  if (!row) return;
  const wasOn = !!row.is_favorite;
  // Optimistic local flip so the heart redraws instantly
  row.is_favorite = wasOn ? 0 : 1;
  // Find any visible heart for this row + the mini player heart and flip them
  updateFavoriteUI(historyId, !wasOn);

  try {
    const r = await fetch(API + '/history/' + historyId + '/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: !wasOn }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Favorite failed');
    row.is_favorite = j.favorite ? 1 : 0;

    // Auto-tag into / out of the Favorites stockpile folder
    if (j.favorite) {
      const folderId = await ensureFavoritesFolder();
      if (folderId) {
        await fetch(API + '/stockpile/tracks/' + historyId + '/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // stockpile_root is included so the backend can auto-move the
          // file into the folder if this tag becomes primary. Favorites
          // is_primary=0, so usually a no-op here, but pass it for
          // consistency in case Favorites is a track's only tag.
          body: JSON.stringify({
            folder_id: folderId, is_primary: 0, source: 'favorite',
            stockpile_root: stockpileFolder || undefined,
          }),
        });
      }
    } else {
      // Untag from Favorites folder if present
      const favFolder = spFolders.find(f => f.name === 'Favorites');
      if (favFolder) {
        // stockpile_root as query param so the backend can re-commit if
        // we just removed the primary
        const root = stockpileFolder ? '?stockpile_root=' + encodeURIComponent(stockpileFolder) : '';
        await fetch(API + '/stockpile/tracks/' + historyId + '/tags/' + favFolder.id + root, {
          method: 'DELETE'
        });
      }
    }
    refreshUIForAction('favorite-toggled', { historyId });
  } catch (e) {
    // Roll back optimistic state on failure
    row.is_favorite = wasOn ? 1 : 0;
    updateFavoriteUI(historyId, wasOn);
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// Find or lazily create the Favorites stockpile folder. Returns the folder id.
async function ensureFavoritesFolder() {
  // Check in-memory cache first (fast path)
  let folder = spFolders.find(f => f.name === 'Favorites');
  if (folder) return folder.id;
  // Cache may be stale — refresh from server before deciding to create.
  // This avoids the UNIQUE constraint error from racing creations across
  // tabs or stale cache states.
  try {
    const r = await fetch(API + '/stockpile/folders');
    if (r.ok) {
      const fresh = await r.json();
      if (Array.isArray(fresh)) {
        spFolders = fresh;
        folder = spFolders.find(f => f.name === 'Favorites');
        if (folder) return folder.id;
      }
    }
  } catch {}
  // Still not there — try to create
  try {
    const r = await fetch(API + '/stockpile/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Favorites', color: '#ff5555', icon: '♥' }),
    });
    const j = await r.json();
    if (r.ok && j.id) {
      // Push into local cache so subsequent calls don't refetch
      spFolders.push({ id: j.id, name: 'Favorites', color: '#ff5555', icon: '♥', track_count: 0 });
      return j.id;
    }
    // POST failed (likely UNIQUE constraint from a parallel race) — refresh
    // and look again.
    const r2 = await fetch(API + '/stockpile/folders');
    if (r2.ok) {
      const fresh = await r2.json();
      if (Array.isArray(fresh)) {
        spFolders = fresh;
        folder = spFolders.find(f => f.name === 'Favorites');
        if (folder) return folder.id;
      }
    }
  } catch {}
  return null;
}

// Sync the heart icon UI in the history row + mini player without a full
// re-render. Faster + preserves scroll.
function updateFavoriteUI(historyId, on) {
  const heartIconFilled = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#ff5555" stroke="#ff5555" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const heartIconEmpty = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  const row = document.querySelector('.hist-row[data-id="' + historyId + '"] .hist-fav');
  if (row) {
    row.classList.toggle('on', on);
    row.innerHTML = on ? heartIconFilled : heartIconEmpty;
  }
  // Mini player heart. IMPORTANT: resolve the displayed track through
  // getMiniPlayerTrack() — NOT globalPlayer.track directly. In mirror mode
  // (track playing inside the Analyzer, mini player just reflecting it)
  // globalPlayer.track is null and the old check silently skipped the
  // update: the tag applied but the heart never turned red.
  const miniHeart = document.getElementById('sp-fv-mini-fav');
  const miniTr = (typeof getMiniPlayerTrack === 'function') ? getMiniPlayerTrack() : null;
  if (miniHeart && miniTr && miniTr.id === historyId) {
    miniHeart.classList.toggle('on', on);
    miniHeart.innerHTML = on ? heartIconFilled : heartIconEmpty;
  }
}

// Sync the mini player heart from current data — called whenever a track
// is (re)loaded into the mini player, in EITHER mode. Without this, playing
// an already-favorited track showed an empty heart until you clicked it.
function syncMiniFavHeart() {
  const tr = (typeof getMiniPlayerTrack === 'function') ? getMiniPlayerTrack() : null;
  if (!tr || !tr.id) return;
  // Freshest favorite state lives in histData; the legacy track object is
  // a snapshot that can go stale if the user toggled from the History row.
  const row = Array.isArray(histData) ? histData.find(h => h.id === tr.id) : null;
  const on = !!((row || tr).is_favorite);
  updateFavoriteUI(tr.id, on);
}

async function hydrateHistoryTags(historyId) {
  try {
    const r = await fetch(API + '/stockpile/tracks/' + historyId + '/tags');
    const j = await r.json();
    const cell = document.getElementById('hist-tags-' + historyId);
    const tags = j.tags || [];
    // Keep the global tag cache in sync so the History filter dropdown
    // sees this change immediately — otherwise users would have to
    // reload history to filter on a freshly-tagged track.
    if (!window.histTagsByHistoryId) window.histTagsByHistoryId = {};
    window.histTagsByHistoryId[historyId] = tags;
    // If the currently visible filter is "this folder" and the user just
    // added/removed that tag, the row should appear/disappear from the
    // list. Re-render the history to honor the active filter.
    const filterVal = document.getElementById('hist-filter')?.value;
    if (filterVal && filterVal !== 'all') renderHistory();
    if (!cell) return;
    const chips = tags.map(tag => `
      <span class="hist-tag-chip ${tag.is_primary ? 'primary' : ''}" title="${escapeHtml(tag.source || '')}">
        ${escapeHtml(tag.name)}
        <span class="hist-tag-x" onclick="event.stopPropagation();untagFromHistory(${historyId}, ${tag.folder_id})">×</span>
      </span>
    `).join('');
    const addBtn = `<button class="hist-tag-add" onclick="event.stopPropagation();openTagPicker(${historyId})">+ ${t('spTagBtn')}</button>`;
    cell.innerHTML = chips + addBtn;
  } catch {}
}

async function untagFromHistory(historyId, folderId) {
  try {
    // Append stockpile_root as a query param so the backend can re-commit
    // the file (move it to the new primary's folder, or back to the
    // stockpile root if this was the only tag).
    const root = stockpileFolder ? '?stockpile_root=' + encodeURIComponent(stockpileFolder) : '';
    await fetch(API + '/stockpile/tracks/' + historyId + '/tags/' + folderId + root, { method: 'DELETE' });
    delete spSuggestionsByTrack[historyId];
    refreshUIForAction('tag-changed', { historyId, folderId });
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// ── Auto-refresh dispatcher ────────────────────────────────────────────────
// Different state changes touch different UI surfaces. Rather than every
// action manually re-rendering 4 different lists, this centralizes the
// "what to refresh after which action" logic. Each branch knows the minimal
// set of refetches/repaints to do — keeps the UI consistent without a
// full page reload that would feel laggy.
async function refreshUIForAction(action, payload) {
  payload = payload || {};
  try {
    switch (action) {
      case 'tag-changed':
        // A folder tag was added or removed from a history track
        if (payload.historyId) hydrateHistoryTags(payload.historyId);
        // The stockpile counts on each folder card need updating too
        if (typeof loadStockpile === 'function' && lastTab === 'stockpile') loadStockpile();
        // If a folder view is open and the track is in it, refresh the list
        if (typeof spFvFolder !== 'undefined' && spFvFolder &&
            typeof loadFolderTracks === 'function') {
          loadFolderTracks(spFvFolder.id);
        }
        break;
      case 'track-downloaded':
        // New track in history — refetch and rerender. Preserve scroll.
        if (typeof loadHistory === 'function') {
          const main = document.getElementById('main');
          const savedScroll = main ? main.scrollTop : 0;
          await loadHistory();
          if (main) main.scrollTop = savedScroll;
        }
        break;
      case 'history-removed':
        if (typeof loadHistory === 'function') loadHistory();
        break;
      case 'settings-changed':
        // Re-apply language, then re-render whatever's visible. Settings
        // changes can touch i18n strings on every tab so this is a full
        // re-render but it's cheap (no network).
        if (typeof applyLang === 'function') applyLang();
        if (typeof renderHistory === 'function') renderHistory();
        break;
      case 'folder-created':
      case 'folder-deleted':
      case 'folder-renamed':
        if (typeof loadStockpile === 'function') loadStockpile();
        // History rows show tag chips that reference folder names — refresh them
        if (typeof renderHistory === 'function' && histData && histData.length) {
          renderHistory();
        }
        break;
      case 'favorite-toggled':
        // Refresh history row to show the heart state, plus the favorites
        // folder count if visible
        if (typeof loadHistory === 'function') loadHistory();
        if (typeof loadStockpile === 'function' && lastTab === 'stockpile') loadStockpile();
        break;
    }
  } catch (e) {
    diagLog('refreshUIForAction(' + action + ') failed: ' + e.message, 'err');
  }
}
async function loadFromHistory(id, opts){
  opts = opts || {};
  // skipTabSwitch=true: load the track + start playback in the Analyzer
  // WITHOUT navigating away from the user's current tab. The play button
  // on a history row uses this so users can keep browsing while music plays.
  // Default behavior (clicking the row itself) still jumps to Analyze.
  const skipTabSwitch = !!opts.skipTabSwitch;
  let row=histData.find(h=>h.id===id);if(!row?.file_path)return;

  // FAST PATH: this track is ALREADY loaded in the Analyzer (currentHistId
  // matches AND we have an audioBuf). Don't re-fetch the file, don't reset
  // playback — just switch to the Analyze tab. This preserves the live
  // playback position perfectly when the user clicks a row to "open" a
  // track they're already previewing via the mini player. Re-loading here
  // was the desync bug: it reset pauseOff to 0 and restarted audio.
  if (id === currentHistId && audioBuf && !opts.forceReload) {
    if (!skipTabSwitch) {
      const tab = document.querySelector('[data-tab="analyze"]');
      if (tab) showTab(tab);
    }
    // Release any pending transition lock from the caller
    if (typeof globalPlayer !== 'undefined') globalPlayer._transitionLock = false;
    return;
  }

  // Save history scroll position before navigating to analyze
  const main = document.getElementById('main');
  if (main) tabScrollMemory['history'] = main.scrollTop;
  historyScrollTop = main ? main.scrollTop : 0; // legacy compat

  let filePath = row.file_path;
  let result = await api.readFile(filePath);

  // Fallback 1: re-fetch from server (DB may have updated path after move)
  if (!result.ok) {
    try {
      const freshData = await (await fetch(API + '/history')).json();
      const freshRow = freshData.find(h => h.id === id);
      if (freshRow && freshRow.file_path && freshRow.file_path !== filePath) {
        filePath = freshRow.file_path;
        result = await api.readFile(filePath);
        row.file_path = filePath;
      }
    } catch {}
  }

  // Fallback 2: scan stockpile + known folders for the filename
  if (!result.ok) {
    try {
      const filename = filePath.split(/[/\\]/).pop();
      const stockpile = stockpileFolder || '';
      const findResp = await fetch(API + '/find-file?filename=' + encodeURIComponent(filename) + '&stockpile=' + encodeURIComponent(stockpile) + '&id=' + id);
      const findData = await findResp.json();
      if (findData.found && findData.path) {
        filePath = findData.path;
        result = await api.readFile(filePath);
        row.file_path = filePath; // update local cache
      }
    } catch {}
  }

  if (!result.ok) {
    showAppNotification('✕ Could not load: file not found on disk','err');
    // Release any pending transition lock so a follow-up click can recover
    if (typeof globalPlayer !== 'undefined') globalPlayer._transitionLock = false;
    return;
  }

  try{
    setLastFilePath(filePath, row.title || filePath.split(/[/\\]/).pop());
    // Only jump to the Analyze tab when the user explicitly clicked the row
    // (i.e. they want to see the Analyzer). The history play button passes
    // skipTabSwitch=true so playback starts in the background.
    if (!skipTabSwitch) {
      showTab(document.querySelector('[data-tab="analyze"]'));
    }
    await loadAudioBuffer(result.data,row.title||filePath.split(/[/\\]/).pop(),id);
    if(row.notes)document.getElementById('notes-box').value=row.notes;
    if(row.transcript)document.getElementById('transcript-out').value=row.transcript;
  }catch(e){showAppNotification('✕ Could not load: '+e.message.slice(0,50),'err');}
}
async function deleteHistory(id){
  // Styled confirm — danger style because removing from history is
  // destructive (the row is gone from DB; file on disk is preserved).
  const ok = await confirmModal({
    title: 'Remove from history?',
    message: 'This removes the entry from your library. The audio file on disk is not deleted.',
    okLabel: 'Remove',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  await fetch(API+'/history/'+id,{method:'DELETE'});
  await loadHistory();
}

function setMetroBpm(v){metroBpm=parseInt(v);document.getElementById('metro-num').textContent=metroBpm;}
function toggleMetro(){
  if(metroOn){metroOn=false;clearTimeout(metroId);document.getElementById('metro-btn').textContent='Start';document.getElementById('metro-btn').classList.add('pri');document.querySelectorAll('.beat-dot').forEach(d=>d.classList.remove('lit'));}
  else{metroOn=true;metroBeat=0;document.getElementById('metro-btn').textContent='Stop';document.getElementById('metro-btn').classList.remove('pri');if(!metroACtx)metroACtx=new AudioContext();scheduleBeat();}
}
function scheduleBeat(){
  if(!metroOn)return;
  const sig=parseInt(document.getElementById('metro-sig').value),wrap=document.getElementById('metro-beats');
  if(wrap.children.length!==sig)wrap.innerHTML=Array(sig).fill('<div class="beat-dot"></div>').join('');
  document.querySelectorAll('.beat-dot').forEach((d,i)=>d.classList.toggle('lit',i===metroBeat));
  const osc=metroACtx.createOscillator(),gain=metroACtx.createGain();osc.connect(gain);gain.connect(metroACtx.destination);osc.frequency.value=metroBeat===0?1000:600;
  gain.gain.setValueAtTime(0.3,metroACtx.currentTime);gain.gain.exponentialRampToValueAtTime(0.001,metroACtx.currentTime+0.08);osc.start();osc.stop(metroACtx.currentTime+0.08);
  metroBeat=(metroBeat+1)%sig;metroId=setTimeout(scheduleBeat,60000/metroBpm);
}
function tapBpm(){const now=performance.now();taps.push(now);if(taps.length>8)taps.shift();if(taps.length<2){document.getElementById('tap-ct').textContent='keep tapping…';return;}const avg=taps.slice(1).reduce((s,t,i)=>s+(t-taps[i]),0)/(taps.length-1);document.getElementById('tap-num').textContent=Math.round(60000/avg);document.getElementById('tap-ct').textContent=taps.length+' taps';clearTimeout(window._tt);window._tt=setTimeout(resetTap,2500);}
function resetTap(){taps=[];document.getElementById('tap-num').textContent='—';document.getElementById('tap-ct').textContent='tap at least 4 times';}
function renderRef(){
  const key=document.getElementById('ref-key')?.value||'C',mode=document.getElementById('ref-mode')?.value||'major';
  const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],root=N.indexOf(key);
  const steps=mode==='major'?[0,2,4,5,7,9,11]:[0,2,3,5,7,8,10],scale=steps.map(s=>N[(root+s)%12]);
  const majQ=['maj','min','min','maj','maj','min','dim'],minQ=['min','dim','maj','min','min','maj','maj'],qs=mode==='major'?majQ:minQ;
  const roman=mode==='major'?['I','ii','iii','IV','V','vi','vii°']:['i','ii°','III','iv','v','VI','VII'];
  document.getElementById('ref-out').innerHTML='<div style="margin-bottom:14px;font-size:14px;color:var(--muted)">Scale: <span style="color:var(--white);font-weight:500">'+scale.join(' · ')+'</span></div><div style="display:flex;flex-wrap:wrap;gap:7px">'+scale.map((note,i)=>'<div class="scale-note"><div class="rom">'+roman[i]+'</div><div class="note">'+note+'</div><div class="qual">'+qs[i]+'</div></div>').join('')+'</div>';
}
// ── WAV encoder (AudioBuffer → ArrayBuffer) for drag-out export ──────────────
function encodeWAV(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const bps = 16; // 16-bit PCM
  const length = audioBuffer.length;
  const byteRate = sr * numCh * (bps / 8);
  const blockAlign = numCh * (bps / 8);
  const dataSize = length * numCh * (bps / 8);
  const bufSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufSize);
  const view = new DataView(buf);

  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bps, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels and convert float → int16
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(audioBuffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return buf;
}

// Drag-out state
let dragTempPath = null;
let dragReady = false;

async function prepareDragWav() {
  if (!audioBuf) return;
  dragReady = false;
  const name = (document.getElementById('player-name').textContent || 'audio').trim();
  const wavData = encodeWAV(audioBuf);
  const result = await api.writeTempWav(new Uint8Array(wavData), name);
  if (result.ok) {
    dragTempPath = result.path;
    dragReady = true;
    diagLog('Drag WAV ready: ' + dragTempPath, 'ok');
  } else {
    diagLog('Drag WAV failed: ' + result.error, 'err');
  }
}

// ── Pure JS WAV parser — reads PCM directly, avoids decodeAudioData which hangs in packaged Electron
function parseWAV(arrayBuffer, ctx) {
  const view = new DataView(arrayBuffer);
  const riff = String.fromCharCode(view.getUint8(0),view.getUint8(1),view.getUint8(2),view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a valid WAV file');
  let pos = 12, numChannels, sampleRate, bitsPerSample, dataOffset, dataSize, audioFormat = 1;
  while (pos < arrayBuffer.byteLength - 8) {
    const id   = String.fromCharCode(view.getUint8(pos),view.getUint8(pos+1),view.getUint8(pos+2),view.getUint8(pos+3));
    const size = view.getUint32(pos+4, true);
    if (id === 'fmt ') {
      // audioFormat: 1 = PCM, 3 = IEEE float, 0xFFFE = extensible.
      // Without this, IEEE float WAVs read as INT32 produce garbage —
      // playback would sound like white noise, peaks would show as a
      // uniform amplitude rectangle. Parse it so we route to the right
      // sample-reading branch below.
      audioFormat   = view.getUint16(pos+8,  true);
      numChannels   = view.getUint16(pos+10, true);
      sampleRate    = view.getUint32(pos+12, true);
      bitsPerSample = view.getUint16(pos+22, true);
      diagLog('WAV fmt: ch='+numChannels+' rate='+sampleRate+' bits='+bitsPerSample+' fmt='+(audioFormat===3?'float':'pcm'), 'info');
    } else if (id === 'data') {
      dataOffset = pos+8; dataSize = size; break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!dataOffset) throw new Error('WAV data chunk not found');
  if (!numChannels || !sampleRate) throw new Error('WAV fmt chunk not found');
  const bps = bitsPerSample / 8;
  const frames = Math.floor(dataSize / bps / numChannels);
  diagLog('WAV frames='+frames+' duration='+(frames/sampleRate).toFixed(2)+'s', 'info');
  const buf = ctx.createBuffer(numChannels, frames, sampleRate);
  const isFloat = (audioFormat === 3);
  for (let ch = 0; ch < numChannels; ch++) {
    const out = buf.getChannelData(ch);
    for (let i = 0; i < frames; i++) {
      const p = dataOffset + (i * numChannels + ch) * bps;
      let s;
      if      (isFloat && bitsPerSample === 32) s = view.getFloat32(p, true);
      else if (isFloat && bitsPerSample === 64) s = view.getFloat64(p, true);
      else if (bitsPerSample === 16) s = view.getInt16(p, true) / 32768;
      else if (bitsPerSample === 24) { let v=(view.getUint8(p+2)<<16)|(view.getUint8(p+1)<<8)|view.getUint8(p); if(v>=0x800000)v-=0x1000000; s=v/8388608; }
      else if (bitsPerSample === 32) s = view.getInt32(p, true) / 2147483648;
      else if (bitsPerSample === 8)  s = (view.getUint8(p) - 128) / 128;
      else s = 0;
      // Clamp + handle non-finite (NaN/Inf possible from malformed float WAV)
      if (!isFinite(s)) s = 0;
      out[i] = Math.max(-1, Math.min(1, s));
    }
  }
  return buf;
}

function fmt2time(s){s=Math.max(0,s||0);return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');}
function fmtSec(s){if(!s)return'—';return s>60?Math.floor(s/60)+'m '+Math.floor(s%60)+'s':Math.round(s)+'s';}

// ── Stem separator ────────────────────────────────────────────────────────────

// Called from the Analyze tab — ships the currently loaded track to the separator
// ── Separator queue engine ──────────────────────────────────────────
function enqueueSeparation(filePath, name) {
  if (!filePath) return false;
  if (sepQueue.some(q => q.path === filePath && (q.status === 'waiting' || q.status === 'running'))) return false;
  sepQueue.push({ id: _sepQueueSeq++, path: filePath, name: name || filePath.split(/[/\\]/).pop(), status: 'waiting' });
  renderSepQueue();
  processSepQueue();
  return true;
}

function processSepQueue() {
  if (sepQueueRunning) return;
  const next = sepQueue.find(q => q.status === 'waiting');
  if (!next) { renderSepQueue(); return; }
  sepQueueRunning = true;
  next.status = 'running';
  renderSepQueue();
  // Load it as the active source and reuse the normal start path — all
  // quality toggles apply exactly as if the user clicked Separate.
  sepSourcePath = next.path;
  sepSourceName = next.name;
  showSeparatorSource();
  startSeparation();
}

// Called from the separation done/error handlers. Marks the running job
// and pulls the next one in after a short breather (lets the GPU drain).
function sepQueueAdvance(ok) {
  const running = sepQueue.find(q => q.status === 'running');
  if (running) running.status = ok ? 'done' : 'error';
  sepQueueRunning = false;
  renderSepQueue();
  if (sepQueue.some(q => q.status === 'waiting')) setTimeout(processSepQueue, 1500);
}

function removeFromSepQueue(id) {
  const item = sepQueue.find(q => q.id === id);
  if (!item || item.status === 'running') return; // can't remove the active job
  sepQueue = sepQueue.filter(q => q.id !== id);
  renderSepQueue();
}

function clearSepQueueFinished() {
  sepQueue = sepQueue.filter(q => q.status === 'waiting' || q.status === 'running');
  renderSepQueue();
}

function renderSepQueue() {
  const wrap = document.getElementById('sep-queue');
  const list = document.getElementById('sep-queue-list');
  if (!wrap || !list) return;
  if (!sepQueue.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const lbl = document.getElementById('sep-queue-count');
  const waiting = sepQueue.filter(q => q.status === 'waiting').length;
  if (lbl) lbl.textContent = sepQueue.length + (waiting ? ' · ' + waiting + ' ' + t('sepqWaiting') : '');
  const icon = { waiting: '◌', running: '⏳', done: '✓', error: '✕' };
  list.innerHTML = sepQueue.map(q => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);border-radius:6px;margin-bottom:4px;font-size:12px">
      <span style="width:16px;text-align:center;color:${q.status === 'error' ? '#ff6b6b' : q.status === 'done' ? '#7ed982' : 'var(--hint)'}">${icon[q.status]}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--white)">${escapeHtml(q.name)}</span>
      ${q.status === 'waiting' ? `<button class="btn xs" onclick="removeFromSepQueue(${q.id})">✕</button>` : ''}
    </div>`).join('');
}

function sendToSeparator() {
  if (!lastFilePath) {
    showAppNotification('✕ Load a track first', 'err');
    return;
  }
  sepSourcePath = lastFilePath;
  sepSourceName = sepLastSourceName || lastFilePath.split(/[/\\]/).pop();
  showSeparatorSource();
  showTab(document.querySelector('[data-tab="stems"]'));
}

// Drop or pick a file directly into the separator
function loadSeparatorFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.path) {
    showAppNotification('✕ Cannot read file path', 'err');
    return;
  }
  sepSourcePath = f.path;
  sepSourceName = f.name;
  showSeparatorSource();
}

function clearSeparatorSource() {
  sepSourcePath = null;
  sepSourceName = null;
  document.getElementById('stems-options').classList.add('hidden');
  document.getElementById('drop-stems').parentElement.classList.remove('hidden');
}

function showSeparatorSource() {
  document.getElementById('stems-source-name').textContent = sepSourceName || '—';
  document.getElementById('stems-options').classList.remove('hidden');
  // Hide drop card now that we have a source
  document.getElementById('drop-stems').parentElement.classList.add('hidden');
  // Reset progress + results from any prior run
  document.getElementById('stems-progress').classList.add('hidden');
  document.getElementById('stems-results').classList.add('hidden');
}

function setStemMode(btn) {
  document.querySelectorAll('#stems-options .fmt[data-mode]').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  sepMode = btn.dataset.mode;
  const desc = document.getElementById('stems-mode-desc');
  if (desc) desc.textContent = sepMode === '6' ? t('sepMode6Desc') : t('sepMode4Desc');
}

function setStemQuality(btn) {
  document.querySelectorAll('#stems-options .fmt[data-quality]').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  sepQuality = btn.dataset.quality;
  const desc = document.getElementById('stems-quality-desc');
  if (desc) desc.textContent = t('sepQuality_' + sepQuality);
}

// Direct mode skips Stage 1 (vocal isolation) entirely. Faster, and producer
// vocal samples that are part of the beat (ad-libs, vocal chops, sample
// vocals) stay in 'other' instead of being merged with lead vocals.
function setDirectMode(checked) {
  sepDirectMode = !!checked;
  // Stage 1 indicator on the progress card needs to dim when direct mode is
  // active so the user understands the pipeline shape they picked.
  const stage1 = document.getElementById('stage-pill-1');
  if (stage1) stage1.style.opacity = sepDirectMode ? '0.35' : '';
  // Direct mode + split lead are mutually exclusive — lead-vocal split needs
  // a clean vocals.wav from Stage 1 to operate on. Disable the toggle.
  const splitLeadBox = document.getElementById('stems-split-lead');
  if (splitLeadBox) {
    splitLeadBox.disabled = !!checked;
    if (checked && splitLeadBox.checked) {
      splitLeadBox.checked = false;
      window.sepSplitLead = false;
    }
  }
}

function setSplitLead(checked) {
  // Lead-vocal split adds Stage 1.5: separating the Stage 1 vocals.wav into
  // lead and backing+samples sub-stems. Stored as a window-scoped flag so
  // startSeparation can read it. Persisted? No — user re-picks per track.
  window.sepSplitLead = !!checked;
}

// Ensemble: when on AND quality is high/ultra, run a second Stage 2 model
// and average outputs on piano/other/guitar. Trades 30% extra runtime for
// 0.3-0.8 dB SDR gain on those stems. Persisted in localStorage because
// users who care about quality tend to want it on by default once they try
// it.
function setEnsemble(checked) {
  window.sepEnsemble = !!checked;
  try { localStorage.setItem('freqphull.ensemble', checked ? '1' : '0'); } catch {}
}

// Vocal ensemble: runs a second vocal isolation model alongside the primary
// and averages outputs. Different from Stage 2 ensemble — targets vocal
// quality specifically. Persisted because vocal-focused workflows (sampling,
// remixing, karaoke production) typically want it on by default.
function setVocalEnsemble(checked) {
  window.sepVocalEnsemble = !!checked;
  try { localStorage.setItem('freqphull.vocalEnsemble', checked ? '1' : '0'); } catch {}
}

// De-reverb: removes reverb tail/echo from the isolated vocal stem. Useful
// for sampling/remixing vocals recorded with heavy ambience. Persisted so
// users who use it for a producer workflow have it ready every time.
function setDereverb(checked) {
  window.sepDereverb = !!checked;
  try { localStorage.setItem('freqphull.dereverb', checked ? '1' : '0'); } catch {}
}

// ── Quality Advanced (fullness restoration controls) ────────────────────
// Four pieces of state:
//   - sepFullnessPreset:    'subtle' | 'balanced' | 'aggressive'
//   - sepFullnessSustainOverride:    null or float 0..2
//   - sepFullnessDuckingOverride:    null or float 0..8 (dB)
//   - sepFullnessTransientOverride:  null or float 0..8 (dB)
// All persist in localStorage so power users don't reset their workflow
// every time. Override values of null mean "use preset default" — the
// server only forwards them to python when they're set.
window.sepFullnessPreset = 'balanced';
window.sepFullnessSustainOverride = null;
window.sepFullnessDuckingOverride = null;
window.sepFullnessTransientOverride = null;

// Maps the preset name to the slider values it represents. Used to keep
// the slider UI in visual sync with the preset dropdown so users
// understand what each preset actually does. KEEP IN SYNC with
// FULLNESS_PRESETS in stems.py.
const _FULLNESS_PRESET_VALUES = {
  subtle:     { sustain: 0.40, ducking_db: 2.0, transient_db: 1.5 },
  balanced:   { sustain: 1.00, ducking_db: 4.0, transient_db: 3.0 },
  aggressive: { sustain: 1.50, ducking_db: 6.0, transient_db: 5.0 },
};

function toggleQualityAdvanced() {
  // Expand/collapse the whole Quality Advanced panel. Chevron rotates
  // via the .open class on the parent.
  const wrap = document.getElementById('quality-advanced');
  const body = document.getElementById('quality-advanced-body');
  if (!wrap || !body) return;
  const open = wrap.classList.toggle('open');
  body.classList.toggle('hidden', !open);
}

function toggleQualityPerPass() {
  // Expand/collapse the per-pass slider section inside Quality Advanced.
  const btn = document.getElementById('qa-advanced-toggle');
  const wrap = document.getElementById('qa-perpass');
  if (!btn || !wrap) return;
  const open = btn.classList.toggle('open');
  wrap.classList.toggle('hidden', !open);
}

function setFullnessPreset(name) {
  if (!['subtle', 'balanced', 'aggressive'].includes(name)) name = 'balanced';
  window.sepFullnessPreset = name;
  // Update the header pill so the user sees the active preset without
  // expanding the panel.
  const pill = document.getElementById('quality-advanced-pill');
  if (pill) {
    pill.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    pill.classList.remove('subtle', 'aggressive');
    if (name === 'subtle') pill.classList.add('subtle');
    if (name === 'aggressive') pill.classList.add('aggressive');
  }
  // Move the sliders to match the new preset's default values. This
  // ALSO clears any per-pass overrides because picking a preset is the
  // primary user intent — if they wanted overrides, they'd touch the
  // sliders after.
  const vals = _FULLNESS_PRESET_VALUES[name];
  if (vals) {
    _setSliderValue('qa-sustain',   'qa-sustain-val',   vals.sustain,     'x');
    _setSliderValue('qa-ducking',   'qa-ducking-val',   vals.ducking_db,  '+db');
    _setSliderValue('qa-transient', 'qa-transient-val', vals.transient_db,'±db');
  }
  window.sepFullnessSustainOverride = null;
  window.sepFullnessDuckingOverride = null;
  window.sepFullnessTransientOverride = null;
  try {
    localStorage.setItem('freqphull.fullnessPreset', name);
    localStorage.removeItem('freqphull.fullnessSustainOverride');
    localStorage.removeItem('freqphull.fullnessDuckingOverride');
    localStorage.removeItem('freqphull.fullnessTransientOverride');
  } catch {}
}

function _setSliderValue(sliderId, valId, value, fmt) {
  const s = document.getElementById(sliderId);
  const v = document.getElementById(valId);
  if (s) s.value = String(value);
  if (v) {
    if (fmt === 'x')   v.textContent = (parseFloat(value).toFixed(2)) + '×';
    else if (fmt === '+db') v.textContent = (parseFloat(value) > 0 ? '+' : '') + parseFloat(value) + ' dB';
    else if (fmt === '±db') v.textContent = '±' + parseFloat(value) + ' dB';
    else v.textContent = String(value);
  }
}

function onFullnessSustainChange(val) {
  const v = parseFloat(val);
  window.sepFullnessSustainOverride = isFinite(v) ? v : null;
  const lbl = document.getElementById('qa-sustain-val');
  if (lbl) lbl.textContent = v.toFixed(2) + '×';
  try { localStorage.setItem('freqphull.fullnessSustainOverride', String(v)); } catch {}
}
function onFullnessDuckingChange(val) {
  const v = parseFloat(val);
  window.sepFullnessDuckingOverride = isFinite(v) ? v : null;
  const lbl = document.getElementById('qa-ducking-val');
  if (lbl) lbl.textContent = (v > 0 ? '+' : '') + v + ' dB';
  try { localStorage.setItem('freqphull.fullnessDuckingOverride', String(v)); } catch {}
}
function onFullnessTransientChange(val) {
  const v = parseFloat(val);
  window.sepFullnessTransientOverride = isFinite(v) ? v : null;
  const lbl = document.getElementById('qa-transient-val');
  if (lbl) lbl.textContent = '±' + v + ' dB';
  try { localStorage.setItem('freqphull.fullnessTransientOverride', String(v)); } catch {}
}

function resetFullnessOverrides() {
  // "Reset overrides" doesn't change the preset — just clears any per-pass
  // overrides and moves the sliders back to the preset's defaults.
  const name = window.sepFullnessPreset || 'balanced';
  setFullnessPreset(name);
}

// "Auto-send to detected folder" — when enabled, the post-download
// auto-match call passes commit:true so the server promotes the best
// match to primary AND physically moves the file into the folder.
// "Auto-tag downloads": when OFF, the post-download auto-match call is
// skipped entirely — tracks arrive in History untagged regardless of
// whether their title matches a folder's artist seeds. Users who want
// pure manual organization opt out here. Defaults ON (the original
// behavior since 0.0.8). Stored as freqphull.autoTag === '0' for OFF,
// so the absence of the key means ON.
function toggleAutoTag(checked) {
  localStorage.setItem('freqphull.autoTag', checked ? '1' : '0');
  syncPrefsToServer();
  if (typeof showAppNotification === 'function') {
    showAppNotification(checked ? t('autoTagOnNotif') : t('autoTagOffNotif'), 'info', null, 3000);
  }
}
// Single source of truth — every gate uses this helper.
function autoTagEnabled() { return localStorage.getItem('freqphull.autoTag') !== '0'; }

function toggleAutoSend(checked) {
  localStorage.setItem('freqphull.autoSend', checked ? '1' : '0');
  syncPrefsToServer(); // extension downloads + watch folder honor it too
  if (typeof showAppNotification === 'function') {
    showAppNotification(checked ? t('autoSendOnNotif') : t('autoSendOffNotif'), 'info', null, 3000);
  }
}

// ── Hardware Acceleration (v0.2.8) ───────────────────────────────
async function syncHardwareAccelToggle() {
  if (!window.api || !window.api.bootFlags) return;
  try {
    const flags = await window.api.bootFlags.get();
    const el = document.getElementById('hw-accel-toggle');
    if (el) el.checked = flags.hardwareAcceleration !== false;
  } catch {}
}
async function toggleHardwareAcceleration(checked) {
  if (!window.api || !window.api.bootFlags) {
    showAppNotification(t('hwAccelUnavailable'), 'warn'); return;
  }
  try {
    await window.api.bootFlags.set({ hardwareAcceleration: !!checked });
    const msg = checked ? t('hwAccelOnNotif') : t('hwAccelOffNotif');
    if (typeof confirmModal === 'function') {
      const ok = await confirmModal({
        title: t('hwAccelRestartTitle'),
        message: msg + '\n\n' + t('hwAccelRestartBody'),
        okLabel: t('hwAccelRestartNow'),
        cancelLabel: t('hwAccelRestartLater'),
      });
      if (ok && window.api.app && window.api.app.relaunch) window.api.app.relaunch();
    } else {
      showAppNotification(msg + ' - ' + t('hwAccelRestartLater'), 'info', null, 5000);
    }
  } catch (e) { showAppNotification('X ' + e.message, 'err'); }
}

// ── Extension repo link + how-to modal (v0.2.8) ────────────────────
const EXT_REPO_URL = 'https://github.com/CodePhull/FreqPhull-realease/tree/main/freqpull-ext';
function openExtensionPage() {
  if (window.api && window.api.openExternal) window.api.openExternal(EXT_REPO_URL);
  else window.open(EXT_REPO_URL, '_blank');
}
function openExtensionHowTo() {
  let modal = document.getElementById('ext-howto-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ext-howto-modal';
    modal.className = 'setup-modal';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="setup-card ext-howto-card" style="max-width:640px;max-height:84vh;display:flex;flex-direction:column;padding:28px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px">
        <div>
          <div class="setup-title" style="font-size:24px;text-align:left;margin-bottom:4px">${t('extHowToTitle')}</div>
          <div style="font-size:13px;color:var(--muted);max-width:480px">${t('extHowToSub')}</div>
        </div>
        <button class="btn xs" onclick="document.getElementById('ext-howto-modal').style.display='none'" aria-label="Close">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding-right:6px">
        <ol class="ext-howto-list">
          <li><div class="ext-howto-step-num">1</div><div class="ext-howto-step-body">
            <div class="ext-howto-step-title">${t('extHowToStep1Title')}</div>
            <div class="ext-howto-step-desc">${t('extHowToStep1Desc')}</div>
            <button class="btn sm pri" onclick="openExtensionPage()">${t('extHowToStep1Btn')}</button>
          </div></li>
          <li><div class="ext-howto-step-num">2</div><div class="ext-howto-step-body">
            <div class="ext-howto-step-title">${t('extHowToStep2Title')}</div>
            <div class="ext-howto-step-desc">${t('extHowToStep2Desc')}</div>
            <code class="ext-howto-code">chrome://extensions</code>
          </div></li>
          <li><div class="ext-howto-step-num">3</div><div class="ext-howto-step-body">
            <div class="ext-howto-step-title">${t('extHowToStep3Title')}</div>
            <div class="ext-howto-step-desc">${t('extHowToStep3Desc')}</div>
          </div></li>
          <li><div class="ext-howto-step-num">4</div><div class="ext-howto-step-body">
            <div class="ext-howto-step-title">${t('extHowToStep4Title')}</div>
            <div class="ext-howto-step-desc">${t('extHowToStep4Desc')}</div>
          </div></li>
          <li><div class="ext-howto-step-num">5</div><div class="ext-howto-step-body">
            <div class="ext-howto-step-title">${t('extHowToStep5Title')}</div>
            <div class="ext-howto-step-desc">${t('extHowToStep5Desc')}</div>
          </div></li>
        </ol>
        <div class="ext-howto-tip">${t('extHowToTip')}</div>
      </div>
      <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('ext-howto-modal').style.display='none'">${t('spCancel')}</button>
        <button class="btn pri" onclick="openExtensionPage()">${t('extHowToOpenRepo')}</button>
      </div>
    </div>`;
}

function toggleCpuOnly(checked) {
  // Persisted in localStorage so the setting survives app restarts.
  // Read by startSeparation to add ?cpuOnly=1 to the /stems request.
  localStorage.setItem('freqphull.cpuOnly', checked ? '1' : '0');
  if (typeof showAppNotification === 'function') {
    showAppNotification(checked ? 'Stem separator will use CPU only' : 'Stem separator will use GPU if available', 'info', null, 2500);
  }
}

// Toggle whether to stamp BPM/key into audio file metadata after analysis.
// Default ON — the value '0' means OFF; any other value (including absent)
// means ON. This way new users get the feature by default and only people
// who explicitly disabled it stay disabled.
function toggleWriteTags(checked) {
  localStorage.setItem('freqphull.writeTags', checked ? '1' : '0');
  if (typeof showAppNotification === 'function') {
    showAppNotification(
      checked
        ? 'Analysis will write BPM/key into audio file tags'
        : 'Analysis will NOT modify audio file tags',
      'info', null, 2500
    );
  }
}

async function startSeparation() {
  if (!sepSourcePath) {
    showAppNotification('✕ ' + t('sepNoTrack'), 'err');
    return;
  }
  if (!backendOnline) {
    showAppNotification('✕ ' + t('sepBackendOffline'), 'err');
    return;
  }

  // Preflight: if engines aren't installed, prompt the user to run setup instead
  // of letting the SSE call fail with a confusing error.
  try {
    const r = await fetch(API + '/engines-status');
    const j = await r.json();
    if (!j.installed) {
      const ok = await confirmModal({
        title: t('setupRequired') || 'Setup required',
        message: t('setupNotInstalled') || 'The separator engines are not installed yet. Run setup now?',
        okLabel: t('setupRun') || 'Run setup',
        cancelLabel: 'Cancel',
      });
      if (ok) showSetupModal();
      return;
    }
  } catch (e) {
    // Backend probably hiccup — just proceed and let SSE surface any error
    diagLog('engines preflight failed: ' + e.message, 'err');
  }

  // Stop any prior playback before kicking off a new run
  stopAllStems();

  const btn = document.getElementById('btn-separate');
  btn.disabled = true;
  document.getElementById('stems-progress').classList.remove('hidden');
  document.getElementById('stems-results').classList.add('hidden');
  resetStagePills();
  setStemProgress(0, t('sepPreparing'), '');

  // Clean up any previous SSE
  if (sepEvtSource) try { sepEvtSource.close(); } catch {}

  // Read the new toggles. sepSplitLead defaults false; sepCpuOnly +
  // ensemble + vocalEnsemble + dereverb persist via localStorage so they
  // survive restarts.
  const splitLead     = !!window.sepSplitLead;
  const cpuOnly       = localStorage.getItem('freqphull.cpuOnly') === '1';
  const ensemble      = !!window.sepEnsemble;
  const vocalEnsemble = !!window.sepVocalEnsemble;
  const dereverb      = !!window.sepDereverb;
  // Quality Advanced controls
  const fullnessPreset = window.sepFullnessPreset || 'balanced';
  const fullnessSustain     = window.sepFullnessSustainOverride;
  const fullnessDucking     = window.sepFullnessDuckingOverride;
  const fullnessTransient   = window.sepFullnessTransientOverride;

  const url = API + '/stems'
    + '?path=' + encodeURIComponent(sepSourcePath)
    + '&mode=' + encodeURIComponent(sepMode)
    + '&quality=' + encodeURIComponent(sepQuality)
    + (sepDirectMode ? '&direct=1' : '')
    + (splitLead ? '&splitLead=1' : '')
    + (cpuOnly ? '&cpuOnly=1' : '')
    + (ensemble ? '&ensemble=1' : '')
    + (vocalEnsemble ? '&vocalEnsemble=1' : '')
    + (dereverb ? '&dereverb=1' : '')
    + '&fullnessPreset=' + encodeURIComponent(fullnessPreset)
    + (fullnessSustain   !== null && fullnessSustain   !== undefined ? '&fullnessSustain='     + fullnessSustain   : '')
    + (fullnessDucking   !== null && fullnessDucking   !== undefined ? '&fullnessDuckingDb='   + fullnessDucking   : '')
    + (fullnessTransient !== null && fullnessTransient !== undefined ? '&fullnessTransientDb=' + fullnessTransient : '');

  sepEvtSource = new EventSource(url);

  sepEvtSource.addEventListener('progress', e => {
    try {
      const m = JSON.parse(e.data);
      const pct = typeof m.progress === 'number' ? m.progress : null;
      const stepLabel = stepToLabel(m.step, m);
      setStemProgress(pct, stepLabel, formatStepDetail(m));
      updateStagePills(m.step);
    } catch {}
  });

  // Warnings — non-fatal messages from the python pipeline. Currently used
  // for CPU+ultra slow-warning and for lead-vocal-split failure fallback.
  // Render as toast notifications; pipeline keeps running underneath.
  sepEvtSource.addEventListener('warning', e => {
    try {
      const m = JSON.parse(e.data);
      const msg = m.message || 'Warning';
      const hint = m.hint ? '\n' + m.hint : '';
      showAppNotification('⚠ ' + msg + hint, 'info', null, 8000);
      diagLog('[stems-warn] ' + msg + (m.hint ? ' · ' + m.hint : ''), 'warn');
    } catch {}
  });

  sepEvtSource.addEventListener('done', e => {
    try {
      const m = JSON.parse(e.data);
      sepCurrent = m;
      // Reset master result so the new separation starts with a clean
      // master section (no stale "previous result" stats showing).
      masterResult = null;
      const masterProg = document.getElementById('master-progress');
      const masterRes = document.getElementById('master-result');
      if (masterProg) masterProg.classList.add('hidden');
      if (masterRes) masterRes.classList.add('hidden');
      setStemProgress(100, t('sepStageDone'), '');
      renderStemPlayers(m);
      document.getElementById('stems-results').classList.remove('hidden');
      // Smooth UX — fade out the progress card after a beat
      setTimeout(() => document.getElementById('stems-progress').classList.add('hidden'), 600);
      const procTime = m.processing_time ? ' · ' + m.processing_time + 's' : '';
      showAppNotification('✓ ' + t('sepReady') + procTime, 'done');
      loadSepHistory();
    } catch {}
    btn.disabled = false;
    if (sepEvtSource) { sepEvtSource.close(); sepEvtSource = null; }
    sepQueueAdvance(true);
  });

  sepEvtSource.addEventListener('error', e => {
    let msg = t('sepFailed');
    let hint = '';
    try {
      const m = JSON.parse(e.data);
      if (m.message) msg = m.message;
      if (m.hint) hint = m.hint;
    } catch {
      // EventSource native error — connection dropped
    }
    document.getElementById('stems-progress').classList.add('hidden');
    showAppNotification('✕ ' + msg.slice(0, 60), 'err');
    if (hint) {
      // Surface install hints in the diag log
      diagLog('[stems hint] ' + hint, 'info');
    }
    btn.disabled = false;
    if (sepEvtSource) { sepEvtSource.close(); sepEvtSource = null; }
    sepQueueAdvance(false);
  });
}

function stepToLabel(step, msg) {
  const en = {
    loading_engine:              'Initializing ensemble…',
    loading_vocal_model:         'Loading Stage 1 model…',
    separating_vocals:           'Isolating vocals — Stage 1 of 2',
    vocal_split_complete:        'Vocals isolated ✓',
    loading_vocal_ensemble_model:'Loading vocal ensemble model…',
    separating_vocal_ensemble:   'Vocal ensemble pass — second model for vocal isolation…',
    vocal_ensemble_complete:     'Vocal ensemble pass ✓',
    loading_lead_vocal_model:    'Loading lead-vocal model…',
    separating_lead_vocal:       'Splitting lead from backing vocals…',
    lead_vocal_split_complete:   'Lead/backing vocals split ✓',
    loading_dereverb_model:      'Loading de-reverb model…',
    dereverberating:             'Removing reverb from vocal stem…',
    dereverb_complete:           'Vocal de-reverbed ✓',
    loading_instrumental_model:  'Loading Stage 2 model…',
    separating_instrumental:     'Splitting instrumental — Stage 2 of 2',
    instrumental_split_complete: 'Instrumental split ✓',
    separating_instrumental_ensemble: 'Running ensemble pass — second model for harmonic stems…',
    instrumental_split_ensemble_complete: 'Ensemble pass ✓',
    recovering_stems:            'AI stem recovery — routing misclassified content…',
    restoring_fullness:          'Restoring note tails and ducking compensation…',
    cleaning_back_vocal:         'Removing hat bleed from back vocal stem…',
    post_processing:             'Cleaning bleeds in harmonic stems…',
    per_stem_analysis:           'Analyzing BPM and key on each stem…',
    writing_stems:               'Finalizing stems…',
    // Legacy single-stage labels kept for safety
    loading_model: 'Loading model…',
    loading_audio: 'Loading audio…',
    resampling:    'Resampling…',
    separating:    'Separating stems…',
    retry_smaller_segment: 'Retrying with smaller chunks…',
    writing:       'Writing stems…',
  };
  const fr = {
    loading_engine:              'Initialisation de l\'ensemble…',
    loading_vocal_model:         'Chargement du modèle Étape 1…',
    separating_vocals:           'Isolation des voix — Étape 1 sur 2',
    vocal_split_complete:        'Voix isolées ✓',
    loading_vocal_ensemble_model:'Chargement du modèle ensemble vocal…',
    separating_vocal_ensemble:   'Pass d\'ensemble vocal — second modèle pour l\'isolation…',
    vocal_ensemble_complete:     'Pass d\'ensemble vocal ✓',
    loading_lead_vocal_model:    'Chargement du modèle voix lead…',
    separating_lead_vocal:       'Séparation lead / chœurs…',
    lead_vocal_split_complete:   'Voix lead / chœurs séparées ✓',
    loading_dereverb_model:      'Chargement du modèle dé-réverb…',
    dereverberating:             'Suppression de la réverb sur la voix…',
    dereverb_complete:           'Voix dé-réverbée ✓',
    loading_instrumental_model:  'Chargement du modèle Étape 2…',
    separating_instrumental:     'Séparation instrumentale — Étape 2 sur 2',
    instrumental_split_complete: 'Instrumental séparé ✓',
    separating_instrumental_ensemble: 'Pass d\'ensemble — second modèle pour stems harmoniques…',
    instrumental_split_ensemble_complete: 'Pass d\'ensemble ✓',
    recovering_stems:            'Récupération IA — routage du contenu mal classé…',
    restoring_fullness:          'Restauration des queues de notes et compensation du ducking…',
    cleaning_back_vocal:         'Nettoyage des charlestons dans le stem back vocal…',
    post_processing:             'Nettoyage des fuites inter-stems…',
    per_stem_analysis:           'Analyse BPM et tonalité par stem…',
    writing_stems:               'Finalisation des stems…',
    loading_model: 'Chargement du modèle…',
    loading_audio: 'Lecture du fichier…',
    resampling:    'Rééchantillonnage…',
    separating:    'Séparation en cours…',
    retry_smaller_segment: 'Nouvelle tentative avec des segments plus petits…',
    writing:       'Écriture des fichiers…',
  };
  const d = lang === 'fr' ? fr : en;
  return d[step] || (msg && msg.message) || step || '…';
}

function formatStepDetail(m) {
  const bits = [];
  if (m.stage)    bits.push(m.stage === 'vocal_split' ? t('sepStageVocal') :
                            m.stage === 'instrumental_split' ? t('sepStageInst') : '');
  if (m.model)    bits.push(formatModelName(m.model));
  if (m.device)   bits.push(m.device);
  if (typeof m.overlap === 'number') bits.push('overlap ' + m.overlap);
  if (typeof m.shifts === 'number')  bits.push(m.shifts + ' shift' + (m.shifts === 1 ? '' : 's'));
  if (m.processing_time) bits.push(m.processing_time + 's');
  return bits.filter(Boolean).join(' · ');
}

// Friendly display names for Freq.Phull internal model codenames.
// Real model identities are intentionally not referenced anywhere in this file.
function formatModelName(name) {
  if (!name) return '';
  // Codename map — kept tight on purpose. New codenames should map here.
  const known = {
    'Phull-V2': 'Phull-V2 (vocal)',
    'Phull-I4': 'Phull-I4 (4-stem)',
    'Phull-I6': 'Phull-I6 (6-stem)',
    'Phull-I':  'Phull-I',
  };
  if (known[name]) return known[name];
  // Anything else: display as-is. Old separator-history rows from a previous
  // build may carry legacy real-name strings — those are stripped on read
  // by stripLegacyModelName() below before reaching the UI.
  return stripLegacyModelName(name);
}

// Defense-in-depth: any model name persisted in older history rows that
// happens to be a real artifact filename gets coerced to a codename for display.
function stripLegacyModelName(name) {
  const s = String(name);
  if (/bs[_-]?roformer/i.test(s))    return 'Phull-V2 (vocal)';
  if (/htdemucs[_-]?ft/i.test(s))    return 'Phull-I4 (4-stem)';
  if (/htdemucs[_-]?6s/i.test(s))    return 'Phull-I6 (6-stem)';
  if (/htdemucs/i.test(s))           return 'Phull-I';
  // Strip extension on anything else and call it good
  return s.replace(/\.(ckpt|yaml|onnx|pth|pt|bin)$/i, '');
}

function setStemProgress(pct, msg, detail) {
  const fill = document.getElementById('stems-prog-fill');
  const pctEl = document.getElementById('stems-prog-pct');
  const msgEl = document.getElementById('stems-prog-msg');
  const detEl = document.getElementById('stems-prog-detail');
  if (fill && typeof pct === 'number') fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  if (msgEl && msg !== undefined) msgEl.textContent = msg;
  if (detEl && detail !== undefined) detEl.textContent = detail;
}

function resetStagePills() {
  ['stage-pill-1', 'stage-pill-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active', 'done');
  });
}

function updateStagePills(step) {
  const pill1 = document.getElementById('stage-pill-1');
  const pill2 = document.getElementById('stage-pill-2');
  if (!pill1 || !pill2) return;
  // Stage 1 active: anything before vocals are done
  if (['loading_engine','loading_vocal_model','separating_vocals'].includes(step)) {
    pill1.classList.add('active');
    pill1.classList.remove('done');
    pill2.classList.remove('active', 'done');
  } else if (step === 'vocal_split_complete') {
    pill1.classList.remove('active');
    pill1.classList.add('done');
  } else if (['loading_instrumental_model','separating_instrumental'].includes(step)) {
    pill1.classList.remove('active');
    pill1.classList.add('done');
    pill2.classList.add('active');
    pill2.classList.remove('done');
  } else if (step === 'instrumental_split_complete' || step === 'writing_stems') {
    pill1.classList.add('done');
    pill1.classList.remove('active');
    pill2.classList.add('done');
    pill2.classList.remove('active');
  }
}

function renderStemPlayers(result) {
  const list = document.getElementById('stem-list');
  if (!list) return;
  stopAllStems();
  destroyMixer();
  sepAudioMap = {};

  // Show the ensemble badge — proves the quality on screen
  const badge = document.getElementById('ensemble-badge');
  const badgeTxt = document.getElementById('ensemble-badge-text');
  if (badge && badgeTxt) {
    if (result.ensemble && Array.isArray(result.models) && result.models.length >= 2) {
      const m1 = formatModelName(result.models[0]);
      const m2 = formatModelName(result.models[1]);
      badgeTxt.textContent = 'Ensemble · ' + m1 + ' + ' + m2;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  const stems = result.stems || [];
  // Stem order is mutable (drag-to-reorder); we keep an index array that
  // points back into the stable sepAudioMap keys.
  stemOrder = stems.map((_, i) => i);

  // Master transport — appears above the stem rows.
  // Per-stem rows have: drag-handle, color, name, mute, solo, volume, pan, seek bar, drag-to-DAW
  list.innerHTML = `
    <div class="mixer-master">
      <div class="mixer-master-info">
        <div class="mixer-master-title">${t('sepMixerTitle')}</div>
        <div class="mixer-master-time" id="mixer-time">0:00 / 0:00</div>
      </div>
      <div class="mixer-master-controls">
        <button class="mixer-btn mixer-btn-primary" id="mixer-play-all" onclick="mixerPlayPauseAll()" title="${t('sepPlayAll')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          <span id="mixer-play-all-label">${t('sepPlayAll')}</span>
        </button>
        <button class="mixer-btn" onclick="mixerStopAll()" title="${t('sepStopAll')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14"/></svg>
        </button>
        <button class="mixer-btn" id="mixer-loop-btn" onclick="mixerToggleLoop()" title="${t('sepLoopRegion') || 'Loop region'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
        <button class="mixer-btn" onclick="mixerResetLevels()" title="${t('sepReset')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        </button>
      </div>
      <!-- Master fader — controls the whole mix without changing per-stem levels.
           Range 0–1.4 (≈+3dB headroom for quiet stem collections). -->
      <div class="mixer-master-fader" title="${t('sepMasterVolume') || 'Master volume'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
        <input type="range" class="mixer-master-vol" id="mixer-master-vol" min="0" max="1.4" step="0.01" value="${mixerMasterVolume}" oninput="setMasterVolume(this.value)">
        <div class="mixer-master-vol-lbl" id="mixer-master-vol-lbl">0 dB</div>
      </div>
      <!-- Master VU meter — stereo bars showing real-time output level. Red
           segment lights when peaks approach 0 dBFS (clipping risk). -->
      <div class="mixer-master-vu" id="mixer-master-vu" title="Output level">
        <div class="mixer-master-vu-bar"><div class="mixer-master-vu-fill" id="mixer-master-vu-l"></div></div>
        <div class="mixer-master-vu-bar"><div class="mixer-master-vu-fill" id="mixer-master-vu-r"></div></div>
      </div>
      <div class="mixer-master-seek" id="mixer-master-seek" onclick="mixerSeekMaster(event)">
        <div class="mixer-master-seek-fill" id="mixer-master-seek-fill"></div>
      </div>
    </div>
    <!-- Master waveform timeline — overlays all stems in their own colors at
         low alpha so the user sees the song shape at a glance, like a DAW
         overview lane. Click to seek; drag with Shift held to set loop region. -->
    <div class="mixer-master-waveform" id="mixer-master-waveform"
         onclick="mixerSeekMaster(event)"
         onmousedown="mixerMasterMouseDown(event)"
         title="${t('sepSeekMaster') || 'Click to seek · Shift+drag to set loop'}">
      <canvas id="mixer-master-wave"></canvas>
      <canvas id="mixer-master-grid"></canvas>
      <div class="mixer-master-loop-region" id="mixer-master-loop-region"></div>
      <div class="mixer-master-wave-playhead" id="mixer-master-wave-playhead"></div>
    </div>
    <div class="mixer-stems" id="mixer-stems">
      ${stems.map((s, i) => renderStemRow(s, i, result.per_stem_analysis || {})).join('')}
    </div>
  `;

  // Build the audio graph: each stem → GainNode (mute/volume) → StereoPannerNode → destination.
  // Sharing one AudioContext keeps everything sample-clock-aligned.
  if (!window.AudioContext && !window.webkitAudioContext) {
    showAppNotification('✕ Web Audio API not supported in this Electron version', 'err');
    return;
  }
  mixerCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Master chain: stems → masterGain → masterAnalyser → destination.
  // masterGain is the single fader that controls the whole mix without
  // touching individual stem volumes. masterAnalyser feeds the VU meter
  // — it's a tap (not in series), so meter failure can't break audio.
  mixerMasterGain = mixerCtx.createGain();
  mixerMasterGain.gain.value = mixerMasterVolume;
  mixerMasterAnalyser = mixerCtx.createAnalyser();
  mixerMasterAnalyser.fftSize = 256;  // small = cheap, plenty for level metering
  mixerMasterAnalyser.smoothingTimeConstant = 0.4;  // some smoothing so bars don't twitch
  mixerMasterGain.connect(mixerMasterAnalyser);
  mixerMasterAnalyser.connect(mixerCtx.destination);

  // Stage 1: render the rows immediately with placeholder state so the UI
  // appears instantly. The buffers + peaks will fill in over the next
  // 1–2 seconds as the fetches complete (single fetch per stem, no races).
  stems.forEach((s, i) => {
    sepAudioMap[i] = {
      audio: null,        // filled after fetch+blob-url
      path: s.path,
      gain: null,
      panner: null,
      source: null,
      muted: false,
      soloed: false,
      volume: 1.0,
      pan: 0.0,
      peaks: null,        // Float32Array per pixel, filled after decode
      buffer: null,       // AudioBuffer (kept so we can recompute peaks on resize)
      loaded: false,
    };
  });

  // Stage 2: serial fetch + decode loop. We do these one at a time so the
  // renderer never has >1 outstanding HTTP request for a stem file — that
  // was the crash trigger on Windows (multiple parallel fetches against
  // the same server racing against MediaElementSource binding). One file
  // at a time is plenty fast (~50ms per stem at local server speed).
  loadStemsSerially(stems).then(() => {
    diagLog('All stems loaded — waveforms painted', 'ok');
  }).catch(err => {
    diagLog('Stem load failed: ' + err.message, 'err');
  });

  // Start the master tick — keeps the master seek bar + timestamp in sync
  // with the longest playing stem. RequestAnimationFrame at ~60fps; cheap.
  startMixerTick();
}

// One-fetch-per-stem loader. Returns a promise that resolves when all
// stems are decoded, peaks computed, and the audio elements are wired
// up to the Web Audio graph.
async function loadStemsSerially(stems) {
  diagLog('loadStemsSerially: starting ' + stems.length + ' stems', 'info');
  for (let i = 0; i < stems.length; i++) {
    const s = stems[i];
    try {
      await loadOneStem(i, s);
    } catch (err) {
      diagLog('Stem ' + i + ' (' + s.name + ') load failed: ' + err.message, 'err');
      paintStemPlaceholder(i, 'load failed');
      // CRITICAL: continue with next stem even if this one failed. A single
      // bad file (corrupt, missing, decode error) must NOT block the rest.
    }
  }
  diagLog('loadStemsSerially: all stems processed', 'info');
  // Paint the master overview waveform with whatever loaded
  paintMasterWaveform();
  // Bar/beat grid overlay if BPM is known
  paintBpmGrid();
  // Restore loop region overlay (cleared on teardown; redrawn here if set)
  updateLoopRegionUI();
  // Wire ResizeObservers to per-stem wave wrappers so resize repaints
  // happen exactly when each row settles, not during the transient
  // mid-resize frames where clientWidth can read 0.
  setupStemRowResizeObservers();
}

// Master waveform — all stems overlaid in their respective colors, at low
// alpha so they layer transparently. The user sees the overall song shape
// at a glance: vocal phrases pop in red over the bass+drum bed, dropouts
// are visible as flat sections, etc. Like a DAW overview lane.
function paintMasterWaveform() {
  const canvas = document.getElementById('mixer-master-wave');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.max(2, Math.floor(w * dpr));
  canvas.height = Math.max(2, Math.floor(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const stemColors = {
    vocals: '#e84040', drums: '#f59e0b', bass: '#a855f7',
    other: '#6b7280', guitar: '#4caf50', piano: '#3b82f6',
    // Lead/backing/sample vocal sub-stems — vocals-family palette, distinct shades
    lead_vocal: '#ff5566', back_vocal: '#b03030', sample_vocal: '#7a2424',
  };

  // Centerline
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, h/2 - 0.5, w, 1);

  const mid = h / 2;
  const maxBarH = (h - 4) / 2;

  // Paint each stem in its color at low alpha. Layer order matters: paint
  // bigger/quieter stuff first (bass, drums) and vocals/leads last so they
  // pop on top. The vocal sub-stems (lead_vocal, back_vocal, sample_vocal)
  // share the top layer with vocals — order within that group is arbitrary.
  const layerOrder = ['bass', 'drums', 'other', 'piano', 'guitar', 'vocals',
                      'back_vocal', 'sample_vocal', 'lead_vocal'];

  // Pre-compute master peaks at full pixel width using each stem's already-
  // decoded buffer. We don't recompute every paint — once is enough.
  const entries = Object.entries(sepAudioMap)
    .map(([k, e]) => [parseInt(k, 10), e])
    .filter(([, e]) => e && (e.miniPeaks || e.peaks));
  if (!entries.length) return;

  // Find the stem-class for each entry by querying the row's color marker
  const stemClassOf = (idx) => {
    const el = document.querySelector('#stem-row-' + idx + ' .stem-color');
    if (!el) return 'other';
    for (const c of el.classList) {
      if (layerOrder.includes(c)) return c;
    }
    return 'other';
  };

  // Sort entries by layer order so vocals paint last (on top)
  entries.sort((a, b) => {
    const ca = stemClassOf(a[0]);
    const cb = stemClassOf(b[0]);
    return layerOrder.indexOf(ca) - layerOrder.indexOf(cb);
  });

  const numPx = Math.floor(w);
  for (const [idx, e] of entries) {
    const cls = stemClassOf(idx);
    const color = stemColors[cls] || '#888';
    // Peaks at master width — resample from mini-peaks cache
    let peaks = e.masterPeaks;
    if (!peaks || peaks.length !== numPx) {
      const src = e.miniPeaks || e.peaks;
      if (!src) continue;
      peaks = resamplePeaks(src, numPx);
      e.masterPeaks = peaks;
    }
    ctx.fillStyle = color;
    // Layer alpha — vocals brightest, other quieter
    ctx.globalAlpha = (cls === 'vocals') ? 0.75 :
                      (cls === 'drums' || cls === 'bass') ? 0.50 : 0.35;
    for (let px = 0; px < numPx; px++) {
      const v = peaks[px];
      const barH = Math.max(0.5, v * maxBarH);
      ctx.fillRect(px, mid - barH, 1, barH * 2);
    }
  }
  ctx.globalAlpha = 1;
}

async function loadOneStem(i, s) {
  const url = API + '/file?path=' + encodeURIComponent(s.path);
  diagLog('Stem ' + i + ' (' + s.name + '): fetching ' + url, 'info');

  // Single fetch — get the full WAV bytes.
  const resp = await fetchWithTimeout(url, 30000);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const arrayBuf = await resp.arrayBuffer();
  diagLog('Stem ' + i + ': fetched ' + arrayBuf.byteLength + ' bytes', 'info');

  const entry = sepAudioMap[i];
  if (!entry) return;  // mixer was torn down while we were fetching

  // Cache the raw WAV bytes on the entry. The mini-DAW needs Web Audio
  // AudioBuffers (not MediaElementSource bindings) to schedule
  // BufferSourceNodes against the timeline; we lazily build those when the
  // DAW opens via parseWAV. Holding ArrayBuffers here is OK — typical stem
  // is 25-40 MB, 6 stems × 35 MB ≈ 210 MB, well within Electron renderer
  // memory budget on Windows. Cleared in teardownStemsView when the user
  // closes the results screen.
  entry.rawWavBytes = arrayBuf;

  // Compute peaks DIRECTLY from the WAV bytes — NEVER call decodeAudioData.
  // We've confirmed decodeAudioData hangs the renderer thread on Windows
  // for stem-sized WAVs (28MB+). The hang is at the native Chromium level
  // so JS timeouts can't rescue from it. The Analyze tab already worked
  // around this with parseWAV(); we use the same approach here.
  try {
    // peaksFromWAV reads the WAV chunks and computes per-pixel max-abs
    // amplitudes without allocating a full AudioBuffer. Fast enough on
    // 28MB files (~100ms) and uses minimal memory.
    const targetPx = getWaveformPixelWidth();
    entry.peaks = peaksFromWAV(arrayBuf, targetPx);
    // Also store enough to recompute peaks at different pixel widths later
    // (e.g., on resize). We keep a compact "mini-peaks" array at 8192px
    // and resample from that — far cheaper than re-scanning the WAV.
    entry.miniPeaks = (targetPx >= 8192) ? entry.peaks : peaksFromWAV(arrayBuf, 8192);
    diagLog('Stem ' + i + ': peaks computed (' + entry.peaks.length + ' px)', 'info');
  } catch (err) {
    diagLog('Stem ' + i + ': peak computation failed: ' + err.message, 'err');
    // Audio still plays — just no waveform display
    entry.peaks = null;
  }

  // Audio element from Blob URL — same bytes, no network re-fetch.
  // Audio elements use their own internal decoder for playback (not the
  // Web Audio decodeAudioData path), so this works reliably even when
  // decodeAudioData would hang.
  const blob = new Blob([arrayBuf], { type: 'audio/wav' });
  const blobUrl = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = 'auto';
  a.src = blobUrl;
  entry.blobUrl = blobUrl;

  a.addEventListener('loadedmetadata', () => updateMixerTime());
  a.addEventListener('ended', () => {
    const allEnded = Object.values(sepAudioMap)
      .every(e => !e || !e.audio || e.audio.ended || e.audio.paused);
    if (allEnded) setMasterPlayIcon(false);
  });

  // Wire to the Web Audio graph
  const source = mixerCtx.createMediaElementSource(a);
  const gain = mixerCtx.createGain();
  const panner = mixerCtx.createStereoPanner();
  gain.gain.value = entry.muted ? 0 : entry.volume;
  panner.pan.value = entry.pan;
  source.connect(gain).connect(panner).connect(mixerMasterGain);

  entry.audio = a;
  entry.gain = gain;
  entry.panner = panner;
  entry.source = source;
  entry.loaded = true;
  diagLog('Stem ' + i + ': ready for playback', 'ok');

  paintStemWaveform(i);
}

// Compute peak amplitudes directly from WAV bytes, never allocating a full
// AudioBuffer. Iterates the data chunk taking max-abs per output-pixel
// bucket. Supports 8/16/24/32-bit PCM with any sample rate / channel count.
// Returns Float32Array of length numPx with values in [0, 1].
function peaksFromWAV(arrayBuffer, numPx) {
  const view = new DataView(arrayBuffer);
  // Parse RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV');
  let pos = 12, numChannels, bitsPerSample, dataOffset, dataSize, audioFormat = 1;
  while (pos < arrayBuffer.byteLength - 8) {
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos+1), view.getUint8(pos+2), view.getUint8(pos+3));
    const size = view.getUint32(pos+4, true);
    if (id === 'fmt ') {
      // fmt chunk layout (little-endian, byte offsets from pos):
      //   8  audioFormat (uint16) — 1=PCM, 3=IEEE float, 0xFFFE=extensible
      //  10  numChannels (uint16)
      //  22  bitsPerSample (uint16)
      audioFormat   = view.getUint16(pos+8,  true);
      numChannels   = view.getUint16(pos+10, true);
      bitsPerSample = view.getUint16(pos+22, true);
    } else if (id === 'data') {
      dataOffset = pos + 8; dataSize = size; break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!dataOffset) throw new Error('WAV data chunk not found');
  if (!numChannels || !bitsPerSample) throw new Error('WAV fmt chunk not found');

  const bps = bitsPerSample / 8;
  const frameBytes = bps * numChannels;
  const totalFrames = Math.floor(dataSize / frameBytes);
  const framesPerPx = Math.max(1, Math.floor(totalFrames / numPx));
  const peaks = new Float32Array(numPx);

  // IEEE 754 float WAV branch — emitted by some downstream tools / our own
  // soundfile.write(... subtype="FLOAT") in earlier versions. If we read
  // these bytes as INT32 the peak values come out roughly uniform across
  // the whole track (float representation clusters in similar magnitudes
  // for typical audio amplitudes), producing the "solid color rectangle"
  // waveform bug. Float reads native via getFloat32.
  if (audioFormat === 3 && bitsPerSample === 32) {
    for (let px = 0; px < numPx; px++) {
      let maxAbs = 0;
      const start = px * framesPerPx;
      const end = Math.min(totalFrames, start + framesPerPx);
      for (let f = start; f < end; f++) {
        const base = dataOffset + f * frameBytes;
        for (let c = 0; c < numChannels; c++) {
          const v = Math.abs(view.getFloat32(base + c * 4, true));
          if (v > maxAbs && isFinite(v)) maxAbs = v;
        }
      }
      // Float samples are already in [-1, 1] range conventionally; clip
      // just in case the source went hot.
      peaks[px] = Math.min(1, maxAbs);
    }
    return peaks;
  }

  // Tight inner loops keyed by bit depth — branch out of the hot path
  if (bitsPerSample === 16) {
    for (let px = 0; px < numPx; px++) {
      let maxAbs = 0;
      const start = px * framesPerPx;
      const end = Math.min(totalFrames, start + framesPerPx);
      for (let f = start; f < end; f++) {
        const base = dataOffset + f * frameBytes;
        for (let c = 0; c < numChannels; c++) {
          const v = Math.abs(view.getInt16(base + c * 2, true));
          if (v > maxAbs) maxAbs = v;
        }
      }
      peaks[px] = maxAbs / 32768;
    }
  } else if (bitsPerSample === 24) {
    for (let px = 0; px < numPx; px++) {
      let maxAbs = 0;
      const start = px * framesPerPx;
      const end = Math.min(totalFrames, start + framesPerPx);
      for (let f = start; f < end; f++) {
        const base = dataOffset + f * frameBytes;
        for (let c = 0; c < numChannels; c++) {
          const p = base + c * 3;
          let v = (view.getUint8(p+2) << 16) | (view.getUint8(p+1) << 8) | view.getUint8(p);
          if (v >= 0x800000) v -= 0x1000000;
          const a = Math.abs(v);
          if (a > maxAbs) maxAbs = a;
        }
      }
      peaks[px] = maxAbs / 8388608;
    }
  } else if (bitsPerSample === 32) {
    for (let px = 0; px < numPx; px++) {
      let maxAbs = 0;
      const start = px * framesPerPx;
      const end = Math.min(totalFrames, start + framesPerPx);
      for (let f = start; f < end; f++) {
        const base = dataOffset + f * frameBytes;
        for (let c = 0; c < numChannels; c++) {
          const v = Math.abs(view.getInt32(base + c * 4, true));
          if (v > maxAbs) maxAbs = v;
        }
      }
      peaks[px] = maxAbs / 2147483648;
    }
  } else if (bitsPerSample === 8) {
    for (let px = 0; px < numPx; px++) {
      let maxAbs = 0;
      const start = px * framesPerPx;
      const end = Math.min(totalFrames, start + framesPerPx);
      for (let f = start; f < end; f++) {
        const base = dataOffset + f * frameBytes;
        for (let c = 0; c < numChannels; c++) {
          const v = Math.abs(view.getUint8(base + c) - 128);
          if (v > maxAbs) maxAbs = v;
        }
      }
      peaks[px] = maxAbs / 128;
    }
  } else {
    throw new Error('Unsupported bit depth: ' + bitsPerSample);
  }
  return peaks;
}

// Resample a higher-resolution peaks array down (or up) to numPx. Faster
// than re-scanning the original WAV on resize.
function resamplePeaks(srcPeaks, numPx) {
  const out = new Float32Array(numPx);
  const ratio = srcPeaks.length / numPx;
  for (let i = 0; i < numPx; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(srcPeaks.length, Math.floor((i + 1) * ratio));
    let maxAbs = 0;
    for (let j = start; j < end; j++) {
      if (srcPeaks[j] > maxAbs) maxAbs = srcPeaks[j];
    }
    out[i] = maxAbs;
  }
  return out;
}

// fetch() with a timeout — never wait forever
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Compute peak amplitudes per output pixel. Each pixel takes the max
// absolute sample across both channels in its bucket. Returns a
// Float32Array of length numPx with values in [0, 1].
function computePeaks(audioBuf, numPx) {
  const ch0 = audioBuf.getChannelData(0);
  const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
  const samplesPerPx = Math.max(1, Math.floor(ch0.length / numPx));
  const peaks = new Float32Array(numPx);
  for (let px = 0; px < numPx; px++) {
    const s = px * samplesPerPx;
    let maxAbs = 0;
    const end = Math.min(ch0.length, s + samplesPerPx);
    for (let j = s; j < end; j++) {
      const a = Math.abs(ch0[j]);
      if (a > maxAbs) maxAbs = a;
      if (ch1) {
        const b = Math.abs(ch1[j]);
        if (b > maxAbs) maxAbs = b;
      }
    }
    peaks[px] = maxAbs;
  }
  return peaks;
}

// Returns the current target pixel width for stem waveforms. We render
// at full row width minus the left controls + right drag-out button.
// On screens where the row reflows, this is just the visible width.
function getWaveformPixelWidth() {
  const wrap = document.querySelector('.stem-waveform');
  if (wrap && wrap.clientWidth > 0) return wrap.clientWidth * (window.devicePixelRatio || 1);
  // Sensible default if no row is rendered yet
  return 800;
}

// Renders one stem row. The data-idx attr lets us look up the stem during drag-reorder.
// `analysisMap` is the per_stem_analysis dict from the done payload: maps
// stem name → { bpm, key, mode, camelot } (or { error } / { silent }).
// When provided, we render BPM + key chips next to the stem name. The
// chips degrade gracefully — missing values just don't render.
function renderStemRow(s, i, analysisMap) {
  // Map stem `name` to a CSS color class. The 6 standard stems map 1:1.
  // The vocal sub-stems (lead_vocal, back_vocal, sample_vocal) are also
  // recognized here so their rows get distinct colors instead of falling
  // back to 'other' grey.
  const KNOWN_COLOR_CLASSES = {
    vocals:1, drums:1, bass:1, other:1, guitar:1, piano:1,
    lead_vocal:1, back_vocal:1, sample_vocal:1
  };
  const colorClass = s.name in KNOWN_COLOR_CLASSES ? s.name : 'other';

  // Build the BPM/key chips. We only show them when the analyzer actually
  // produced a reading — silent or errored stems get nothing so the row
  // doesn't show noise. Drums are the most reliable for BPM, harmonic
  // stems (piano/bass/other/guitar) are most reliable for key. Vocals
  // are often weak on both since pitched vocals confuse key detection
  // and rhythm-poor vocal lines confuse BPM, so we display whatever the
  // analyzer returned without trying to filter.
  let chipsHTML = '';
  const a = (analysisMap && analysisMap[s.name]) || null;
  if (a && !a.error && !a.silent) {
    const chips = [];
    if (typeof a.bpm === 'number' && a.bpm > 0) {
      chips.push(`<span class="stem-chip stem-chip-bpm" title="Detected BPM for this stem">${Math.round(a.bpm)} BPM</span>`);
    }
    if (a.key && a.mode) {
      const camelotPart = a.camelot && a.camelot !== '—'
        ? ` <span class="stem-chip-camelot">${escapeHtml(a.camelot)}</span>`
        : '';
      chips.push(`<span class="stem-chip stem-chip-key" title="Detected key for this stem">${escapeHtml(a.key)} ${escapeHtml(a.mode)}${camelotPart}</span>`);
    }
    if (chips.length) {
      chipsHTML = `<div class="stem-chips">${chips.join('')}</div>`;
    }
  }
  return `
    <div class="stem-row" id="stem-row-${i}" data-idx="${i}"
         draggable="true"
         ondragstart="stemRowDragStart(event, ${i})"
         ondragover="stemRowDragOver(event)"
         ondragleave="stemRowDragLeave(event)"
         ondrop="stemRowDrop(event, ${i})"
         ondragend="stemRowDragEnd(event)">
      <div class="stem-row-handle" title="${t('sepMixerTitle')}">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="8" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="8" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="8" cy="12" r="1.2"/></svg>
      </div>
      <div class="stem-color ${colorClass}"></div>
      <div class="stem-name-block">
        <div class="stem-name">${escapeHtml(s.label || s.name)}</div>
        ${chipsHTML}
      </div>
      <div class="stem-mixer-controls">
        <button class="stem-tog stem-tog-mute" id="stem-mute-${i}" onclick="toggleMute(${i})" title="${t('sepMute')}">M</button>
        <button class="stem-tog stem-tog-solo" id="stem-solo-${i}" onclick="toggleSolo(${i})" title="${t('sepSolo')}">S</button>
        <div class="stem-knob-group" title="${t('sepVolume')}">
          <input type="range" class="stem-vol" id="stem-vol-${i}" min="0" max="1.2" step="0.01" value="1"
                 oninput="setStemVolume(${i}, this.value)">
          <div class="stem-knob-label" id="stem-vol-lbl-${i}">100%</div>
        </div>
        <div class="stem-knob-group" title="Pan">
          <input type="range" class="stem-pan" id="stem-pan-${i}" min="-1" max="1" step="0.05" value="0"
                 oninput="setStemPan(${i}, this.value)">
          <div class="stem-knob-label" id="stem-pan-lbl-${i}">C</div>
        </div>
      </div>
      <div class="stem-waveform" id="stem-wave-wrap-${i}" onclick="seekStemWaveform(${i}, event)" title="${t('sepSeekWaveform') || 'Click to seek'}">
        <canvas class="stem-wave-canvas" id="stem-wave-${i}"></canvas>
        <div class="stem-wave-playhead" id="stem-wave-ph-${i}"></div>
      </div>
      <button class="stem-drag-out" onclick="dragStem(event, ${i})"
              ondragstart="dragStem(event, ${i})" draggable="true"
              title="${t('sepSendToSeparator')}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    </div>`;
}

// ---------- Mixer state ----------
let mixerCtx = null;
let mixerTickRaf = null;
let mixerMasterGain = null;     // single master volume node (between stems and destination)
let mixerMasterAnalyser = null; // analyser for the VU meter
let mixerMasterVolume = 1.0;    // user-set master volume [0, 1.4]
let mixerLoopStart = null;      // loop region: seconds, or null when disabled
let mixerLoopEnd = null;
let stemOrder = [];     // ordered indices into sepAudioMap
let dragSrcIdx = null;  // stem currently being dragged for reorder

function destroyMixer() {
  if (mixerTickRaf) {
    cancelAnimationFrame(mixerTickRaf);
    mixerTickRaf = null;
  }
  stopVUMeter();
  // Disconnect master chain
  if (mixerMasterGain)     { try { mixerMasterGain.disconnect(); } catch {} mixerMasterGain = null; }
  if (mixerMasterAnalyser) { try { mixerMasterAnalyser.disconnect(); } catch {} mixerMasterAnalyser = null; }
  // Loop region resets on new project
  mixerLoopStart = null;
  mixerLoopEnd = null;
  // Disconnect the per-row ResizeObserver from the previous project so we
  // don't accumulate observers on torn-down DOM nodes (those would still
  // fire callbacks until GC, which can take a while).
  if (typeof _stemResizeObserver !== 'undefined' && _stemResizeObserver) {
    try { _stemResizeObserver.disconnect(); } catch {}
    _stemResizeObserver = null;
  }

  // CRITICAL: tear down every <audio> element from the previous project
  // before creating new ones. Otherwise the old elements keep their HTTP
  // streams open while new fetches stack on top, leading to a connection
  // pile-up that blanks the renderer on Windows (we saw this in the log
  // as a cascade of "sendFile error: Request aborted" entries followed
  // by a black-screen state).
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) {
      try { e.audio.pause(); } catch {}
      try {
        e.audio.removeAttribute('src');
        e.audio.load();  // forces the HTTP stream to close
      } catch {}
    }
    // Revoke blob URL — each stem creates one in loadOneStem() and we'd
    // leak ~10-50MB per project open otherwise (one Blob URL holds a
    // reference to the full ArrayBuffer).
    if (e && e.blobUrl) {
      try { URL.revokeObjectURL(e.blobUrl); } catch {}
      e.blobUrl = null;
    }
    // Disconnect Web Audio nodes so the old graph can be GC'd
    if (e && e.source) { try { e.source.disconnect(); } catch {} }
    if (e && e.gain)   { try { e.gain.disconnect(); } catch {} }
    if (e && e.panner) { try { e.panner.disconnect(); } catch {} }
    // Drop buffer references explicitly so the AudioBuffer can be freed
    if (e) { e.buffer = null; e.peaks = null; e.masterPeaks = null; e.miniPeaks = null; e._lastPaintedPx = null; e.rawWavBytes = null; }
  }

  // Clear waveform peak cache — different project = different files, the
  // cached peaks would be wrong. Also close the dedicated decode context
  // so we don't pile up AudioContexts (Chromium caps at 6).
  if (typeof stemPeaksCache !== 'undefined') {
    for (const k of Object.keys(stemPeaksCache)) delete stemPeaksCache[k];
  }
  if (typeof _stemDecodeCtx !== 'undefined' && _stemDecodeCtx) {
    try { _stemDecodeCtx.close(); } catch {}
    _stemDecodeCtx = null;
  }
  if (typeof _stemDecodeQueue !== 'undefined') {
    _stemDecodeQueue = Promise.resolve();
  }

  if (mixerCtx) {
    try { mixerCtx.close(); } catch {}
    mixerCtx = null;
  }
}

// ---------- Master transport ----------
function mixerPlayPauseAll() {
  if (!mixerCtx) return;
  // Resume context on first user gesture (Chromium autoplay policy)
  if (mixerCtx.state === 'suspended') mixerCtx.resume();

  // Only consider stems that have actually loaded their audio element
  const loaded = Object.values(sepAudioMap).filter(e => e && e.audio);
  if (!loaded.length) {
    showAppNotification(t('sepStillLoading') || 'Stems still loading…', 'info');
    return;
  }
  const anyPlaying = loaded.some(e => !e.audio.paused && !e.audio.ended);
  if (anyPlaying) {
    loaded.forEach(e => { try { e.audio.pause(); } catch {} });
    setMasterPlayIcon(false);
    stopVUMeter();
  } else {
    // Sync all stems to the same currentTime before starting (in case they drifted).
    // If a loop region is set and we're outside it, jump to its start.
    const ref = loaded[0];
    let t0 = ref ? ref.audio.currentTime : 0;
    if (mixerLoopStart != null && mixerLoopEnd != null &&
        (t0 < mixerLoopStart || t0 >= mixerLoopEnd)) {
      t0 = mixerLoopStart;
    }
    loaded.forEach(e => { try { e.audio.currentTime = t0; } catch {} });
    Promise.all(loaded.map(e =>
      e.audio.play().catch(err => console.warn('play failed:', err.message))
    )).then(() => {
      setMasterPlayIcon(true);
      startVUMeter();
    });
  }
}

function mixerStopAll() {
  Object.values(sepAudioMap).forEach(e => {
    if (!e || !e.audio) return;
    try { e.audio.pause(); e.audio.currentTime = 0; } catch {}
  });
  setMasterPlayIcon(false);
  stopVUMeter();
  updateMixerTime();
}

function mixerResetLevels() {
  Object.entries(sepAudioMap).forEach(([k, e]) => {
    if (!e) return;
    const i = parseInt(k);
    e.muted = false;
    e.soloed = false;
    e.volume = 1.0;
    e.pan = 0.0;
    if (e.gain)   e.gain.gain.value = 1.0;
    if (e.panner) e.panner.pan.value = 0.0;
    const v = document.getElementById('stem-vol-' + i);
    const p = document.getElementById('stem-pan-' + i);
    const m = document.getElementById('stem-mute-' + i);
    const s = document.getElementById('stem-solo-' + i);
    const vl = document.getElementById('stem-vol-lbl-' + i);
    const pl = document.getElementById('stem-pan-lbl-' + i);
    if (v) v.value = 1;
    if (p) p.value = 0;
    if (m) m.classList.remove('active');
    if (s) s.classList.remove('active');
    if (vl) vl.textContent = '100%';
    if (pl) pl.textContent = 'C';
  });
  applySoloLogic();
  // Reset master fader too
  setMasterVolume(1.0);
  const mv = document.getElementById('mixer-master-vol');
  if (mv) mv.value = 1.0;
}

// Master volume — sets the single fader that controls the whole mix.
// Range [0, 1.4] (slight gain headroom for quiet stems collections; the
// peak meter shows clipping if you push too far). Setting via setTargetAtTime
// avoids zipper noise during fast drags.
function setMasterVolume(val) {
  mixerMasterVolume = Math.max(0, Math.min(1.4, parseFloat(val) || 0));
  if (mixerMasterGain) {
    // Smooth ramp over 30ms — fast enough to feel instant, slow enough
    // to suppress zipper noise on rapid slider drags.
    try {
      mixerMasterGain.gain.setTargetAtTime(
        mixerMasterVolume,
        mixerCtx.currentTime,
        0.01
      );
    } catch {
      mixerMasterGain.gain.value = mixerMasterVolume;
    }
  }
  const lbl = document.getElementById('mixer-master-vol-lbl');
  if (lbl) {
    if (mixerMasterVolume === 0) lbl.textContent = '−∞';
    else lbl.textContent = Math.round(20 * Math.log10(mixerMasterVolume)) + ' dB';
  }
}

// ── Master VU meter ─────────────────────────────────────────────────────────
// Reads the master analyser at ~30fps and paints fill height per channel.
// Uses time-domain data to compute peak level; converts to a 0–1 fill
// scaled so 0 dBFS = 100% (top), -36 dBFS = 0% (bottom). Color gradient
// in CSS provides the green/yellow/red segmentation visually.
let _vuRaf = null;
let _vuLevels = { l: 0, r: 0 };
function startVUMeter() {
  if (_vuRaf) cancelAnimationFrame(_vuRaf);
  const tick = () => {
    if (!mixerMasterAnalyser) { _vuRaf = null; return; }
    const buf = new Float32Array(mixerMasterAnalyser.fftSize);
    mixerMasterAnalyser.getFloatTimeDomainData(buf);
    // Compute peak level (max abs sample in the buffer). One analyser
    // serves both channels in this graph — we can't easily split L/R
    // without rewiring, so we paint both bars the same level (true stereo
    // metering would require ChannelSplitter + two analysers; not worth
    // the complexity for a level indicator).
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    // Convert peak to dBFS then to 0-1 fill. -36 dBFS = 0%, 0 dBFS = 100%.
    let level = 0;
    if (peak > 0) {
      const db = 20 * Math.log10(peak);
      level = Math.max(0, Math.min(1, (db + 36) / 36));
    }
    // Smooth release — fast attack, slower release (DAW-like)
    _vuLevels.l = (level > _vuLevels.l) ? level : _vuLevels.l * 0.85 + level * 0.15;
    _vuLevels.r = _vuLevels.l;
    const fillL = document.getElementById('mixer-master-vu-l');
    const fillR = document.getElementById('mixer-master-vu-r');
    if (fillL) fillL.style.height = (_vuLevels.l * 100) + '%';
    if (fillR) fillR.style.height = (_vuLevels.r * 100) + '%';
    _vuRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopVUMeter() {
  if (_vuRaf) { cancelAnimationFrame(_vuRaf); _vuRaf = null; }
  const fillL = document.getElementById('mixer-master-vu-l');
  const fillR = document.getElementById('mixer-master-vu-r');
  if (fillL) fillL.style.height = '0%';
  if (fillR) fillR.style.height = '0%';
  _vuLevels = { l: 0, r: 0 };
}

// ── Loop region ─────────────────────────────────────────────────────────────
// User drags on the master waveform with Shift held (or via dedicated loop
// drag mode) to define a section that loops continuously. Implemented by
// watching the timeupdate event and seeking back to loopStart when we
// cross loopEnd. Click anywhere without Shift = clear loop (returns to
// normal seek behavior).
function mixerToggleLoop() {
  const btn = document.getElementById('mixer-loop-btn');
  if (mixerLoopStart != null && mixerLoopEnd != null) {
    // Clear it
    mixerLoopStart = null;
    mixerLoopEnd = null;
    updateLoopRegionUI();
    if (btn) btn.classList.remove('active');
    showAppNotification(t('sepLoopCleared') || '✕ Loop cleared', 'info');
  } else {
    showAppNotification(t('sepLoopHint') || 'Shift+drag on the waveform to set loop region', 'info');
  }
}

function mixerMasterMouseDown(ev) {
  // Only kick into loop-drag mode when Shift is held. Plain clicks fall
  // through to the existing onclick handler (which calls mixerSeekMaster).
  if (!ev.shiftKey) return;
  ev.preventDefault();
  ev.stopPropagation();

  const wrap = document.getElementById('mixer-master-waveform');
  if (!wrap) return;
  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) { ref = e; break; }
  }
  if (!ref || !isFinite(ref.audio.duration)) return;
  const dur = ref.audio.duration;
  const rect = wrap.getBoundingClientRect();

  const xToTime = (x) => Math.max(0, Math.min(dur,
    ((x - rect.left) / rect.width) * dur));

  const startTime = xToTime(ev.clientX);
  let endTime = startTime;
  mixerLoopStart = startTime;
  mixerLoopEnd = startTime + 0.001;
  updateLoopRegionUI();

  const onMove = (e) => {
    endTime = xToTime(e.clientX);
    if (endTime >= startTime) {
      mixerLoopStart = startTime;
      mixerLoopEnd = endTime;
    } else {
      mixerLoopStart = endTime;
      mixerLoopEnd = startTime;
    }
    updateLoopRegionUI();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    // If the drag was a near-zero distance (just a shift+click), clear instead
    if (Math.abs(endTime - startTime) < 0.05) {
      mixerLoopStart = null;
      mixerLoopEnd = null;
      updateLoopRegionUI();
      return;
    }
    const btn = document.getElementById('mixer-loop-btn');
    if (btn) btn.classList.add('active');
    showAppNotification(
      (t('sepLoopSet') || '⟲ Loop:') + ' ' + fmtTime(mixerLoopStart) + ' – ' + fmtTime(mixerLoopEnd),
      'ok'
    );
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function updateLoopRegionUI() {
  const region = document.getElementById('mixer-master-loop-region');
  if (!region) return;
  if (mixerLoopStart == null || mixerLoopEnd == null) {
    region.classList.remove('active');
    region.style.width = '0%';
    return;
  }
  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) { ref = e; break; }
  }
  if (!ref || !isFinite(ref.audio.duration)) return;
  const dur = ref.audio.duration;
  const startPct = (mixerLoopStart / dur) * 100;
  const endPct   = (mixerLoopEnd   / dur) * 100;
  region.style.left  = startPct + '%';
  region.style.width = (endPct - startPct) + '%';
  region.classList.add('active');
}

// ── BPM grid overlay ────────────────────────────────────────────────────────
// If the source track has a BPM in history, draw faint vertical lines at
// each bar boundary on the master waveform. Lines fade in opacity from
// bars (brighter) → beats → subdivisions (subtle) so you can spot the
// grid without it competing with the waveform.
function paintBpmGrid() {
  const canvas = document.getElementById('mixer-master-grid');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = Math.max(2, Math.floor(w * dpr));
  canvas.height = Math.max(2, Math.floor(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Resolve BPM + duration. BPM comes from sepCurrent (set when project
  // is restored) or via a separate field if present.
  let bpm = 0;
  if (sepCurrent && sepCurrent.bpm) bpm = parseFloat(sepCurrent.bpm);
  if (!bpm || !isFinite(bpm) || bpm < 40 || bpm > 240) return;

  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) { ref = e; break; }
  }
  if (!ref || !isFinite(ref.audio.duration)) return;
  const dur = ref.audio.duration;

  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;   // assume 4/4 — the only meter that matters for trap
  const totalBars = Math.floor(dur / barSec);
  if (totalBars < 1) return;

  // Beats first (subtle), then bars on top (brighter)
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let beat = 0; beat <= totalBars * 4; beat++) {
    if (beat % 4 === 0) continue;  // skip bar positions, drawn next
    const t = beat * beatSec;
    if (t > dur) break;
    const x = (t / dur) * w;
    ctx.fillRect(x, 0, 1, h);
  }
  // Bar lines — slightly brighter
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let bar = 0; bar <= totalBars; bar++) {
    const t = bar * barSec;
    if (t > dur) break;
    const x = (t / dur) * w;
    ctx.fillRect(x, 0, 1, h);
  }
  // Bar numbers — only at every 4 bars to avoid clutter
  ctx.font = '9px Inter,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let bar = 0; bar <= totalBars; bar += 4) {
    const t = bar * barSec;
    if (t > dur) break;
    const x = (t / dur) * w;
    ctx.fillText(String(bar + 1), x + 3, 11);
  }
}

function mixerSeekMaster(ev) {
  // Pick the first loaded stem as the time reference
  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) { ref = e; break; }
  }
  if (!ref) return;
  const dur = ref.audio.duration;
  if (!isFinite(dur)) return;
  // The click can come from either the thin seek strip OR the big waveform
  const seek = ev.currentTarget ||
               document.getElementById('mixer-master-seek');
  const rect = seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const newTime = ratio * dur;
  Object.values(sepAudioMap).forEach(e => {
    if (!e || !e.audio) return;
    try { e.audio.currentTime = newTime; } catch {}
  });
  updateMixerTime();
}

function setMasterPlayIcon(isPlaying) {
  const btn = document.getElementById('mixer-play-all');
  const lbl = document.getElementById('mixer-play-all-label');
  if (!btn) return;
  const svg = isPlaying
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  btn.innerHTML = svg + '<span id="mixer-play-all-label">' + (isPlaying ? t('sepPauseAll') : t('sepPlayAll')) + '</span>';
}

// ---------- Per-stem controls ----------
function toggleMute(i) {
  const e = sepAudioMap[i];
  if (!e) return;
  e.muted = !e.muted;
  const btn = document.getElementById('stem-mute-' + i);
  if (btn) btn.classList.toggle('active', e.muted);
  applySoloLogic();
}

function toggleSolo(i) {
  const e = sepAudioMap[i];
  if (!e) return;
  e.soloed = !e.soloed;
  const btn = document.getElementById('stem-solo-' + i);
  if (btn) btn.classList.toggle('active', e.soloed);
  applySoloLogic();
}

// Compute effective gain per stem given mute + solo state across all stems.
// If any stem is soloed, only soloed-and-not-muted stems are audible.
// Otherwise, all stems play except muted ones.
function applySoloLogic() {
  const anySoloed = Object.values(sepAudioMap).some(e => e && e.soloed);
  Object.values(sepAudioMap).forEach(e => {
    if (!e || !e.gain) return;  // not loaded yet
    let audible = true;
    if (anySoloed) audible = e.soloed && !e.muted;
    else audible = !e.muted;
    e.gain.gain.value = audible ? e.volume : 0;
  });
}

function setStemVolume(i, val) {
  const e = sepAudioMap[i];
  if (!e) return;
  e.volume = parseFloat(val);
  const lbl = document.getElementById('stem-vol-lbl-' + i);
  if (lbl) lbl.textContent = Math.round(e.volume * 100) + '%';
  applySoloLogic();  // re-evaluates effective gain
}

function setStemPan(i, val) {
  const e = sepAudioMap[i];
  if (!e) return;
  e.pan = parseFloat(val);
  if (e.panner) e.panner.pan.value = e.pan;
  const lbl = document.getElementById('stem-pan-lbl-' + i);
  if (lbl) {
    if (Math.abs(e.pan) < 0.05) lbl.textContent = 'C';
    else if (e.pan < 0) lbl.textContent = 'L' + Math.round(-e.pan * 100);
    else lbl.textContent = 'R' + Math.round(e.pan * 100);
  }
}

// ---------- Drag-to-reorder ----------
function stemRowDragStart(ev, i) {
  // Don't trigger reorder if the user is dragging from the right-side
  // export handle (that's drag-to-DAW). We detect by checking the source.
  const target = ev.target;
  if (target && target.closest && target.closest('.stem-drag-out')) {
    return; // let drag-to-DAW handler take over
  }
  dragSrcIdx = i;
  ev.dataTransfer.effectAllowed = 'move';
  // Need *some* data set or Firefox refuses the drag
  try { ev.dataTransfer.setData('text/plain', String(i)); } catch {}
  const row = document.getElementById('stem-row-' + i);
  if (row) row.classList.add('dragging');
}

function stemRowDragOver(ev) {
  if (dragSrcIdx === null) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const row = ev.currentTarget;
  if (row && !row.classList.contains('drop-target')) {
    document.querySelectorAll('.stem-row.drop-target').forEach(r => r.classList.remove('drop-target'));
    row.classList.add('drop-target');
  }
}

function stemRowDragLeave(ev) {
  ev.currentTarget.classList.remove('drop-target');
}

function stemRowDrop(ev, targetIdx) {
  ev.preventDefault();
  ev.stopPropagation();
  if (dragSrcIdx === null || dragSrcIdx === targetIdx) {
    document.querySelectorAll('.stem-row.drop-target,.stem-row.dragging').forEach(r => {
      r.classList.remove('drop-target');
      r.classList.remove('dragging');
    });
    dragSrcIdx = null;
    return;
  }
  // Reorder the DOM only — sepAudioMap keys stay stable.
  const list = document.getElementById('mixer-stems');
  const src = document.getElementById('stem-row-' + dragSrcIdx);
  const tgt = document.getElementById('stem-row-' + targetIdx);
  if (list && src && tgt) {
    // Insert src before or after target depending on relative position
    const srcRect = src.getBoundingClientRect();
    const tgtRect = tgt.getBoundingClientRect();
    if (srcRect.top < tgtRect.top) {
      list.insertBefore(src, tgt.nextSibling);
    } else {
      list.insertBefore(src, tgt);
    }
    // Update stemOrder for completeness (not currently used for playback)
    const fromOrd = stemOrder.indexOf(dragSrcIdx);
    if (fromOrd !== -1) stemOrder.splice(fromOrd, 1);
    const toOrd = stemOrder.indexOf(targetIdx);
    stemOrder.splice(toOrd === -1 ? stemOrder.length : toOrd, 0, dragSrcIdx);
  }
  document.querySelectorAll('.stem-row.drop-target,.stem-row.dragging').forEach(r => {
    r.classList.remove('drop-target');
    r.classList.remove('dragging');
  });
  dragSrcIdx = null;
}

function stemRowDragEnd(ev) {
  document.querySelectorAll('.stem-row.drop-target,.stem-row.dragging').forEach(r => {
    r.classList.remove('drop-target');
    r.classList.remove('dragging');
  });
  dragSrcIdx = null;
}

// ---------- Master tick (master seek + timestamp sync) ----------
function startMixerTick() {
  function tick() {
    updateMixerTime();
    mixerTickRaf = requestAnimationFrame(tick);
  }
  tick();
}

function updateMixerTime() {
  // Find the first stem that has an audio element loaded. During async
  // load, sepAudioMap[0] may exist but its .audio is still null — pick
  // the first entry that's actually ready.
  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) { ref = e; break; }
  }
  if (!ref) return;
  const cur = ref.audio.currentTime || 0;
  const dur = ref.audio.duration || 0;

  // Loop region enforcement — if user set a loop and playback crossed the
  // end, seek all stems back to the start. Done before UI update so the
  // playhead doesn't visibly briefly jump past the end before snapping back.
  if (mixerLoopStart != null && mixerLoopEnd != null &&
      mixerLoopEnd > mixerLoopStart &&
      cur >= mixerLoopEnd - 0.01 && !ref.audio.paused) {
    for (const k of Object.keys(sepAudioMap)) {
      const e = sepAudioMap[k];
      if (e && e.audio) {
        try { e.audio.currentTime = mixerLoopStart; } catch {}
      }
    }
  }

  const meta = document.getElementById('mixer-time');
  const fill = document.getElementById('mixer-master-seek-fill');
  if (meta) meta.textContent = fmtTime(cur) + ' / ' + (isFinite(dur) ? fmtTime(dur) : '0:00');
  if (fill && dur > 0) fill.style.width = (cur / dur * 100) + '%';
  if (dur > 0) {
    const pct = (cur / dur) * 100;
    // Per-stem playheads
    for (const idx of Object.keys(sepAudioMap)) {
      const ph = document.getElementById('stem-wave-ph-' + idx);
      if (ph) ph.style.left = pct + '%';
    }
    // Master overview playhead
    const mph = document.getElementById('mixer-master-wave-playhead');
    if (mph) mph.style.left = pct + '%';
  }
}

// ── Stem waveform painting ──────────────────────────────────────────────────
// Peaks are pre-computed in loadOneStem() using the SAME ArrayBuffer that
// becomes the audio source — no second fetch. paintStemWaveform() is now
// a pure UI function: it reads entry.peaks (already a Float32Array of pixel
// amplitudes) and draws to the canvas. Re-paint on resize recomputes peaks
// at the new pixel width from the already-decoded AudioBuffer (also in
// memory as entry.buffer). Network is touched exactly once per stem, ever.

function paintStemWaveform(idx) {
  const canvas = document.getElementById('stem-wave-' + idx);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const entry = sepAudioMap[idx];
  if (!entry) return;

  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.max(2, Math.floor(w * dpr));
  canvas.height = Math.max(2, Math.floor(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Resolve stem color from row class
  const colorEl = document.querySelector('#stem-row-' + idx + ' .stem-color');
  let stemClass = 'other';
  if (colorEl) {
    for (const c of colorEl.classList) {
      if (['vocals','drums','bass','other','guitar','piano'].includes(c)) {
        stemClass = c; break;
      }
    }
  }
  const stemColors = {
    vocals: '#e84040', drums: '#f59e0b', bass: '#a855f7',
    other: '#6b7280', guitar: '#4caf50', piano: '#3b82f6',
    lead_vocal: '#ff5566', back_vocal: '#b03030', sample_vocal: '#7a2424',
  };
  const color = stemColors[stemClass] || '#888';

  // Resolve peaks at canvas resolution. If we have miniPeaks (always
  // cached) and current peaks don't match the canvas resolution, resample.
  let peaks = entry.peaks;
  const targetPx = Math.floor(w * dpr);
  if ((!peaks || peaks.length !== targetPx) && entry.miniPeaks && targetPx >= 2) {
    peaks = resamplePeaks(entry.miniPeaks, targetPx);
    entry.peaks = peaks;
    entry._lastPaintedPx = targetPx;
  }
  if (!peaks) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, h/2 - 0.5, w, 1);
    return;
  }

  // Paint: filled bipolar waveform (centered around mid-line, mirrored).
  // This is the DAW look — solid color, full vertical fill at each pixel.
  ctx.clearRect(0, 0, w, h);
  // Faint background centerline shows under quiet sections
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, h/2 - 0.5, w, 1);

  // Bipolar bars — top half + bottom half, mirrored
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.92;
  const mid = h / 2;
  const numPx = Math.min(peaks.length, Math.floor(w));
  const maxBarH = (h - 2) / 2;
  for (let px = 0; px < numPx; px++) {
    const v = peaks[px];
    const barH = Math.max(0.5, v * maxBarH);
    ctx.fillRect(px, mid - barH, 1, barH * 2);
  }
  ctx.globalAlpha = 1;
}

// Click on a stem waveform to seek. All stems share master clock so
// seeking one syncs them all.
function seekStemWaveform(idx, evt) {
  const wrap = document.getElementById('stem-wave-wrap-' + idx);
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  const e0 = sepAudioMap[0];
  if (!e0 || !e0.audio || !isFinite(e0.audio.duration)) return;
  const newTime = pct * e0.audio.duration;
  for (const k of Object.keys(sepAudioMap)) {
    const e = sepAudioMap[k];
    if (e && e.audio) {
      try { e.audio.currentTime = newTime; } catch {}
    }
  }
  updateMixerTime();
}

// Paint a placeholder (e.g., when a stem failed to load)
function paintStemPlaceholder(idx, label) {
  const canvas = document.getElementById('stem-wave-' + idx);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, h/2 - 0.5, w, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '10px Inter,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label || '—', w/2, h/2 + 3);
}

// Repaint waveforms on resize. Uses ResizeObserver per stem-row when
// available — fires when each row actually settles to a new width rather
// than during the transient frames of the resize gesture (where the row
// can briefly read clientWidth=0 and produce empty peaks).
//
// We also DON'T null out e.peaks until new peaks have been computed.
// The old approach (null peaks → repaint) caused the waveforms to flash
// to empty during resize because paintStemWaveform with peaks=null draws
// an empty centerline. Now we keep the old peaks visible until the new
// ones are ready.
let _stemResizeObserver = null;

function setupStemRowResizeObservers() {
  if (typeof ResizeObserver === 'undefined') return;
  // Tear down any previous observer
  if (_stemResizeObserver) {
    try { _stemResizeObserver.disconnect(); } catch {}
  }
  _stemResizeObserver = new ResizeObserver(entries => {
    // Batch repaints into the next frame so we don't paint mid-layout
    requestAnimationFrame(() => {
      for (const obs of entries) {
        const wrap = obs.target;
        if (!wrap || !wrap.id) continue;
        // wrap.id is "stem-wave-wrap-N"
        const m = wrap.id.match(/^stem-wave-wrap-(\d+)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        const entry = sepAudioMap[idx];
        if (!entry) continue;
        // Only repaint if width is non-zero AND has actually changed by
        // more than a pixel — skip the noisy mid-flow updates.
        const newW = Math.floor(wrap.clientWidth);
        if (newW < 2) continue;
        const dpr = window.devicePixelRatio || 1;
        const targetPx = Math.floor(newW * dpr);
        if (entry._lastPaintedPx === targetPx) continue;
        // Recompute peaks at the new width FIRST, then swap atomically
        // so the canvas never paints with empty data.
        if (entry.miniPeaks) {
          entry.peaks = resamplePeaks(entry.miniPeaks, targetPx);
          entry._lastPaintedPx = targetPx;
          paintStemWaveform(idx);
        }
      }
    });
  });
  // Observe every stem row wrapper
  for (const k of Object.keys(sepAudioMap)) {
    const wrap = document.getElementById('stem-wave-wrap-' + k);
    if (wrap) _stemResizeObserver.observe(wrap);
  }
}

// Window-level resize also handles the master overview waveform (which
// scales with the parent container, not per-stem).
let _stemWaveResizeTimer = null;
window.addEventListener('resize', () => {
  if (_stemWaveResizeTimer) clearTimeout(_stemWaveResizeTimer);
  _stemWaveResizeTimer = setTimeout(() => {
    // Master overview needs to clear its cached peaks since its width changed
    for (const k of Object.keys(sepAudioMap)) {
      const e = sepAudioMap[k];
      if (e) e.masterPeaks = null;
    }
    paintMasterWaveform();
    paintBpmGrid();
    updateLoopRegionUI();
    // ResizeObserver handles per-stem rows; fallback for environments
    // where it doesn't exist (very old Electron — unlikely):
    if (typeof ResizeObserver === 'undefined') {
      for (const k of Object.keys(sepAudioMap)) {
        const e = sepAudioMap[k];
        if (e && e.miniPeaks) {
          const wrap = document.getElementById('stem-wave-wrap-' + k);
          if (wrap && wrap.clientWidth > 1) {
            const dpr = window.devicePixelRatio || 1;
            e.peaks = resamplePeaks(e.miniPeaks, Math.floor(wrap.clientWidth * dpr));
            paintStemWaveform(parseInt(k, 10));
          }
        }
      }
    }
  }, 150);
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function openStemFile(i) {
  const e = sepAudioMap[i];
  if (!e || !e.path) return;
  if (api.openPath) api.openPath(e.path);
  else if (api.showInFolder) api.showInFolder(e.path);
}

function openStemFolder() {
  if (!sepCurrent || !sepCurrent.output_dir) return;
  if (api.openPath) api.openPath(sepCurrent.output_dir);
}

// ── Mastering ──────────────────────────────────────────────────────────
// Calls the /master SSE endpoint to apply a rule-based mastering preset
// to the ORIGINAL source track (not the stems). We feed it sepSourcePath
// because the mastering preset is meant to give the user a finished
// version of the song they just separated — not a remix from stems.

let masterEvtSource = null;
let masterResult = null;
let masterReferencePath = null;      // absolute path to the user-picked reference
let masterMatchStrength = 0.5;       // 0..1, controls EQ-match aggressiveness

function onMasterPresetChange() {
  // Show/hide the reference picker depending on which preset is selected.
  // We only need the picker for reference_match; the fixed-curve presets
  // (loudness_normalize/bright/warm) don't use a reference.
  const sel = document.getElementById('master-preset');
  const refRow = document.getElementById('master-ref-row');
  if (!sel || !refRow) return;
  if (sel.value === 'reference_match') {
    refRow.classList.remove('hidden');
  } else {
    refRow.classList.add('hidden');
  }
}

function onMasterReferencePicked(ev) {
  const f = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!f) return;
  if (!f.path) {
    showAppNotification('Cannot read reference path', 'err');
    return;
  }
  _setMasterReference(f.path, f.name);
}

function _setMasterReference(absPath, displayName) {
  masterReferencePath = absPath;
  const drop = document.getElementById('master-ref-drop');
  const label = document.getElementById('master-ref-label');
  const clearBtn = document.getElementById('master-ref-clear');
  if (drop) drop.classList.add('has-file');
  if (label) label.textContent = displayName || absPath.split(/[/\\]/).pop();
  if (clearBtn) clearBtn.classList.remove('hidden');
}

function clearMasterReference() {
  masterReferencePath = null;
  const drop = document.getElementById('master-ref-drop');
  const label = document.getElementById('master-ref-label');
  const clearBtn = document.getElementById('master-ref-clear');
  const fileInput = document.getElementById('master-ref-file');
  if (drop) drop.classList.remove('has-file');
  if (label) label.textContent = 'Drop a reference track or click to pick';
  if (clearBtn) clearBtn.classList.add('hidden');
  if (fileInput) fileInput.value = '';  // reset so re-picking same file works
}

function onMasterStrengthChange(val) {
  const v = parseFloat(val);
  masterMatchStrength = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
  const el = document.getElementById('master-strength-val');
  if (el) el.textContent = Math.round(masterMatchStrength * 100) + '%';
}

// Drag-and-drop on the reference picker — same UX as the main track drops
// so users can drag any audio file onto it without opening a file dialog.
window.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('master-ref-drop');
  if (!drop) return;
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!f.path) {
      showAppNotification('Cannot read dropped file path', 'err');
      return;
    }
    _setMasterReference(f.path, f.name);
  });
});

function startMastering() {
  if (!sepSourcePath) {
    showAppNotification('No source track to master', 'err');
    return;
  }
  const presetEl = document.getElementById('master-preset');
  const preset = presetEl ? presetEl.value : 'loudness_normalize';
  // Reference-match needs a reference file. Block submission and prompt
  // if the user clicked Apply without picking one.
  if (preset === 'reference_match' && !masterReferencePath) {
    showAppNotification('Pick a reference track first', 'info');
    return;
  }
  const btn = document.getElementById('btn-master');
  const lbl = document.getElementById('btn-master-lbl');
  const prog = document.getElementById('master-progress');
  const progFill = document.getElementById('master-prog-fill');
  const progTxt = document.getElementById('master-prog-text');
  const result = document.getElementById('master-result');

  if (btn) btn.disabled = true;
  if (lbl) lbl.textContent = 'Mastering…';
  if (prog) prog.classList.remove('hidden');
  if (result) result.classList.add('hidden');
  if (progFill) progFill.style.width = '0%';
  if (progTxt) progTxt.textContent = 'Starting…';

  // Output directory: same place as the stems for tidy organization.
  const outDir = (sepCurrent && sepCurrent.output_dir) || '';
  const qs = new URLSearchParams({
    path: sepSourcePath,
    preset,
  });
  if (outDir) qs.set('outDir', outDir);
  if (preset === 'reference_match' && masterReferencePath) {
    qs.set('reference', masterReferencePath);
    qs.set('strength', String(masterMatchStrength));
  }
  const url = API + '/master?' + qs.toString();

  if (masterEvtSource) { try { masterEvtSource.close(); } catch {} }
  masterEvtSource = new EventSource(url);

  masterEvtSource.addEventListener('progress', e => {
    try {
      const m = JSON.parse(e.data);
      const pct = typeof m.progress === 'number' ? m.progress : null;
      if (pct !== null && progFill) progFill.style.width = pct + '%';
      if (progTxt) {
        const labels = {
          loading_audio: 'Loading audio…',
          loading_reference: 'Analyzing reference…',
          highpass: 'High-pass filter…',
          eq_shaping: 'EQ shaping…',
          matching_eq: 'Matching EQ to reference…',
          compression: 'Glue compression…',
          loudness_measurement: 'Measuring loudness…',
          limiting: 'Brick-wall limiter…',
          writing: 'Writing output…',
        };
        progTxt.textContent = labels[m.step] || (m.step || 'Working…');
      }
    } catch {}
  });

  masterEvtSource.addEventListener('done', e => {
    try {
      const m = JSON.parse(e.data);
      masterResult = m;
      if (progFill) progFill.style.width = '100%';
      if (progTxt) progTxt.textContent = 'Done.';
      const stats = document.getElementById('master-result-stats');
      if (stats) {
        const inL = m.input_lufs;
        const outL = m.output_lufs;
        const gain = m.gain_applied_db;
        const peak = m.peak_dbfs;
        let line = `${m.preset_label || m.preset} · ${inL} → ${outL} LUFS · ${gain > 0 ? '+' : ''}${gain} dB · peak ${peak} dBFS`;
        // For reference-match, also surface the per-band deltas so users
        // can see WHAT was matched (e.g. "bass +2.1, mid -1.4, air +3.0").
        if (m.band_deltas_db) {
          const big = [];
          for (const [band, db] of Object.entries(m.band_deltas_db)) {
            if (Math.abs(db) >= 1.0) {
              big.push(band.split('-')[0] + 'Hz ' + (db > 0 ? '+' : '') + db.toFixed(1));
            }
          }
          if (big.length) line += '\n' + big.slice(0, 4).join(' · ');
        }
        stats.textContent = line;
        stats.style.whiteSpace = 'pre-line';
      }
      if (result) result.classList.remove('hidden');
      showAppNotification('✓ Mastered with ' + (m.preset_label || m.preset), 'ok');
    } catch {}
    if (btn) btn.disabled = false;
    if (lbl) lbl.textContent = 'Apply';
    if (masterEvtSource) { masterEvtSource.close(); masterEvtSource = null; }
  });

  masterEvtSource.addEventListener('error', e => {
    let msg = 'Mastering failed';
    try {
      const m = JSON.parse(e.data);
      if (m.message) msg = m.message;
    } catch {}
    if (progTxt) progTxt.textContent = msg;
    showAppNotification('✕ ' + msg.slice(0, 80), 'err');
    if (btn) btn.disabled = false;
    if (lbl) lbl.textContent = 'Apply';
    if (masterEvtSource) { masterEvtSource.close(); masterEvtSource = null; }
  });
}

function openMasteredFolder() {
  if (!masterResult || !masterResult.output_path) return;
  const dir = masterResult.output_path.split(/[/\\]/).slice(0, -1).join(require('path').sep || '/');
  if (api.openPath) api.openPath(dir);
}

function playMastered() {
  if (!masterResult || !masterResult.output_path) return;
  // Quick preview via a temporary HTMLAudioElement. We don't try to
  // integrate with the analyzer / mini-player here because the mastered
  // file isn't a stem and doesn't belong in the mixer view — just play
  // it back briefly so the user can A/B with the unmastered original.
  try {
    const a = new Audio('file://' + masterResult.output_path);
    a.volume = 0.9;
    a.play().catch(err => {
      diagLog('[master-preview] ' + err.message, 'err');
      showAppNotification('Preview failed — open folder to play in your audio app', 'info');
    });
  } catch (err) {
    showAppNotification('Preview failed: ' + err.message, 'err');
  }
}

function dragStem(ev, i) {
  const e = sepAudioMap[i];
  if (!e || !e.path) return;
  ev.stopPropagation();  // prevent the row's own dragstart from firing reorder
  ev.dataTransfer.effectAllowed = 'copy';

  if (api.startDrag) {
    ev.preventDefault();
    const label = (sepCurrent && sepCurrent.stems && sepCurrent.stems[i])
      ? (sepCurrent.stems[i].label || sepCurrent.stems[i].name || 'Stem')
      : 'Stem';
    const ghost = renderStemDragGhost(label);
    api.startDrag(e.path, ghost);
    return;
  }
  // Browser fallback (rare — Electron preload always provides startDrag)
  const filename = e.path.split(/[/\\]/).pop();
  ev.dataTransfer.setData('DownloadURL', 'audio/wav:' + filename + ':file://' + e.path);
}

// Lightweight glass-card ghost for stem drags
function renderStemDragGhost(label) {
  const DPR = 2;
  const W = 200, H = 48;
  const canvas = document.createElement('canvas');
  canvas.width = W * DPR; canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
  ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H);
  ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, 'rgba(18,18,18,0.94)');
  grad.addColorStop(1, 'rgba(28,28,28,0.90)');
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '600 14px Inter, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 16, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '500 11px Inter, -apple-system, sans-serif';
  ctx.fillText('Drag to DAW', 16, 36);
  return canvas.toDataURL('image/png');
}

// ── Drag history/stockpile rows out to the OS (DAWs, Explorer, etc.) ──────
// Reuses the same `api.startDrag` IPC that stem rows already use. From the
// renderer's perspective we just hand over a file path and a ghost preview;
// main.js calls Electron's webContents.startDrag, which announces a native
// drag operation. Receiving apps (FL Studio, Ableton, Logic, Reaper, Studio
// One, even File Explorer) see a real file drop and import normally.
//
// Why this matters: previously, getting a track into a DAW required
// (1) finding the right Stockpile folder in Explorer, (2) dragging from
// there. Now you can drag straight from the history list or any folder
// view. Saves 4-5 seconds per drag and feels like a real desktop app.
//
// Edge cases handled:
//   • Track has no file_path (deleted on disk, or download failed) →
//     showAppNotification with the reason, no drag fires.
//   • Track file_path points at a missing file → we still attempt the
//     drag; Electron returns silently and the receiving app shows
//     nothing. We can't easily fs.existsSync from the renderer without
//     an IPC round-trip, and the latency would kill the drag's
//     responsiveness. Better to fire and fail silently than block.
//   • Browser fallback path (no api.startDrag) sets DownloadURL — works
//     in browsers but unlikely to ever fire in Electron.

function dragHistoryRowToExternal(ev, histId) {
  const h = (histData || []).find(x => x.id === histId);
  if (!h) return;
  if (!h.file_path) {
    showAppNotification('No file on disk for this track', 'warn');
    ev.preventDefault();
    return;
  }
  _performExternalDrag(ev, h.file_path, h.title || (h.file_path.split(/[/\\]/).pop() || 'Track'));
}

function dragStockpileRowToExternal(ev, trackId) {
  const tr = (spFvTracks || []).find(x => x.id === trackId);
  if (!tr) return;
  if (!tr.file_path) {
    showAppNotification('No file on disk for this track', 'warn');
    ev.preventDefault();
    return;
  }
  _performExternalDrag(ev, tr.file_path, tr.title || (tr.file_path.split(/[/\\]/).pop() || 'Track'));
}

function _performExternalDrag(ev, filePath, label) {
  ev.stopPropagation();
  ev.dataTransfer.effectAllowed = 'copy';
  if (window.api && window.api.startDrag) {
    ev.preventDefault();
    const ghost = renderStemDragGhost(label);
    window.api.startDrag(filePath, ghost);
    return;
  }
  // Browser fallback — unlikely path in Electron, included for safety
  const filename = filePath.split(/[/\\]/).pop();
  ev.dataTransfer.setData('DownloadURL', 'audio/wav:' + filename + ':file://' + filePath);
}

function stopAllStems() {
  Object.values(sepAudioMap).forEach(e => {
    try { e.audio.pause(); } catch {}
  });
}

function closeSeparatorResults() {
  stopAllStems();
  destroyMixer();
  document.getElementById('stems-results').classList.add('hidden');
  // Reset master section state so a new separation starts fresh
  masterResult = null;
  if (masterEvtSource) { try { masterEvtSource.close(); } catch {} masterEvtSource = null; }
  const prog = document.getElementById('master-progress');
  const result = document.getElementById('master-result');
  if (prog) prog.classList.add('hidden');
  if (result) result.classList.add('hidden');
  // Clear any reference picked for this separation. Each song typically
  // wants its own reference; not carrying old references forward avoids
  // accidentally mastering Song B to Song A's reference.
  clearMasterReference();
  // Reset preset dropdown to default so reference-match doesn't surface
  // on the next results card unless the user picks it again.
  const presetSel = document.getElementById('master-preset');
  if (presetSel) {
    presetSel.value = 'loudness_normalize';
    onMasterPresetChange();
  }
}

// Cache of separator history rows so click handlers can look up the
// output_dir without inlining it through HTML attribute escaping (which
// eats backslashes from Windows paths and produces "C:UsersKnights Zody..." 
// with the slashes missing).
let sepHistData = [];

async function loadSepHistory() {
  if (!backendOnline) return;
  try {
    const r = await fetch(API + '/separator-history');
    const rows = await r.json();
    sepHistData = Array.isArray(rows) ? rows : [];
    const list = document.getElementById('sep-hist-list');
    if (!sepHistData.length) {
      list.innerHTML = '<div class="hist-empty" id="sep-hist-empty">' + t('sepEmpty') + '</div>';
      return;
    }
    list.innerHTML = sepHistData.map(row => {
      let stemsList = [];
      try { stemsList = JSON.parse(row.stems || '[]'); } catch {}
      const stemNames = stemsList.map(s => s.label || s.name).join(' · ');
      const meta = [
        row.model || '',
        (row.quality || '') ? row.quality : '',
        row.duration ? fmtTime(row.duration) : '',
        row.processing_time ? row.processing_time + 's' : '',
        row.device || '',
      ].filter(Boolean).join(' · ');
      return `
        <div class="sep-hist-row" onclick="openSepHistoryEntry(${row.id})">
          <div class="sep-hist-info">
            <div class="sep-hist-title">${escapeHtml(row.title || 'Untitled')}</div>
            <div class="sep-hist-meta">${escapeHtml(stemNames)}${stemNames ? ' — ' : ''}${escapeHtml(meta)}</div>
          </div>
          <button class="btn xs" onclick="openSepHistoryFolder(${row.id},event)" title="${t('sepOpenFolder') || 'Open folder'}">📁</button>
          <button class="btn xs danger" onclick="event.stopPropagation();deleteSepHistory(${row.id})" title="${t('remove')}">✕</button>
        </div>`;
    }).join('');
  } catch (e) {
    diagLog('loadSepHistory failed: ' + e.message, 'err');
  }
}

// Open a separator history entry: switches to the Separator tab and
// rebuilds the stem players from the saved record. Mirrors how the History
// tab loads a track into Analyze. Files are streamed from disk via /file.
function openSepHistoryEntry(id) {
  const row = sepHistData.find(r => r.id === id);
  if (!row) {
    diagLog('openSepHistoryEntry: id ' + id + ' not in cache', 'warn');
    return;
  }

  // Parse the stems JSON. Each stem has {label, path, color?, name?}.
  let stems = [];
  try { stems = JSON.parse(row.stems || '[]'); } catch (e) {
    diagLog('openSepHistoryEntry: bad stems JSON for id=' + id, 'err');
  }
  if (!stems.length) {
    showAppNotification(t('sepNoStemsRecorded') || 'No stems recorded for this entry', 'err');
    return;
  }

  // Verify at least the first stem file exists. If files were deleted
  // we'd rather tell the user up front than render broken players.
  fetch(API + '/path-exists?path=' + encodeURIComponent(stems[0].path))
    .then(r => r.json())
    .then(j => {
      if (!j.exists) {
        showAppNotification(
          (t('sepFolderMissing') || 'Output folder no longer exists') + ': ' + (row.output_dir || ''),
          'err'
        );
        return;
      }
      // Switch to Separator tab. Then rebuild the stem player UI.
      // Use the same path History uses to switch tabs programmatically.
      const stemsTabBtn = document.querySelector('.nav-btn[data-tab="stems"]');
      if (stemsTabBtn) showTab(stemsTabBtn);
      // Restore sepCurrent so transport / open-folder actions work too
      sepCurrent = {
        stems,
        output_dir: row.output_dir,
        model: row.model,
        mode: row.mode,
        quality: row.quality,
        device: row.device,
        duration: row.duration,
        processing_time: row.processing_time,
        bpm: row.bpm,  // pass through so the BPM grid can paint on the master waveform
        ensemble: stems.length >= 2,  // any saved entry with multi-stem implies ensemble path
      };
      // Render players. This is what `done` SSE handler does after a fresh run.
      try {
        renderStemPlayers(sepCurrent);
        document.getElementById('stems-results').classList.remove('hidden');
        // Hide the progress card if it was showing
        const prog = document.getElementById('stems-progress');
        if (prog) prog.classList.add('hidden');
        showAppNotification('✓ ' + (t('sepRestored') || 'Loaded from separator history'), 'ok');
      } catch (e) {
        diagLog('openSepHistoryEntry render failed: ' + e.message, 'err');
        showAppNotification('✕ ' + e.message, 'err');
      }
    })
    .catch(() => {
      // Server unreachable; try the render anyway, audio elements will surface their own errors
      const stemsTabBtn = document.querySelector('.nav-btn[data-tab="stems"]');
      if (stemsTabBtn) showTab(stemsTabBtn);
    });
}

// Reveal the entry's output folder in Explorer (separate explicit action).
function openSepHistoryFolder(id, evt) {
  if (evt) evt.stopPropagation();
  const row = sepHistData.find(r => r.id === id);
  if (!row || !row.output_dir) return;
  fetch(API + '/path-exists?path=' + encodeURIComponent(row.output_dir))
    .then(r => r.json())
    .then(j => {
      if (j.exists && api.openPath) api.openPath(row.output_dir);
      else showAppNotification(t('sepFolderMissing') || 'Folder no longer exists', 'err');
    })
    .catch(() => { if (api.openPath) api.openPath(row.output_dir); });
}

async function deleteSepHistory(id) {
  const ok = await confirmModal({
    title: t('removeConfirm') || 'Remove this entry?',
    message: 'The separated stems on disk are not deleted.',
    okLabel: 'Remove',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch(API + '/separator-history/' + id, { method: 'DELETE' });
    await loadSepHistory();
  } catch {}
}

// Wire up the separator drop zone — same pattern as analyze drop
window.addEventListener('DOMContentLoaded', () => {
  const drop = document.getElementById('drop-stems');
  if (drop) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (!f.path) {
        showAppNotification('✕ Cannot read file path', 'err');
        return;
      }
      sepSourcePath = f.path;
      sepSourceName = f.name;
      showSeparatorSource();
    });
  }
  // Restore ensemble preference from localStorage. We persist this because
  // quality-conscious users tend to keep it on once they've tried it.
  try {
    const ensembleOn = localStorage.getItem('freqphull.ensemble') === '1';
    window.sepEnsemble = ensembleOn;
    const cb = document.getElementById('stems-ensemble');
    if (cb) cb.checked = ensembleOn;
  } catch {}
  // Restore vocal-ensemble preference. Vocal-focused workflows (sampling,
  // remixing) typically want this on by default once enabled.
  try {
    const veOn = localStorage.getItem('freqphull.vocalEnsemble') === '1';
    window.sepVocalEnsemble = veOn;
    const cb = document.getElementById('stems-vocal-ensemble');
    if (cb) cb.checked = veOn;
  } catch {}
  // Restore de-reverb preference. Sample-flippers will turn this on once
  // and want it persisted as their default workflow.
  try {
    const drOn = localStorage.getItem('freqphull.dereverb') === '1';
    window.sepDereverb = drOn;
    const cb = document.getElementById('stems-dereverb');
    if (cb) cb.checked = drOn;
  } catch {}

  // Restore Quality Advanced state: preset + any per-pass overrides.
  // We apply the preset first (which moves the sliders to defaults and
  // clears overrides), then if any overrides are saved we re-apply them
  // on top so the slider positions match what the user last set.
  try {
    const savedPreset = localStorage.getItem('freqphull.fullnessPreset');
    if (savedPreset && ['subtle','balanced','aggressive'].includes(savedPreset)) {
      // Set state and pill text without going through setFullnessPreset
      // (which would clear overrides we're about to restore).
      window.sepFullnessPreset = savedPreset;
      const presetSel = document.getElementById('qa-preset');
      if (presetSel) presetSel.value = savedPreset;
      const pill = document.getElementById('quality-advanced-pill');
      if (pill) {
        pill.textContent = savedPreset.charAt(0).toUpperCase() + savedPreset.slice(1);
        pill.classList.remove('subtle','aggressive');
        if (savedPreset === 'subtle') pill.classList.add('subtle');
        if (savedPreset === 'aggressive') pill.classList.add('aggressive');
      }
      // Move sliders to preset defaults before applying any overrides
      const vals = _FULLNESS_PRESET_VALUES[savedPreset];
      if (vals) {
        _setSliderValue('qa-sustain',   'qa-sustain-val',   vals.sustain,     'x');
        _setSliderValue('qa-ducking',   'qa-ducking-val',   vals.ducking_db,  '+db');
        _setSliderValue('qa-transient', 'qa-transient-val', vals.transient_db,'±db');
      }
    }
    // Now restore any per-pass overrides on top of the preset
    const sus = localStorage.getItem('freqphull.fullnessSustainOverride');
    if (sus !== null) {
      const v = parseFloat(sus);
      if (isFinite(v)) {
        window.sepFullnessSustainOverride = v;
        _setSliderValue('qa-sustain', 'qa-sustain-val', v, 'x');
      }
    }
    const duk = localStorage.getItem('freqphull.fullnessDuckingOverride');
    if (duk !== null) {
      const v = parseFloat(duk);
      if (isFinite(v)) {
        window.sepFullnessDuckingOverride = v;
        _setSliderValue('qa-ducking', 'qa-ducking-val', v, '+db');
      }
    }
    const tra = localStorage.getItem('freqphull.fullnessTransientOverride');
    if (tra !== null) {
      const v = parseFloat(tra);
      if (isFinite(v)) {
        window.sepFullnessTransientOverride = v;
        _setSliderValue('qa-transient', 'qa-transient-val', v, '±db');
      }
    }
  } catch {}
  // Start the periodic auto-clear sweep. The dropdown that controls this
  // lives in Settings → "Auto-clear download queue" — its onchange wires
  // straight into setDlAutoclear which updates dlAutoclearHours and runs
  // an immediate sweep. The interval below is the steady-state pass that
  // catches items as they age out.
  if (!_dlSweepInterval) {
    _dlSweepInterval = setInterval(_sweepStaleDownloads, 60 * 1000);
  }
});


// ── Engines setup (first launch) ──────────────────────────────────────────
// Check if engine runtime is installed. If not, show the
// big setup modal that runs setup-engines.ps1 and streams progress in.
let setupEvtSource = null;
let setupSkipped = false;

async function checkEnginesStatus() {
  if (!backendOnline) return;
  // First: if a setup is currently running on the backend, jump straight into
  // showing live progress. Don't show the confirm dialog with a "Begin" button
  // because the user already kicked it off in a previous session.
  try {
    const sR = await fetch(API + '/setup-status');
    const sJ = await sR.json();
    if (sJ.running) {
      diagLog('Setup is already running on backend; rejoining', 'info');
      showSetupModal();
      // Jump straight to progress card
      document.getElementById('setup-confirm').classList.add('hidden');
      document.getElementById('setup-progress').classList.remove('hidden');
      // Subscribe to live updates the same way startEnginesSetup does
      setupFinished = false;
      if (setupEvtSource) { try { setupEvtSource.close(); } catch {} }
      setupEvtSource = new EventSource(API + '/setup-engines');
      setupEvtSource.addEventListener('progress', e => {
        try {
          const m = JSON.parse(e.data);
          const pct = typeof m.progress === 'number' ? m.progress : null;
          setSetupProgress(pct, m.message || stepToHuman(m.step), m.detail || '');
        } catch {}
      });
      setupEvtSource.addEventListener('done', () => {
        setupFinished = true;
        setSetupProgress(100, t('setupAllSet'), '');
        document.getElementById('setup-progress').classList.add('hidden');
        document.getElementById('setup-done').classList.remove('hidden');
        closeSetupConn();
        setTimeout(hideSetupModal, 2200);
        showAppNotification('✓ ' + t('enginesReady'), 'done');
        try { localStorage.removeItem('freqphull_setup_skipped'); } catch {}
      });
      setupEvtSource.addEventListener('error', e => {
        if (e.data) {
          setupFinished = true;
          let msg = 'Setup failed', hint = '';
          try { const m = JSON.parse(e.data); if (m.message) msg = m.message; if (m.hint) hint = m.hint; } catch {}
          showSetupError(msg, hint);
          closeSetupConn();
        } else {
          closeSetupConn();
          if (!setupFinished) startSetupPolling();
        }
      });
      return;
    }
  } catch (e) {
    diagLog('setup-status check failed: ' + e.message, 'err');
  }

  // If user previously chose to skip, don't nag every launch
  try {
    if (localStorage.getItem('freqphull_setup_skipped') === '1') {
      setupSkipped = true;
      return;
    }
  } catch {}
  try {
    const r = await fetch(API + '/engines-status');
    const j = await r.json();
    if (!j.installed) {
      diagLog('AI engines not installed - showing setup modal', 'info');
      showSetupModal();
    } else {
      diagLog('AI engines marker found, skipping setup', 'ok');
    }
  } catch (e) {
    diagLog('engines-status check failed: ' + e.message, 'err');
  }
}

function showSetupModal() {
  const modal = document.getElementById('setup-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('setup-confirm').classList.remove('hidden');
  document.getElementById('setup-progress').classList.add('hidden');
  document.getElementById('setup-error').classList.add('hidden');
  document.getElementById('setup-done').classList.add('hidden');
}

function hideSetupModal() {
  const modal = document.getElementById('setup-modal');
  if (modal) modal.style.display = 'none';
}

function skipEnginesSetup() {
  if (setupEvtSource) { try { setupEvtSource.close(); } catch {} setupEvtSource = null; }
  try { localStorage.setItem('freqphull_setup_skipped', '1'); } catch {}
  setupSkipped = true;
  hideSetupModal();
  showAppNotification(t('setupRunningLater'), 'info');
}

// Polling state used when EventSource drops mid-install
let setupPollTimer = null;
let setupFinished = false; // local flag set on done/error so polling stops

function startEnginesSetup() {
  document.getElementById('setup-confirm').classList.add('hidden');
  document.getElementById('setup-error').classList.add('hidden');
  document.getElementById('setup-done').classList.add('hidden');
  document.getElementById('setup-progress').classList.remove('hidden');
  setSetupProgress(0, 'Starting…', '');
  setupFinished = false;

  if (setupEvtSource) { try { setupEvtSource.close(); } catch {} }
  if (setupPollTimer) { clearInterval(setupPollTimer); setupPollTimer = null; }

  setupEvtSource = new EventSource(API + '/setup-engines');

  setupEvtSource.addEventListener('progress', e => {
    try {
      const m = JSON.parse(e.data);
      const pct = typeof m.progress === 'number' ? m.progress : null;
      setSetupProgress(pct, m.message || stepToHuman(m.step), m.detail || '');
    } catch {}
  });

  setupEvtSource.addEventListener('done', () => {
    setupFinished = true;
    setSetupProgress(100, t('setupAllSet'), '');
    document.getElementById('setup-progress').classList.add('hidden');
    document.getElementById('setup-done').classList.remove('hidden');
    closeSetupConn();
    setTimeout(hideSetupModal, 2200);
    showAppNotification('✓ ' + t('enginesReady'), 'done');
    try { localStorage.removeItem('freqphull_setup_skipped'); } catch {}
  });

  setupEvtSource.addEventListener('error', e => {
    // Distinguish a server-emitted error (has data) from a native connection drop.
    // EventSource fires 'error' both on actual errors AND on connection close
    // (network blip, browser idle timeout, page navigation). For drops, the
    // setup process keeps running on the server, so we switch to polling
    // /setup-status instead of marking the whole flow as failed.
    if (e.data) {
      // Real server error message
      setupFinished = true;
      let msg = 'Setup failed';
      let hint = '';
      try {
        const m = JSON.parse(e.data);
        if (m.message) msg = m.message;
        if (m.hint) hint = m.hint;
      } catch {}
      showSetupError(msg, hint);
      closeSetupConn();
    } else {
      // Native connection drop - do NOT mark failed. Switch to polling.
      diagLog('setup SSE dropped, falling back to /setup-status polling', 'info');
      closeSetupConn();
      if (!setupFinished) startSetupPolling();
    }
  });
}

function closeSetupConn() {
  if (setupEvtSource) { try { setupEvtSource.close(); } catch {} setupEvtSource = null; }
  if (setupPollTimer) { clearInterval(setupPollTimer); setupPollTimer = null; }
}

function startSetupPolling() {
  if (setupPollTimer) clearInterval(setupPollTimer);
  // Poll /setup-status every 1.5s until done or errored
  setupPollTimer = setInterval(async () => {
    try {
      const r = await fetch(API + '/setup-status');
      const j = await r.json();
      // Update progress from the latest event we have
      if (j.lastEvent) {
        const m = j.lastEvent.data || {};
        if (j.lastEvent.type === 'progress') {
          const pct = typeof m.progress === 'number' ? m.progress : null;
          setSetupProgress(pct, m.message || stepToHuman(m.step), m.detail || '');
        }
      }
      if (!j.running) {
        // Setup finished. Inspect the last error if any.
        clearInterval(setupPollTimer); setupPollTimer = null;
        setupFinished = true;
        if (j.lastError) {
          showSetupError(j.lastError.message || 'Setup failed', j.lastError.hint || '');
        } else {
          // No error recorded - assume success. Verify via /engines-status.
          const sR = await fetch(API + '/engines-status');
          const sJ = await sR.json();
          if (sJ.installed) {
            setSetupProgress(100, t('setupAllSet'), '');
            document.getElementById('setup-progress').classList.add('hidden');
            document.getElementById('setup-done').classList.remove('hidden');
            setTimeout(hideSetupModal, 2200);
            showAppNotification('✓ ' + t('enginesReady'), 'done');
            try { localStorage.removeItem('freqphull_setup_skipped'); } catch {}
          } else {
            showSetupError('Setup ended without confirmation',
              'Engines marker is missing. Check Settings -> View logs -> Setup tab for details.');
          }
        }
      }
    } catch (e) {
      diagLog('setup-status poll failed: ' + e.message, 'err');
    }
  }, 1500);
}

function showSetupError(msg, hint) {
  document.getElementById('setup-progress').classList.add('hidden');
  document.getElementById('setup-error').classList.remove('hidden');
  document.getElementById('setup-error-msg').textContent = msg;
  document.getElementById('setup-error-hint').textContent = hint || '';
}

async function cancelEnginesSetup() {
  closeSetupConn();
  setupFinished = true;
  try { await fetch(API + '/setup-cancel', { method: 'POST' }); } catch {}
  hideSetupModal();
  showAppNotification(t('setupCancelled'), 'info');
}

function retryEnginesSetup() {
  startEnginesSetup();
}

function setSetupProgress(pct, msg, detail) {
  const fill = document.getElementById('setup-prog-fill');
  const pctEl = document.getElementById('setup-prog-pct');
  const stepEl = document.getElementById('setup-step-msg');
  const detailEl = document.getElementById('setup-prog-detail');
  if (fill && typeof pct === 'number') fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (pctEl && typeof pct === 'number') pctEl.textContent = Math.round(pct) + '%';
  if (stepEl && msg !== undefined) stepEl.textContent = msg;
  if (detailEl && detail !== undefined) detailEl.textContent = detail;
}

function stepToHuman(step) {
  const d = {
    starting:               'Starting setup…',
    checking_python:        'Checking for Python…',
    python_found:           'Python detected',
    downloading_python:     'Downloading Python…',
    installing_python:      'Installing Python…',
    upgrading_pip:          'Updating pip…',
    installing_pytorch:     'Installing runtime (heaviest step)…',
    pytorch_cached:         'Runtime already installed',
    pytorch_installed:      'Runtime installed',
    installing_separator:   'Installing separation engine…',
    separator_cached:       'Separation engine already installed',
    separator_installed:    'Separation engine installed',
    installing_whisper:     'Installing transcription engine…',
    whisper_cached:         'Transcription engine already installed',
    whisper_installed:      'Transcription engine installed',
    downloading_models:     'Downloading AI models…',
    dl_vocal:               'Downloading Stage 1 model (~640MB)…',
    dl_vocal_done:          'Stage 1 model ready',
    dl_vocal_skip:          'Stage 1 model skipped — will download on first separation',
    dl_demucs:              'Downloading Stage 2 model (~330MB)…',
    dl_demucs_done:         'Stage 2 model ready',
    dl_demucs_skip:         'Stage 2 model skipped — will download on first separation',
    dl_whisper:             'Downloading transcription model (~150MB)…',
    dl_whisper_done:        'Transcription model ready',
    dl_whisper_skip:        'Transcription model skipped — will download on first transcription',
    all_models_done:        'All models ready',
    finalizing:             'Finalizing…',
  };
  return d[step] || step || '…';
}


const T = {
  en: {
    // ── v0.2.8: hardware acceleration ──
    hwAccelName:'Hardware acceleration',
    hwAccelDesc:"Uses the GPU for rendering, animations, and the analyzer canvases. Recommended ON for most users. Turn OFF only if you see graphical glitches, white flashes, or your laptop's fan ramps up just from idle scrolling - some integrated GPUs handle Electron poorly. Requires an app restart to take effect.",
    hwAccelUnavailable:'Hardware acceleration toggle unavailable on this build',
    hwAccelOnNotif:'Hardware acceleration: ON',
    hwAccelOffNotif:'Hardware acceleration: OFF',
    hwAccelRestartTitle:'Restart required',
    hwAccelRestartBody:'This setting only takes effect after restarting Freq.Phull. Restart now?',
    hwAccelRestartNow:'Restart now',
    hwAccelRestartLater:'Restart later',
    // ── v0.2.8: extension link + how-to ──
    extLinkName:'Browser extension',
    extLinkDesc:'A Chrome extension that adds a Grab button to YouTube so you can pull beats straight into Freq.Phull. Updated independently from the main app via the same GitHub repo.',
    extLinkOpen:'Open page',
    extLinkHowTo:'How to install',
    extHowToTitle:'Install the browser extension',
    extHowToSub:'Chrome, Edge, Brave, Opera, Arc - any Chromium-based browser. 1 minute setup.',
    extHowToStep1Title:'Download the extension folder',
    extHowToStep1Desc:'Open the repo and download the freqpull-ext folder as a ZIP, then unzip it somewhere you will not move it from (Documents works fine).',
    extHowToStep1Btn:'Open GitHub repo',
    extHowToStep2Title:'Open your extensions page',
    extHowToStep2Desc:'Paste this in your browser address bar and hit Enter:',
    extHowToStep3Title:'Enable Developer mode',
    extHowToStep3Desc:'Top-right toggle on the extensions page. This lets you install local extensions; you only need to do it once.',
    extHowToStep4Title:'Click "Load unpacked"',
    extHowToStep4Desc:'Button appears once Developer mode is on. Select the freqpull-ext folder you unzipped in step 1.',
    extHowToStep5Title:'Pin and use',
    extHowToStep5Desc:'Click the puzzle-piece icon in your browser toolbar, then the pin next to Freq.Phull. The extension panel will open beside any YouTube video; press Grab to send it to the app.',
    extHowToTip:'Tip: keep Freq.Phull desktop running. The extension talks to it on 127.0.0.1:47891 - downloads land in your library automatically.',
    extHowToOpenRepo:'Open repo',

    // ── Boot update check toasts (0.2.8) ──
    updCheckingBoot:'Checking for updates...',
    updUpToDate:"You're up to date",

    // ── Repair metadata (0.2.7) ──
    storRepairThumbs:'Fix missing thumbnails',
    storRepairScanning:'Scanning for rows with missing thumbnails or duration...',
    storRepairNone:'All rows have complete metadata. Nothing to repair.',
    storRepairConfirm:'Found {n} rows with missing metadata.\n\n{twin} can be fixed instantly by copying from a YouTube-original twin row.\n{probe} will be probed with ffmpeg (slower, ~50ms each).\n\nProceed?',
    storRepairDone:'Repaired {n} rows ({twin} via twin merge, {probe} via ffprobe)',

    // ── Scroll-lock toggle (0.2.6) ──
    scrollLockOn:'Following playing track in History',
    scrollLockOff:'Browsing freely - track will change without scrolling',
    scrollLockTitleOn:'Following - click to browse freely while playing',
    scrollLockTitleOff:'Browsing freely - click to follow the playing track',

    // ── Background analysis pill (0.2.2) ──
    bgAnalyzing:'Analyzing',
    bgPending:'tracks pending — click to retry',
    bgCaughtUp:'All tracks analyzed',

    // ── Auto-tag opt-out (0.2.2) ──
    autoTagName:'Auto-tag downloads',
    autoTagDesc:"After each download, scan the title against your Stockpile folders' artist seeds and tag matches automatically. Turn OFF to keep new downloads completely untagged — you'll handle organization manually, or in batches via Auto-organize. (Disabling this also turns Auto-send into a no-op, since there's no tag to act on.)",
    autoTagOnNotif:'Auto-tag ON — downloads will be matched to folders by artist',
    autoTagOffNotif:'Auto-tag OFF — downloads stay untagged, organize manually',

    // ── Beat switch (0.1.3) ──
    bsTitle:'Beat switch detected',
    bsSection:'Beat',
    bsSwitchAt:'Switch at',
    bsChange_bpm:'tempo change', bsChange_key:'key change', bsChange_harmony:'new melody', bsChange_energy:'energy jump',
    bsNone:'No beat switch detected at normal sensitivity.',
    bsForceBtn:'Scan harder',
    bsForcing:'Re-scanning with lower threshold…',
    bsLoadFirst:'Load the track in the Analyzer to seek',

    // ── 0.1.1 features ──
    watchName:'Watch stockpile folder',
    watchDesc:"Monitor the stockpile root for new audio files dropped in from anywhere (Explorer, other apps, network drives). New files are imported into the library, fingerprinted, and auto-matched automatically — combined with Auto-send they get filed into the right folder without you touching anything.",
    watchOnNotif:'Watching stockpile folder — new audio gets imported automatically',
    watchOffNotif:'Watch folder off',
    ytdlpAvail:'update available — click to install',
    ytdlpUpToDate:'up to date',
    ytdlpSystem:'yt-dlp is system-installed — update it via your package manager',
    sepqTitle:'Separation queue',
    sepqWaiting:'waiting',
    sepqAdded:'{n} added to separation queue',
    sepqSkipped:'skipped (no file)',
    sepqClear:'Clear finished',
    sepSendSelected:'Separate',
    simBtn:'Find similar tracks',
    simTitle:'Similar tracks',
    simLooking:'Comparing fingerprints, mood, BPM and key…',
    simNone:'No similar tracks found. More tracks need fingerprints or analysis — run the backfill in Find duplicates, or analyze more of your library.',
    simOpen:'Open',
    simReason_sound:'sound', simReason_mood:'mood', simReason_bpm:'BPM', simReason_key:'key',

    // ── i18n sweep batch 2 (0.1.0) ──
    backendOfflineRetry:'Backend offline — try again in a moment',
    dupBackfillHead:'{n} tracks aren\'t fingerprinted yet.',
    dupBackfillDesc:'New downloads are fingerprinted automatically. Existing tracks need a one-time scan. Each takes a few seconds; runs in the background.',
    dupBackfillBtn:'Backfill {n} tracks',
    dupNoneFound:'No duplicates found across <strong>{n}</strong> fingerprinted tracks.',
    dupNotScanned:'({n} tracks not yet scanned)',
    dupKeep:'KEEP',
    dupGroupWord:'Group',
    dupOne:'duplicate', dupMany:'duplicates',
    dupDeleteChecked:'Delete checked',
    dupFoundSummary:'Found <strong>{x}</strong> duplicate {g} across <strong>{n}</strong> fingerprinted tracks. The oldest track in each group is marked "KEEP" by default. Uncheck any duplicate you want to keep.',
    dupGroupOne:'group', dupGroupMany:'groups',
    dupNothingChecked:'Nothing checked',
    dupDeleteTitle:'Delete {n} {w}?',
    dupDeleteMsg:'Removes the selected entries from your history. The actual audio files on disk are NOT deleted — only the history records. To free disk space, delete the files in your file manager afterward.',
    deletedWord:'Deleted',
    fixFilesConfirmTitle:'Fix file locations?',
    fixFilesConfirmMsg:"Scans every tagged track and moves any whose files aren't in their primary folder on disk. Files are never deleted — only moved into place.",
    stockRootLbl:'Stockpile root:',
    scanningBtn:'Scanning…',
    movedWord:'Moved',
    alreadyInPlace:'already in place',
    missingOnDisk:'missing on disk',
    errorsWord:'errors',
    checkedNothing:'Checked {n} — nothing to do',
    cleanConfirmTitle:'Clean Freq.Phull temp files?',
    cleanConfirmMsg:'Removes WAV files older than 1 hour from Windows Temp that Freq.Phull left behind from analysis, stem separation, and conversion. Anything currently being processed is safe.',
    cleaningBtn:'Cleaning…',
    cleanedResult:'Cleaned {n} {w} ({mb} MB freed)',
    cleanNothing:'Nothing to clean — temp folder is tidy',
    updDevOnly:'Updates only work in packaged builds',
    updDevOnlyLong:'Updates only work in the packaged (installed) build, not in dev mode.',
    updApiUnavailable:'Update API unavailable in this build',
    checkingBtn:'Checking…',

    // ── Settings page (patch 0.1.0 i18n) ──
    fixFilesName:'Fix file locations',
    fixFilesDesc:"Scan every tagged track and move any whose files aren't in their primary folder. Files that should be in <code>Cali Type beat/</code> but ended up elsewhere get moved into place. Safe to re-run.",
    btnFixFiles:'Fix files',
    cleanTempName:'Clean temp files',
    cleanTempDesc:"Removes Freq.Phull's leftover WAV files from Windows Temp (older than 1 hour). Only touches files starting with <code>freqphull_</code> — never the app's own runtime folders. Runs automatically every 6 hours; use this for a manual sweep.<br><strong>Do NOT use <code>del Temp\\*</code> manually</strong> — it will delete the portable build's ffmpeg/yt-dlp binaries and break downloads until you relaunch.",
    btnCleanNow:'Clean now',
    autoSendName:'Auto-send to detected folder',
    autoSendDesc:"When a new download matches a Stockpile folder's artist seeds, don't just tag it — automatically make that folder the track's primary and move the file into <code>StockpileRoot/FolderName/</code> right away. Tracks with no confident match stay where they land and can be sorted later with Auto-organize.",
    autoSendOnNotif:'New downloads will be moved into their detected folder',
    autoSendOffNotif:'Auto-send off — downloads stay put, tags only',
    sentTo:'Sent to',
    storName:'Storage breakdown',
    storDesc:'See how much disk space each Stockpile folder uses, find missing files, spot orphaned audio in your stockpile root.',
    btnViewStorage:'View storage',
    dupName:'Find duplicate tracks',
    dupDesc:'Detect tracks with identical audio (same song re-uploaded under different YouTube URLs, different bitrates, etc.). Uses a perceptual fingerprint of the audio itself, not filenames. New downloads are fingerprinted automatically; existing tracks need a one-time backfill.',
    btnFindDupes:'Find duplicates',
    updName:'Check for updates',
    updDesc:'Manually check GitHub for a newer release. Updates download in the background and prompt to install when ready. The app also checks automatically every 4 hours.',
    btnCheckNow:'Check now',
    cpuOnlyName:'Force CPU-only for stem separation',
    cpuOnlyDesc:'Skip GPU acceleration even when a CUDA GPU is available. Use this on low-VRAM machines (under 4GB) or to keep the GPU free for DAW plugins / other apps. Slower but lower system load.',
    writeTagsName:'Write BPM &amp; key into audio files',
    writeTagsDesc:"After analysis, stamp the detected BPM and musical key into the audio file's standard metadata tags (ID3 for MP3/WAV, Vorbis for FLAC/OGG, MP4 atoms for M4A). FL Studio, Mixed In Key, Rekordbox, foobar2000, and Apple Music all read these tags — so your analysis follows the file anywhere it goes. Default on. Disable if you want files to remain bit-identical to the original download.",
    dlClearName:'Auto-clear download queue',
    dlClearDesc:'Completed and failed downloads disappear from the Downloads list after this much time. Active downloads are never auto-cleared. Set to "Off" to keep them visible until you manually clear.',
    optOff:'Off', optHour1:'1 hour', optHours12:'12 hours', optHours24:'24 hours', optHours72:'72 hours',
    enginesName:'AI Engines',
    runSetupBtn:'Run setup',
    diagName:'Diagnose paths',
    diagDesc:"Check which binaries the app can find — useful when ffmpeg, yt-dlp etc. aren't working",
    btnDiagnose:'Diagnose',
    logsName:'View logs',
    logsDesc:'Server + setup logs, useful for debugging',
    devBuild:'Development build',
    checking:'Checking…',
    // ── Storage breakdown modal ──
    storSub:'Per-folder disk usage and orphan detection',
    storScanning:'Scanning your stockpile…',
    storTotalIn:'total in stockpile',
    storTagged:'tagged',
    storFreeOnDrive:'free on this drive',
    storMissingOne:'missing file', storMissingMany:'missing files',
    storOrphanOne:'untagged audio file in root', storOrphanMany:'untagged audio files in root',
    storMissingNote:'missing',
    storNoFolders:'No folders yet — create one in Stockpile to start organizing',
    fileWord:'file', filesWord:'files',
    storLocate:'Locate missing files',
    storPrune:'Remove dead entries',
    storImportBtn:'Import untagged files',
    storImporting:'Importing files…',
    notifImported:'Imported', notifStemsSkipped:'stem files skipped',
    importFailed:'Import failed:',
    pruneNoDead:'No dead entries found',
    pruneConfirm:'Remove {n} history entries whose audio file no longer exists?\n\nThis only deletes the database rows (and their folder tags) — no files are touched.\nTip: run "Locate missing files" first if the files might just have moved.',
    pruneRemoved:'Removed', deadEntriesWord:'dead entries',
    pruneFailed:'Prune failed:',
    scanRelocatable:'Scanning for relocatable files…',
    setStockpileFirst:'Set a stockpile folder in Settings first',
    backendOffline:'Backend offline',
    // ── Auto-organize modal ──
    aoTitle:'Auto-organize',
    aoScanningSub:'Scanning untagged tracks for folder matches…',
    aoLooking:'Looking for matches…',
    aoNoFolders:'No folders to suggest from. Create at least one folder (with artist seeds or some tagged tracks) first.',
    aoNoUntagged:'No untagged tracks. Nice and clean!',
    aoNoneMatched:'{n} untagged tracks found, but none matched any folder above the confidence threshold. Try adding artist seeds to your folders, or tag a few manually so the mood model has more to learn from.',
    aoFound:"Found <strong>{x}</strong> matches out of <strong>{y}</strong> untagged tracks. Uncheck any you don't want. Each track gets the picked folder as its primary tag — files get moved into place automatically.",
    aoSelectAll:'✓ Select all', aoClearSel:'○ Clear', aoConf70:'≥ 70% only',
    aoApply:'Apply selected',
    aoNothing:'Nothing selected',
    aoApplying:'Applying',
    aoTaggedOk:'Tagged', failedWord:'failed',
    // ── Duplicate finder / repair / logs / diag ──
    dupSub:'Tracks with near-identical audio content',
    rrTitle:'Review Matches',
    rrApplyAll:'Apply all top matches',
    logsTitle:'Logs',
    diagTitle:'Diagnose Paths',
    copyClip:'Copy to clipboard',
    cancelWord:'Cancel', deleteWord:'Delete', previewWord:'Preview',
    // ── Previously missing keys (had inline fallbacks) ──
    autoMatched:'Auto-tagged into',
    setupRequired:'Setup required',
    setupRun:'Run setup',

    // Nav
    download:'Download', analyze:'Analyze', transcribe:'Transcribe',
    tools:'Tools', history:'History', settings:'Settings',
    stems:'Separator',
    // Download tab
    dlTitle:'Download', dlSub:'Paste a YouTube URL and save as MP3, WAV, FLAC and more',
    ytUrl:'YouTube URL', format:'Format', fetch:'Fetch',
    dlReady:'Ready — choose a format and download',
    dlPaste:'Paste a YouTube URL to get started',
    folderLbl:'Downloads folder', change:'Change',
    // Analyze tab
    anaTitle:'Analyze', anaSub:'Detect BPM, key, chords and more from any audio file',
    dropTitle:'Drop an audio file here', dropSub:'or click to browse — MP3 · WAV · FLAC · OGG · M4A',
    bpm:'BPM', key:'KEY', length:'LENGTH',
    camelot:'CAMELOT', chords:'CHORDS', pitch:'PITCH',
    exportWav:'⬇ Export WAV', dragHint:'After grabbing, drag from Chrome\'s download bar straight into FL Studio',
    notes:'NOTES', notesPlaceholder:'Lyrics, ideas…',
    // Transcribe tab
    transTitle:'Transcribe', transSub:'Use AI to convert audio to text — powered by Whisper',
    transModel:'Model', transLang:'Language', transAuto:'Auto',
    transCopy:'Copy', transSave:'Save .txt',
    // Separator tab
    sepTitle:'Separator', sepSub:'Pro-grade stem separation — multi-stage ensemble, runs locally',
    sepDropTitle:'Drop a track to separate', sepDropSub:'or click to browse — MP3 · WAV · FLAC · OGG · M4A',
    sepStemsLbl:'Stems', sepQualityLbl:'Quality',
    sep4Stems:'4 Stems', sep6Stems:'6 Stems',
    sepFast:'Fast', sepHigh:'High', sepUltra:'Ultra',
    sepStart:'Separate Stems', sepResults:'Separated Stems',
    sepOpenFolder:'Open Folder', sepSendToSeparator:'Send to Separator',
    sepHistory:'Separator History', sepEmpty:'No separations yet',
    sepMode4Desc:'Vocals · Drums · Bass · Other',
    sepMode6Desc:'Vocals · Drums · Bass · Guitar · Piano · Other',
    sepQuality_fast:'Fast — single-shot · ~1× realtime on CPU',
    sepQuality_high:'Balanced — 1 shift on instrumental · ~2× realtime on CPU',
    sepQuality_ultra:'Ultra — 1 shift, max overlap · ~2.5× realtime on CPU',

    // Stockpile
    spTitle:'Stockpile', spSub:'Organize your beats by style, mood, and artist',
    spFolders:'Style Folders', spTagged:'Tagged', spCommitted:'Committed', spUntaggedLbl:'Untagged',
    spDestTitle:'Stockpile destination',
    spDestHint:'Tagged tracks move into <code>{root}/{folder name}/</code> when committed.',
    spStyleFolders:'Style Folders', spNewFolderBtn:'+ New folder',
    spNoFolders:'No folders yet.',
    spNoFoldersHint:"Create your first style folder — Cali Trap, Detroit, Atlanta Trap, Drill, whatever scenes you work in.",
    spUntagged:'Untagged', spAllTagged:'All tracks tagged.',
    spLoadingSugs:'Loading suggestions…',
    spTrack:'track', spTracks:'tracks',
    spMore:'more',
    spTagBtn:'Tag',
    spTagged:'Tagged',
    spTagThisTrack:'Tag this track',
    spSuggestions:'Suggestions',
    spAllFolders:'All folders',
    spNoSuggestions:'No suggestions — pick a folder below',
    spFolderViewComingSoon:'(folder browser coming next patch)',
    spNewFolder:'New style folder', spEditFolder:'Edit folder',
    spFolderName:'Folder name', spFolderDesc:'Description (optional)',
    spFolderSeeds:'Artist seeds — comma-separated',
    spFolderSeedsHint:'When a track filename mentions any of these, it\'ll be auto-suggested for this folder.',
    spCancel:'Cancel', spCreate:'Create', spSave:'Save',
    spNameRequired:'Folder name is required',
    spFolderCreated:'Folder created',
    spFolderSaved:'Folder saved',
    spFolderDeleted:'Folder deleted',
    spDeleteFolder:'Delete the folder "{name}"? This won\'t delete any audio files.',
    spDeleteFolderWithTracks:'Delete the folder "{name}"? It currently has {n} tagged tracks. The tags will be removed but the audio files won\'t be touched.',
    stockpileNotSet:'Not set — click to choose',
    // Bulk match
    spAutoMatchTooltip:'Auto-match tracks to this folder',
    spFindingMatches:'Finding matches…',
    spScanning:'Scanning your library…',
    spMatchesFor:'Matches for',
    spArtistMatches:'Artist matches',
    spMoodMatches:'Mood-similar matches',
    spMatchArtist:'matches',
    spMatchMood:'similar mood',
    spNoMatchesYet:'No matches yet.',
    spNoMatchesHint:'Add artist seeds to this folder, or tag a few tracks manually so the system learns the mood profile. Then come back here.',
    spSelectAll:'Select all',
    spSelectNone:'Select none',
    spTagSelected:'Tag selected',
    spTagging:'Tagging',
    spNoTracksSelected:'No tracks selected',
    spTaggedNTracks:'Tagged {n} tracks',
    spClose:'Close',
    sepNoOutDir:'No output folder recorded for this entry',
    sepFolderMissing:'Output folder no longer exists. The stems may have been moved or deleted.',
    // Folder view
    spLoading:'Loading…',
    spNoMatches:'No tracks match',
    spFolderEmpty:'No tracks tagged in this folder yet',
    spPreview:'Preview',
    spChangeFolder:'Move to another folder',
    spShowInExplorer:'Show in Explorer',
    spRemoveFromFolder:'Remove from this folder',
    spConfirmUntag:'Remove this track from the folder? The audio file will not be deleted.',
    spUntagged:'Removed from folder',
    spPreviewError:'Cannot play this file',
    spFileMissing:'File no longer exists at',
    spOpenAnalysis:'Open full analysis',
    spJumpToAnalyze:'Open in Analyzer',
    spInAnalyzer:'in Analyzer',
    sepRestored:'Loaded from separator history',
    sepNoStemsRecorded:'No stems recorded for this entry',
    sepOpenFolder:'Open folder',
    sepSeekWaveform:'Click to seek',
    sepSeekMaster:'Click to seek (all stems)',
    sepStillLoading:'Stems still loading…',
    sepMasterVolume:'Master volume',
    miniMirrorNoPlaylist:'No playlist in Analyzer mode',
    miniNoPrev:'No previous track',
    miniNoNext:'No next track',
    miniNoTrack:'No track loaded',
    miniShuffleOn:'Shuffle on',
    miniShuffleOff:'Shuffle off',
    miniLoopOff:'Loop off',
    miniLoopPlaylist:'Loop playlist',
    miniLoopTrack:'Loop track',
    miniNotesFor:'Notes for',
    miniSaved:'Saved',
    miniSaving:'Saving…',
    histFavorite:'Favorite',
    sepLoopRegion:'Loop region — Shift+drag to set',
    sepLoopHint:'Shift+drag on the waveform to set loop region',
    sepLoopSet:'⟲ Loop:',
    sepLoopCleared:'Loop cleared',
    spFolderMoodProfile:'Folder mood profile',
    spMoodEnergy:'Energy',
    spMoodBrightness:'Brightness',
    spMoodDensity:'Density',
    spMoodTempo:'Tempo',
    spSeedsLabel:'Artist seeds',
    spTracks:'Tracks',
    spSortNewest:'Newest first',
    spSortOldest:'Oldest first',
    spSortTitle:'Title A→Z',
    spSortBpmAsc:'BPM ↑',
    spSortBpmDesc:'BPM ↓',
    spSortKey:'Key',
    spSearchInFolder:'Search inside this folder…',
    sepStageDone:'Done', sepFailed:'Separation failed',
    sepStageVocal:'Vocals', sepStageInst:'Instrumental',
    sepDirectLabel:'Keep producer vocal samples in beat',
    sepDirectDesc:'Skips Stage 1. Faster. Vocal samples in the instrumental (ad-libs, vocal chops) stay in \'other\' instead of being merged with lead vocals.',
    sepNoTrack:'No track loaded', sepBackendOffline:'Backend offline',
    sepReady:'Stems ready', sepPreparing:'Preparing…',
    sepPlay:'Play', sepPause:'Pause', sepMute:'Mute', sepSolo:'Solo',
    sepPlayAll:'Play all', sepPauseAll:'Pause all', sepStopAll:'Stop',
    sepMixerTitle:'Mixer', sepVolume:'Volume', sepReset:'Reset levels',
    // Tools tab
    toolsTitle:'Tools', metronome:'Metronome', tapBpm:'Tap BPM',
    scaleRef:'Scale & Chord Reference',
    metStart:'Start', metStop:'Stop',
    tapHint:'tap at least 4 times', reset:'Reset',
    // History tab
    histTitle:'History', histSub:'Every track downloaded — BPM and key saved automatically',
    searchTracks:'Search tracks…', select:'☐ Select', cancel:'✕ Cancel',
    selectAll:'Select All', selected:'selected',
    toStockpile:'📦 To Stockpile', moveTo:'📁 Move to…',
    stockpile:'Stockpile', stockpileNotSet:'Not set — click to choose',
    noHistory:'No history yet — download a track to get started',
    noMatch:'No matching tracks', remove:'Remove',
    // Settings
    setTitle:'Settings', setSub:'Customize your Freq.Phull experience',
    langLabel:'Language', langDesc:'Choose the application language',
    autoLabel:'Auto-analyze on download',
    autoDesc:'When off, downloads won\'t switch to the analyzer page — use the notification to access it. Better for batch downloading.',
    stockLabel:'Stockpile folder',
    repairLabel:'Repair history', repairDesc:'Scan stockpile and downloads to reconnect moved files.',
    repairBtn:'Scan now', repairFixed:'files reconnected', repairOk:'All files are linked correctly.',
    repairReviewTitle:'Review matches',
    repairReviewSub:'tracks need confirmation — pick the right file or skip',
    repairApply:'Apply', repairSkip:'Skip', repairApplyAll:'Apply all top matches',
    repairDone:'Done',
    removeConfirm:'Remove from history?',
    // Setup modal
    setupWelcome:'Welcome to Freq.Phull',
    setupSub:'Set up the AI engines to unlock stem separation and lyric transcription',
    setupBegin:'Begin Setup', setupSkip:'Continue without engines',
    setupHide:'Hide window (setup keeps running)', setupCancel:'Cancel setup',
    setupRetry:'Retry', setupAllSet:'All set',
    setupRunningLater:'You can run setup later from Settings → Engines',
    setupCancelled:'Setup cancelled',
    setupNotInstalled:'AI engines are not installed. Run setup now?',
    enginesReady:'AI engines ready',
    enginesInstalled:'✓ Installed',
    enginesNotInstalled:'Not installed — stem separator and transcription unavailable',
    enginesStale:'Setup is out-of-date — re-run setup to fix',
    runSetup:'Run setup',
    diagnose:'Diagnose', diagnoseTitle:'Diagnose Paths',
    diagnoseDesc:'Check which binaries the app can find — useful when ffmpeg, yt-dlp etc. aren\'t working',
    viewLogs:'View logs', viewLogsDesc:'Server + setup logs, useful for debugging',
    copyToClipboard:'Copy to clipboard', copied:'Copied to clipboard',
    refresh:'Refresh',
    // Download queue
    alreadyInQueue:'Already in queue',
    addedToQueue:'Added to queue',
    pending:'pending',
    // General
    close:'Close', by:'by', save:'Save', delete:'Delete',
  },
  fr: {
    // ── v0.2.8: acceleration materielle ──
    hwAccelName:'Acceleration materielle',
    hwAccelDesc:"Utilise le GPU pour le rendu, les animations et les canvas de l'analyseur. Recommande ACTIVE pour la plupart des utilisateurs. Desactivez uniquement si vous voyez des artefacts graphiques, des flashs blancs, ou si le ventilateur de votre ordinateur s'emballe juste en faisant defiler la page - certains GPU integres gerent mal Electron. Un redemarrage de l'application est requis.",
    hwAccelUnavailable:"Le toggle d'acceleration materielle est indisponible sur cette version",
    hwAccelOnNotif:'Acceleration materielle : ACTIVEE',
    hwAccelOffNotif:'Acceleration materielle : DESACTIVEE',
    hwAccelRestartTitle:'Redemarrage requis',
    hwAccelRestartBody:'Ce parametre ne prendra effet qu\'apres avoir redemarre Freq.Phull. Redemarrer maintenant ?',
    hwAccelRestartNow:'Redemarrer maintenant',
    hwAccelRestartLater:'Redemarrer plus tard',
    // ── v0.2.8: lien extension + tutoriel ──
    extLinkName:'Extension de navigateur',
    extLinkDesc:'Une extension Chrome qui ajoute un bouton Grab sur YouTube pour envoyer les beats directement vers Freq.Phull. Mise a jour independamment de l\'app principale via le meme depot GitHub.',
    extLinkOpen:'Ouvrir la page',
    extLinkHowTo:'Comment installer',
    extHowToTitle:'Installer l\'extension de navigateur',
    extHowToSub:'Chrome, Edge, Brave, Opera, Arc - tout navigateur base sur Chromium. Installation en 1 minute.',
    extHowToStep1Title:'Telechargez le dossier de l\'extension',
    extHowToStep1Desc:'Ouvrez le depot et telechargez le dossier freqpull-ext en ZIP, puis decompressez-le quelque part ou vous ne le deplacerez pas (Documents convient).',
    extHowToStep1Btn:'Ouvrir le depot GitHub',
    extHowToStep2Title:'Ouvrez votre page d\'extensions',
    extHowToStep2Desc:'Collez ceci dans la barre d\'adresse de votre navigateur et appuyez sur Entree :',
    extHowToStep3Title:'Activez le Mode developpeur',
    extHowToStep3Desc:'Bascule en haut a droite de la page des extensions. Permet d\'installer des extensions locales ; a faire une seule fois.',
    extHowToStep4Title:'Cliquez sur "Charger l\'extension non empaquetee"',
    extHowToStep4Desc:'Le bouton apparait une fois le Mode developpeur active. Selectionnez le dossier freqpull-ext decompresse a l\'etape 1.',
    extHowToStep5Title:'Epinglez et utilisez',
    extHowToStep5Desc:'Cliquez sur l\'icone de piece de puzzle dans la barre d\'outils du navigateur, puis sur l\'epingle a cote de Freq.Phull. Le panneau de l\'extension s\'ouvrira a cote de toute video YouTube ; appuyez sur Grab pour l\'envoyer a l\'app.',
    extHowToTip:'Astuce : gardez Freq.Phull desktop ouvert. L\'extension communique avec sur 127.0.0.1:47891 - les telechargements arrivent automatiquement dans votre bibliotheque.',
    extHowToOpenRepo:'Ouvrir le depot',

    // ── Notifications de verification au demarrage (0.2.8) ──
    updCheckingBoot:'Verification des mises a jour...',
    updUpToDate:'Vous etes a jour',

    // ── Reparation des metadonnees (0.2.7) ──
    storRepairThumbs:'Reparer les miniatures manquantes',
    storRepairScanning:'Recherche des entrees avec miniatures ou duree manquantes...',
    storRepairNone:'Toutes les entrees ont des metadonnees completes. Rien a reparer.',
    storRepairConfirm:'{n} entrees ont des metadonnees manquantes.\n\n{twin} peuvent etre corrigees instantanement en copiant depuis une entree jumelle (YouTube original).\n{probe} seront analysees avec ffmpeg (plus lent, ~50ms chacune).\n\nContinuer ?',
    storRepairDone:'{n} entrees reparees ({twin} par jumelage, {probe} via ffprobe)',

    // ── Verrouillage de defilement (0.2.6) ──
    scrollLockOn:'Suivi de la piste en lecture dans Historique',
    scrollLockOff:'Navigation libre - la piste change sans defilement',
    scrollLockTitleOn:'Suivi actif - cliquez pour naviguer librement pendant la lecture',
    scrollLockTitleOff:'Navigation libre - cliquez pour suivre la piste en lecture',

    // ── Bandeau d'analyse en arrière-plan (0.2.2) ──
    bgAnalyzing:'Analyse de',
    bgPending:'pistes en attente — cliquez pour relancer',
    bgCaughtUp:'Toutes les pistes sont analysées',

    // ── Désactivation auto-étiquetage (0.2.2) ──
    autoTagName:'Étiquetage auto des téléchargements',
    autoTagDesc:"Après chaque téléchargement, analyse le titre par rapport aux artistes de référence de vos dossiers Stockpile et étiquette automatiquement les correspondances. Désactivez pour garder les nouveaux téléchargements totalement non étiquetés — vous gérerez l'organisation manuellement ou par lots avec Auto-organiser. (Désactiver ceci rend également l'Envoi auto sans effet, puisqu'il n'y a plus d'étiquette à promouvoir.)",
    autoTagOnNotif:'Étiquetage auto activé — les téléchargements seront associés aux dossiers par artiste',
    autoTagOffNotif:'Étiquetage auto désactivé — les téléchargements restent non étiquetés, organisez à la main',

    // ── Beat switch (0.1.3) ──
    bsTitle:'Beat switch détecté',
    bsSection:'Beat',
    bsSwitchAt:'Switch à',
    bsChange_bpm:'changement de tempo', bsChange_key:'changement de tonalité', bsChange_harmony:'nouvelle mélodie', bsChange_energy:'saut d\'énergie',
    bsNone:'Aucun beat switch détecté à la sensibilité normale.',
    bsForceBtn:'Scanner plus fort',
    bsForcing:'Nouvelle analyse avec un seuil plus bas…',
    bsLoadFirst:'Chargez la piste dans l\'Analyseur pour naviguer',

    // ── Fonctionnalités 0.1.1 ──
    watchName:'Surveiller le dossier stockpile',
    watchDesc:"Surveille la racine du stockpile pour tout nouveau fichier audio déposé depuis n'importe où (Explorateur, autres applications, disques réseau). Les nouveaux fichiers sont importés dans la bibliothèque, indexés et associés automatiquement — combiné avec l'Envoi auto, ils sont classés dans le bon dossier sans que vous touchiez à rien.",
    watchOnNotif:'Dossier stockpile surveillé — le nouvel audio est importé automatiquement',
    watchOffNotif:'Surveillance du dossier désactivée',
    ytdlpAvail:'mise à jour disponible — cliquez pour installer',
    ytdlpUpToDate:'à jour',
    ytdlpSystem:'yt-dlp est installé au niveau système — mettez-le à jour via votre gestionnaire de paquets',
    sepqTitle:'File de séparation',
    sepqWaiting:'en attente',
    sepqAdded:'{n} ajoutée(s) à la file de séparation',
    sepqSkipped:'ignorée(s) (pas de fichier)',
    sepqClear:'Effacer les terminées',
    sepSendSelected:'Séparer',
    simBtn:'Trouver des pistes similaires',
    simTitle:'Pistes similaires',
    simLooking:'Comparaison des empreintes, du mood, du BPM et de la tonalité…',
    simNone:'Aucune piste similaire trouvée. Plus de pistes doivent être indexées ou analysées — lancez l\'indexation dans Trouver les doublons, ou analysez davantage votre bibliothèque.',
    simOpen:'Ouvrir',
    simReason_sound:'son', simReason_mood:'mood', simReason_bpm:'BPM', simReason_key:'tonalité',

    // ── i18n balayage lot 2 (0.1.0) ──
    backendOfflineRetry:'Moteur hors ligne — réessayez dans un instant',
    dupBackfillHead:'{n} pistes ne sont pas encore indexées.',
    dupBackfillDesc:'Les nouveaux téléchargements sont indexés automatiquement. Les pistes existantes nécessitent une analyse unique. Quelques secondes chacune ; s\'exécute en arrière-plan.',
    dupBackfillBtn:'Indexer {n} pistes',
    dupNoneFound:'Aucun doublon trouvé parmi <strong>{n}</strong> pistes indexées.',
    dupNotScanned:'({n} pistes pas encore analysées)',
    dupKeep:'GARDER',
    dupGroupWord:'Groupe',
    dupOne:'doublon', dupMany:'doublons',
    dupDeleteChecked:'Supprimer la sélection',
    dupFoundSummary:'<strong>{x}</strong> {g} de doublons trouvés parmi <strong>{n}</strong> pistes indexées. La piste la plus ancienne de chaque groupe est marquée « GARDER » par défaut. Décochez les doublons que vous voulez conserver.',
    dupGroupOne:'groupe', dupGroupMany:'groupes',
    dupNothingChecked:'Rien de coché',
    dupDeleteTitle:'Supprimer {n} {w} ?',
    dupDeleteMsg:'Retire les entrées sélectionnées de votre historique. Les fichiers audio sur le disque ne sont PAS supprimés — seulement les entrées. Pour libérer de l\'espace, supprimez ensuite les fichiers dans votre explorateur.',
    deletedWord:'Supprimé(s)',
    fixFilesConfirmTitle:'Corriger l\'emplacement des fichiers ?',
    fixFilesConfirmMsg:'Analyse chaque piste étiquetée et déplace celles dont le fichier n\'est pas dans son dossier principal sur le disque. Aucun fichier n\'est supprimé — seulement déplacé à sa place.',
    stockRootLbl:'Racine du stockpile :',
    scanningBtn:'Analyse…',
    movedWord:'Déplacé(s)',
    alreadyInPlace:'déjà en place',
    missingOnDisk:'manquant(s) sur le disque',
    errorsWord:'erreurs',
    checkedNothing:'{n} vérifiées — rien à faire',
    cleanConfirmTitle:'Nettoyer les fichiers temporaires de Freq.Phull ?',
    cleanConfirmMsg:'Supprime les fichiers WAV de plus d\'une heure laissés par Freq.Phull dans le Temp de Windows (analyse, séparation de stems, conversion). Tout ce qui est en cours de traitement est protégé.',
    cleaningBtn:'Nettoyage…',
    cleanedResult:'{n} {w} nettoyé(s) ({mb} Mo libérés)',
    cleanNothing:'Rien à nettoyer — le dossier temporaire est propre',
    updDevOnly:'Les mises à jour ne fonctionnent que dans les versions installées',
    updDevOnlyLong:'Les mises à jour ne fonctionnent que dans la version installée (packagée), pas en mode développement.',
    updApiUnavailable:'API de mise à jour indisponible dans cette version',
    checkingBtn:'Vérification…',

    // ── Page Paramètres (patch 0.1.0 i18n) ──
    fixFilesName:'Corriger l\'emplacement des fichiers',
    fixFilesDesc:"Analyse chaque piste étiquetée et déplace celles dont le fichier n'est pas dans son dossier principal. Les fichiers qui devraient être dans <code>Cali Type beat/</code> mais qui ont atterri ailleurs sont remis à leur place. Réutilisable sans risque.",
    btnFixFiles:'Corriger',
    cleanTempName:'Nettoyer les fichiers temporaires',
    cleanTempDesc:"Supprime les fichiers WAV résiduels de Freq.Phull dans le dossier Temp de Windows (plus d'une heure). Ne touche que les fichiers commençant par <code>freqphull_</code> — jamais les dossiers d'exécution de l'application. S'exécute automatiquement toutes les 6 heures ; utilisez ceci pour un nettoyage manuel.<br><strong>N'utilisez PAS <code>del Temp\\*</code> manuellement</strong> — cela supprimerait les binaires ffmpeg/yt-dlp de la version portable et casserait les téléchargements jusqu'au redémarrage.",
    btnCleanNow:'Nettoyer',
    autoSendName:'Envoi auto vers le dossier détecté',
    autoSendDesc:"Quand un nouveau téléchargement correspond aux artistes d'un dossier Stockpile, ne pas seulement l'étiqueter — faire de ce dossier le principal et déplacer le fichier dans <code>RacineStockpile/NomDossier/</code> immédiatement. Les pistes sans correspondance fiable restent en place et pourront être triées plus tard avec Auto-organiser.",
    autoSendOnNotif:'Les nouveaux téléchargements seront déplacés vers leur dossier détecté',
    autoSendOffNotif:'Envoi auto désactivé — les fichiers restent en place, étiquettes seulement',
    sentTo:'Envoyé vers',
    storName:'Répartition du stockage',
    storDesc:'Voyez l\'espace disque utilisé par chaque dossier Stockpile, trouvez les fichiers manquants, repérez l\'audio orphelin à la racine de votre stockpile.',
    btnViewStorage:'Voir le stockage',
    dupName:'Trouver les pistes en double',
    dupDesc:'Détecte les pistes au contenu audio identique (même morceau re-uploadé sous différents liens YouTube, bitrates différents, etc.). Utilise une empreinte perceptuelle de l\'audio lui-même, pas les noms de fichiers. Les nouveaux téléchargements sont automatiquement indexés ; les pistes existantes nécessitent une indexation unique.',
    btnFindDupes:'Trouver les doublons',
    updName:'Vérifier les mises à jour',
    updDesc:'Vérifie manuellement sur GitHub si une nouvelle version est disponible. Les mises à jour se téléchargent en arrière-plan et proposent l\'installation une fois prêtes. L\'application vérifie aussi automatiquement toutes les 4 heures.',
    btnCheckNow:'Vérifier',
    cpuOnlyName:'Forcer le CPU pour la séparation de stems',
    cpuOnlyDesc:'Ignore l\'accélération GPU même quand un GPU CUDA est disponible. Utile sur les machines avec peu de VRAM (moins de 4 Go) ou pour garder le GPU libre pour les plugins DAW / autres applications. Plus lent mais charge système réduite.',
    writeTagsName:'Écrire le BPM et la tonalité dans les fichiers audio',
    writeTagsDesc:"Après l'analyse, inscrit le BPM et la tonalité détectés dans les métadonnées standard du fichier (ID3 pour MP3/WAV, Vorbis pour FLAC/OGG, atomes MP4 pour M4A). FL Studio, Mixed In Key, Rekordbox, foobar2000 et Apple Music lisent tous ces tags — votre analyse suit le fichier partout. Activé par défaut. Désactivez si vous voulez des fichiers identiques au téléchargement d'origine.",
    dlClearName:'Effacement auto de la file de téléchargement',
    dlClearDesc:'Les téléchargements terminés ou échoués disparaissent de la liste après ce délai. Les téléchargements actifs ne sont jamais effacés automatiquement. Choisissez « Désactivé » pour les garder visibles jusqu\'à un effacement manuel.',
    optOff:'Désactivé', optHour1:'1 heure', optHours12:'12 heures', optHours24:'24 heures', optHours72:'72 heures',
    enginesName:'Moteurs IA',
    runSetupBtn:'Lancer l\'installation',
    diagName:'Diagnostiquer les chemins',
    diagDesc:'Vérifie quels binaires l\'application trouve — utile quand ffmpeg, yt-dlp etc. ne fonctionnent pas',
    btnDiagnose:'Diagnostiquer',
    logsName:'Voir les journaux',
    logsDesc:'Journaux du serveur et de l\'installation, utiles pour le débogage',
    devBuild:'Version de développement',
    checking:'Vérification…',
    // ── Fenêtre Répartition du stockage ──
    storSub:'Utilisation disque par dossier et détection des orphelins',
    storScanning:'Analyse de votre stockpile…',
    storTotalIn:'au total dans le stockpile',
    storTagged:'étiquetés',
    storFreeOnDrive:'libres sur ce disque',
    storMissingOne:'fichier manquant', storMissingMany:'fichiers manquants',
    storOrphanOne:'fichier audio non étiqueté à la racine', storOrphanMany:'fichiers audio non étiquetés à la racine',
    storMissingNote:'manquant(s)',
    storNoFolders:'Aucun dossier pour l\'instant — créez-en un dans Stockpile pour commencer à organiser',
    fileWord:'fichier', filesWord:'fichiers',
    storLocate:'Localiser les fichiers manquants',
    storPrune:'Supprimer les entrées mortes',
    storImportBtn:'Importer les fichiers non étiquetés',
    storImporting:'Importation des fichiers…',
    notifImported:'Importé(s)', notifStemsSkipped:'fichiers de stems ignorés',
    importFailed:'Échec de l\'importation :',
    pruneNoDead:'Aucune entrée morte trouvée',
    pruneConfirm:'Supprimer {n} entrées de l\'historique dont le fichier audio n\'existe plus ?\n\nSeules les lignes de la base de données (et leurs étiquettes) sont supprimées — aucun fichier n\'est touché.\nAstuce : lancez d\'abord « Localiser les fichiers manquants » si les fichiers ont peut-être juste été déplacés.',
    pruneRemoved:'Supprimé', deadEntriesWord:'entrées mortes',
    pruneFailed:'Échec de la suppression :',
    scanRelocatable:'Recherche de fichiers déplaçables…',
    setStockpileFirst:'Définissez d\'abord un dossier stockpile dans les Paramètres',
    backendOffline:'Moteur hors ligne',
    // ── Fenêtre Auto-organiser ──
    aoTitle:'Auto-organiser',
    aoScanningSub:'Analyse des pistes non étiquetées pour trouver des correspondances…',
    aoLooking:'Recherche de correspondances…',
    aoNoFolders:'Aucun dossier disponible pour les suggestions. Créez d\'abord au moins un dossier (avec des artistes de référence ou quelques pistes étiquetées).',
    aoNoUntagged:'Aucune piste non étiquetée. Tout est propre !',
    aoNoneMatched:'{n} pistes non étiquetées trouvées, mais aucune ne correspond à un dossier au-dessus du seuil de confiance. Essayez d\'ajouter des artistes de référence à vos dossiers, ou étiquetez-en quelques-unes manuellement pour entraîner le modèle.',
    aoFound:"<strong>{x}</strong> correspondances trouvées sur <strong>{y}</strong> pistes non étiquetées. Décochez celles que vous ne voulez pas. Chaque piste reçoit le dossier choisi comme étiquette principale — les fichiers sont déplacés automatiquement.",
    aoSelectAll:'✓ Tout sélectionner', aoClearSel:'○ Effacer', aoConf70:'≥ 70 % seulement',
    aoApply:'Appliquer la sélection',
    aoNothing:'Aucune sélection',
    aoApplying:'Application',
    aoTaggedOk:'Étiquetées', failedWord:'échecs',
    // ── Doublons / réparation / journaux / diagnostic ──
    dupSub:'Pistes au contenu audio quasi identique',
    rrTitle:'Vérifier les correspondances',
    rrApplyAll:'Appliquer toutes les meilleures correspondances',
    logsTitle:'Journaux',
    diagTitle:'Diagnostiquer les chemins',
    copyClip:'Copier dans le presse-papiers',
    cancelWord:'Annuler', deleteWord:'Supprimer', previewWord:'Aperçu',
    // ── Clés manquantes auparavant (repli en dur) ──
    autoMatched:'Étiqueté automatiquement dans',
    setupRequired:'Installation requise',
    setupRun:'Lancer l\'installation',

    // Nav
    download:'Télécharger', analyze:'Analyser', transcribe:'Transcrire',
    tools:'Outils', history:'Historique', settings:'Paramètres',
    stems:'Séparateur',
    // Download tab
    dlTitle:'Télécharger', dlSub:'Collez un lien YouTube et enregistrez en MP3, WAV, FLAC et plus',
    ytUrl:'Lien YouTube', format:'Format', fetch:'Récupérer',
    dlReady:'Prêt — choisissez un format et téléchargez',
    dlPaste:'Collez un lien YouTube pour commencer',
    folderLbl:'Dossier de téléchargement', change:'Changer',
    // Analyze tab
    anaTitle:'Analyser', anaSub:'Détectez le BPM, la tonalité, les accords et plus depuis n\'importe quel fichier audio',
    dropTitle:'Déposez un fichier audio ici', dropSub:'ou cliquez pour parcourir — MP3 · WAV · FLAC · OGG · M4A',
    bpm:'BPM', key:'TONALITÉ', length:'DURÉE',
    camelot:'CAMELOT', chords:'ACCORDS', pitch:'HAUTEUR',
    exportWav:'⬇ Exporter en WAV', dragHint:'Après le téléchargement, glissez la piste depuis la barre de Chrome directement dans FL Studio',
    notes:'NOTES', notesPlaceholder:'Paroles, idées…',
    // Transcribe tab
    transTitle:'Transcrire', transSub:'Utilisez l\'IA pour convertir l\'audio en texte — propulsé par Whisper',
    transModel:'Modèle', transLang:'Langue', transAuto:'Auto',
    transCopy:'Copier', transSave:'Enregistrer en .txt',
    // Separator tab
    sepTitle:'Séparateur', sepSub:'Séparation de stems professionnelle — ensemble multi-étapes, exécution locale',
    sepDropTitle:'Déposez une piste à séparer', sepDropSub:'ou cliquez pour parcourir — MP3 · WAV · FLAC · OGG · M4A',
    sepStemsLbl:'Stems', sepQualityLbl:'Qualité',
    sep4Stems:'4 stems', sep6Stems:'6 stems',
    sepFast:'Rapide', sepHigh:'Haute', sepUltra:'Ultra',
    sepStart:'Séparer les stems', sepResults:'Stems séparés',
    sepOpenFolder:'Ouvrir le dossier', sepSendToSeparator:'Envoyer au séparateur',
    sepHistory:'Historique du séparateur', sepEmpty:'Aucune séparation pour l\'instant',
    sepMode4Desc:'Voix · Batterie · Basse · Autre',
    sepMode6Desc:'Voix · Batterie · Basse · Guitare · Piano · Autre',
    sepQuality_fast:'Rapide — passe unique · ~1× temps réel sur CPU',
    sepQuality_high:'Équilibré — 1 décalage sur l\'instrumental · ~2× temps réel sur CPU',
    sepQuality_ultra:'Ultra — 1 décalage, chevauchement max · ~2.5× temps réel sur CPU',
    sepStageDone:'Terminé', sepFailed:'Échec de la séparation',
    sepStageVocal:'Voix', sepStageInst:'Instrumental',
    sepDirectLabel:'Garder les samples vocaux du beat',
    sepDirectDesc:'Saute l\'Étape 1. Plus rapide. Les samples vocaux dans l\'instrumental (ad-libs, vocal chops) restent dans « other » au lieu d\'être fusionnés avec la voix principale.',
    sepNoTrack:'Aucune piste chargée', sepBackendOffline:'Moteur hors ligne',
    sepReady:'Stems prêts', sepPreparing:'Préparation…',
    sepPlay:'Lecture', sepPause:'Pause', sepMute:'Muet', sepSolo:'Solo',
    sepPlayAll:'Tout lire', sepPauseAll:'Tout mettre en pause', sepStopAll:'Stop',
    sepMixerTitle:'Mixeur', sepVolume:'Volume', sepReset:'Réinitialiser les niveaux',

    // Stockpile FR
    spTitle:'Stockpile', spSub:'Organisez vos beats par style, ambiance et artiste',
    spFolders:'Dossiers de style', spTagged:'Étiquetés', spCommitted:'Engagés', spUntaggedLbl:'Sans étiquette',
    spDestTitle:'Destination du stockpile',
    spDestHint:'Les pistes étiquetées vont dans <code>{root}/{nom du dossier}/</code> lors de l\'engagement.',
    spStyleFolders:'Dossiers de style', spNewFolderBtn:'+ Nouveau dossier',
    spNoFolders:'Aucun dossier pour l\'instant.',
    spNoFoldersHint:'Créez votre premier dossier de style — Cali Trap, Detroit, Atlanta Trap, Drill, peu importe la scène.',
    spUntagged:'Sans étiquette', spAllTagged:'Toutes les pistes sont étiquetées.',
    spLoadingSugs:'Chargement des suggestions…',
    spTrack:'piste', spTracks:'pistes',
    spMore:'autres',
    spTagBtn:'Étiqueter',
    spTagThisTrack:'Étiqueter cette piste',
    spSuggestions:'Suggestions',
    spAllFolders:'Tous les dossiers',
    spNoSuggestions:'Aucune suggestion — choisissez un dossier ci-dessous',
    spFolderViewComingSoon:'(navigateur de dossier au prochain patch)',
    spNewFolder:'Nouveau dossier de style', spEditFolder:'Modifier le dossier',
    spFolderName:'Nom du dossier', spFolderDesc:'Description (facultatif)',
    spFolderSeeds:'Artistes de référence — séparés par virgules',
    spFolderSeedsHint:'Quand un nom de fichier mentionne l\'un de ces artistes, il sera suggéré pour ce dossier.',
    spCancel:'Annuler', spCreate:'Créer', spSave:'Enregistrer',
    spNameRequired:'Le nom du dossier est requis',
    spFolderCreated:'Dossier créé',
    spFolderSaved:'Dossier enregistré',
    spFolderDeleted:'Dossier supprimé',
    spDeleteFolder:'Supprimer le dossier « {name} » ? Aucun fichier audio ne sera supprimé.',
    spDeleteFolderWithTracks:'Supprimer le dossier « {name} » ? Il contient actuellement {n} pistes étiquetées. Les étiquettes seront retirées mais les fichiers audio resteront intacts.',
    stockpileNotSet:'Non défini — cliquez pour choisir',
    // Bulk match FR
    spAutoMatchTooltip:'Détecter les pistes correspondant à ce dossier',
    spFindingMatches:'Recherche des correspondances…',
    spScanning:'Analyse de votre bibliothèque…',
    spMatchesFor:'Correspondances pour',
    spArtistMatches:'Correspondances par artiste',
    spMoodMatches:'Correspondances par ambiance',
    spMatchArtist:'correspond à',
    spMatchMood:'ambiance similaire',
    spNoMatchesYet:'Aucune correspondance pour l\'instant.',
    spNoMatchesHint:'Ajoutez des artistes de référence à ce dossier, ou étiquetez quelques pistes manuellement pour que le système apprenne le profil d\'ambiance. Revenez ensuite ici.',
    spSelectAll:'Tout sélectionner',
    spSelectNone:'Tout désélectionner',
    spTagSelected:'Étiqueter la sélection',
    spTagging:'Étiquetage',
    spNoTracksSelected:'Aucune piste sélectionnée',
    spTaggedNTracks:'{n} pistes étiquetées',
    spClose:'Fermer',
    sepNoOutDir:'Aucun dossier de sortie enregistré pour cette entrée',
    sepFolderMissing:'Le dossier de sortie n\'existe plus. Les stems ont peut-être été déplacés ou supprimés.',
    // Folder view FR
    spLoading:'Chargement…',
    spNoMatches:'Aucune piste ne correspond',
    spFolderEmpty:'Aucune piste étiquetée dans ce dossier',
    spPreview:'Aperçu',
    spChangeFolder:'Déplacer vers un autre dossier',
    spShowInExplorer:'Afficher dans l\'Explorateur',
    spRemoveFromFolder:'Retirer de ce dossier',
    spConfirmUntag:'Retirer cette piste du dossier ? Le fichier audio ne sera pas supprimé.',
    spUntagged:'Retiré du dossier',
    spPreviewError:'Impossible de lire ce fichier',
    spFileMissing:'Le fichier n\'existe plus à',
    spOpenAnalysis:'Ouvrir l\'analyse complète',
    spJumpToAnalyze:'Ouvrir dans l\'Analyseur',
    spInAnalyzer:'dans l\'Analyseur',
    sepRestored:'Chargé depuis l\'historique du séparateur',
    sepNoStemsRecorded:'Aucun stem enregistré pour cette entrée',
    sepOpenFolder:'Ouvrir le dossier',
    sepSeekWaveform:'Cliquez pour aller à cette position',
    sepSeekMaster:'Cliquez pour aller à cette position (tous les stems)',
    sepStillLoading:'Chargement des stems en cours…',
    sepMasterVolume:'Volume master',
    miniMirrorNoPlaylist:'Pas de playlist en mode Analyseur',
    miniNoPrev:'Aucune piste précédente',
    miniNoNext:'Aucune piste suivante',
    miniNoTrack:'Aucune piste chargée',
    miniShuffleOn:'Lecture aléatoire activée',
    miniShuffleOff:'Lecture aléatoire désactivée',
    miniLoopOff:'Boucle désactivée',
    miniLoopPlaylist:'Boucler la playlist',
    miniLoopTrack:'Boucler la piste',
    miniNotesFor:'Notes pour',
    miniSaved:'Enregistré',
    miniSaving:'Enregistrement…',
    histFavorite:'Favori',
    sepLoopRegion:'Boucle — Maj+glisser pour définir',
    sepLoopHint:'Maj+glissez sur la forme d\'onde pour définir une boucle',
    sepLoopSet:'⟲ Boucle :',
    sepLoopCleared:'Boucle effacée',
    spFolderMoodProfile:'Profil d\'ambiance du dossier',
    spMoodEnergy:'Énergie',
    spMoodBrightness:'Luminosité',
    spMoodDensity:'Densité',
    spMoodTempo:'Tempo',
    spSeedsLabel:'Artistes de référence',
    spTracks:'Pistes',
    spSortNewest:'Plus récent',
    spSortOldest:'Plus ancien',
    spSortTitle:'Titre A→Z',
    spSortBpmAsc:'BPM ↑',
    spSortBpmDesc:'BPM ↓',
    spSortKey:'Tonalité',
    spSearchInFolder:'Chercher dans ce dossier…',
    // Tools tab
    toolsTitle:'Outils', metronome:'Métronome', tapBpm:'Tap BPM',
    scaleRef:'Référence des gammes et accords',
    metStart:'Démarrer', metStop:'Arrêter',
    tapHint:'tapez au moins 4 fois', reset:'Réinitialiser',
    // History tab
    histTitle:'Historique', histSub:'Toutes les pistes téléchargées — BPM et tonalité enregistrés automatiquement',
    searchTracks:'Rechercher des pistes…', select:'☐ Sélectionner', cancel:'✕ Annuler',
    selectAll:'Tout sélectionner', selected:'sélectionnée(s)',
    toStockpile:'📦 Vers le stockage', moveTo:'📁 Déplacer vers…',
    stockpile:'Stockage', stockpileNotSet:'Non défini — cliquez pour choisir',
    noHistory:'Aucun historique pour l\'instant — téléchargez une piste pour commencer',
    noMatch:'Aucune piste correspondante', remove:'Supprimer',
    // Settings
    setTitle:'Paramètres', setSub:'Personnalisez votre expérience Freq.Phull',
    langLabel:'Langue', langDesc:'Choisissez la langue de l\'application',
    autoLabel:'Analyse automatique au téléchargement',
    autoDesc:'Lorsque désactivé, les téléchargements ne basculent pas vers l\'analyseur — utilisez la notification pour y accéder. Idéal pour les téléchargements en lot.',
    stockLabel:'Dossier de stockage',
    repairLabel:'Réparer l\'historique', repairDesc:'Scanne le stockage et les téléchargements pour reconnecter les fichiers déplacés.',
    repairBtn:'Scanner maintenant', repairFixed:'fichiers reconnectés', repairOk:'Tous les fichiers sont correctement liés.',
    repairReviewTitle:'Vérifier les correspondances',
    repairReviewSub:'pistes nécessitent une confirmation — choisissez le bon fichier ou ignorez',
    repairApply:'Appliquer', repairSkip:'Ignorer', repairApplyAll:'Appliquer toutes les meilleures correspondances',
    repairDone:'Terminé',
    removeConfirm:'Supprimer de l\'historique ?',
    // Setup modal
    setupWelcome:'Bienvenue dans Freq.Phull',
    setupSub:'Configurez les moteurs IA pour activer la séparation de stems et la transcription',
    setupBegin:'Lancer l\'installation', setupSkip:'Continuer sans les moteurs',
    setupHide:'Masquer (l\'installation continue en arrière-plan)', setupCancel:'Annuler l\'installation',
    setupRetry:'Réessayer', setupAllSet:'Tout est prêt',
    setupRunningLater:'Vous pouvez lancer l\'installation plus tard depuis Paramètres → Moteurs',
    setupCancelled:'Installation annulée',
    setupNotInstalled:'Les moteurs IA ne sont pas installés. Lancer l\'installation maintenant ?',
    enginesReady:'Moteurs IA prêts',
    enginesInstalled:'✓ Installé',
    enginesNotInstalled:'Non installé — la séparation et la transcription sont indisponibles',
    enginesStale:'Installation obsolète — relancer pour corriger',
    runSetup:'Lancer l\'installation',
    diagnose:'Diagnostiquer', diagnoseTitle:'Diagnostic des chemins',
    diagnoseDesc:'Vérifie quels binaires l\'application trouve — utile lorsque ffmpeg, yt-dlp, etc. ne fonctionnent pas',
    viewLogs:'Voir les journaux', viewLogsDesc:'Journaux serveur et installation, utiles pour le débogage',
    copyToClipboard:'Copier dans le presse-papiers', copied:'Copié dans le presse-papiers',
    refresh:'Actualiser',
    // Download queue
    alreadyInQueue:'Déjà dans la file',
    addedToQueue:'Ajouté à la file',
    pending:'en attente',
    // General
    close:'Fermer', by:'par', save:'Enregistrer', delete:'Supprimer',
  }
};
function t(key) { return (T[lang] && T[lang][key]) || T.en[key] || key; }

function applyLang() {
  // Nav buttons
  const navMap = {download:'download',analyze:'analyze',transcribe:'transcribe',stems:'stems',tools:'tools',history:'history',settings:'settings'};
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    if (tab && navMap[tab]) {
      // Keep the SVG, just change the text node
      const textNodes = Array.from(btn.childNodes).filter(n => n.nodeType === 3);
      if (textNodes.length) textNodes[textNodes.length - 1].textContent = '\n      ' + t(tab) + '\n    ';
    }
  });

  // Tab headers
  const headers = {
    'tab-download': ['dlTitle', 'dlSub'],
    'tab-analyze': ['anaTitle', 'anaSub'],
    'tab-stems': ['sepTitle', 'sepSub'],
    'tab-transcribe': ['transTitle', 'transSub'],
    'tab-tools': ['toolsTitle', null],
    'tab-history': ['histTitle', 'histSub'],
    'tab-settings': ['setTitle', 'setSub'],
  };
  for (const [id, [titleKey, subKey]] of Object.entries(headers)) {
    const pane = document.getElementById(id);
    if (!pane) continue;
    const title = pane.querySelector('.ph-title');
    const sub = pane.querySelector('.ph-sub');
    if (title && titleKey) title.textContent = t(titleKey);
    if (sub && subKey) sub.textContent = t(subKey);
  }

  // Search placeholder
  const histSearch = document.getElementById('hist-search');
  if (histSearch) histSearch.placeholder = t('searchTracks');

  // Select button
  const selBtn = document.getElementById('hist-select-btn');
  if (selBtn && !selectMode) selBtn.textContent = t('select');
  else if (selBtn && selectMode) selBtn.textContent = t('cancel');

  // Batch bar labels
  const checkAll = document.querySelector('#hist-batch .hb-check span');
  if (checkAll) checkAll.textContent = t('selectAll');
  const btnStock = document.getElementById('btn-stockpile');
  if (btnStock) btnStock.textContent = t('toStockpile');
  const btnMove = document.getElementById('btn-moveto');
  if (btnMove) btnMove.textContent = t('moveTo');

  // Stockpile label
  const stockLbl = document.querySelector('.stockpile-lbl');
  if (stockLbl) stockLbl.textContent = '📦 ' + t('stockpile') + ':';
  const stockPath = document.getElementById('stockpile-path');
  if (stockPath && !stockpileFolder) stockPath.textContent = t('stockpileNotSet');

  // Drop zone
  const dropTitle = document.querySelector('#drop-analyze h3');
  const dropSub = document.querySelector('#drop-analyze p');
  if (dropTitle) dropTitle.textContent = t('dropTitle');
  if (dropSub) dropSub.textContent = t('dropSub');

  // Separator labels
  const sepDropT = document.getElementById('stems-drop-title');
  const sepDropS = document.getElementById('stems-drop-sub');
  if (sepDropT) sepDropT.textContent = t('sepDropTitle');
  if (sepDropS) sepDropS.textContent = t('sepDropSub');
  const sepModeLbl = document.getElementById('stems-mode-lbl');
  if (sepModeLbl) sepModeLbl.textContent = t('sepStemsLbl');
  const sepQualLbl = document.getElementById('stems-quality-lbl');
  if (sepQualLbl) sepQualLbl.textContent = t('sepQualityLbl');
  document.querySelectorAll('.stem-mode-en').forEach(el => {
    const btn = el.closest('.fmt');
    if (!btn) return;
    el.textContent = btn.dataset.mode === '6' ? t('sep6Stems') : t('sep4Stems');
  });
  const fastEl = document.querySelector('.stem-q-fast');
  const highEl = document.querySelector('.stem-q-high');
  const ultraEl = document.querySelector('.stem-q-ultra');
  if (fastEl) fastEl.textContent = t('sepFast');
  if (highEl) highEl.textContent = t('sepHigh');
  if (ultraEl) ultraEl.textContent = t('sepUltra');
  const sepStartLbl = document.getElementById('btn-separate-lbl');
  if (sepStartLbl) sepStartLbl.textContent = t('sepStart');
  const sepResultsT = document.getElementById('stems-results-title');
  if (sepResultsT) sepResultsT.textContent = t('sepResults');
  const sepOpenFolderLbl = document.getElementById('btn-open-stems-lbl');
  if (sepOpenFolderLbl) sepOpenFolderLbl.textContent = t('sepOpenFolder');
  const sepSendLbl = document.getElementById('btn-send-stems-lbl');
  if (sepSendLbl) sepSendLbl.textContent = t('sepSendToSeparator');
  const sepHistTitle = document.getElementById('sep-hist-title');
  if (sepHistTitle) sepHistTitle.textContent = t('sepHistory');
  const sepHistEmpty = document.getElementById('sep-hist-empty');
  if (sepHistEmpty) sepHistEmpty.textContent = t('sepEmpty');
  const sepDirectLbl = document.getElementById('stems-direct-lbl');
  if (sepDirectLbl) sepDirectLbl.textContent = t('sepDirectLabel');
  const sepDirectDesc = document.getElementById('stems-direct-desc');
  if (sepDirectDesc) sepDirectDesc.textContent = t('sepDirectDesc');
  // Update mode/quality descriptors
  const activeMode = document.querySelector('#stems-options .fmt[data-mode].on');
  if (activeMode) setStemMode(activeMode);
  const activeQual = document.querySelector('#stems-options .fmt[data-quality].on');
  if (activeQual) setStemQuality(activeQual);

  // Stockpile labels
  const $set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  $set('sp-title', 'spTitle');
  $set('sp-sub', 'spSub');
  $set('sp-stat-folders-lbl', 'spStyleFolders');
  $set('sp-stat-tagged-lbl', 'spTagged');
  $set('sp-stat-committed-lbl', 'spCommitted');
  $set('sp-stat-untagged-lbl', 'spUntaggedLbl');
  $set('sp-root-title', 'spDestTitle');
  const spRootHint = document.getElementById('sp-root-hint');
  if (spRootHint) spRootHint.innerHTML = t('spDestHint');
  $set('sp-folders-title', 'spStyleFolders');
  $set('sp-new-lbl', 'spNewFolderBtn');
  $set('sp-untagged-title', 'spUntagged');
  $set('sp-modal-title', 'spNewFolder');
  $set('sp-modal-name-lbl', 'spFolderName');
  $set('sp-modal-desc-lbl', 'spFolderDesc');
  $set('sp-modal-seeds-lbl', 'spFolderSeeds');
  const spSeedsHint = document.getElementById('sp-modal-seeds-hint');
  if (spSeedsHint) spSeedsHint.textContent = t('spFolderSeedsHint');
  $set('sp-modal-cancel', 'spCancel');
  $set('sp-modal-create', 'spCreate');
  // Folder view labels
  $set('sp-fv-back-lbl', 'spTitle');
  $set('sp-fv-automatch-lbl', 'spAutoMatchTooltip');
  $set('sp-fv-mood-lbl', 'spFolderMoodProfile');
  $set('sp-fv-mood-energy-lbl', 'spMoodEnergy');
  $set('sp-fv-mood-tonality-lbl', 'spMoodBrightness');
  $set('sp-fv-mood-density-lbl', 'spMoodDensity');
  $set('sp-fv-mood-tempo-lbl', 'spMoodTempo');
  $set('sp-fv-seeds-lbl', 'spSeedsLabel');
  $set('sp-fv-list-title', 'spTracks');
  const sortEl = document.getElementById('sp-fv-sort');
  if (sortEl && sortEl.options.length >= 6) {
    sortEl.options[0].textContent = t('spSortNewest');
    sortEl.options[1].textContent = t('spSortOldest');
    sortEl.options[2].textContent = t('spSortTitle');
    sortEl.options[3].textContent = t('spSortBpmAsc');
    sortEl.options[4].textContent = t('spSortBpmDesc');
    sortEl.options[5].textContent = t('spSortKey');
  }
  const searchEl = document.getElementById('sp-fv-search');
  if (searchEl) searchEl.placeholder = t('spSearchInFolder');
  // Re-render stockpile if it's the active tab so dynamic content updates too
  if (document.getElementById('tab-stockpile')?.classList.contains('on')) {
    renderStockpileFolders();
    renderStockpileUntagged();
  }

  // URL input placeholder
  const urlIn = document.getElementById('url-in');
  if (urlIn) urlIn.placeholder = 'https://www.youtube.com/watch?v=…';

  // Generic data-i18n applier (0.1.1): static index.html elements tagged
  // with data-i18n="key" get their text swapped on language change. Tiny
  // alternative to converting every static label to a JS render.
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(k);
  });

  // Render settings page if visible
  renderSettings();
}

// ── Settings page ─────────────────────────────────────────────────────────────
function renderSettings() {
  const el = document.getElementById('settings-content');
  if (!el) return;
  el.innerHTML = `
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('langLabel')}</div>
        <div class="setting-desc">${t('langDesc')}</div>
      </div>
      <div class="setting-toggle lang-toggle">
        <button class="lt ${lang==='en'?'on':''}" onclick="setLang('en')">EN</button>
        <button class="lt ${lang==='fr'?'on':''}" onclick="setLang('fr')">FR</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('autoLabel')}</div>
        <div class="setting-desc">${t('autoDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${autoAnalyze?'checked':''} onchange="toggleAutoAnalyze(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('stockLabel')}</div>
        <div class="setting-desc">${stockpileFolder||t('stockpileNotSet')}</div>
      </div>
      <button class="btn sm" onclick="pickStockpileFolder()">${t('change')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('repairLabel')}</div>
        <div class="setting-desc" id="repair-desc">${t('repairDesc')}</div>
      </div>
      <button class="btn sm" id="btn-repair" onclick="repairHistory(false)">🔍 ${t('repairBtn')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('fixFilesName')}</div>
        <div class="setting-desc" id="fix-files-desc">${t('fixFilesDesc')}</div>
      </div>
      <button class="btn sm" id="btn-fix-files" onclick="repairFileLocations()">📁 ${t('btnFixFiles')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('cleanTempName')}</div>
        <div class="setting-desc" id="clean-temp-desc">${t('cleanTempDesc')}</div>
      </div>
      <button class="btn sm" id="btn-clean-temp" onclick="cleanTempFiles()">🧹 ${t('btnCleanNow')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('autoTagName')}</div>
        <div class="setting-desc">${t('autoTagDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${autoTagEnabled() ? 'checked' : ''} onchange="toggleAutoTag(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('autoSendName')}</div>
        <div class="setting-desc">${t('autoSendDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${(localStorage.getItem('freqphull.autoSend')==='1')?'checked':''} onchange="toggleAutoSend(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('watchName')}</div>
        <div class="setting-desc">${t('watchDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${(localStorage.getItem('freqphull.watchFolder')==='1')?'checked':''} onchange="toggleWatchFolder(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('storName')}</div>
        <div class="setting-desc" id="storage-breakdown-desc">${t('storDesc')}</div>
      </div>
      <button class="btn sm" onclick="openStorageBreakdown()">💾 ${t('btnViewStorage')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('dupName')}</div>
        <div class="setting-desc">${t('dupDesc')}</div>
      </div>
      <button class="btn sm" onclick="openDuplicateFinder()">🔁 ${t('btnFindDupes')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('updName')}</div>
        <div class="setting-desc" id="update-check-desc">${t('updDesc')}</div>
      </div>
      <button class="btn sm" id="btn-check-updates" onclick="manualCheckForUpdates()">🔄 ${t('btnCheckNow')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">yt-dlp</div>
        <div class="setting-desc" id="ytdlp-status-desc">${t('checking')}</div>
      </div>
      <button class="btn sm" id="btn-ytdlp-update" onclick="manualUpdateYtdlp()">⬆ ${t('btnCheckNow')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('cpuOnlyName')}</div>
        <div class="setting-desc">${t('cpuOnlyDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${(localStorage.getItem('freqphull.cpuOnly')==='1')?'checked':''} onchange="toggleCpuOnly(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('hwAccelName')}</div>
        <div class="setting-desc">${t('hwAccelDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="hw-accel-toggle" checked onchange="toggleHardwareAcceleration(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('extLinkName')}</div>
        <div class="setting-desc">${t('extLinkDesc')}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn sm" onclick="openExtensionPage()" title="GitHub">🌐 ${t('extLinkOpen')}</button>
        <button class="btn sm pri" onclick="openExtensionHowTo()">📖 ${t('extLinkHowTo')}</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('writeTagsName')}</div>
        <div class="setting-desc">${t('writeTagsDesc')}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${(localStorage.getItem('freqphull.writeTags')!=='0')?'checked':''} onchange="toggleWriteTags(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('dlClearName')}</div>
        <div class="setting-desc">${t('dlClearDesc')}</div>
      </div>
      <select class="setting-select" id="dl-autoclear-sel" onchange="setDlAutoclear(this.value)">
        <option value="0">${t('optOff')}</option>
        <option value="1">${t('optHour1')}</option>
        <option value="12">${t('optHours12')}</option>
        <option value="24">${t('optHours24')}</option>
        <option value="72">${t('optHours72')}</option>
      </select>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('enginesName')}</div>
        <div class="setting-desc" id="engines-status-desc">${t('checking')}</div>
      </div>
      <button class="btn sm" id="btn-run-setup" onclick="showSetupModal()">${t('runSetupBtn')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('diagName')}</div>
        <div class="setting-desc" id="diag-paths-desc">${t('diagDesc')}</div>
      </div>
      <button class="btn sm" onclick="diagnosePaths()">${t('btnDiagnose')}</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">${t('logsName')}</div>
        <div class="setting-desc">${t('logsDesc')}</div>
      </div>
      <button class="btn sm" onclick="viewLogs()">${t('logsName')}</button>
    </div>
    <div class="setting-row" style="border:none">
      <div class="setting-info">
        <div class="setting-name">Freq.Phull</div>
        <div class="setting-desc" id="about-version-desc">${t('by')} Cynphull / Hood Knights</div>
      </div>
    </div>
  `;
  // Async-fetch current app version and patch the About row.
  // window.api.updater.getStatus() returns {currentVersion, autoDownload} in
  // packaged builds, or {status:'dev'} in unpackaged. We display the version
  // dynamically instead of hardcoding so releases don't drift out of sync
  // with the displayed string.
  refreshYtdlpStatus();
  syncHardwareAccelToggle();
  if (window.api && window.api.updater) {
    window.api.updater.getStatus().then(s => {
      const el = document.getElementById('about-version-desc');
      if (!el) return;
      if (s && s.currentVersion) {
        el.textContent = 'v' + s.currentVersion + ' — ' + t('by') + ' Cynphull / Hood Knights';
      } else {
        el.textContent = t('devBuild') + ' — ' + t('by') + ' Cynphull / Hood Knights';
      }
    }).catch(() => {});
  }
  // Async-fetch the engines status to update the row
  fetch(API + '/engines-status').then(r => r.json()).then(j => {
    const el = document.getElementById('engines-status-desc');
    if (!el) return;
    if (j.installed) {
      el.textContent = '✓ Installed' + (j.info && j.info.date ? ' · ' + j.info.date : '');
      el.style.color = '#7ed982';
    } else if (j.info && j.info.python) {
      // Marker exists but invalid (stale/old format). Tell the user it needs re-setup.
      el.textContent = 'Setup is out-of-date — re-run setup to fix';
      el.style.color = '#f59e0b';
    } else {
      el.textContent = 'Not installed — stem separator and transcription unavailable';
      el.style.color = '#f59e0b';
    }
  }).catch(() => {});
  // Reflect the current auto-clear value in the dropdown. We always sync
  // after innerHTML so the visible selection matches state, even when
  // the user opens Settings without ever interacting with downloads.
  const acSel = document.getElementById('dl-autoclear-sel');
  if (acSel) acSel.value = String(dlAutoclearHours);
}

async function diagnosePaths() {
  try {
    const r = await fetch(API + '/diag-bin');
    const j = await r.json();
    // Build a clean readable report
    const lines = [];
    lines.push('=== ROOTS ===');
    lines.push('RES (resourcesPath): ' + j.RES);
    lines.push('__dirname:           ' + j.__dirname);
    lines.push('asarUnpacked:        ' + j.asarUnpacked);
    lines.push('');
    lines.push('=== ENGINES ===');
    if (j.engines) {
      lines.push('Marker: ' + (j.engines.markerExists ? 'YES' : 'NO') + '  (' + j.engines.markerPath + ')');
      lines.push('Python: ' + j.engines.pythonCmd);
      if (j.engines.markerContent) {
        lines.push('Setup date: ' + (j.engines.markerContent.date || '?'));
        lines.push('Python version: ' + (j.engines.markerContent.python_version || '?'));
        lines.push('Engines: ' + (j.engines.markerContent.engines || []).join(', '));
      }
      if (j.engines.markerError) lines.push('Marker read error: ' + j.engines.markerError);
    }
    lines.push('');
    lines.push('=== BINARIES ===');
    for (const [name, info] of Object.entries(j.tools)) {
      lines.push('');
      lines.push('[' + name + '] resolved: ' + info.resolved);
      for (const c of info.candidates) {
        lines.push('  ' + (c.exists ? '✓ FOUND  ' : '✗ missing') + ' ' + c.path);
      }
    }
    lines.push('');
    lines.push('=== SCRIPTS ===');
    for (const [name, info] of Object.entries(j.scripts)) {
      lines.push('');
      lines.push('[' + name + '] resolved: ' + (info.resolved || '(none)'));
      for (const c of info.paths) {
        lines.push('  ' + (c.exists ? '✓ FOUND  ' : '✗ missing') + ' ' + c.path);
      }
    }
    const text = lines.join('\n');

    // Show in a modal with a copy button
    let modal = document.getElementById('diag-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'diag-modal';
      modal.className = 'setup-modal';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="setup-card" style="max-width:720px;max-height:80vh;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div class="setup-title" style="font-size:22px;text-align:left;margin:0">${t('diagTitle')}</div>
          <button class="btn xs" onclick="document.getElementById('diag-modal').style.display='none'">✕</button>
        </div>
        <pre id="diag-output" style="flex:1;overflow:auto;background:var(--bg3);padding:14px;border-radius:8px;font-size:11px;font-family:'Menlo',monospace;color:var(--white);white-space:pre-wrap;word-break:break-all;border:1px solid var(--border);line-height:1.55">${escapeHtml(text)}</pre>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="btn pri" onclick="copyDiagOutput()" style="flex:1">${t('copyToClipboard')}</button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
  } catch (e) {
    showAppNotification('✕ Diagnose failed: ' + e.message, 'err');
  }
}

function copyDiagOutput() {
  const el = document.getElementById('diag-output');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    showAppNotification('✓ Copied to clipboard', 'done');
  }).catch(e => showAppNotification('✕ ' + e.message, 'err'));
}

// View server + setup logs in a tabbed modal
async function viewLogs() {
  try {
    const r = await fetch(API + '/logs?kb=300');
    const j = await r.json();

    let modal = document.getElementById('logs-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'logs-modal';
      modal.className = 'setup-modal';
      document.body.appendChild(modal);
    }

    const serverEmpty = !(j.server || '').trim();
    const setupEmpty  = !(j.setup  || '').trim();

    modal.innerHTML = `
      <div class="setup-card" style="max-width:820px;max-height:85vh;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div class="setup-title" style="font-size:22px;text-align:left;margin:0">${t('logsTitle')}</div>
          <button class="btn xs" onclick="document.getElementById('logs-modal').style.display='none'">✕</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="btn sm logs-tab on" onclick="switchLogTab(0)">Server</button>
          <button class="btn sm logs-tab" onclick="switchLogTab(1)">Setup</button>
          <div style="flex:1"></div>
          <button class="btn sm" onclick="refreshLogs()">↻ Refresh</button>
          <button class="btn sm" onclick="copyCurrentLog()">Copy</button>
        </div>
        <div style="font-size:11px;color:var(--hint);margin-bottom:8px;font-family:monospace;word-break:break-all" id="logs-pathline"></div>
        <pre id="logs-output" style="flex:1;overflow:auto;background:var(--bg3);padding:12px;border-radius:8px;font-size:11px;font-family:'Menlo',monospace;color:var(--white);white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);line-height:1.5;margin:0"></pre>
      </div>
    `;
    modal.style.display = 'flex';

    // Cache the data so tab-switch is instant
    window._logsData = j;
    window._logsCurrentTab = 0;
    switchLogTab(0);
  } catch (e) {
    showAppNotification('✕ Failed to fetch logs: ' + e.message, 'err');
  }
}

function switchLogTab(idx) {
  window._logsCurrentTab = idx;
  document.querySelectorAll('.logs-tab').forEach((b, i) => {
    b.classList.toggle('on', i === idx);
  });
  const j = window._logsData || {};
  const out = document.getElementById('logs-output');
  const path = document.getElementById('logs-pathline');
  if (idx === 0) {
    if (path) path.textContent = j.paths?.server || '';
    if (out) out.textContent = (j.server || '').trim() || '(empty — no server log activity yet)';
  } else {
    if (path) path.textContent = j.paths?.setup || '';
    if (out) out.textContent = (j.setup || '').trim() || '(empty — no setup log; setup may not have run yet)';
  }
  // Auto-scroll to bottom (most recent)
  if (out) out.scrollTop = out.scrollHeight;
}

async function refreshLogs() {
  try {
    const r = await fetch(API + '/logs?kb=300');
    window._logsData = await r.json();
    switchLogTab(window._logsCurrentTab || 0);
  } catch (e) {
    showAppNotification('✕ Refresh failed: ' + e.message, 'err');
  }
}

function copyCurrentLog() {
  const out = document.getElementById('logs-output');
  if (!out) return;
  navigator.clipboard.writeText(out.textContent || '').then(() => {
    showAppNotification('✓ Copied to clipboard', 'done');
  }).catch(e => showAppNotification('✕ ' + e.message, 'err'));
}


async function repairHistory(silent) {
  if (!backendOnline) return;
  try {
    const stockpile = stockpileFolder || '';
    diagLog('repair-history: starting (silent=' + silent + ', stockpile=' + (stockpile || '(none set)') + ')', 'info');
    const resp = await fetch(API + '/repair-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stockpile })
    });
    const data = await resp.json();
    diagLog('repair-history result: indexed=' + data.indexed + ' broken=' + data.broken +
            ' repaired=' + data.repaired + ' needsReview=' + data.needsReview, 'info');

    if (data.repaired > 0) {
      showAppNotification('🔧 ' + data.repaired + ' track(s) reconnected', 'done');
      // Re-render only if repairs were made AND user can see the change.
      // The silent startup scan that returns repaired=0 must NOT trigger a
      // second render — that's the visible "jiggle" on app load.
      await loadHistory();
    } else if (!silent && data.broken === 0) {
      showAppNotification('✓ All tracks are already linked', 'info');
    }

    // If there are review items, surface them in a modal
    if (data.needsReview > 0 && !silent) {
      showRepairReviewModal(data.reviewItems);
    } else if (data.needsReview > 0 && silent) {
      // Silent startup scan — don't pop the modal but tell the user via notification
      showAppNotification('🔧 ' + data.repaired + ' linked, ' + data.needsReview + ' need review',
        'info', () => showRepairReviewModal(data.reviewItems));
    }

    // Update settings description if visible
    const desc = document.getElementById('repair-desc');
    if (desc) {
      if (data.repaired > 0) {
        desc.textContent = data.repaired + '/' + data.broken + ' ' + t('repairFixed') +
          (data.needsReview > 0 ? ' · ' + data.needsReview + ' need review' : '');
      } else if (data.needsReview > 0) {
        desc.textContent = data.needsReview + ' tracks need review — click to pick';
      } else {
        desc.textContent = t('repairOk');
      }
    }
  } catch (e) {
    if (!silent) showAppNotification('✕ Repair failed: ' + e.message, 'err');
  }
}

// ── Fix file locations ──────────────────────────────────────────────────
// Scans all tagged tracks and moves any whose file_path doesn't sit
// inside their primary tag's folder. Triggered from the Settings page.
// Shows a confirm dialog first (because it touches the filesystem), then
// a result toast with the move count. Disables the button while running
// so impatient clicks don't kick off a second pass.
async function repairFileLocations() {
  if (!backendOnline) {
    showAppNotification(t('backendOfflineRetry'), 'err');
    return;
  }
  if (!stockpileFolder) {
    showAppNotification(t('setStockpileFirst'), 'err');
    return;
  }
  const ok = await confirmModal({
    title: t('fixFilesConfirmTitle'),
    message: t('fixFilesConfirmMsg'),
    detail: t('stockRootLbl') + ' ' + stockpileFolder,
    okLabel: t('btnFixFiles'),
    cancelLabel: t('spCancel'),
  });
  if (!ok) return;

  const btn = document.getElementById('btn-fix-files');
  const desc = document.getElementById('fix-files-desc');
  // Disable + show a spinner so the user knows something is happening.
  // Reuse the existing pri styling so it matches the rest of the buttons.
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('scanningBtn'); }
  try {
    const r = await fetch(API + '/stockpile/repair-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stockpile_root: stockpileFolder }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Repair failed');
    // Build a human summary. We want the most important number first.
    const parts = [];
    if (j.moved)      parts.push(t('movedWord') + ' ' + j.moved + ' ' + (j.moved === 1 ? t('fileWord') : t('filesWord')));
    if (j.alreadyOk)  parts.push(j.alreadyOk + ' ' + t('alreadyInPlace'));
    if (j.missing)    parts.push(j.missing + ' ' + t('missingOnDisk'));
    if (j.errors)     parts.push(j.errors + ' ' + t('errorsWord'));
    const summary = parts.length
      ? parts.join(' · ')
      : t('checkedNothing').replace('{n}', j.checked);
    showAppNotification('✓ ' + summary, 'done');
    if (desc) desc.textContent = summary;
    // Refresh history so the renderer reflects the new file_paths
    if (j.moved) await loadHistory();
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📁 ' + t('btnFixFiles'); }
  }
}

// ── Manual temp-file cleanup ────────────────────────────────────────────
// Triggered by the "Clean now" button in Settings. The backend's
// automatic 6-hour sweep handles most cases, but if Windows Temp is
// filling the drive (we've seen 80GB accumulate), the user wants relief
// NOW, not in 6 hours. Confirms before running because killing in-flight
// conversions is bad — maxAge=1h ensures we don't touch anything fresh.
async function cleanTempFiles() {
  if (!backendOnline) {
    showAppNotification(t('backendOffline'), 'err');
    return;
  }
  const ok = await confirmModal({
    title: t('cleanConfirmTitle'),
    message: t('cleanConfirmMsg'),
    okLabel: t('btnCleanNow'),
    cancelLabel: t('spCancel'),
  });
  if (!ok) return;
  const btn = document.getElementById('btn-clean-temp');
  const desc = document.getElementById('clean-temp-desc');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('cleaningBtn'); }
  try {
    const r = await fetch(API + '/clean-temp-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeHours: 1 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Cleanup failed');
    const msg = j.deleted > 0
      ? '✓ ' + t('cleanedResult').replace('{n}', j.deleted).replace('{w}', j.deleted === 1 ? t('fileWord') : t('filesWord')).replace('{mb}', j.mbFreed)
      : '✓ ' + t('cleanNothing');
    showAppNotification(msg, 'done');
    if (desc) desc.textContent = msg;
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧹 ' + t('btnCleanNow'); }
  }
}

// ── Manual update check (Settings button) ───────────────────────────────
// Triggered by the "Check now" button. Calls into the main-process updater
// which pings GitHub's latest.yml. The existing onAvailable/onNone/onError
// event handlers wired in _setupUpdater() do the heavy lifting — they pop
// the update banner if a new version is found, or log "up to date"
// silently. This handler just adds an explicit foreground toast so the
// user gets immediate feedback on a button they clicked (the silent
// background check is too quiet to feel responsive).
//
// In dev / unpackaged builds, the updater bridge returns {ok:false,
// reason:'dev'} and we surface that clearly instead of swallowing it.
async function manualCheckForUpdates() {
  const btn = document.getElementById('btn-check-updates');
  const desc = document.getElementById('update-check-desc');
  const origDesc = desc ? desc.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('checkingBtn'); }
  try {
    if (!window.api || !window.api.updater) {
      throw new Error(t('updApiUnavailable'));
    }
    const result = await window.api.updater.check();
    if (!result || result.ok === false) {
      // dev mode, or genuine error
      if (result && result.reason === 'dev') {
        showAppNotification(t('updDevOnly'), 'warn');
        if (desc) desc.textContent = t('updDevOnlyLong');
      } else {
        const errMsg = (result && result.error) || 'Update check failed';
        showAppNotification('✕ ' + errMsg, 'err');
        if (desc) desc.textContent = '✕ ' + errMsg;
      }
      return;
    }
    // result.version is set when an update IS available. If it matches the
    // current version OR was not returned at all, we're up to date.
    // The event handlers (onAvailable/onNone) already fired by this point;
    // onAvailable pops the banner automatically. We just surface a toast.
    const status = await window.api.updater.getStatus();
    const current = (status && status.currentVersion) || 'current';
    if (result.version && result.version !== current) {
      const msg = '✓ Update available: v' + result.version + ' (you have v' + current + ')';
      showAppNotification(msg, 'done');
      if (desc) desc.textContent = msg + ' — see the banner at the top of the app.';
    } else {
      const msg = '✓ You\'re up to date (v' + current + ')';
      showAppNotification(msg, 'ok');
      if (desc) desc.textContent = msg + '. The app also checks automatically every 4 hours.';
      // After 5 seconds restore the original explainer so future clicks
      // don't show stale "up to date" text from a previous session.
      setTimeout(() => { if (desc) desc.textContent = origDesc; }, 8000);
    }
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
    if (desc) desc.textContent = '✕ ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Check now'; }
  }
}

// ── Storage breakdown modal ─────────────────────────────────────────────
// Opens a panel showing per-folder disk usage from /stockpile/disk-usage.
// Three things the user wants to know:
//   1. Which folder is biggest? (visual bar chart helps spot bloat)
//   2. How much total space is the library using?
//   3. Are there orphans? (audio files in the stockpile root that aren't
//      tagged into any folder — easy to forget about)
//
// The modal is built ad-hoc on open since this is rarely accessed and
// keeping it out of the static HTML keeps app.js leaner.
async function openStorageBreakdown() {
  if (!backendOnline) {
    showAppNotification('Backend offline', 'err');
    return;
  }
  const root = (typeof stockpileFolder !== 'undefined' && stockpileFolder) ? stockpileFolder : '';
  if (!root) {
    showAppNotification('Set a stockpile folder in Settings first', 'warn');
    return;
  }

  // Build modal shell first so the user sees a loading state immediately —
  // the disk walk can take ~500ms on a big library and a frozen settings
  // page in the meantime feels broken.
  let modal = document.getElementById('storage-breakdown-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'storage-breakdown-modal';
    modal.className = 'setup-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="setup-card" style="max-width:720px;max-height:80vh;display:flex;flex-direction:column;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="setup-title" style="font-size:24px;text-align:left;margin-bottom:2px">💾 ${t('storName')}</div>
          <div style="font-size:12px;color:var(--muted)">${t('storSub')}</div>
        </div>
        <button class="btn xs" onclick="closeStorageBreakdown()">✕</button>
      </div>
      <div id="storage-breakdown-body" style="flex:1;overflow-y:auto;padding-right:4px">
        <div style="text-align:center;padding:40px;color:var(--hint)">${t('storScanning')}</div>
      </div>
    </div>`;
  modal.style.display = 'flex';

  try {
    const r = await fetch(API + '/stockpile/disk-usage?root=' + encodeURIComponent(root));
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    const data = await r.json();
    renderStorageBreakdown(data);
  } catch (e) {
    const body = document.getElementById('storage-breakdown-body');
    if (body) body.innerHTML = `<div style="color:var(--err);padding:24px">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

function closeStorageBreakdown() {
  const modal = document.getElementById('storage-breakdown-modal');
  if (modal) modal.style.display = 'none';
}

// ── Storage Breakdown fix actions ───────────────────────────────────────
// These give the warnings chips actual teeth. Each one re-opens the
// breakdown afterwards so the user immediately sees the updated numbers.

// "Locate missing files" — run the existing repair scan in review mode.
// Anything fuzzy-matchable gets surfaced in the repair review modal where
// the user approves each relocation. We close the storage modal first so
// the two modals don't stack.
async function storageFixMissing() {
  closeStorageBreakdown();
  showAppNotification(t('scanRelocatable'), 'info');
  await repairHistory(false);
}

// "Remove dead entries" — prune history rows whose file no longer exists.
// Dry-run first to show an exact count in the confirm prompt; the server
// only deletes on confirm=true.
async function storagePruneMissing() {
  try {
    const dry = await fetch(API + '/history/prune-missing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    }).then(r => r.json());
    const n = dry.missing || 0;
    if (!n) { showAppNotification(t('pruneNoDead'), 'info'); openStorageBreakdown(); return; }
    const ok = confirm(t('pruneConfirm').replace('{n}', n));
    if (!ok) return;
    const r = await fetch(API + '/history/prune-missing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then(x => x.json());
    showAppNotification('🗑 ' + t('pruneRemoved') + ' ' + (r.removed || 0) + ' ' + t('deadEntriesWord'), 'done');
    if (typeof loadHistory === 'function') await loadHistory();
    openStorageBreakdown();
  } catch (e) {
    showAppNotification(t('pruneFailed') + ' ' + e.message, 'err');
  }
}

// "Import N untagged files" — adopt orphan audio files in the stockpile
// root into the library, then jump straight into Auto-organize so they
// get folder suggestions in the same motion.
// Repair-metadata (v0.2.7): fixes blank thumbnails + duration on rows
// adopted by the watch folder before v0.2.5 prevented the duplicate
// problem. Dry-run first to show a count; confirm to apply. Twin-merge
// is instant; ffprobe takes ~50ms per row so we surface the per-strategy
// count so the user knows what they're signing up for.
async function storageRepairMetadata() {
  showAppNotification(t('storRepairScanning'), 'info');
  try {
    const dry = await fetch(API + '/history/repair-metadata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false })
    }).then(r => r.json());
    if (!dry.affected) {
      showAppNotification(t('storRepairNone'), 'info');
      return;
    }
    const msg = t('storRepairConfirm')
      .replace('{n}', dry.affected)
      .replace('{twin}', dry.twin_merge)
      .replace('{probe}', dry.ffprobe);
    if (!confirm(msg)) return;
    const r = await fetch(API + '/history/repair-metadata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    }).then(r => r.json());
    showAppNotification('🖼 ' + t('storRepairDone')
      .replace('{n}', r.affected)
      .replace('{twin}', r.twin_merge)
      .replace('{probe}', r.ffprobe), 'done');
    if (typeof loadHistory === 'function') await loadHistory();
    openStorageBreakdown();
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

async function storageAdoptOrphans() {
  const root = (typeof stockpileFolder !== 'undefined' && stockpileFolder) ? stockpileFolder : '';
  if (!root) { showAppNotification(t('setStockpileFirst'), 'warn'); return; }
  const btnRow = document.getElementById('storage-fix-actions');
  if (btnRow) btnRow.innerHTML = '<span style="font-size:12px;color:var(--hint)">' + t('storImporting') + '</span>';
  try {
    const r = await fetch(API + '/stockpile/adopt-orphans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error);
    showAppNotification('📥 ' + t('notifImported') + ' ' + r.adopted + ' ' + (r.adopted === 1 ? t('fileWord') : t('filesWord')) +
      (r.skipped_stems ? ' (' + r.skipped_stems + ' ' + t('notifStemsSkipped') + ')' : ''), 'done');
    if (typeof loadHistory === 'function') await loadHistory();
    closeStorageBreakdown();
    if (r.adopted > 0) openAutoOrganize();
  } catch (e) {
    showAppNotification(t('importFailed') + ' ' + e.message, 'err');
    openStorageBreakdown();
  }
}

function renderStorageBreakdown(data) {
  const body = document.getElementById('storage-breakdown-body');
  if (!body) return;
  // Sort folders by size descending — biggest first is what people actually
  // want to see (find the bloat, decide what to thin out).
  const folders = (data.folders || []).slice().sort((a, b) => b.bytes - a.bytes);
  const maxBytes = folders.reduce((m, f) => Math.max(m, f.bytes), 0) || 1;

  // Top-line summary chips
  const trackedMB = formatBytes(data.tracked ? data.tracked.bytes : 0);
  const orphanMB = formatBytes(data.untracked ? data.untracked.bytes : 0);
  const totalMB = formatBytes(data.root_total_bytes || 0);
  const freeStr = data.drive && data.drive.free_bytes
    ? formatBytes(data.drive.free_bytes) + ' ' + t('storFreeOnDrive')
    : '';
  const missingChip = data.missing_files > 0
    ? `<span class="storage-chip warn">⚠ ${data.missing_files} ${data.missing_files === 1 ? t('storMissingOne') : t('storMissingMany')}</span>`
    : '';
  const orphanChip = (data.untracked && data.untracked.files > 0)
    ? `<span class="storage-chip warn">${data.untracked.files} ${data.untracked.files === 1 ? t('storOrphanOne') : t('storOrphanMany')} (${orphanMB})</span>`
    : '';

  // Action buttons — the whole point of surfacing problems is letting the
  // user fix them right here instead of hunting through Settings.
  const fixActions = [];
  if (data.missing_files > 0) {
    fixActions.push(`<button class="btn xs" onclick="storageFixMissing()">🔍 ${t('storLocate')}</button>`);
    fixActions.push(`<button class="btn xs" onclick="storagePruneMissing()">🗑 ${t('storPrune')}</button>`);
  }
  if (data.untracked && data.untracked.files > 0) {
    fixActions.push(`<button class="btn xs" onclick="storageAdoptOrphans()">📥 ${t('storImportBtn')} (${data.untracked.files})</button>`);
  }
  fixActions.push(`<button class="btn xs" onclick="storageRepairMetadata()">🖼 ${t('storRepairThumbs')}</button>`);
  fixActions.push(`<button class="btn xs" onclick="closeStorageBreakdown();openAutoOrganize()">✨ ${t('aoTitle')}</button>`);
  const actionsHTML = `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap" id="storage-fix-actions">${fixActions.join('')}</div>`;

  const summaryHTML = `
    <div style="margin-bottom:16px;padding:12px 14px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">
      <div style="font-size:12px;color:var(--hint);margin-bottom:4px">${escapeHtml(data.stockpile_root)}</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px">
        <div><strong>${totalMB}</strong> ${t('storTotalIn')}</div>
        <div><strong>${trackedMB}</strong> ${t('storTagged')} (${data.tracked ? data.tracked.files : 0} ${t('filesWord')})</div>
        ${freeStr ? `<div style="color:var(--hint)">${freeStr}</div>` : ''}
      </div>
      ${(missingChip || orphanChip) ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${missingChip}${orphanChip}</div>` : ''}
      ${actionsHTML}
    </div>`;

  // Per-folder bars
  const folderRowsHTML = folders.length === 0
    ? '<div style="text-align:center;color:var(--hint);padding:24px">' + t('storNoFolders') + '</div>'
    : folders.map(f => {
        const pct = Math.max(2, Math.round((f.bytes / maxBytes) * 100));
        const colorStyle = f.color ? `background:${escapeHtml(f.color)}` : 'background:var(--accent)';
        const missingNote = f.missing_count > 0
          ? `<span style="color:#f59e0b;margin-left:8px;font-size:11px">⚠ ${f.missing_count} ${t('storMissingNote')}</span>`
          : '';
        return `
          <div class="storage-folder-row" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
              <div style="font-size:13px;font-weight:500">${escapeHtml(f.name)}</div>
              <div style="font-size:12px;color:var(--hint)">${formatBytes(f.bytes)} · ${f.file_count} ${f.file_count === 1 ? t('fileWord') : t('filesWord')}${missingNote}</div>
            </div>
            <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden;border:1px solid var(--border)">
              <div style="height:100%;width:${pct}%;${colorStyle};transition:width 240ms ease"></div>
            </div>
          </div>`;
      }).join('');

  body.innerHTML = summaryHTML + folderRowsHTML;
}

// Repair review modal — shows broken history entries with the top candidate(s)
// the server found via fuzzy matching. User picks "Apply" per row or "Skip".
function showRepairReviewModal(items) {
  if (!items || !items.length) return;
  // Build modal HTML
  let modal = document.getElementById('repair-review-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'repair-review-modal';
    modal.className = 'setup-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }

  const fmtSize = (b) => {
    if (!b) return '';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  };
  const fmtMtime = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const diffH = (now - d) / 3600000;
    if (diffH < 1) return 'just now';
    if (diffH < 24) return Math.round(diffH) + 'h ago';
    if (diffH < 24 * 7) return Math.round(diffH / 24) + 'd ago';
    return d.toLocaleDateString();
  };

  modal.innerHTML = `
    <div class="setup-card" style="max-width:640px;max-height:80vh;display:flex;flex-direction:column;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div class="setup-title" style="font-size:24px;text-align:left;margin-bottom:2px">${t('rrTitle')}</div>
          <div style="font-size:12px;color:var(--muted)">${items.length} track${items.length === 1 ? '' : 's'} need confirmation — pick the right file or skip</div>
        </div>
        <button class="btn xs" onclick="closeRepairReview()">✕</button>
      </div>
      <div id="review-list" style="flex:1;overflow-y:auto;padding-right:4px">
        ${items.map((item, i) => `
          <div class="review-row" id="review-row-${i}" data-id="${item.id}">
            <div style="font-size:13px;color:var(--white);font-weight:600;margin-bottom:3px">${escapeHtml(item.title || '(untitled)')}</div>
            <div style="font-size:11px;color:var(--hint);margin-bottom:8px;font-family:monospace">${escapeHtml(item.oldName)}</div>
            <div class="review-candidates">
              ${item.candidates.map((c, ci) => `
                <div class="review-cand">
                  <input type="radio" name="cand-${i}" id="cand-${i}-${ci}" value="${escapeHtml(c.path)}" ${ci === 0 ? 'checked' : ''}>
                  <label for="cand-${i}-${ci}" style="flex:1;cursor:pointer;min-width:0">
                    <div style="font-size:12px;color:var(--white);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.name)}</div>
                    <div style="font-size:10px;color:var(--hint);margin-top:1px">
                      <span style="color:${c.score >= 0.85 ? '#7ed982' : c.score >= 0.70 ? '#f59e0b' : '#999'}">${Math.round(c.score * 100)}% match</span>
                      · ${c.stage}
                      · ${fmtSize(c.size)}
                      · ${fmtMtime(c.mtime)}
                      <span style="display:block;font-family:monospace;color:var(--muted);font-size:10px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.path)}</span>
                    </div>
                  </label>
                </div>
              `).join('')}
            </div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn sm" onclick="applyReviewMatch(${i}, ${item.id})" style="flex:1">Apply</button>
              <button class="btn xs" onclick="skipReviewMatch(${i})">Skip</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="display:flex;gap:6px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn pri" onclick="applyAllReviewMatches()" style="flex:1">${t('repairApplyAll')}</button>
        <button class="btn xs" onclick="closeRepairReview()">Done</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
}

function closeRepairReview() {
  const modal = document.getElementById('repair-review-modal');
  if (modal) modal.style.display = 'none';
}

async function applyReviewMatch(rowIdx, historyId) {
  const radio = document.querySelector('input[name="cand-' + rowIdx + '"]:checked');
  if (!radio) return;
  const newPath = radio.value;
  try {
    const r = await fetch(API + '/repair-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: historyId, path: newPath }),
    });
    const j = await r.json();
    if (!j.ok) {
      showAppNotification('✕ ' + (j.error || 'Apply failed'), 'err');
      return;
    }
    // Visually remove the row
    const row = document.getElementById('review-row-' + rowIdx);
    if (row) {
      row.style.opacity = '0.4';
      row.style.pointerEvents = 'none';
      const status = document.createElement('div');
      status.style.cssText = 'font-size:11px;color:#7ed982;margin-top:6px';
      status.textContent = '✓ Linked';
      row.appendChild(status);
    }
    await loadHistory();
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

function skipReviewMatch(rowIdx) {
  const row = document.getElementById('review-row-' + rowIdx);
  if (row) {
    row.style.opacity = '0.4';
    row.style.pointerEvents = 'none';
  }
}

async function applyAllReviewMatches() {
  const rows = document.querySelectorAll('.review-row');
  let applied = 0;
  for (const row of rows) {
    if (row.style.opacity === '0.4') continue; // already handled
    const historyId = row.dataset.id;
    const radio = row.querySelector('input[type="radio"]:checked');
    if (!historyId || !radio) continue;
    try {
      const r = await fetch(API + '/repair-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: historyId, path: radio.value }),
      });
      const j = await r.json();
      if (j.ok) {
        applied++;
        row.style.opacity = '0.4';
        row.style.pointerEvents = 'none';
      }
    } catch {}
  }
  if (applied > 0) {
    showAppNotification('✓ ' + applied + ' track(s) linked', 'done');
    await loadHistory();
  }
}

function setLang(l) {
  lang = l;
  setSetting('lang', l);
  applyLang();
}

function toggleAutoAnalyze(on) {
  autoAnalyze = on;
  setSetting('autoAnalyze', on);
}


// ════════════════════════════════════════════════════════════════════════════
// Stockpile organization — style folders, mood tagging, suggestions
// ════════════════════════════════════════════════════════════════════════════

let spFolders = [];        // cached folder list
let spUntagged = [];       // cached untagged track list
let spTagsByTrack = {};    // historyId -> [tags]
let spSuggestionsByTrack = {}; // historyId -> [suggestions]

// Top-level loader — called when the Stockpile tab opens.
async function loadStockpile() {
  try {
    const [summary, folders, untagged] = await Promise.all([
      fetch(API + '/stockpile/summary').then(r => r.json()),
      fetch(API + '/stockpile/folders').then(r => r.json()),
      fetch(API + '/stockpile/untagged').then(r => r.json()),
    ]);
    spFolders = folders.folders || [];
    spUntagged = untagged.tracks || [];
    renderStockpileSummary(summary);
    renderStockpileFolders();
    renderStockpileUntagged();
    // Update root-path display from settings
    const rootEl = document.getElementById('sp-root-path');
    if (rootEl) rootEl.textContent = stockpileFolder || t('stockpileNotSet');
  } catch (e) {
    diagLog('loadStockpile failed: ' + e.message, 'err');
  }
}

function renderStockpileSummary(s) {
  if (!s) return;
  const $ = id => document.getElementById(id);
  if ($('sp-stat-folders'))   $('sp-stat-folders').textContent   = s.folders ?? 0;
  if ($('sp-stat-tagged'))    $('sp-stat-tagged').textContent    = s.tagged_tracks ?? 0;
  if ($('sp-stat-committed')) $('sp-stat-committed').textContent = s.committed_tracks ?? 0;
  if ($('sp-stat-untagged'))  $('sp-stat-untagged').textContent  = s.untagged ?? 0;
}

function renderStockpileFolders() {
  const grid = document.getElementById('sp-folder-grid');
  if (!grid) return;
  if (!spFolders.length) {
    grid.classList.remove('scroll-y');
    grid.innerHTML = `<div class="sp-empty" id="sp-folder-empty">
      <div style="font-size:14px;margin-bottom:8px">${t('spNoFolders')}</div>
      <div style="font-size:12px;color:var(--hint)">${t('spNoFoldersHint')}</div>
    </div>`;
    return;
  }
  // Once you accumulate more than ~12 folders the grid would push the
  // untagged section off-screen; switch the grid to a scrollable region
  // so the page stays balanced.
  if (spFolders.length > 12) {
    grid.classList.add('scroll-y');
  } else {
    grid.classList.remove('scroll-y');
  }
  grid.innerHTML = '';
  for (const f of spFolders) {
    const card = document.createElement('div');
    card.className = 'sp-folder-card';
    card.onclick = (e) => {
      // Don't trigger card click when interacting with action buttons
      if (e.target.closest('.sp-fc-actions')) return;
      openFolderView(f);
    };
    const seedsTxt = f.artist_seeds ? f.artist_seeds.split(',').slice(0, 3).map(s => s.trim()).join(' · ') : '';
    const canAutoMatch = !!(f.artist_seeds || f.mood_centroid);
    card.innerHTML = `
      <div class="sp-fc-actions">
        ${canAutoMatch ? `<button title="${t('spAutoMatchTooltip')}" class="sp-fc-magic" onclick="openMatchPreview(${f.id})">⚡</button>` : ''}
        <button title="Edit" onclick="editFolder(${f.id})">✎</button>
        <button title="Delete" onclick="deleteFolder(${f.id})">×</button>
      </div>
      <div class="sp-fc-name"><span class="sp-fc-color" ${f.color ? `style="background:${escapeHtml(f.color)}"` : ''}></span>${escapeHtml(f.name)}</div>
      <div class="sp-fc-count">${f.track_count} ${f.track_count === 1 ? t('spTrack') : t('spTracks')} <span class="sp-fc-size" id="sp-fc-size-${f.id}" style="opacity:.6;margin-left:6px"></span></div>
      ${f.description ? `<div class="sp-fc-desc">${escapeHtml(f.description)}</div>` : ''}
      ${seedsTxt ? `<div class="sp-fc-seeds">${escapeHtml(seedsTxt)}${f.artist_seeds.split(',').length > 3 ? ' …' : ''}</div>` : ''}
    `;
    grid.appendChild(card);
  }
  // Lazy-fill disk usage badges on each folder card. Single endpoint hit
  // populates all of them in one round trip — cheaper than per-card requests
  // and avoids the cards flickering in one by one.
  hydrateFolderCardSizes();
}

// Fetches disk usage for all folders in one call and writes the formatted
// byte count into each card's size span. Failures are silent — the cards
// just don't get a size annotation, which is no worse than before.
async function hydrateFolderCardSizes() {
  try {
    const root = (typeof stockpileFolder !== 'undefined' && stockpileFolder) ? stockpileFolder : '';
    if (!root) return;
    const r = await fetch(API + '/stockpile/disk-usage?root=' + encodeURIComponent(root));
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.folders)) return;
    for (const f of j.folders) {
      const el = document.getElementById('sp-fc-size-' + f.id);
      if (el && f.bytes > 0) el.textContent = '· ' + formatBytes(f.bytes);
    }
  } catch {}
}

// Bytes → human string. Uses 1024 (binary) which is what Windows shows.
function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let u = 0;
  let v = n;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[u];
}

async function renderStockpileUntagged() {
  const list = document.getElementById('sp-untagged-list');
  const countEl = document.getElementById('sp-untagged-count');
  if (!list) return;
  if (countEl) countEl.textContent = `${spUntagged.length} ${spUntagged.length === 1 ? t('spTrack') : t('spTracks')}`;
  if (!spUntagged.length) {
    list.innerHTML = `<div class="sp-empty" id="sp-untagged-empty" style="font-size:12px;color:var(--hint)">${t('spAllTagged')}</div>`;
    return;
  }
  // Show first 30 with suggestion chips. Loading suggestions for all untagged
  // is expensive; we paginate in batches as the user scrolls if needed.
  list.innerHTML = '';
  const slice = spUntagged.slice(0, 30);
  for (const track of slice) {
    const row = document.createElement('div');
    row.className = 'sp-untagged-row';
    row.innerHTML = `
      <div>
        <div class="sp-ut-title">${escapeHtml(track.title || track.file_path || '?')}</div>
        <div class="sp-ut-meta">${track.bpm ? `${Math.round(track.bpm)} BPM` : ''}${track.key_note ? ` · ${escapeHtml(track.key_note)} ${escapeHtml(track.key_mode || '')}` : ''}</div>
      </div>
      <div class="sp-ut-suggestions" id="sp-sug-${track.id}">
        <span style="font-size:10px;color:var(--hint)">${t('spLoadingSugs')}</span>
      </div>
    `;
    list.appendChild(row);
    // Load suggestions for this row
    loadTrackSuggestions(track.id).then(sugs => {
      const cell = document.getElementById('sp-sug-' + track.id);
      if (!cell) return;
      if (!sugs || !sugs.length) {
        cell.innerHTML = `<button class="sp-suggestion-chip low" onclick="openTagPicker(${track.id})">+ ${t('spTagBtn')}</button>`;
        return;
      }
      cell.innerHTML = sugs.slice(0, 3).map(s => `
        <button class="sp-suggestion-chip ${s.confidence < 0.4 ? 'low' : ''}"
                title="${escapeHtml((s.reasons || []).join(' · '))}"
                onclick="quickTag(${track.id}, ${s.folder_id}, ${s.confidence}, 'auto-suggested')">
          ${escapeHtml(s.folder_name)}<span class="sp-sc-conf">${Math.round(s.confidence * 100)}%</span>
        </button>
      `).join('') + `<button class="sp-suggestion-chip low" onclick="openTagPicker(${track.id})">…</button>`;
    });
  }
  if (spUntagged.length > 30) {
    const more = document.createElement('div');
    more.style.cssText = 'text-align:center;color:var(--hint);font-size:11px;padding:8px';
    more.textContent = `+ ${spUntagged.length - 30} ${t('spMore')}`;
    list.appendChild(more);
  }
}

async function loadTrackSuggestions(historyId) {
  if (spSuggestionsByTrack[historyId]) return spSuggestionsByTrack[historyId];
  try {
    const r = await fetch(API + '/stockpile/tracks/' + historyId + '/suggestions');
    const j = await r.json();
    spSuggestionsByTrack[historyId] = j.suggestions || [];
    return spSuggestionsByTrack[historyId];
  } catch (e) {
    return [];
  }
}

async function quickTag(historyId, folderId, confidence, source) {
  try {
    const r = await fetch(API + '/stockpile/tracks/' + historyId + '/tags', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      // stockpile_root is passed so the backend's auto-commit can move
      // the file into its primary folder right when we tag it. The
      // user no longer needs a separate "commit to stockpile" step.
      body: JSON.stringify({
        folder_id: folderId, is_primary: 1, confidence, source,
        stockpile_root: stockpileFolder || undefined,
      }),
    });
    if (!r.ok) throw new Error('Tag failed');
    delete spSuggestionsByTrack[historyId];
    // Optimistic local updates so the user sees the change instantly
    spUntagged = spUntagged.filter(t => t.id !== historyId);
    const f = spFolders.find(x => x.id === folderId);
    if (f) f.track_count = (f.track_count || 0) + 1;
    renderStockpileFolders();
    renderStockpileUntagged();
    fetch(API + '/stockpile/summary').then(r => r.json()).then(renderStockpileSummary);
    // Auto-refresh history row's tag chips + folder view if relevant
    refreshUIForAction('tag-changed', { historyId, folderId });
    showAppNotification('✓ ' + t('spTagged') + ': ' + (f ? f.name : ''), 'ok');
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// Open a fuller tag picker (modal) for a track.
async function openTagPicker(historyId) {
  // Lazy-load folders if the cache is empty. spFolders is normally
  // populated when the user visits the Stockpile tab, but they can also
  // open this picker from History without ever opening Stockpile this
  // session — in which case spFolders is still `[]` from its initial
  // declaration and the picker would show "No folders yet" even when
  // folders exist on the backend. Refetching here costs one HTTP call
  // and guarantees the picker reflects current state.
  if (!Array.isArray(spFolders) || spFolders.length === 0) {
    try {
      const r = await fetch(API + '/stockpile/folders');
      const j = await r.json();
      spFolders = j.folders || [];
    } catch (e) {
      diagLog('openTagPicker: failed to load folders: ' + e.message, 'err');
      // Carry on — the picker will show empty state and the user can
      // close and retry, rather than blocking on a backend hiccup.
    }
  }
  // Build a modal on the fly; simpler than another HTML block.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const sugs = await loadTrackSuggestions(historyId);
  const sugRows = sugs.length ? sugs.map(s => `
    <div class="tag-picker-row" onclick="quickTag(${historyId}, ${s.folder_id}, ${s.confidence}, 'auto-suggested'); document.querySelector('.modal-overlay').remove()">
      <div style="flex:1">
        <div class="tp-name">${escapeHtml(s.folder_name)}</div>
        <div class="tp-reasons">${escapeHtml((s.reasons || []).join(' · '))}</div>
      </div>
      <div class="tp-conf">${Math.round(s.confidence * 100)}%</div>
    </div>
  `).join('') : `<div class="tag-picker-empty">${t('spNoSuggestions')}</div>`;

  // Filter out folders already shown as suggestions so the user doesn't
  // see the same folder twice in the picker. Suggestions are the ranked
  // top matches; "All folders" should be the complete list MINUS those.
  // Sort all-folders alphabetically so they're easy to scan.
  const suggestedIds = new Set(sugs.map(s => s.folder_id));
  const allFolders = spFolders
    .filter(f => !suggestedIds.has(f.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const allRows = allFolders.map(f => `
    <div class="tag-picker-row" onclick="quickTag(${historyId}, ${f.id}, null, 'manual'); document.querySelector('.modal-overlay').remove()">
      <div class="tp-name">${escapeHtml(f.name)}</div>
      <div class="tp-conf">${f.track_count}</div>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div class="tag-picker">
      <div class="tag-picker-title">${t('spTagThisTrack')}</div>
      <div class="tag-picker-section-lbl">${t('spSuggestions')}</div>
      ${sugRows}
      <div class="tag-picker-section-lbl">${t('spAllFolders')}</div>
      ${allRows || `<div class="tag-picker-empty">${t('spNoFolders')}</div>`}
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── Folder browser view ─────────────────────────────────────────────────────
// ── Global audio player ─────────────────────────────────────────────────────
// A SINGLE <audio> element used for all playback across the app:
// folder-view previews, history-row previews, and analyze-view playback.
// One element = one source of truth = no two streams fighting for the same
// file (which was causing rapid-fire ECANCELED errors and an occasional
// freeze when the renderer process got tangled up).
//
// `globalPlayer.track` holds the currently playing track metadata.
// `globalPlayer.context` holds the playlist context (list + index) for
// prev/next behavior. Source-agnostic — works whether the playlist came
// from a folder, history, or anywhere else.
const globalPlayer = {
  audio: null,
  track: null,           // {id, title, file_path, thumbnail, ...}
  context: null,         // {source: 'folder'|'history'|'analyze', tracks: [], index: 0}
  loadCounter: 0,        // monotonic counter to detect stale load callbacks
};

// Legacy aliases — the rest of the code still references these names. We
// keep them as live getters/setters that delegate to globalPlayer so the
// refactor is incremental and safe.
let spFvTracks = [];        // cached folder tracks (used when context.source = 'folder')

Object.defineProperty(window, 'spFvAudio', {
  get() { return globalPlayer.audio; },
  set(v) { globalPlayer.audio = v; },
});
Object.defineProperty(window, 'spFvAudioTrackId', {
  get() { return globalPlayer.track ? globalPlayer.track.id : null; },
  set(v) {
    // Setter is a no-op; ID is derived from globalPlayer.track. Older code
    // that wrote to this used to track "is something playing"; that role is
    // now filled by globalPlayer.track !== null.
  },
});

// State for the folder view: which folder is open. Track playback state
// has migrated to globalPlayer.
let spFvFolder = null;          // current folder object {id, name, ...}
let spFvAudioTimer = null;      // timer for time display updates (legacy field, unused)

async function openFolderView(folder) {
  spFvFolder = folder;
  // Hide dashboard, show folder view
  const dash = document.getElementById('sp-dashboard');
  const view = document.getElementById('sp-folder-view');
  if (dash) dash.classList.add('hidden');
  if (view) view.classList.remove('hidden');

  // Populate header immediately from cached folder data
  document.getElementById('sp-fv-title').textContent = folder.name;
  document.getElementById('sp-fv-meta').textContent =
    `${folder.track_count || 0} ${folder.track_count === 1 ? t('spTrack') : t('spTracks')}`;

  // Description block
  const descEl = document.getElementById('sp-fv-desc');
  if (folder.description) {
    descEl.textContent = folder.description;
    descEl.style.display = '';
  } else {
    descEl.style.display = 'none';
  }

  // Seeds row
  const seedsRow = document.getElementById('sp-fv-seeds-row');
  const seedsEl = document.getElementById('sp-fv-seeds');
  if (folder.artist_seeds) {
    seedsEl.textContent = folder.artist_seeds.split(',').map(s => s.trim()).join(' · ');
    seedsRow.style.display = '';
  } else {
    seedsRow.style.display = 'none';
  }

  // Mood centroid bars — only show if the folder has tracks (centroid exists)
  const moodRow = document.getElementById('sp-fv-mood-row');
  let centroid = null;
  try { if (folder.mood_centroid) centroid = JSON.parse(folder.mood_centroid); } catch {}
  if (centroid) {
    document.getElementById('sp-fv-mood-energy').style.width   = Math.round((centroid.energy   || 0) * 100) + '%';
    document.getElementById('sp-fv-mood-tonality').style.width = Math.round((centroid.tonality || 0) * 100) + '%';
    document.getElementById('sp-fv-mood-density').style.width  = Math.round((centroid.density  || 0) * 100) + '%';
    document.getElementById('sp-fv-mood-tempo').style.width    = Math.round((centroid.tempo_pos|| 0) * 100) + '%';
    moodRow.style.display = '';
  } else {
    moodRow.style.display = 'none';
  }

  // Reset toolbar state
  const sortEl = document.getElementById('sp-fv-sort');
  const searchEl = document.getElementById('sp-fv-search');
  if (sortEl) sortEl.value = 'date';
  if (searchEl) searchEl.value = '';

  // Loading state
  document.getElementById('sp-fv-track-list').innerHTML =
    `<div style="text-align:center;padding:32px;color:var(--muted);font-size:12px">${t('spLoading') || 'Loading…'}</div>`;

  // Fetch tracks
  try {
    const r = await fetch(API + '/stockpile/folders/' + folder.id + '/tracks');
    const j = await r.json();
    spFvTracks = j.tracks || [];
    renderFolderTracks();
  } catch (e) {
    document.getElementById('sp-fv-track-list').innerHTML =
      `<div style="text-align:center;padding:24px;color:#ff8888">${escapeHtml(e.message)}</div>`;
  }
}

function closeFolderView() {
  // Stop any playing preview
  folderViewStopPlay();
  spFvFolder = null;
  spFvTracks = [];
  const dash = document.getElementById('sp-dashboard');
  const view = document.getElementById('sp-folder-view');
  if (view) view.classList.add('hidden');
  if (dash) dash.classList.remove('hidden');
  // Refresh dashboard counts (in case tags changed inside the view)
  loadStockpile();
}

// Render the current spFvTracks using the active sort + search filter.
function renderFolderTracks() {
  const list = document.getElementById('sp-fv-track-list');
  const countEl = document.getElementById('sp-fv-list-count');
  if (!list) return;

  const q = (document.getElementById('sp-fv-search')?.value || '').toLowerCase().trim();
  const sortKey = document.getElementById('sp-fv-sort')?.value || 'date';

  // Filter
  let visible = spFvTracks;
  if (q) {
    visible = visible.filter(tr => {
      const hay = ((tr.title || '') + ' ' + (tr.file_path || '') + ' ' + (tr.channel || '')).toLowerCase();
      return hay.includes(q);
    });
  }

  // Sort
  visible = visible.slice();
  switch (sortKey) {
    case 'date':
      visible.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      break;
    case 'date-asc':
      visible.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      break;
    case 'title':
      visible.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'bpm':
      visible.sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
      break;
    case 'bpm-desc':
      visible.sort((a, b) => (b.bpm || 0) - (a.bpm || 0));
      break;
    case 'key':
      // Camelot-style sort: key letter then mode
      visible.sort((a, b) => {
        const ka = (a.key_note || 'Z') + (a.key_mode === 'minor' ? '0' : '1');
        const kb = (b.key_note || 'Z') + (b.key_mode === 'minor' ? '0' : '1');
        return ka.localeCompare(kb);
      });
      break;
  }

  if (countEl) countEl.textContent = `${visible.length} / ${spFvTracks.length}`;

  if (!visible.length) {
    list.innerHTML = `<div class="sp-empty" style="font-size:12px;color:var(--hint)">${q ? (t('spNoMatches') || 'No tracks match') : (t('spFolderEmpty') || 'No tracks tagged yet')}</div>`;
    return;
  }

  list.innerHTML = visible.map(tr => {
    const meta = [
      tr.bpm ? `<span class="badge">${Math.round(tr.bpm)} BPM</span>` : '',
      tr.key_note ? `<span class="badge">${escapeHtml(tr.key_note)} ${escapeHtml(tr.key_mode || '')}</span>` : '',
      tr.duration ? `<span class="badge">${fmtSec(tr.duration)}</span>` : '',
      tr.mood_label ? `<span class="badge">${escapeHtml(tr.mood_label)}</span>` : '',
      tr.stockpile_committed ? `<span class="badge committed">✓ ${t('spCommitted') || 'Committed'}</span>` : '',
    ].filter(Boolean).join('');
    const isPlaying = (spFvAudioTrackId === tr.id) ? 'playing' : '';
    const playGlyph = isPlaying
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,5 7,19 19,12"/></svg>';
    // Thumbnail: image if available, otherwise dim ♪ glyph in the slot
    const thumb = tr.thumbnail
      ? `<img class="sp-fv-row-thumb" loading="lazy" decoding="async" src="${escapeHtml(resolveThumb(tr.thumbnail))}" onerror="window._thumbFail(this)"/>`
      : `<div class="sp-fv-row-thumb fallback">♪</div>`;
    // Clicking the title block opens the full analysis (waveform, sections,
    // chord progression, LUFS, dynamic range, etc.). The title is the
    // primary surface so it gets a hover affordance.
    return `
      <div class="sp-fv-row" data-id="${tr.id}" draggable="true" ondragstart="dragStockpileRowToExternal(event, ${tr.id})">
        <button class="sp-fv-play ${isPlaying}" tabindex="-1" onmousedown="this.blur()" onclick="folderViewPlayTrack(${tr.id});this.blur()" title="${t('spPreview') || 'Preview'}">${playGlyph}</button>
        ${thumb}
        <div class="sp-fv-info sp-fv-info-clickable" onclick="folderViewOpenAnalysis(${tr.id})" title="${t('spOpenAnalysis') || 'Open full analysis'}">
          <div class="sp-fv-row-title">${escapeHtml(tr.title || (tr.file_path || '').split(/[/\\\\]/).pop() || '?')}</div>
          <div class="sp-fv-row-meta">${meta}</div>
        </div>
        <div class="sp-fv-row-actions">
          <button onclick="folderViewOpenAnalysis(${tr.id})" title="${t('spOpenAnalysis') || 'Open full analysis'}">🎵</button>
          <button onclick="folderViewRetag(${tr.id})" title="${t('spChangeFolder') || 'Move to another folder'}">↪</button>
          <button onclick="folderViewOpenInExplorer(${tr.id})" title="${t('spShowInExplorer') || 'Show in Explorer'}">📁</button>
          <button class="danger" onclick="folderViewUntag(${tr.id})" title="${t('spRemoveFromFolder') || 'Remove from this folder'}">×</button>
        </div>
      </div>
    `;
  }).join('');
}

function filterFolderTracks() {
  // Search input change handler. Re-renders without re-fetching.
  renderFolderTracks();
}

// Inline audio preview using the global <audio> element. Click play on a
// row to start; click again to pause; click another row to switch tracks.
// This function is called from folder rows, history rows, and analyze.
function folderViewPlayTrack(trackId) {
  const tr = (spFvTracks || []).find(x => x.id === trackId);
  if (!tr || !tr.file_path) return;
  // Build a folder-scoped playlist context so prev/next walks the visible
  // (filtered + sorted) folder track list, not the raw cache.
  const visible = getVisibleFolderTracks();
  const idx = visible.findIndex(x => x.id === trackId);
  playTrack(tr, { source: 'folder', tracks: visible, index: idx >= 0 ? idx : 0 });
}

// Get the currently visible folder tracks (after sort/filter) so prev/next
// behaves the way the user expects given what they see on screen.
function getVisibleFolderTracks() {
  if (!spFvTracks || !spFvTracks.length) return [];
  const q = (document.getElementById('sp-fv-search')?.value || '').toLowerCase().trim();
  const sortKey = document.getElementById('sp-fv-sort')?.value || 'date';
  let visible = spFvTracks;
  if (q) {
    visible = visible.filter(tr => {
      const hay = ((tr.title || '') + ' ' + (tr.file_path || '') + ' ' + (tr.channel || '')).toLowerCase();
      return hay.includes(q);
    });
  }
  visible = visible.slice();
  switch (sortKey) {
    case 'date':     visible.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')); break;
    case 'date-asc': visible.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')); break;
    case 'title':    visible.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'bpm':      visible.sort((a, b) => (a.bpm || 0) - (b.bpm || 0)); break;
    case 'bpm-desc': visible.sort((a, b) => (b.bpm || 0) - (a.bpm || 0)); break;
    case 'key':      visible.sort((a, b) => {
      const ka = (a.key_note || 'Z') + (a.key_mode === 'minor' ? '0' : '1');
      const kb = (b.key_note || 'Z') + (b.key_mode === 'minor' ? '0' : '1');
      return ka.localeCompare(kb);
    }); break;
  }
  return visible;
}

// The actual play logic — single entry point used everywhere.
// `track` must have { id, title, file_path, thumbnail? }.
// `context` is { source: 'folder'|'history'|'analyze', tracks: [...], index: N }.
function playTrack(track, context) {
  if (!track || !track.file_path) return;

  // CRITICAL: transition lock. Spam-clicking history rows / mini-player title
  // can call playTrack() / openInAnalyzer() / loadFromHistory() in parallel.
  // Each starts its own fetch; if one starts the global <audio> before another
  // has stopped the Analyzer's Web Audio source, both ring out simultaneously.
  // The lock is a simple monotonic guard: only one transition runs at a time.
  // Concurrent calls during the lock window are ignored (latest-wins would be
  // worse — it lets stale fetches cancel fresh ones and leave nothing playing).
  if (globalPlayer._transitionLock) {
    return;
  }
  globalPlayer._transitionLock = true;
  // Auto-release after 2s as a safety net (in case of unexpected throws)
  if (globalPlayer._transitionLockTimer) clearTimeout(globalPlayer._transitionLockTimer);
  globalPlayer._transitionLockTimer = setTimeout(() => {
    globalPlayer._transitionLock = false;
  }, 2000);

  // If clicking the same track that's already loaded → toggle play/pause.
  if (globalPlayer.audio && globalPlayer.track && globalPlayer.track.id === track.id) {
    if (globalPlayer.audio.paused) {
      globalPlayer.audio.play().catch(() => {});
    } else {
      globalPlayer.audio.pause();
    }
    updateMiniPlayerPlayState();
    globalPlayer._transitionLock = false;
    return;
  }

  // Different track or first play. Bump the load counter to invalidate any
  // pending callbacks from a previous load (prevents stale 'error' or
  // 'loadedmetadata' events from causing UI flicker).
  globalPlayer.loadCounter++;
  const myLoad = globalPlayer.loadCounter;
  // Store the active load on the audio element itself so event handlers
  // (attached once during initial setup) can compare against the *current*
  // load — closures captured at handler-attach time would only see the
  // first call's myLoad forever, defeating the staleness check.

  // If the Analyze view is currently playing audio, stop it. They share
  // the output device and running both at once was causing freezes.
  // CRITICAL: clear srcNode.onended FIRST so the trailing 'ended' event
  // (which fires async after srcNode.stop()) doesn't call hideAnalyzeMirror
  // and yank the mini player out from under us right as we're showing it.
  if (typeof playing !== 'undefined' && playing && typeof stopAudio === 'function') {
    try {
      if (typeof srcNode !== 'undefined' && srcNode) srcNode.onended = null;
      stopAudio();
    } catch {}
  }
  // Also exit mirror mode silently — we're taking over with the global player
  if (typeof analyzeMirrorActive !== 'undefined' && analyzeMirrorActive) {
    analyzeMirrorActive = false;
    if (typeof analyzeMirrorRaf !== 'undefined' && analyzeMirrorRaf) {
      cancelAnimationFrame(analyzeMirrorRaf);
      analyzeMirrorRaf = null;
    }
    const player = document.getElementById('sp-fv-mini-player');
    if (player) player.removeAttribute('data-mirror');
  }

  // Tear down existing playback cleanly. Pausing first lets the browser
  // close the in-flight HTTP stream gracefully (avoids the rapid-fire
  // ECANCELED errors that were thrashing the server log).
  // We set a flag so the 'error' event triggered by removeAttribute('src')
  // is ignored — that's a teardown artifact, not a real audio error.
  if (globalPlayer.audio) {
    globalPlayer._tearingDown = true;
    try { globalPlayer.audio.pause(); } catch {}
    try { globalPlayer.audio.removeAttribute('src'); globalPlayer.audio.load(); } catch {}
    globalPlayer._tearingDown = false;
  }

  // Lazily create the audio element once. We attach listeners that check
  // globalPlayer._currentLoad to detect stale callbacks. (We can't use a
  // closure-captured myLoad because the handler is attached only on first
  // creation — that closure would freeze its myLoad value forever.)
  if (!globalPlayer.audio) {
    globalPlayer.audio = new Audio();
    globalPlayer.audio.preload = 'metadata';
    globalPlayer.audio.addEventListener('ended', () => {
      // Shuffle + loop modes decide what's next. If nothing's next, stop.
      if (!pickNextTrackAfterEnd()) stopGlobalPlay();
    });
    globalPlayer.audio.addEventListener('timeupdate', updateMiniPlayerTime);
    globalPlayer.audio.addEventListener('loadedmetadata', updateMiniPlayerTime);
    globalPlayer.audio.addEventListener('play',  updateMiniPlayerPlayState);
    globalPlayer.audio.addEventListener('pause', updateMiniPlayerPlayState);
    globalPlayer.audio.addEventListener('progress', updateMiniPlayerTime);
    globalPlayer.audio.addEventListener('error', () => {
      // Ignore errors that fire during a teardown (removeAttribute('src') +
      // load() triggers an empty-src error that we don't want surfaced).
      if (globalPlayer._tearingDown) return;
      // If we have no current track loaded, this is a stale event from a
      // previous track that's already been replaced.
      if (!globalPlayer.track) return;
      // Real error on the current track
      showAppNotification('✕ ' + (t('spPreviewError') || 'Cannot play this file'), 'err');
      stopGlobalPlay();
    });
  }

  // Attach the new source. Apply volume BEFORE play() so we don't get a
  // momentary blast of audio at full volume.
  globalPlayer.track = track;
  globalPlayer.context = context || null;
  globalPlayer._currentLoad = myLoad;
  // New track in the mini player → heart must reflect ITS favorite state,
  // not whatever the previous track left behind.
  syncMiniFavHeart();
  globalPlayer.audio.src = API + '/file?path=' + encodeURIComponent(track.file_path);
  applyVolumeToAudio();
  globalPlayer.audio.play().catch(err => {
    // The play() promise rejects when src changes mid-load — that's normal
    // during track-switching, not a real error. Only surface if our load
    // counter is still current AND we still have a track set.
    if (myLoad !== globalPlayer._currentLoad) return;
    if (!globalPlayer.track) return;
    // Common harmless rejection: AbortError when the user spams play. Skip.
    if (err && err.name === 'AbortError') return;
    showAppNotification('✕ ' + err.message, 'err');
  }).finally(() => {
    // Release transition lock once playback actually started (or failed).
    // The play() promise resolves when audio begins; that's the safest
    // point to allow another transition to start.
    globalPlayer._transitionLock = false;
  });

  // Show mini player and populate UI
  showMiniPlayerForTrack(track);
  // Re-render any visible row lists so the playing indicator reflects the
  // new track. Both folder view and history row playing buttons read from
  // globalPlayer.track.id.
  if (spFvFolder) renderFolderTracks();
  if (typeof renderHistory === 'function') {
    try { renderHistory(); } catch {}
  }
}

function showMiniPlayerForTrack(track) {
  const player = document.getElementById('sp-fv-mini-player');
  if (player) player.classList.remove('hidden');
  // Helper: open this track in the Analyzer. If Analyzer already has this
  // track loaded (currentHistId matches), sync the timestamp + playback
  // state from the mini player to the analyzer before switching tabs.
  // Otherwise call the load path that the History → Analyzer flow uses
  // (which goes through loadAudioBuffer and uses the _handoffTime bridge).
  const openInAnalyzer = () => {
    // Same transition lock as playTrack — blocks spam-clicks from kicking
    // off parallel fetches that would double up the audio.
    if (globalPlayer._transitionLock) return;
    globalPlayer._transitionLock = true;
    if (globalPlayer._transitionLockTimer) clearTimeout(globalPlayer._transitionLockTimer);
    globalPlayer._transitionLockTimer = setTimeout(() => {
      globalPlayer._transitionLock = false;
    }, 2000);

    if (track.id && currentHistId == track.id && audioBuf) {
      // Analyzer already has this exact track. Sync state without reloading.
      const wasMiniPlaying = globalPlayer.audio && !globalPlayer.audio.paused;
      const miniTime = globalPlayer.audio ? globalPlayer.audio.currentTime : 0;
      // Stop the mini player to free the audio output for Analyzer.
      // CRITICAL: hard-stop — pause + remove src + load. Just pausing leaves
      // the audio element in a state where it can resume on the next play()
      // call mid-transition.
      if (globalPlayer.audio) {
        try {
          globalPlayer._tearingDown = true;
          globalPlayer.audio.pause();
        } catch {}
      }
      // Stop any in-flight Analyzer playback so we can re-seek cleanly.
      // stopAudio already disconnects srcNode immediately (post-13q fix).
      if (typeof playing !== 'undefined' && playing && typeof stopAudio === 'function') {
        try { stopAudio(); } catch {}
      }
      // Seek Analyzer to the mini player's position
      if (isFinite(miniTime) && miniTime > 0 && miniTime < audioBuf.duration - 0.5) {
        pauseOff = miniTime;
        if (typeof resetProg === 'function') resetProg();
        document.getElementById('ttime').textContent =
          fmt2time(pauseOff) + ' / ' + fmt2time(audioBuf.duration);
      }
      // Switch to the Analyzer tab
      const tab = document.querySelector('.nav-btn[data-tab="analyze"]');
      if (tab) showTab(tab);
      if (globalPlayer.audio) globalPlayer._tearingDown = false;
      // If mini was playing, kick the Analyzer to play from the synced position.
      // Deferred one frame so DOM updates from showTab settle before audio starts.
      if (wasMiniPlaying) {
        requestAnimationFrame(() => {
          if (typeof startAudio === 'function' && !playing) {
            try { startAudio(); } catch {}
          }
          globalPlayer._transitionLock = false;
        });
      } else {
        globalPlayer._transitionLock = false;
      }
      return;
    }
    // Different track or no audioBuf yet — full reload via loadFromHistory.
    // The _handoffTime bridge in loadAudioBuffer will sync the timestamp.
    if (track.id) {
      if (typeof folderViewOpenAnalysis === 'function' && spFvFolder) {
        folderViewOpenAnalysis(track.id);
      } else if (typeof loadFromHistory === 'function') {
        loadFromHistory(track.id);
      }
      // Note: lock will be released by loadAudioBuffer's own .finally hook
      // (added below). If loadFromHistory bails before reaching loadAudioBuffer,
      // the 2-second safety timer will release it.
    } else {
      globalPlayer._transitionLock = false;
    }
  };
  const titleEl = document.getElementById('sp-fv-mini-title');
  if (titleEl) {
    titleEl.textContent = track.title ||
      (track.file_path || '').split(/[/\\]/).pop() || '?';
    titleEl.style.cursor = 'pointer';
    titleEl.title = t('spJumpToAnalyze') || 'Open in Analyzer';
    titleEl.onclick = openInAnalyzer;
  }
  // Also make the thumbnail clickable so the whole left side opens analyzer
  const thumbWrap = document.getElementById('sp-fv-mini-thumb');
  if (thumbWrap) {
    thumbWrap.style.cursor = 'pointer';
    thumbWrap.title = t('spJumpToAnalyze') || 'Open in Analyzer';
    thumbWrap.onclick = openInAnalyzer;
  }
  const subEl = document.getElementById('sp-fv-mini-sub');
  if (subEl) {
    const sub = [
      track.bpm ? Math.round(track.bpm) + ' BPM' : null,
      (track.key_note ? (track.key_note + ' ' + (track.key_mode || '')).trim() : null),
    ].filter(Boolean).join(' · ');
    subEl.textContent = sub;
    subEl.style.cursor = 'pointer';
    subEl.onclick = openInAnalyzer;
  }
  // Thumbnail image (set after onclick so the img inherits parent's handler)
  if (thumbWrap) {
    const url = track.thumbnail || '';
    if (url) {
      thumbWrap.innerHTML =
        '<img src="' + url.replace(/"/g, '&quot;') +
        '" onerror="this.parentElement.innerHTML=\'<span class=&quot;sp-fv-mini-thumb-fallback&quot;>♪</span>\'"/>';
    } else {
      thumbWrap.innerHTML = '<span class="sp-fv-mini-thumb-fallback">♪</span>';
    }
  }
  // Wire drag handlers (idempotent)
  spFvSeekDragSetup();
  spFvVolumeDragSetup();
  updateVolumeUI();
  updatePrevNextButtons();
  // Heart state for current track
  updateFavoriteUI(track.id, !!track.is_favorite);
  // Apply persisted shuffle/loop button states (idempotent)
  applyModeButtonStates();
  // If notepad is open, switch it to the new track's notes
  const pad = document.getElementById('sp-fv-mini-notepad');
  if (pad && !pad.classList.contains('hidden')) loadMiniNotepad(track.id);
  // Reset seek bar to 0 visually until metadata loads
  const fill  = document.getElementById('sp-fv-mini-seek-fill');
  const thumb = document.getElementById('sp-fv-mini-seek-thumb');
  if (fill)  fill.style.width  = '0%';
  if (thumb) thumb.style.left  = '0%';
  // Wire OS-level media keys (play/pause, forward, backward) so headphone
  // buttons and keyboard media keys control the global player.
  setupMediaSessionForTrack(track);
}

// MediaSession API — exposes the current track to the OS so that physical
// media keys (Play/Pause, Next, Previous) and Bluetooth headphone buttons
// control the global player. Only needs setting up once per track.
function setupMediaSessionForTrack(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Untitled',
      artist: track.channel || '',
      album: 'Freq.Phull',
      artwork: track.thumbnail ? [
        { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => {
      if (globalPlayer.audio && globalPlayer.audio.paused) {
        globalPlayer.audio.play().catch(() => {});
      }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (globalPlayer.audio && !globalPlayer.audio.paused) {
        globalPlayer.audio.pause();
      }
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => globalPlayerPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => globalPlayerNext());
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      if (!globalPlayer.audio || !isFinite(globalPlayer.audio.duration)) return;
      const offset = details.seekOffset || 5;
      globalPlayer.audio.currentTime = Math.max(0, globalPlayer.audio.currentTime - offset);
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      if (!globalPlayer.audio || !isFinite(globalPlayer.audio.duration)) return;
      const offset = details.seekOffset || 5;
      globalPlayer.audio.currentTime = Math.min(globalPlayer.audio.duration, globalPlayer.audio.currentTime + offset);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (!globalPlayer.audio || !isFinite(globalPlayer.audio.duration)) return;
      if (details.seekTime !== undefined) {
        globalPlayer.audio.currentTime = Math.max(0, Math.min(globalPlayer.audio.duration, details.seekTime));
      }
    });
    navigator.mediaSession.setActionHandler('stop', () => stopGlobalPlay());
  } catch (e) {
    // Some action handlers aren't supported on every platform; ignore failures
  }
}

function updatePrevNextButtons() {
  const prevBtn = document.getElementById('sp-fv-mini-prev');
  const nextBtn = document.getElementById('sp-fv-mini-next');
  const ctx = globalPlayer.context;
  const hasList = ctx && ctx.tracks && ctx.tracks.length > 1;
  if (prevBtn) prevBtn.disabled = !hasList || ctx.index <= 0;
  if (nextBtn) nextBtn.disabled = !hasList || ctx.index >= ctx.tracks.length - 1;
}

// v0.2.5: scroll the currently-active history row into view so
// pressing ←/→ for prev/next never strands the user looking at the
// wrong list location. No-op if no matching row is visible (we're
// on a different tab) or if the row is already in view.
// v0.2.6: respect the mini player's scroll-lock toggle. When the user
// turns it OFF, they're explicitly opting to keep browsing History
// while skipping tracks in the background — don't yank the scroll.
function scrollLockEnabled() {
  // Stored as '0' for OFF; anything else (including absent) means ON.
  return localStorage.getItem('freqphull.scrollLock') !== '0';
}

function _scrollActiveRowIntoView() {
  if (!scrollLockEnabled()) return;
  let id = null;
  if (analyzeMirrorActive && currentHistId) id = currentHistId;
  else if (globalPlayer && globalPlayer.track && globalPlayer.track.id) id = globalPlayer.track.id;
  if (!id) return;
  const row = document.querySelector('.hist-row[data-id="' + id + '"]');
  if (!row) return;
  const container = document.getElementById('main');
  if (!container) return;
  const r = row.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  // Only scroll if the row is outside the comfortable middle band.
  // Bottom margin is taller (200) so the mini player + the row below
  // stay visible as users keep tapping →.
  if (r.top < c.top + 80 || r.bottom > c.bottom - 200) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      row.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    } catch {
      row.scrollIntoView();
    }
  }
}

function globalPlayerPrev() {
  // Mirror mode: walk the Analyzer playlist (set by playFromHistory). The
  // Analyzer remains the audio source — we just swap the loaded track.
  if (analyzeMirrorActive) {
    if (!analyzePlaylist || !analyzePlaylist.tracks || analyzePlaylist.index <= 0) {
      showAppNotification(t('miniNoPrev') || 'No previous track', 'info');
      return;
    }
    const prevIdx = analyzePlaylist.index - 1;
    const prevTrack = analyzePlaylist.tracks[prevIdx];
    analyzePlaylist.index = prevIdx;
    // Force handoff resume so Analyzer keeps playing the new track
    if (typeof globalPlayer !== 'undefined') {
      globalPlayer._handoffWasPlaying = true;
      globalPlayer._handoffTime = 0;
    }
    loadFromHistory(prevTrack.id, { skipTabSwitch: true });
    // Defer the scroll one rAF so loadFromHistory has set currentHistId
    // (which our helper reads) before we ask which row to scroll to.
    requestAnimationFrame(_scrollActiveRowIntoView);
    return;
  }
  const ctx = globalPlayer.context;
  if (!ctx || !ctx.tracks || ctx.index <= 0) return;
  const prevIdx = ctx.index - 1;
  playTrack(ctx.tracks[prevIdx], { ...ctx, index: prevIdx });
  requestAnimationFrame(_scrollActiveRowIntoView);
}
function globalPlayerNext() {
  // Mirror mode: walk the Analyzer playlist (set by playFromHistory). The
  // Analyzer remains the audio source — we just swap the loaded track.
  if (analyzeMirrorActive) {
    if (!analyzePlaylist || !analyzePlaylist.tracks || analyzePlaylist.tracks.length === 0) {
      showAppNotification(t('miniNoNext') || 'No next track', 'info');
      return;
    }
    let nextIdx;
    if (shuffleMode && analyzePlaylist.tracks.length > 1) {
      // Random pick — avoid the current track so we always move
      do { nextIdx = Math.floor(Math.random() * analyzePlaylist.tracks.length); }
      while (nextIdx === analyzePlaylist.index);
    } else {
      nextIdx = analyzePlaylist.index + 1;
      if (nextIdx >= analyzePlaylist.tracks.length) {
        if (loopMode === 'playlist') {
          nextIdx = 0;
        } else {
          showAppNotification(t('miniNoNext') || 'End of playlist', 'info');
          return;
        }
      }
    }
    const nextTrack = analyzePlaylist.tracks[nextIdx];
    analyzePlaylist.index = nextIdx;
    if (typeof globalPlayer !== 'undefined') {
      globalPlayer._handoffWasPlaying = true;
      globalPlayer._handoffTime = 0;
    }
    loadFromHistory(nextTrack.id, { skipTabSwitch: true });
    requestAnimationFrame(_scrollActiveRowIntoView);
    return;
  }
  const ctx = globalPlayer.context;
  if (!ctx || !ctx.tracks || ctx.index >= ctx.tracks.length - 1) return;
  const nextIdx = ctx.index + 1;
  playTrack(ctx.tracks[nextIdx], { ...ctx, index: nextIdx });
}

// ── Mini player modes: shuffle + loop ──────────────────────────────────────
// shuffleMode: when on, next-track picks a random index from the playlist
//              instead of incrementing. The original "linear" index is
//              ignored. Doesn't repeat the current track.
// loopMode:    'none' = stop at end of playlist
//              'track' = repeat the current track forever
//              'playlist' = wrap to first track when last ends
// Both modes persist in localStorage across sessions.
let shuffleMode = (localStorage.getItem('hk_shuffle') === '1');
let loopMode = localStorage.getItem('hk_loop') || 'none';

function applyModeButtonStates() {
  const shuf = document.getElementById('sp-fv-mini-shuffle');
  if (shuf) shuf.classList.toggle('on', shuffleMode);
  const loop = document.getElementById('sp-fv-mini-loop');
  if (loop) {
    loop.classList.toggle('on', loopMode !== 'none');
    // The "track-loop" state shows a tiny "1" badge by swapping the SVG
    if (loopMode === 'track') {
      loop.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="11" y="14" font-family="Inter" font-size="7" fill="currentColor" stroke="none" text-anchor="middle" font-weight="700">1</text></svg>';
    } else {
      loop.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
    }
  }
}

function toggleShuffleMode() {
  shuffleMode = !shuffleMode;
  localStorage.setItem('hk_shuffle', shuffleMode ? '1' : '0');
  applyModeButtonStates();
  showAppNotification(shuffleMode ? '🔀 ' + (t('miniShuffleOn') || 'Shuffle on') : (t('miniShuffleOff') || 'Shuffle off'), 'info');
}
function toggleLoopMode() {
  // Cycle: none → playlist → track → none
  loopMode = (loopMode === 'none') ? 'playlist' : (loopMode === 'playlist') ? 'track' : 'none';
  localStorage.setItem('hk_loop', loopMode);
  applyModeButtonStates();
  const msgs = {
    none: t('miniLoopOff') || 'Loop off',
    playlist: t('miniLoopPlaylist') || 'Loop playlist',
    track: t('miniLoopTrack') || 'Loop track',
  };
  showAppNotification('⟲ ' + msgs[loopMode], 'info');
}

// Called by the 'ended' event on globalPlayer.audio. Decides what plays next
// based on shuffle + loop state. Returns true if it kicked off another
// track; false if playback should fully stop.
function pickNextTrackAfterEnd() {
  const ctx = globalPlayer.context;
  // Track loop: same track again
  if (loopMode === 'track' && globalPlayer.track) {
    if (globalPlayer.audio) {
      globalPlayer.audio.currentTime = 0;
      globalPlayer.audio.play().catch(() => {});
      return true;
    }
  }
  if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return false;
  let nextIdx;
  if (shuffleMode && ctx.tracks.length > 1) {
    // Random pick that isn't the current index
    do { nextIdx = Math.floor(Math.random() * ctx.tracks.length); }
    while (nextIdx === ctx.index);
  } else {
    nextIdx = ctx.index + 1;
    if (nextIdx >= ctx.tracks.length) {
      if (loopMode === 'playlist') nextIdx = 0;
      else return false;
    }
  }
  playTrack(ctx.tracks[nextIdx], { ...ctx, index: nextIdx });
  return true;
}

// Resolve the currently-displayed mini-player track regardless of which
// playback path is active:
//   • Legacy mode → globalPlayer.track is an object with id + metadata
//   • Mirror mode → track is loaded into the Analyzer; identified by
//     currentHistId; metadata lives in histData
// Returns null if nothing is loaded. Centralizing this here means every
// mini-player action (favorite, notepad, etc.) handles both modes the
// same way without each function reimplementing the check.
function getMiniPlayerTrack() {
  if (globalPlayer && globalPlayer.track && globalPlayer.track.id) {
    return globalPlayer.track;
  }
  if (analyzeMirrorActive && typeof currentHistId !== 'undefined' && currentHistId &&
      Array.isArray(histData)) {
    const row = histData.find(h => h.id === currentHistId);
    if (row) return row;
  }
  return null;
}

// Heart click in mini player → toggles favorite on current track
// Scroll-lock toggle (v0.2.6). Persists in localStorage. The icon and
// aria-pressed state are kept in sync with the actual setting on every
// app boot (see syncScrollLockButton below) so the button is correct
// even right after a restart.
function miniPlayerToggleScrollLock() {
  const next = !scrollLockEnabled();
  localStorage.setItem('freqphull.scrollLock', next ? '1' : '0');
  syncScrollLockButton();
  if (typeof showAppNotification === 'function') {
    showAppNotification(next ? t('scrollLockOn') : t('scrollLockOff'), 'info', null, 2200);
  }
}
function syncScrollLockButton() {
  const btn = document.getElementById('sp-fv-mini-scroll-lock');
  if (!btn) return;
  const on = scrollLockEnabled();
  btn.classList.toggle('off', !on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? (t('scrollLockTitleOn') || 'Following — click to browse freely while playing')
                 : (t('scrollLockTitleOff') || 'Browse freely — click to follow the playing track');
  // Swap the icon: solid anchor when locked, broken/slashed anchor when free.
  btn.innerHTML = on
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
         <circle cx="12" cy="5" r="3"/>
         <line x1="12" y1="22" x2="12" y2="8"/>
         <path d="M5 12H2a10 10 0 0 0 20 0h-3"/>
       </svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
         <circle cx="12" cy="5" r="3"/>
         <line x1="12" y1="22" x2="12" y2="8"/>
         <path d="M5 12H2a10 10 0 0 0 20 0h-3"/>
         <!-- diagonal slash signaling "follow disabled" -->
         <line x1="4" y1="4" x2="20" y2="20" stroke-width="2"/>
       </svg>`;
}
// Boot: ensure the button matches the persisted setting once the DOM
// is ready. Defer one frame so element exists.
requestAnimationFrame(() => { try { syncScrollLockButton(); } catch {} });

function miniPlayerToggleFavorite() {
  const tr = getMiniPlayerTrack();
  if (!tr || !tr.id) {
    showAppNotification(t('miniNoTrack') || 'No track loaded', 'info');
    return;
  }
  toggleFavorite(tr.id);
}

// ── Mini notepad popover ────────────────────────────────────────────────────
// Folds up above the player when toggled. Loads existing user_notes for the
// current track on open; saves on blur. One-track-at-a-time.
function toggleMiniNotepad() {
  const pad = document.getElementById('sp-fv-mini-notepad');
  const btn = document.getElementById('sp-fv-mini-notepad-btn');
  if (!pad) return;
  if (pad.classList.contains('hidden')) {
    const tr = getMiniPlayerTrack();
    if (!tr || !tr.id) {
      showAppNotification(t('miniNoTrack') || 'No track loaded', 'info');
      return;
    }
    loadMiniNotepad(tr.id);
    pad.classList.remove('hidden');
    if (btn) btn.classList.add('on');
    setTimeout(() => document.getElementById('sp-fv-mini-notepad-text')?.focus(), 30);
  } else {
    pad.classList.add('hidden');
    if (btn) btn.classList.remove('on');
  }
}

async function loadMiniNotepad(historyId) {
  const titleEl = document.getElementById('sp-fv-mini-notepad-title');
  // Resolve the track title from whichever data source has it
  const tr = getMiniPlayerTrack();
  if (titleEl && tr) {
    titleEl.textContent = (t('miniNotesFor') || 'Notes —') + ' ' + (tr.title || '').slice(0, 40);
  }
  // Pull fresh notes from server — they may have been edited from elsewhere
  try {
    const r = await fetch(API + '/history');
    const all = await r.json();
    const row = all.find(h => h.id === historyId);
    const txt = document.getElementById('sp-fv-mini-notepad-text');
    if (txt) txt.value = (row && row.user_notes) || '';
    // Store the loaded historyId so saveMiniNotepad knows what to update.
    // We use a data attr because the user might switch tracks while the
    // notepad is open and we want each save to go to the right row.
    if (txt) txt.dataset.historyId = historyId;
  } catch {
    const txt = document.getElementById('sp-fv-mini-notepad-text');
    if (txt) txt.value = '';
  }
}

async function saveMiniNotepad() {
  const txt = document.getElementById('sp-fv-mini-notepad-text');
  if (!txt) return;
  const historyId = parseInt(txt.dataset.historyId || '0', 10);
  if (!historyId) return;
  const notes = txt.value;
  const foot = document.getElementById('sp-fv-mini-notepad-foot');
  if (foot) foot.textContent = (t('miniSaving') || 'Saving…');
  try {
    await fetch(API + '/history/' + historyId + '/user-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    if (foot) foot.textContent = (t('miniSaved') || 'Saved automatically') + ' · ' + new Date().toLocaleTimeString();
    // Also update local cache so a reopened notepad shows the latest
    const row = histData.find(h => h.id === historyId);
    if (row) row.user_notes = notes;
  } catch (e) {
    if (foot) foot.textContent = '✕ ' + e.message;
  }
}

// Stop playback and hide the mini player. Called from × button, on track
// end with no next, or when an unrecoverable error occurs.
function stopGlobalPlay() {
  // If we're in mirror mode (Analyze drives the audio), the × button
  // should pause Analyze and hide the mirror — not stop our own audio.
  if (analyzeMirrorActive) {
    if (typeof playing !== 'undefined' && playing && typeof stopAudio === 'function') {
      try { stopAudio(); } catch {}
    }
    hideAnalyzeMirror();
    return;
  }
  globalPlayer.loadCounter++;  // invalidate any pending callbacks
  if (globalPlayer.audio) {
    try { globalPlayer.audio.pause(); } catch {}
    try { globalPlayer.audio.removeAttribute('src'); globalPlayer.audio.load(); } catch {}
  }
  globalPlayer.track = null;
  globalPlayer.context = null;
  const player = document.getElementById('sp-fv-mini-player');
  if (player) player.classList.add('hidden');
  if (spFvFolder) renderFolderTracks();
  if (typeof renderHistory === 'function') {
    try { renderHistory(); } catch {}
  }
}

// Legacy alias
function folderViewStopPlay() { stopGlobalPlay(); }

function folderViewTogglePlay() {
  // In mirror mode, the mini player drives Analyze playback.
  if (analyzeMirrorActive) {
    if (typeof togglePlay === 'function') togglePlay();
    return;
  }
  if (!globalPlayer.audio) return;
  if (globalPlayer.audio.paused) globalPlayer.audio.play().catch(() => {});
  else globalPlayer.audio.pause();
  updateMiniPlayerPlayState();
}

function updateMiniPlayerPlayState() {
  const toggle = document.getElementById('sp-fv-mini-toggle');
  if (!toggle || !globalPlayer.audio) return;
  const paused = globalPlayer.audio.paused;
  const svg = document.getElementById('sp-fv-mini-toggle-svg');
  if (svg) {
    svg.innerHTML = paused
      ? '<polygon points="7,5 7,19 19,12"/>'   // play triangle
      : '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'; // pause bars
  }
  // Notify OS so taskbar/lock-screen indicator matches
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    }
  } catch {}
}

function updateMiniPlayerTime() {
  if (!globalPlayer.audio) return;
  const audio = globalPlayer.audio;
  const cur = isFinite(audio.currentTime) ? audio.currentTime : 0;
  const dur = isFinite(audio.duration) ? audio.duration : 0;
  const curEl = document.getElementById('sp-fv-mini-time-cur');
  const durEl = document.getElementById('sp-fv-mini-time-dur');
  const fill  = document.getElementById('sp-fv-mini-seek-fill');
  const thumb = document.getElementById('sp-fv-mini-seek-thumb');
  if (curEl) curEl.textContent = fmtSec(cur);
  if (durEl) durEl.textContent = dur > 0 ? fmtSec(dur) : '?:??';
  if (!spFvSeekDragging && dur > 0) {
    const pct = (cur / dur) * 100;
    if (fill)  fill.style.width  = pct + '%';
    if (thumb) thumb.style.left  = pct + '%';
  }
  try {
    if (audio.buffered.length && dur > 0) {
      const buffered = audio.buffered.end(audio.buffered.length - 1);
      const bpct = Math.min(100, (buffered / dur) * 100);
      const bufEl = document.getElementById('sp-fv-mini-seek-buffered');
      if (bufEl) bufEl.style.width = bpct + '%';
    }
  } catch {}
}

// ── Seek bar interaction ──────────────────────────────────────────────────
// Click anywhere on the bar to jump there. Hold-and-drag for fine scrubbing
// (Spotify behavior — we update the visual immediately but only commit the
// audio.currentTime on release).
let spFvSeekDragging = false;

function folderViewSeekClick(evt) {
  if (analyzeMirrorActive && audioBuf) {
    const seek = document.getElementById('sp-fv-mini-seek');
    const rect = seek.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
    const wasPlaying = playing;
    if (playing && typeof stopAudio === 'function') stopAudio();
    pauseOff = pct * audioBuf.duration;
    if (typeof resetProg === 'function') resetProg();
    if (wasPlaying && typeof startAudio === 'function') startAudio();
    return;
  }
  if (!spFvAudio || !isFinite(spFvAudio.duration) || spFvAudio.duration === 0) return;
  const seek = document.getElementById('sp-fv-mini-seek');
  const rect = seek.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  spFvAudio.currentTime = pct * spFvAudio.duration;
  updateMiniPlayerTime();
}

// Wire up drag-to-scrub on mousedown anywhere on the seek bar.
function spFvSeekDragSetup() {
  const seek = document.getElementById('sp-fv-mini-seek');
  if (!seek || seek.dataset.dragWired) return;
  seek.dataset.dragWired = '1';
  seek.addEventListener('mousedown', (e) => {
    // Allow drag whether the global player or the Analyzer (mirror mode)
    // is the audio source. Mirror mode uses audioBuf; global uses spFvAudio.
    const haveMirror = analyzeMirrorActive && audioBuf && isFinite(audioBuf.duration);
    const haveGlobal = spFvAudio && isFinite(spFvAudio.duration) && spFvAudio.duration > 0;
    if (!haveMirror && !haveGlobal) return;
    spFvSeekDragging = true;
    seekPreview(e);
    const onMove = (ev) => seekPreview(ev);
    const onUp = (ev) => {
      seekCommit(ev);
      spFvSeekDragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function seekPreview(evt) {
  // Update visual position only; don't change audio.currentTime yet.
  // Works for both global player (spFvAudio) and mirror mode (Analyzer).
  const seek = document.getElementById('sp-fv-mini-seek');
  if (!seek) return;
  const rect = seek.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  const fill  = document.getElementById('sp-fv-mini-seek-fill');
  const thumb = document.getElementById('sp-fv-mini-seek-thumb');
  if (fill)  fill.style.width = (pct * 100) + '%';
  if (thumb) thumb.style.left = (pct * 100) + '%';
  // Live time preview during drag — show the time we'd seek to, not the
  // current playback time. Use the appropriate duration source.
  const curEl = document.getElementById('sp-fv-mini-time-cur');
  if (curEl) {
    if (analyzeMirrorActive && audioBuf && isFinite(audioBuf.duration)) {
      curEl.textContent = fmtSec(pct * audioBuf.duration);
    } else if (spFvAudio && isFinite(spFvAudio.duration)) {
      curEl.textContent = fmtSec(pct * spFvAudio.duration);
    }
  }
}

function seekCommit(evt) {
  const seek = document.getElementById('sp-fv-mini-seek');
  if (!seek) return;
  const rect = seek.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  // Mirror mode: route to Analyzer's seek. ONE stopAudio + startAudio cycle
  // at mouseup, not on every mousemove. The stale-end-handler bug (token
  // check in startAudio) prevents the old srcNode from clobbering state,
  // but it's still wasteful and audibly chunky to recreate the source on
  // every mousemove. Commit-at-mouseup is also how every DAW does it.
  if (analyzeMirrorActive && audioBuf && isFinite(audioBuf.duration)) {
    const wasPlaying = playing;
    if (playing && typeof stopAudio === 'function') stopAudio();
    pauseOff = pct * audioBuf.duration;
    if (typeof resetProg === 'function') resetProg();
    if (wasPlaying && typeof startAudio === 'function') startAudio();
    return;
  }
  if (!spFvAudio || !isFinite(spFvAudio.duration)) return;
  spFvAudio.currentTime = pct * spFvAudio.duration;
}

// ── Volume control ────────────────────────────────────────────────────────
// Persistent volume saved to localStorage so it survives across sessions.
// Mute toggles via the speaker icon; volume slider drag adjusts in real time.
let spFvVolume = 0.8;        // 0..1
let spFvMutedSaved = 0.8;    // remember pre-mute volume so unmute restores it

function spFvLoadVolume() {
  try {
    const v = parseFloat(localStorage.getItem('spFvVolume'));
    if (isFinite(v) && v >= 0 && v <= 1) spFvVolume = v;
  } catch {}
  return spFvVolume;
}
function spFvSaveVolume(v) {
  spFvVolume = Math.max(0, Math.min(1, v));
  try { localStorage.setItem('spFvVolume', String(spFvVolume)); } catch {}
}

function applyVolumeToAudio() {
  if (!spFvAudio) return;
  spFvAudio.volume = spFvVolume;
}

function updateVolumeUI() {
  const fill  = document.getElementById('sp-fv-mini-volume-fill');
  const thumb = document.getElementById('sp-fv-mini-volume-thumb');
  const btn   = document.getElementById('sp-fv-mini-vol-btn');
  const icon  = document.getElementById('sp-fv-mini-vol-icon');
  const pct = spFvVolume * 100;
  if (fill)  fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';
  if (btn) {
    if (spFvVolume === 0) btn.classList.add('muted');
    else btn.classList.remove('muted');
  }
  // Swap the icon glyph based on volume level — gives a quick visual cue
  if (icon) {
    if (spFvVolume === 0) {
      icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
    } else if (spFvVolume < 0.4) {
      icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/>';
    } else if (spFvVolume < 0.75) {
      icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    } else {
      icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
    }
  }
}

function folderViewVolumeClick(evt) {
  const vol = document.getElementById('sp-fv-mini-volume');
  if (!vol) return;
  const rect = vol.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  if (analyzeMirrorActive) {
    // Map the 0-1 click position to the new 0-130 slider domain
    // (100 = unity, 130 = +6 dB boost). setVolume() handles the dB taper
    // and the visual sync of both displays.
    if (typeof setVolume === 'function') setVolume(Math.round(pct * 130));
    return;
  }
  spFvSaveVolume(pct);
  applyVolumeToAudio();
  updateVolumeUI();
}

function spFvVolumeDragSetup() {
  const vol = document.getElementById('sp-fv-mini-volume');
  if (!vol || vol.dataset.dragWired) return;
  vol.dataset.dragWired = '1';
  vol.addEventListener('mousedown', (e) => {
    const onMove = (ev) => folderViewVolumeClick(ev);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    folderViewVolumeClick(e);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function folderViewToggleMute() {
  // In mirror mode, route mute to the Analyzer volume so it doesn't fight
  // with the global player state. setVolume() handles BOTH the audio gain
  // AND the mini-player visual sync internally (via _syncMiniPlayerVolumeBar),
  // so the previous duplicated icon/fill/thumb updates here are gone.
  if (analyzeMirrorActive) {
    const slider = document.getElementById('vol-slider');
    const currentVol = slider ? parseFloat(slider.value) : 100;
    if (currentVol > 0) {
      // Save current level and mute
      spFvMutedSaved = currentVol / 100;
      if (typeof setVolume === 'function') setVolume(0);
    } else {
      // Unmute to remembered level (or 80% if never set)
      const restore = (spFvMutedSaved > 0 ? spFvMutedSaved : 0.8) * 100;
      if (typeof setVolume === 'function') setVolume(Math.round(restore));
    }
    return;
  }
  if (spFvVolume > 0) {
    spFvMutedSaved = spFvVolume > 0 ? spFvVolume : 0.8;
    spFvSaveVolume(0);
  } else {
    spFvSaveVolume(spFvMutedSaved > 0 ? spFvMutedSaved : 0.8);
  }
  applyVolumeToAudio();
  updateVolumeUI();
}

// Initial volume load happens on first DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  spFvLoadVolume();
  // Wire up drag handlers — these are only created once even though the
  // mini player can show/hide many times.
  spFvSeekDragSetup();
  spFvVolumeDragSetup();
  updateVolumeUI();

  // NUCLEAR FOCUS-RING KILL: intercept mousedown in the capture phase on
  // the mini player and call preventDefault on every button click. This
  // stops the browser from EVER assigning focus to mini-player buttons,
  // which means the blue focus ring (which appears the instant focus
  // lands, separately from CSS `outline`) is never drawn in the first
  // place. CSS-only suppression doesn't catch every Electron build's
  // ring — this is the only approach that works universally.
  const player = document.getElementById('sp-fv-mini-player');
  if (player) {
    player.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) {
        e.preventDefault();  // skip focus assignment entirely
      }
    }, true);  // capture phase so it runs before any default focus logic
  }
});

// Global keyboard shortcuts that apply across the whole app (not just
// when the mini player is open). Tab back/forward navigation works
// anywhere, anytime — like browser shortcuts.
window.addEventListener('keydown', (e) => {
  // Don't capture while typing
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
  // Ctrl+Alt+← → Back / Ctrl+Alt+→ → Forward
  if (e.code === 'ArrowLeft' && e.altKey && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    tabHistoryBack();
  } else if (e.code === 'ArrowRight' && e.altKey && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    tabHistoryForward();
  }
});

// Keyboard shortcuts when the mini player is active. Skip if a text input
// has focus so we don't hijack typing.
//
// Two playback modes need handling:
//   • Mirror mode: audio runs through the Analyzer (Web Audio API).
//     globalPlayer.audio is null. Spacebar → startAudio/stopAudio.
//     Seek arrows → adjust pauseOff via stop+startAudio.
//   • Legacy mode: audio runs through an HTMLAudioElement in globalPlayer.audio.
//     Spacebar → audio.play()/.pause(). Seek arrows → audio.currentTime.
//
// The old check `if (!globalPlayer.audio || !globalPlayer.track) return` killed
// shortcuts in mirror mode entirely — the spacebar bug Real reported.
window.addEventListener('keydown', (e) => {
  // DAW overlay owns the keyboard when open — don't fire global shortcuts.
  if (document.getElementById('daw-overlay')) return;
  const player = document.getElementById('sp-fv-mini-player');
  if (!player || player.classList.contains('hidden')) return;
  // Don't capture keystrokes while user is typing
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;

  // Detect which audio path is active
  const isMirror = analyzeMirrorActive && audioBuf;
  const isLegacy = !!(globalPlayer.audio && globalPlayer.track);
  if (!isMirror && !isLegacy) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (isMirror) {
      // Toggle the Analyzer playback directly. folderViewTogglePlay is the
      // stockpile-folder preview player — not what we want here.
      if (playing) {
        if (typeof stopAudio === 'function') stopAudio();
      } else {
        if (typeof startAudio === 'function') startAudio();
      }
    } else {
      folderViewTogglePlay();
    }
  } else if (e.code === 'ArrowLeft' && e.altKey) {
    // Alt+← seeks back 5s
    e.preventDefault();
    if (isMirror) {
      const cur = playing ? (pauseOff + (audioCtx.currentTime - startT)) : pauseOff;
      const newPos = Math.max(0, cur - 5);
      if (playing) {
        if (srcNode) { srcNode.onended = null; try { srcNode.stop(); } catch {} srcNode = null; }
        playing = false; cancelAnimationFrame(rafId); stopVU();
        pauseOff = newPos;
        if (typeof startAudio === 'function') startAudio();
      } else {
        pauseOff = newPos;
      }
    } else if (isFinite(globalPlayer.audio.duration)) {
      globalPlayer.audio.currentTime = Math.max(0, globalPlayer.audio.currentTime - 5);
      updateMiniPlayerTime();
    }
  } else if (e.code === 'ArrowRight' && e.altKey) {
    e.preventDefault();
    if (isMirror) {
      const cur = playing ? (pauseOff + (audioCtx.currentTime - startT)) : pauseOff;
      const newPos = Math.min(audioBuf.duration - 0.05, cur + 5);
      if (playing) {
        if (srcNode) { srcNode.onended = null; try { srcNode.stop(); } catch {} srcNode = null; }
        playing = false; cancelAnimationFrame(rafId); stopVU();
        pauseOff = newPos;
        if (typeof startAudio === 'function') startAudio();
      } else {
        pauseOff = newPos;
      }
    } else if (isFinite(globalPlayer.audio.duration)) {
      globalPlayer.audio.currentTime = Math.min(globalPlayer.audio.duration, globalPlayer.audio.currentTime + 5);
      updateMiniPlayerTime();
    }
  } else if (e.code === 'ArrowLeft' && !e.altKey && !e.shiftKey) {
    // ← jumps to previous track (v0.2.4: was Ctrl+← only; promoted to
    // bare ← because that's what users actually expect from a media
    // player. Alt+← still seeks back 5s — handled above.)
    e.preventDefault();
    globalPlayerPrev();
  } else if (e.code === 'ArrowRight' && !e.altKey && !e.shiftKey) {
    // → jumps to next track (same promotion as ArrowLeft above).
    e.preventDefault();
    globalPlayerNext();
  }
});

async function folderViewUntag(trackId) {
  if (!spFvFolder) return;
  const ok = await confirmModal({
    title: 'Remove track from folder?',
    message: t('spConfirmUntag') || 'This removes the track from this folder. The audio file on disk is not deleted.',
    okLabel: 'Remove',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    const root = stockpileFolder ? '?stockpile_root=' + encodeURIComponent(stockpileFolder) : '';
    await fetch(API + '/stockpile/tracks/' + trackId + '/tags/' + spFvFolder.id + root, { method: 'DELETE' });
    // Stop preview if this is the playing track
    if (spFvAudioTrackId === trackId) folderViewStopPlay();
    // Remove from cached list and re-render
    spFvTracks = spFvTracks.filter(x => x.id !== trackId);
    spFvFolder.track_count = Math.max(0, (spFvFolder.track_count || 0) - 1);
    document.getElementById('sp-fv-meta').textContent =
      `${spFvFolder.track_count} ${spFvFolder.track_count === 1 ? t('spTrack') : t('spTracks')}`;
    renderFolderTracks();
    showAppNotification('✓ ' + (t('spUntagged') || 'Removed from folder'), 'ok');
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

async function folderViewRetag(trackId) {
  // Open the existing tag picker — it shows all folders and applies new
  // primary tag. After they pick, refresh the list (the track may no longer
  // be in this folder, depending on whether the new pick replaced or added).
  await openTagPicker(trackId);
  // We can't await the user's choice; refresh after a delay as a fallback.
  // The picker also calls quickTag which calls loadStockpile when on dashboard;
  // we need our own refresh here.
  setTimeout(async () => {
    if (!spFvFolder) return;
    try {
      const r = await fetch(API + '/stockpile/folders/' + spFvFolder.id + '/tracks');
      const j = await r.json();
      spFvTracks = j.tracks || [];
      renderFolderTracks();
    } catch {}
  }, 1500);
}

function folderViewOpenInExplorer(trackId) {
  const tr = spFvTracks.find(x => x.id === trackId);
  if (!tr || !tr.file_path) return;
  // Verify file exists, then ask main process to reveal it
  fetch(API + '/path-exists?path=' + encodeURIComponent(tr.file_path))
    .then(r => r.json())
    .then(j => {
      if (!j.exists) {
        showAppNotification('✕ ' + (t('spFileMissing') || 'File no longer exists at') + ' ' + tr.file_path, 'err');
        return;
      }
      if (api.openPath) api.openPath(tr.file_path);
    })
    .catch(() => {
      if (api.openPath) api.openPath(tr.file_path);
    });
}

// Open the full analyze view for a track. Reuses loadFromHistory which
// loads the audio buffer, populates the waveform, runs analyze if needed,
// and switches to the Analyze tab. We stop folder preview audio so the
// two players don't fight over the speakers.
async function folderViewOpenAnalysis(trackId) {
  const tr = spFvTracks.find(x => x.id === trackId);
  if (!tr) return;

  // Stop folder preview before opening the heavier analyze view
  folderViewStopPlay();

  // loadFromHistory looks up the row in histData. If we never visited the
  // History tab this session, that array may be empty — populate it first.
  if (!histData || !histData.length) {
    try {
      histData = await (await fetch(API + '/history')).json();
    } catch {
      histData = [];
    }
  }

  // Sanity: if the track isn't in histData (DB out of sync?), inject the
  // folder-view row's data so loadFromHistory has something to work with.
  if (!histData.find(h => h.id === trackId)) {
    histData.push({
      id: tr.id,
      title: tr.title,
      file_path: tr.file_path,
      duration: tr.duration,
      bpm: tr.bpm,
      key_note: tr.key_note,
      key_mode: tr.key_mode,
      thumbnail: tr.thumbnail || '',
      notes: tr.notes || '',
      transcript: tr.transcript || '',
    });
  }

  // loadFromHistory does the actual heavy lifting: switches tab, loads
  // audio, runs analyze.py if needed.
  await loadFromHistory(trackId);
}

function openMatchPreviewFromView() {
  if (!spFvFolder) return;
  openMatchPreview(spFvFolder.id);
  // After bulk-tag closes, our list will be stale; refresh after a delay.
  setTimeout(async () => {
    if (!spFvFolder) return;
    try {
      const r = await fetch(API + '/stockpile/folders/' + spFvFolder.id + '/tracks');
      const j = await r.json();
      spFvTracks = j.tracks || [];
      // Also update the folder count on the header
      spFvFolder.track_count = spFvTracks.length;
      document.getElementById('sp-fv-meta').textContent =
        `${spFvTracks.length} ${spFvTracks.length === 1 ? t('spTrack') : t('spTracks')}`;
      renderFolderTracks();
    } catch {}
  }, 2000);
}

function editFolderFromView() {
  if (!spFvFolder) return;
  editFolder(spFvFolder.id);
}

// New-folder modal
function openCreateFolderDialog(prefilled) {
  const modal = document.getElementById('sp-new-folder-modal');
  if (!modal) return;
  document.getElementById('sp-modal-name').value  = (prefilled && prefilled.name) || '';
  document.getElementById('sp-modal-desc').value  = (prefilled && prefilled.description) || '';
  document.getElementById('sp-modal-seeds').value = (prefilled && prefilled.artist_seeds) || '';
  modal.dataset.editId = (prefilled && prefilled.id) || '';
  document.getElementById('sp-modal-title').textContent = prefilled ? t('spEditFolder') : t('spNewFolder');
  document.getElementById('sp-modal-create').textContent = prefilled ? t('spSave') : t('spCreate');
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('sp-modal-name').focus(), 50);
}

function closeCreateFolderDialog() {
  const modal = document.getElementById('sp-new-folder-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitCreateFolder() {
  const name = document.getElementById('sp-modal-name').value.trim();
  const desc = document.getElementById('sp-modal-desc').value.trim();
  const seeds = document.getElementById('sp-modal-seeds').value.trim();
  const editId = document.getElementById('sp-new-folder-modal').dataset.editId;

  if (!name) {
    showAppNotification('✕ ' + t('spNameRequired'), 'err');
    return;
  }

  try {
    const url = editId ? API + '/stockpile/folders/' + editId : API + '/stockpile/folders';
    const method = editId ? 'PUT' : 'POST';
    const r = await fetch(url, {
      method,
      headers: {'Content-Type': 'application/json'},
      // stockpile_root is only meaningful on PUT (rename triggers an
      // on-disk folder rename + history.file_path updates). Sending it
      // on POST is harmless — the create endpoint ignores it.
      body: JSON.stringify({
        name, description: desc, artist_seeds: seeds,
        stockpile_root: stockpileFolder || undefined,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    closeCreateFolderDialog();
    // Suggestions cache must be flushed — new folder might match existing untagged tracks.
    spSuggestionsByTrack = {};

    const folderId = (j.folder && j.folder.id) || (editId ? parseInt(editId, 10) : null);
    showAppNotification('✓ ' + (editId ? t('spFolderSaved') : t('spFolderCreated')), 'ok');

    // If seeds were provided AND this is a folder create (or seeds were
    // edited), check for matching untagged tracks and offer bulk-tag.
    if (seeds && folderId) {
      // Slight delay so the create-success toast is visible briefly first.
      setTimeout(() => openMatchPreview(folderId), 350);
    } else {
      loadStockpile();
    }
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

async function editFolder(id) {
  const f = spFolders.find(x => x.id === id);
  if (!f) return;
  openCreateFolderDialog(f);
}

async function deleteFolder(id) {
  const f = spFolders.find(x => x.id === id);
  if (!f) return;
  const msg = (f.track_count > 0)
    ? t('spDeleteFolderWithTracks').replace('{n}', f.track_count).replace('{name}', f.name)
    : t('spDeleteFolder').replace('{name}', f.name);
  const ok = await confirmModal({
    title: 'Delete folder?',
    message: msg,
    okLabel: 'Delete folder',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    // Send stockpile_root so the backend can move any files currently
    // living inside this folder's dir back to the stockpile root before
    // dropping the folder. Otherwise tracks would be "orphaned" — their
    // file_path would still point inside a directory that's about to be
    // empty (or removed). Files are never deleted, only relocated.
    const root = stockpileFolder ? '?stockpile_root=' + encodeURIComponent(stockpileFolder) : '';
    const r = await fetch(API + '/stockpile/folders/' + id + root, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed');
    spSuggestionsByTrack = {};
    loadStockpile();
    showAppNotification('✓ ' + t('spFolderDeleted'), 'ok');
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// Helper used in many places — escape HTML for safe insertion.
// The app already has escapeHtml defined elsewhere; this is a fallback.
if (typeof escapeHtml !== 'function') {
  window.escapeHtml = function(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
}


// ── Bulk match / auto-tag ────────────────────────────────────────────────────
// Given a folder, fetch every untagged track that matches its seeds (filename
// artist match) or its mood centroid, and offer one-click bulk tagging.
// Triggered after folder creation if seeds were given, or via the ⚡ button
// on each folder card.

async function openMatchPreview(folderId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'sp-match-modal';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-card" style="width:min(620px,94vw);max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-title" id="sp-match-title">${t('spFindingMatches')}</div>
      <div id="sp-match-body" style="flex:1;overflow-y:auto;min-height:120px">
        <div style="text-align:center;padding:32px;color:var(--muted)">
          <div style="font-size:13px">${t('spScanning')}</div>
        </div>
      </div>
      <div class="modal-actions" id="sp-match-actions">
        <button class="btn" onclick="document.getElementById('sp-match-modal').remove(); loadStockpile()" id="sp-match-close">${t('spClose')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  try {
    const r = await fetch(API + '/stockpile/folders/' + folderId + '/matches?min_confidence=0.4');
    const j = await r.json();
    renderMatchPreview(folderId, j);
  } catch (e) {
    document.getElementById('sp-match-body').innerHTML =
      `<div style="text-align:center;padding:24px;color:#ff8888">✕ ${escapeHtml(e.message)}</div>`;
  }
}

function renderMatchPreview(folderId, data) {
  const titleEl = document.getElementById('sp-match-title');
  const body = document.getElementById('sp-match-body');
  const actions = document.getElementById('sp-match-actions');
  if (!body || !data) return;

  const folderName = (data.folder && data.folder.name) || '?';
  titleEl.innerHTML = `${t('spMatchesFor')} <strong style="color:#7ed982">${escapeHtml(folderName)}</strong>`;

  if (!data.matches || !data.matches.length) {
    body.innerHTML = `
      <div style="text-align:center;padding:32px;color:var(--muted)">
        <div style="font-size:14px;margin-bottom:8px">${t('spNoMatchesYet')}</div>
        <div style="font-size:11px;color:var(--hint);max-width:380px;margin:0 auto;line-height:1.5">${t('spNoMatchesHint')}</div>
      </div>
    `;
    actions.innerHTML = `<button class="btn" onclick="document.getElementById('sp-match-modal').remove(); loadStockpile()">${t('spClose')}</button>`;
    return;
  }

  // Group: artist matches (high conf) vs mood matches (lower conf).
  const artistMatches = data.matches.filter(m => m.match_type === 'artist');
  const moodMatches   = data.matches.filter(m => m.match_type === 'mood');

  // State: which tracks are checked. Default = all artist matches checked,
  // mood matches above 0.5 checked.
  if (!window.spMatchSelection) window.spMatchSelection = {};
  window.spMatchSelection[folderId] = window.spMatchSelection[folderId] || new Set();
  const sel = window.spMatchSelection[folderId];
  for (const m of artistMatches) sel.add(m.id);
  for (const m of moodMatches) if (m.confidence >= 0.5) sel.add(m.id);

  const renderRow = (m) => {
    const isOn = sel.has(m.id) ? 'checked' : '';
    const meta = [
      m.bpm ? `${Math.round(m.bpm)} BPM` : null,
      m.key_note ? `${m.key_note} ${m.key_mode || ''}` : null,
      m.match_type === 'artist' ? `<span style="color:#7ed982">${t('spMatchArtist')} "${escapeHtml(m.matched_seed)}"</span>` : `<span style="color:#a0a0c0">${t('spMatchMood')}</span>`,
    ].filter(Boolean).join(' · ');
    return `
      <label class="sp-match-row">
        <input type="checkbox" ${isOn} onchange="toggleMatchSelection(${folderId}, ${m.id}, this.checked)"/>
        <div class="sp-match-info">
          <div class="sp-match-title">${escapeHtml(m.title)}</div>
          <div class="sp-match-meta">${meta}</div>
        </div>
        <div class="sp-match-conf">${Math.round(m.confidence * 100)}%</div>
      </label>
    `;
  };

  let html = '';
  if (artistMatches.length) {
    html += `<div class="sp-match-section-lbl">${t('spArtistMatches')} · ${artistMatches.length}</div>`;
    html += artistMatches.map(renderRow).join('');
  }
  if (moodMatches.length) {
    html += `<div class="sp-match-section-lbl" style="margin-top:14px">${t('spMoodMatches')} · ${moodMatches.length}</div>`;
    html += moodMatches.map(renderRow).join('');
  }

  body.innerHTML = html;

  // Action bar with select-all and apply
  actions.innerHTML = `
    <button class="btn xs" onclick="selectAllMatches(${folderId}, true)">${t('spSelectAll')}</button>
    <button class="btn xs" onclick="selectAllMatches(${folderId}, false)">${t('spSelectNone')}</button>
    <div style="flex:1"></div>
    <button class="btn" onclick="document.getElementById('sp-match-modal').remove(); loadStockpile()">${t('spCancel')}</button>
    <button class="btn pri" id="sp-match-apply-btn" onclick="applyMatchSelection(${folderId})">
      <span id="sp-match-apply-lbl">${t('spTagSelected')} (${sel.size})</span>
    </button>
  `;
}

function toggleMatchSelection(folderId, trackId, on) {
  const sel = window.spMatchSelection[folderId];
  if (on) sel.add(trackId); else sel.delete(trackId);
  const lbl = document.getElementById('sp-match-apply-lbl');
  if (lbl) lbl.textContent = `${t('spTagSelected')} (${sel.size})`;
}

function selectAllMatches(folderId, on) {
  const sel = window.spMatchSelection[folderId];
  document.querySelectorAll('#sp-match-body input[type=checkbox]').forEach(cb => {
    cb.checked = on;
  });
  if (on) {
    document.querySelectorAll('#sp-match-body .sp-match-row').forEach(row => {
      const cb = row.querySelector('input[type=checkbox]');
      if (cb && cb.onchange) {
        // Re-derive the trackId from the onchange handler text — cheaper than DOM walking
        const m = (cb.outerHTML.match(/toggleMatchSelection\(\d+,\s*(\d+)/) || [])[1];
        if (m) sel.add(parseInt(m, 10));
      }
    });
  } else {
    sel.clear();
  }
  const lbl = document.getElementById('sp-match-apply-lbl');
  if (lbl) lbl.textContent = `${t('spTagSelected')} (${sel.size})`;
}

async function applyMatchSelection(folderId) {
  const sel = window.spMatchSelection[folderId];
  if (!sel || !sel.size) {
    showAppNotification('✕ ' + t('spNoTracksSelected'), 'err');
    return;
  }
  const ids = Array.from(sel);
  const btn = document.getElementById('sp-match-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('spTagging') + '…'; }
  try {
    const r = await fetch(API + '/stockpile/folders/' + folderId + '/bulk-tag', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ history_ids: ids, source: 'auto-match' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    document.getElementById('sp-match-modal').remove();
    delete window.spMatchSelection[folderId];
    spSuggestionsByTrack = {};
    loadStockpile();
    showAppNotification('✓ ' + t('spTaggedNTracks').replace('{n}', j.tagged), 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; }
    showAppNotification('✕ ' + e.message, 'err');
  }
}

// ── Separator keyboard shortcuts ────────────────────────────────────────────
// Active only when the Stems tab is showing AND the user isn't typing in an
// input/textarea. Provides DAW-style transport: Space=play/pause, ←/→ seek
// 1s (Shift+ for 5s), Home=jump to start (or loop start), L=toggle loop.
window.addEventListener('keydown', (e) => {
  // Don't hijack typing
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (e.target && e.target.isContentEditable)) return;
  // Only when stems tab is active
  if (lastTab !== 'stems') return;
  // If the mini-DAW overlay is open, it owns keyboard input — don't fire
  // mixer shortcuts too or the user gets double-actions (Space starts BOTH
  // the DAW playback and the legacy mixer playback simultaneously).
  if (document.getElementById('daw-overlay')) return;
  // Only when mixer is alive (project loaded)
  if (!mixerCtx || !sepCurrent) return;

  if (e.code === 'Space') {
    e.preventDefault();
    mixerPlayPauseAll();
    return;
  }
  // Seek shortcuts read currentTime from the first loaded stem
  let ref = null;
  for (const k of Object.keys(sepAudioMap)) {
    const ee = sepAudioMap[k];
    if (ee && ee.audio) { ref = ee; break; }
  }
  if (!ref) return;
  const dur = ref.audio.duration;

  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    const newT = Math.max(0, ref.audio.currentTime - step);
    for (const k of Object.keys(sepAudioMap)) {
      const ee = sepAudioMap[k];
      if (ee && ee.audio) { try { ee.audio.currentTime = newT; } catch {} }
    }
    updateMixerTime();
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    const newT = Math.min(dur, ref.audio.currentTime + step);
    for (const k of Object.keys(sepAudioMap)) {
      const ee = sepAudioMap[k];
      if (ee && ee.audio) { try { ee.audio.currentTime = newT; } catch {} }
    }
    updateMixerTime();
  } else if (e.code === 'Home') {
    e.preventDefault();
    const newT = (mixerLoopStart != null) ? mixerLoopStart : 0;
    for (const k of Object.keys(sepAudioMap)) {
      const ee = sepAudioMap[k];
      if (ee && ee.audio) { try { ee.audio.currentTime = newT; } catch {} }
    }
    updateMixerTime();
  } else if (e.code === 'KeyL') {
    e.preventDefault();
    mixerToggleLoop();
  }
});

// ── Auto-updater renderer logic ─────────────────────────────────────────────
//
// Drives the update banner UI in response to main-process events. The banner
// has three logical states; each maps to a specific look and a primary
// button action:
//
//   AVAILABLE   — "Update X.Y.Z available"          [Install] [Later]
//   DOWNLOADING — "Downloading… N%" + progress bar  [Cancel ] [Later]  (no cancel impl in v1)
//   READY       — "Update X.Y.Z ready"              [Restart] [Later]
//
// Banner show/hide uses a two-class system:
//   .hidden  — display:none, gone entirely
//   .out     — display still flex but opacity:0 translateX(20px); transitions
//              to that state. Use this BEFORE adding .hidden so the exit
//              animation runs. Show flow does the reverse: remove .hidden,
//              force a reflow, then remove .out so the entrance animates.
//
// State is held in module-scope vars set by _setupUpdater. Stay-after-Later
// is tracked via _updateDismissedSession to avoid re-popping the same notice
// on every poll. New events (e.g. update-downloaded after the user said
// Later on the AVAILABLE banner) re-open with the relevant state.

let _updateState = null;            // 'AVAILABLE' | 'DOWNLOADING' | 'READY' | null
let _updateInfo = null;             // last payload from main: {version, releaseNotes, ...}
let _updateDismissedSession = false; // user said Later this session
let _updateBannerEl = null;

function _setupUpdater() {
  if (!window.api || !window.api.updater) {
    // Dev mode or broken preload — nothing to wire.
    return;
  }
  _updateBannerEl = document.getElementById('update-banner');
  if (!_updateBannerEl) return;

  // Update available → switch to AVAILABLE state and surface the banner
  // (unless user already dismissed for this session).
  window.api.updater.onAvailable(info => {
    _updateInfo = info;
    _updateState = 'AVAILABLE';
    if (!_updateDismissedSession) _showUpdateBanner();
    _renderUpdateBanner();
  });

  // Download progress → just update the progress bar + sub text.
  window.api.updater.onProgress(p => {
    if (_updateState !== 'DOWNLOADING') return;
    _renderUpdateBannerProgress(p);
  });

  // Download complete → switch to READY state, ensure banner is visible
  // (user might have hit Later during AVAILABLE; ready overrides that).
  window.api.updater.onReady(info => {
    _updateInfo = Object.assign({}, _updateInfo || {}, info || {});
    _updateState = 'READY';
    _updateDismissedSession = false; // override any earlier dismiss
    _showUpdateBanner();
    _renderUpdateBanner();
  });

  window.api.updater.onError(info => {
    // Quiet failure — log to diag panel only. Don't pop a banner; users
    // shouldn't see "update check failed" noise.
    if (typeof diagLog === 'function') {
      diagLog('Updater: ' + (info && info.message || 'unknown error'), 'warn');
    }
  });

  // v0.2.8: surface the boot check so users see it happen instead of
  // a silent network call. The toast auto-dismisses; users don't have
  // to interact, they just get confirmation that we checked.
  let _bootCheckToastShown = false;
  window.api.updater.onChecking(() => {
    if (typeof diagLog === 'function') diagLog('Updater: checking…', 'info');
    if (!_bootCheckToastShown && typeof showAppNotification === 'function') {
      _bootCheckToastShown = true;
      showAppNotification(t('updCheckingBoot') || 'Checking for updates…', 'info', null, 2500);
    }
  });
  window.api.updater.onNone(() => {
    if (typeof diagLog === 'function') diagLog('Updater: up to date', 'info');
    // Only show "up to date" when triggered by the BOOT check, not on
    // every 4-hour interval check (would be spammy). The boot check
    // flag was set by onChecking above.
    if (_bootCheckToastShown && typeof showAppNotification === 'function') {
      showAppNotification('✓ ' + (t('updUpToDate') || "You're up to date"), 'ok', null, 2200);
      _bootCheckToastShown = false;  // reset for next boot
    }
  });

  // Pull-based catch-up: if the main process already found an update
  // BEFORE these listeners attached (boot check beating a slow renderer),
  // that IPC event is gone — fetch the cached payload instead. Belt and
  // suspenders with the main-side did-finish-load replay.
  if (typeof window.api.updater.getPending === 'function') {
    window.api.updater.getPending().then(info => {
      if (info && info.version && _updateState === null) {
        _updateInfo = info;
        _updateState = 'AVAILABLE';
        if (!_updateDismissedSession) _showUpdateBanner();
        _renderUpdateBanner();
      }
    }).catch(() => {});
  }
}

function _showUpdateBanner() {
  if (!_updateBannerEl) return;
  // Two-stage reveal so the slide-in animation fires:
  //   1. Remove .hidden so the element is in the layout
  //   2. Force reflow + ensure .out is set (starting state)
  //   3. Next frame, remove .out → transitions to visible
  _updateBannerEl.classList.add('out');     // start invisible
  _updateBannerEl.classList.remove('hidden'); // now in layout
  // Force reflow so .out's styles apply before we remove it
  void _updateBannerEl.offsetWidth;
  requestAnimationFrame(() => {
    _updateBannerEl.classList.remove('out');
    _repositionNotifStack();
  });
}

function _hideUpdateBanner() {
  if (!_updateBannerEl) return;
  _updateBannerEl.classList.add('out');
  // After the exit transition (320ms), fully remove from layout
  setTimeout(() => {
    if (_updateBannerEl.classList.contains('out')) {
      _updateBannerEl.classList.add('hidden');
    }
    _repositionNotifStack();
  }, 340);
}

function _renderUpdateBanner() {
  if (!_updateBannerEl) return;
  const titleEl = document.getElementById('update-banner-title');
  const subEl = document.getElementById('update-banner-sub');
  const primaryBtn = document.getElementById('update-banner-primary');
  const laterBtn = document.getElementById('update-banner-later');
  const progressEl = document.getElementById('update-banner-progress');
  if (!titleEl || !subEl || !primaryBtn || !laterBtn || !progressEl) return;

  const version = (_updateInfo && _updateInfo.version) || '';
  if (_updateState === 'AVAILABLE') {
    titleEl.textContent = 'Update available';
    subEl.textContent = 'Version ' + version + ' — install when ready';
    primaryBtn.textContent = 'Install';
    primaryBtn.disabled = false;
    laterBtn.textContent = 'Later';
    laterBtn.disabled = false;
    progressEl.classList.add('hidden');
  } else if (_updateState === 'DOWNLOADING') {
    titleEl.textContent = 'Downloading update…';
    subEl.textContent = 'Version ' + version + ' · 0%';
    primaryBtn.textContent = 'Installing…';
    primaryBtn.disabled = true;
    laterBtn.textContent = 'Hide';
    laterBtn.disabled = false;
    progressEl.classList.remove('hidden');
    const fill = document.getElementById('update-banner-progress-fill');
    if (fill) fill.style.width = '0%';
  } else if (_updateState === 'READY') {
    titleEl.textContent = 'Update ready';
    subEl.textContent = 'Version ' + version + ' — restart to install';
    primaryBtn.textContent = 'Restart';
    primaryBtn.disabled = false;
    laterBtn.textContent = 'Later';
    laterBtn.disabled = false;
    progressEl.classList.add('hidden');
  }
}

function _renderUpdateBannerProgress(p) {
  const fill = document.getElementById('update-banner-progress-fill');
  const subEl = document.getElementById('update-banner-sub');
  if (!fill || !subEl) return;
  const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  fill.style.width = pct + '%';
  const version = (_updateInfo && _updateInfo.version) || '';
  // Format bytes/sec if available so users see real download speed
  const mbps = p.bytesPerSecond ? (p.bytesPerSecond / 1024 / 1024).toFixed(1) + ' MB/s' : '';
  subEl.textContent = 'Version ' + version + ' · ' + pct + '%' + (mbps ? ' · ' + mbps : '');
}

// ── Banner button handlers (called from index.html onclick) ─────────────────
async function onUpdateBannerPrimary() {
  if (!window.api || !window.api.updater) return;
  if (_updateState === 'AVAILABLE') {
    // Start downloading — flip to DOWNLOADING state, kick off the download.
    // Progress events from main will drive the progress bar.
    _updateState = 'DOWNLOADING';
    _renderUpdateBanner();
    try {
      const result = await window.api.updater.download();
      if (!result || !result.ok) {
        // Download failed — surface as a notification + revert to AVAILABLE
        if (typeof showAppNotification === 'function') {
          showAppNotification('Update download failed: ' + (result && result.error || 'unknown'), 'err', null, 6000);
        }
        _updateState = 'AVAILABLE';
        _renderUpdateBanner();
      }
      // On success, the onReady event handler flips state to READY.
    } catch (e) {
      if (typeof showAppNotification === 'function') {
        showAppNotification('Update error: ' + e.message, 'err', null, 6000);
      }
      _updateState = 'AVAILABLE';
      _renderUpdateBanner();
    }
  } else if (_updateState === 'READY') {
    // User wants to install now → main process quits + installs + restarts.
    // This is point of no return; the app will disappear in a moment.
    try {
      await window.api.updater.install();
    } catch (e) {
      if (typeof showAppNotification === 'function') {
        showAppNotification('Could not start installer: ' + e.message, 'err', null, 6000);
      }
    }
  }
}

function onUpdateBannerLater() {
  // Hide the banner. The session-dismissed flag prevents re-showing the
  // SAME state if the updater re-fires (e.g. another check finds the same
  // version). New events (DOWNLOADING → READY) will still surface because
  // those handlers reset the flag.
  _updateDismissedSession = true;
  _hideUpdateBanner();
}

// (v0.2.2's installGlobalSpaceKey was REMOVED in v0.2.4 — it double-
// fired with the proper mode-aware mini-player keyboard handler below
// at the "Keyboard shortcuts when the mini player is active" block.
// Its button.click() approach also targeted folderViewTogglePlay() in
// mirror mode, which is the wrong audio path. All media shortcuts now
// live in that one place. Also: a body-level mousedown handler below
// drops focus from stuck input fields so Space/arrows work after the
// very first click outside the URL field.)
// v0.2.7: tiny mousedown handler that records where on a primary button
// the user clicked, so the ::before ripple in CSS originates there
// instead of the geometric center. Composite-only — no DOM injection.
(function installPrimaryButtonRipple(){
  // v0.2.7: passive=true tells the browser we won't preventDefault,
  // so it can dispatch this on the compositor thread without waiting
  // for us. Free perf win.
  document.addEventListener('mousedown', (e) => {
    const t = e.target && e.target.closest && e.target.closest('.btn.pri');
    if (!t || t.disabled) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--ripple-x', ((e.clientX - r.left) / r.width * 100) + '%');
    t.style.setProperty('--ripple-y', ((e.clientY - r.top)  / r.height * 100) + '%');
  }, { capture: true, passive: true });
})();

(function installInputBlurOnOutsideClick(){
  document.addEventListener('mousedown', (e) => {
    const ae = document.activeElement;
    if (!ae) return;
    if (ae.tagName !== 'INPUT' && ae.tagName !== 'TEXTAREA') return;
    const t = e.target;
    if (!t || t === ae) return;
    if (t.closest && t.closest('input,textarea,select,button,a,label,[contenteditable="true"]')) return;
    try { ae.blur(); } catch {}
  }, true);
})();

// ══════════════════════════════════════════════════════════════════════
// CLICK-OUTSIDE-TO-CLOSE FOR POPUP MODALS (patch 20)
// ══════════════════════════════════════════════════════════════════════
// Every popup (Logs, Storage breakdown, Auto-organize, Duplicate finder,
// Diagnose paths, Repair review, bulk-tag picker…) shares the
// `.setup-modal` backdrop class. Clicking the dimmed area around the card
// now closes the popup — no need to hunt for the ✕.
//
// Exclusions:
//   • #setup-modal — the first-run engine setup. Dismissing that
//     mid-install by a stray click would be destructive, so it keeps
//     requiring an explicit button.
// Special cases:
//   • #bulk-tag-modal awaits a Promise; we resolve(null) so the awaiting
//     code unwinds instead of hanging forever.
// We listen on mousedown+up pairs (not bare click) so that selecting text
// inside the card and releasing over the backdrop doesn't nuke the popup.
(function initModalOutsideClose() {
  let downTarget = null;
  document.addEventListener('mousedown', (e) => { downTarget = e.target; }, true);
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains('setup-modal')) return;
    if (downTarget !== el) return;            // press started inside the card
    if (el.id === 'setup-modal') return;      // first-run setup stays explicit
    if (el.style.display === 'none') return;
    if (el.id === 'bulk-tag-modal' && typeof window._bulkTagResolve === 'function') {
      window._bulkTagResolve(null);           // also hides + cleans up
      return;
    }
    el.style.display = 'none';
  }, true);
  // Esc closes the top-most visible popup too — same exclusions.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('.setup-modal'))
      .filter(m => m.style.display !== 'none' && m.id !== 'setup-modal');
    if (!open.length) return;
    const top = open[open.length - 1];
    if (top.id === 'bulk-tag-modal' && typeof window._bulkTagResolve === 'function') {
      window._bulkTagResolve(null);
      return;
    }
    top.style.display = 'none';
  });
})();


// ── 0.1.1 boot: push client prefs to the server once it's reachable ────
// (stockpile root + auto-send + watch-folder live in localStorage; the
// server-side watcher and extension-path auto-send need them mirrored.)
setTimeout(() => { try { syncPrefsToServer(); } catch {} }, 5000);
