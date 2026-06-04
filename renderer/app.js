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

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('on'));
  btn.classList.add('on');
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
    if (historyId) {
      try {
        const am = await fetch(API + '/stockpile/tracks/' + historyId + '/auto-match', { method: 'POST' });
        const amJ = await am.json();
        if (amJ.tagged && amJ.tagged.length) {
          const names = amJ.tagged.map(t => t.folder_name).join(', ');
          showAppNotification('✓ ' + (t('autoMatched') || 'Auto-tagged into') + ': ' + names, 'ok');
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

function _getNotifStack() {
  if (_notifStack && _notifStack.isConnected) return _notifStack;
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

function setM(id, val, conf) { const el = document.getElementById(id); el.textContent = val; el.className = 'm-val'; document.getElementById(id+'-conf').style.width = conf||'80%'; }
function setKeyM(note, mode, conf) { document.getElementById('key').textContent = note; document.getElementById('key').className = 'm-val'; document.getElementById('key-mode').textContent = mode; document.getElementById('key-conf').style.width = conf||'80%'; }

// ── Python analysis engine ────────────────────────────────────────────────────
function runPythonAnalysis(filePath, histId) {
  const params = new URLSearchParams({ path: filePath });
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
      fetch(API + '/history/' + histId + '/analysis', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ bpm: currentBpm, key_note: currentKey, key_mode: currentMode })
      }).catch(()=>{});
      loadHistory();
    }
    return;
  }

  const sb = result.spectral_balance || {};
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
    fetch(API + '/history/' + histId + '/analysis', {
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
  // Determine the currently-playing track id across both modes.
  let activeId = null;
  if (analyzeMirrorActive && typeof playing !== 'undefined' && playing && currentHistId) {
    activeId = currentHistId;
  } else if (globalPlayer && globalPlayer.track && globalPlayer.track.id) {
    activeId = globalPlayer.track.id;
  }
  const rows = document.querySelectorAll('.hist-row');
  for (const row of rows) {
    const id = parseInt(row.dataset.id, 10);
    const btn = row.querySelector('.hist-play');
    if (!btn) continue;
    const shouldPlay = (id === activeId);
    const isMarked = btn.classList.contains('playing');
    if (shouldPlay !== isMarked) {
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

function renderHistory(){
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
  list.innerHTML=rows.map(h=>{
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
    const isPlaying = (
      (globalPlayer && globalPlayer.track && globalPlayer.track.id === h.id) ||
      (analyzeMirrorActive && currentHistId === h.id && typeof playing !== 'undefined' && playing)
    );
    const playIcon = isPlaying
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,5 7,19 19,12"/></svg>';
    const playBtn = selectMode ? '' : `<button class="hist-play ${isPlaying ? 'playing' : ''}" tabindex="-1" onmousedown="this.blur()" onclick="event.stopPropagation();playFromHistory(${h.id});this.blur()" title="Preview">${playIcon}</button>`;
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
    return `<div class="${rowClass}${pulseClass}" data-id="${h.id}"${rowTitle} ${onclick}>${checkbox}${playBtn}<img class="hist-thumb" loading="lazy" decoding="async" src="${h.thumbnail||''}" onerror="this.style.display='none'" alt=""/>${favBtn}<div class="hist-info"><div class="hist-title">${h.title||'(untitled)'}</div><div class="hist-meta">${[h.channel,h.created_at?.slice(0,16),fmtSec(h.duration)].filter(Boolean).join(' · ')}</div>${tagStrip}</div><div class="hist-badges">${h.bpm?`<span class="badge bpm">${Math.round(h.bpm)} BPM</span>`:''}${h.key_note?`<span class="badge key">${h.key_note} ${h.key_mode||''}</span>`:''}${h.format?`<span class="badge">${h.format.toUpperCase()}</span>`:''}</div>${selectMode?'':`<button class="btn xs danger" onclick="event.stopPropagation();deleteHistory(${h.id})">Remove</button>`}</div>`;
  }).join('');
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
  // Mini player heart
  const miniHeart = document.getElementById('sp-fv-mini-fav');
  if (miniHeart && globalPlayer.track && globalPlayer.track.id === historyId) {
    miniHeart.classList.toggle('on', on);
    miniHeart.innerHTML = on ? heartIconFilled : heartIconEmpty;
  }
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

function toggleCpuOnly(checked) {
  // Persisted in localStorage so the setting survives app restarts.
  // Read by startSeparation to add ?cpuOnly=1 to the /stems request.
  localStorage.setItem('freqphull.cpuOnly', checked ? '1' : '0');
  if (typeof showAppNotification === 'function') {
    showAppNotification(checked ? 'Stem separator will use CPU only' : 'Stem separator will use GPU if available', 'info', null, 2500);
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
        <div class="setting-name">Fix file locations</div>
        <div class="setting-desc" id="fix-files-desc">Scan every tagged track and move any whose files aren't in their primary folder. Files that should be in <code>Cali Type beat/</code> but ended up elsewhere get moved into place. Safe to re-run.</div>
      </div>
      <button class="btn sm" id="btn-fix-files" onclick="repairFileLocations()">📁 Fix files</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">Clean temp files</div>
        <div class="setting-desc" id="clean-temp-desc">Removes Freq.Phull's leftover WAV files from Windows Temp (older than 1 hour). Only touches files starting with <code>freqphull_</code> — never the app's own runtime folders. Runs automatically every 6 hours; use this for a manual sweep.<br><strong>Do NOT use <code>del Temp\\*</code> manually</strong> — it will delete the portable build's ffmpeg/yt-dlp binaries and break downloads until you relaunch.</div>
      </div>
      <button class="btn sm" id="btn-clean-temp" onclick="cleanTempFiles()">🧹 Clean now</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">Check for updates</div>
        <div class="setting-desc" id="update-check-desc">Manually check GitHub for a newer release. Updates download in the background and prompt to install when ready. The app also checks automatically every 4 hours.</div>
      </div>
      <button class="btn sm" id="btn-check-updates" onclick="manualCheckForUpdates()">🔄 Check now</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">Force CPU-only for stem separation</div>
        <div class="setting-desc">Skip GPU acceleration even when a CUDA GPU is available. Use this on low-VRAM machines (under 4GB) or to keep the GPU free for DAW plugins / other apps. Slower but lower system load.</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${(localStorage.getItem('freqphull.cpuOnly')==='1')?'checked':''} onchange="toggleCpuOnly(this.checked)"/>
        <span class="slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">Auto-clear download queue</div>
        <div class="setting-desc">Completed and failed downloads disappear from the Downloads list after this much time. Active downloads are never auto-cleared. Set to "Off" to keep them visible until you manually clear.</div>
      </div>
      <select class="setting-select" id="dl-autoclear-sel" onchange="setDlAutoclear(this.value)">
        <option value="0">Off</option>
        <option value="1">1 hour</option>
        <option value="12">12 hours</option>
        <option value="24">24 hours</option>
        <option value="72">72 hours</option>
      </select>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">AI Engines</div>
        <div class="setting-desc" id="engines-status-desc">Checking…</div>
      </div>
      <button class="btn sm" id="btn-run-setup" onclick="showSetupModal()">Run setup</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">Diagnose paths</div>
        <div class="setting-desc" id="diag-paths-desc">Check which binaries the app can find — useful when ffmpeg, yt-dlp etc. aren't working</div>
      </div>
      <button class="btn sm" onclick="diagnosePaths()">Diagnose</button>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-name">View logs</div>
        <div class="setting-desc">Server + setup logs, useful for debugging</div>
      </div>
      <button class="btn sm" onclick="viewLogs()">View logs</button>
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
  if (window.api && window.api.updater) {
    window.api.updater.getStatus().then(s => {
      const el = document.getElementById('about-version-desc');
      if (!el) return;
      if (s && s.currentVersion) {
        el.textContent = 'v' + s.currentVersion + ' — ' + t('by') + ' Cynphull / Hood Knights';
      } else {
        el.textContent = 'Development build — ' + t('by') + ' Cynphull / Hood Knights';
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
          <div class="setup-title" style="font-size:22px;text-align:left;margin:0">Diagnose Paths</div>
          <button class="btn xs" onclick="document.getElementById('diag-modal').style.display='none'">✕</button>
        </div>
        <pre id="diag-output" style="flex:1;overflow:auto;background:var(--bg3);padding:14px;border-radius:8px;font-size:11px;font-family:'Menlo',monospace;color:var(--white);white-space:pre-wrap;word-break:break-all;border:1px solid var(--border);line-height:1.55">${escapeHtml(text)}</pre>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="btn pri" onclick="copyDiagOutput()" style="flex:1">Copy to clipboard</button>
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
          <div class="setup-title" style="font-size:22px;text-align:left;margin:0">Logs</div>
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
    showAppNotification('Backend offline — try again in a moment', 'err');
    return;
  }
  if (!stockpileFolder) {
    showAppNotification('Set a stockpile folder in Settings first', 'err');
    return;
  }
  const ok = await confirmModal({
    title: 'Fix file locations?',
    message: 'Scans every tagged track and moves any whose files aren\'t in their primary folder on disk. Files are never deleted — only moved into place.',
    detail: 'Stockpile root: ' + stockpileFolder,
    okLabel: 'Fix files',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;

  const btn = document.getElementById('btn-fix-files');
  const desc = document.getElementById('fix-files-desc');
  // Disable + show a spinner so the user knows something is happening.
  // Reuse the existing pri styling so it matches the rest of the buttons.
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
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
    if (j.moved)      parts.push('Moved ' + j.moved + ' file' + (j.moved === 1 ? '' : 's'));
    if (j.alreadyOk)  parts.push(j.alreadyOk + ' already in place');
    if (j.missing)    parts.push(j.missing + ' missing on disk');
    if (j.errors)     parts.push(j.errors + ' errors');
    const summary = parts.length
      ? parts.join(' · ')
      : 'Checked ' + j.checked + ' — nothing to do';
    showAppNotification('✓ ' + summary, 'done');
    if (desc) desc.textContent = summary;
    // Refresh history so the renderer reflects the new file_paths
    if (j.moved) await loadHistory();
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📁 Fix files'; }
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
    showAppNotification('Backend offline', 'err');
    return;
  }
  const ok = await confirmModal({
    title: 'Clean Freq.Phull temp files?',
    message: 'Removes WAV files older than 1 hour from Windows Temp that Freq.Phull left behind from analysis, stem separation, and conversion. Anything currently being processed is safe.',
    okLabel: 'Clean now',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  const btn = document.getElementById('btn-clean-temp');
  const desc = document.getElementById('clean-temp-desc');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Cleaning…'; }
  try {
    const r = await fetch(API + '/clean-temp-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeHours: 1 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Cleanup failed');
    const msg = j.deleted > 0
      ? '✓ Cleaned ' + j.deleted + ' file' + (j.deleted === 1 ? '' : 's') + ' (' + j.mbFreed + ' MB freed)'
      : '✓ Nothing to clean — temp folder is tidy';
    showAppNotification(msg, 'done');
    if (desc) desc.textContent = msg;
  } catch (e) {
    showAppNotification('✕ ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Clean now'; }
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
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }
  try {
    if (!window.api || !window.api.updater) {
      throw new Error('Update API unavailable in this build');
    }
    const result = await window.api.updater.check();
    if (!result || result.ok === false) {
      // dev mode, or genuine error
      if (result && result.reason === 'dev') {
        showAppNotification('Updates only work in packaged builds', 'warn');
        if (desc) desc.textContent = 'Updates only work in the packaged (installed) build, not in dev mode.';
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
          <div class="setup-title" style="font-size:24px;text-align:left;margin-bottom:2px">Review Matches</div>
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
        <button class="btn pri" onclick="applyAllReviewMatches()" style="flex:1">Apply all top matches</button>
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
      <div class="sp-fc-count">${f.track_count} ${f.track_count === 1 ? t('spTrack') : t('spTracks')}</div>
      ${f.description ? `<div class="sp-fc-desc">${escapeHtml(f.description)}</div>` : ''}
      ${seedsTxt ? `<div class="sp-fc-seeds">${escapeHtml(seedsTxt)}${f.artist_seeds.split(',').length > 3 ? ' …' : ''}</div>` : ''}
    `;
    grid.appendChild(card);
  }
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
      ? `<img class="sp-fv-row-thumb" src="${escapeHtml(tr.thumbnail)}" onerror="this.outerHTML='<div class=\\'sp-fv-row-thumb fallback\\'>♪</div>'"/>`
      : `<div class="sp-fv-row-thumb fallback">♪</div>`;
    // Clicking the title block opens the full analysis (waveform, sections,
    // chord progression, LUFS, dynamic range, etc.). The title is the
    // primary surface so it gets a hover affordance.
    return `
      <div class="sp-fv-row" data-id="${tr.id}">
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
    return;
  }
  const ctx = globalPlayer.context;
  if (!ctx || !ctx.tracks || ctx.index <= 0) return;
  const prevIdx = ctx.index - 1;
  playTrack(ctx.tracks[prevIdx], { ...ctx, index: prevIdx });
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
  } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
    // Ctrl+← jumps to previous track in the current playlist context
    e.preventDefault();
    globalPlayerPrev();
  } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
    // Ctrl+→ jumps to next track
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

  window.api.updater.onChecking(() => {
    if (typeof diagLog === 'function') diagLog('Updater: checking…', 'info');
  });
  window.api.updater.onNone(() => {
    if (typeof diagLog === 'function') diagLog('Updater: up to date', 'info');
  });
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
