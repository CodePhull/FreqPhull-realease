const $=id=>document.getElementById(id);
const API='http://127.0.0.1:47891';
let ax=null,ab=null,sn=null,gn=null,pl=false,sT=0,pO=0,rI=null,pV=0;
let cK=null,cM=null,cB=null,hist=[];
let mOn=false,mC=null,mB=0,mI=null,mBpm=120,taps=[];
let vol=.5,mut=false,fN='audio',ytFmt='mp3',ytUrl='';
let backendOnline=false,lastFilePath=null,lastHistoryId=null;

// ── Queue system ──────────────────────────────────────────────────────────────
// Each item: { id, url, fmt, title, thumbnail, status, progress, error,
//              finishedAt, filename, fullPath, historyId }
// status: 'waiting' | 'downloading' | 'done' | 'error'
// Items stay in the array AFTER finishing (status='done'/'error') so the
// queue UI keeps showing them — same anti-duplicate model as the desktop
// app (patch 15l). When the user pastes a URL they already grabbed this
// session, we pulse the existing chip + confirm before re-downloading,
// instead of letting them accidentally pull the same file twice.
let queue=[], queueProcessing=false;
let queueNextId = 1;
// Auto-clear threshold in hours — matches the desktop default (24h).
// Persisted in chrome.storage so the user's setting survives the panel
// being closed (a side panel reload re-runs panel.js, which would
// reset to default if we kept it in-memory only).
let queueAutoclearHours = 24;
let _queueSweepInterval = null;

document.addEventListener('DOMContentLoaded',()=>{
  // Tabs
  document.querySelectorAll('.tabs button').forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
      document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');$('p'+b.dataset.i).classList.add('on');
      if(b.dataset.i==='2')loadHist();
    });
  });

  // Format pills
  document.querySelectorAll('.fmts button').forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll('.fmts button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); ytFmt=b.dataset.fmt;
    });
  });

  // Grab
  $('grabBtn').addEventListener('click',doGrab);

  // Drop zone
  const dz=$('dz');
  dz.addEventListener('click',()=>$('fin').click());
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');if(e.dataTransfer.files[0])readF(e.dataTransfer.files[0]);});
  $('fin').addEventListener('change',e=>{if(e.target.files[0])readF(e.target.files[0]);});

  // Player
  $('playbtn').addEventListener('click',togglePlay);
  $('ww').addEventListener('click',e=>seekW(e));
  $('skbar').addEventListener('click',e=>seekB(e));

  // Drag-to-export from waveform
  const ww=$('ww');
  ww.setAttribute('draggable','true');
  // Drag waveform → desktop/explorer still works via DownloadURL
  // For FL Studio, file is already in Chrome's download bar from the grab
  ww.addEventListener('dragstart',e=>{
    if(!ab){e.preventDefault();return;}
    const safeName=(fN||'audio').replace(/[^a-zA-Z0-9._-]/g,'_').replace(/\.[^.]+$/,'');
    const ext = lastFilePath ? lastFilePath.split('.').pop().toLowerCase() : 'wav';
    const fullName = safeName + '.' + ext;

    const ghost=$('dragGhost');
    paintGhost(ghost.querySelector('canvas'),ab);
    ghost.querySelector('.dg-name').textContent=fullName;
    e.dataTransfer.setDragImage(ghost,100,24);
    e.dataTransfer.effectAllowed='copy';

    if(backendOnline&&lastFilePath){
      const mimeMap = {mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',ogg:'audio/ogg'};
      const mime = mimeMap[ext] || 'audio/wav';
      e.dataTransfer.setData('DownloadURL',mime+':'+fullName+':'+API+'/file?path='+encodeURIComponent(lastFilePath));
    }
    e.dataTransfer.setData('text/plain',fullName);
    ww.style.borderColor='var(--w)';ww.style.boxShadow='0 0 8px rgba(255,255,255,0.08)';
  });
  ww.addEventListener('dragend',()=>{
    ww.style.borderColor='';ww.style.boxShadow='';
  });
  $('vico').addEventListener('click',toggleMute);
  $('vsl').addEventListener('input',e=>setVol(e.target.value));
  $('psl').addEventListener('input',e=>setPitch(e.target.value));
  $('expBtn').addEventListener('click',exportWAV);
  $('notesbox').addEventListener('input',saveNote);

  // Tools
  $('metsl').addEventListener('input',e=>{mBpm=parseInt(e.target.value);$('metnum').textContent=mBpm;});
  $('metbtn').addEventListener('click',toggleMet);
  $('tapbtn').addEventListener('click',tapB);
  $('rk').addEventListener('change',renderRef);
  $('rm').addEventListener('change',renderRef);
  $('hsrch').addEventListener('input',renderHist);
  $('clearBtn').addEventListener('click',clearH);

  // Settings selects — wired here because MV3 CSP blocks inline onchange
  // attributes in extension pages (the old inline handler never fired).
  const acSel = document.getElementById('autoclear-sel');
  if(acSel) acSel.addEventListener('change', e => setQueueAutoclear(e.target.value));
  const pSel = document.getElementById('parallel-sel');
  if(pSel) pSel.addEventListener('change', e => setMaxParallel(e.target.value));
  // Playlist picker (all wired here — MV3 CSP blocks inline handlers)
  const plLink = document.getElementById('pl-link');
  if(plLink) plLink.addEventListener('click', openPlaylistPicker);
  const plAll = document.getElementById('pl-all');
  if(plAll) plAll.addEventListener('click', () => plSetAll(true));
  const plNone = document.getElementById('pl-none');
  if(plNone) plNone.addEventListener('click', () => plSetAll(false));
  const plGo = document.getElementById('pl-go');
  if(plGo) plGo.addEventListener('click', plQueueSelected);
  const plClose = document.getElementById('pl-close');
  if(plClose) plClose.addEventListener('click', () => $('pl-modal').classList.add('hide'));

  renderRef(); loadHist(); checkBackend();
  startHistLivePoll();

  // Restore auto-clear setting from chrome.storage. The panel reloads
  // every time the side panel opens, so in-memory state alone would
  // reset to defaults — we need persistent storage. chrome.storage.local
  // is the right place (sync would limit us to 100KB across all keys).
  try {
    chrome.storage.local.get(['queueAutoclearHours','maxParallel'], r => {
      const v = r && r.queueAutoclearHours;
      if(typeof v === 'number' && v >= 0) queueAutoclearHours = v;
      const sel = document.getElementById('autoclear-sel');
      if(sel) sel.value = String(queueAutoclearHours);
      const mp = r && r.maxParallel;
      if(typeof mp === 'number' && mp >= 1 && mp <= 3) maxParallel = mp;
      const psel = document.getElementById('parallel-sel');
      if(psel) psel.value = String(maxParallel);
    });
  } catch {}
  // Start periodic sweep — every minute is plenty
  if(!_queueSweepInterval){
    _queueSweepInterval = setInterval(sweepStaleQueue, 60 * 1000);
  }

  // Get YT info
  chrome.runtime.sendMessage({type:'get-yt-info'},r=>{
    if(!chrome.runtime.lastError&&r&&!r.error)showYT(r);
  });
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.type==='video-info'&&msg.data)showYT(msg.data);
  });
});

function setQueueAutoclear(hours){
  const n = parseFloat(hours);
  queueAutoclearHours = (isFinite(n) && n >= 0) ? n : 0;
  try { chrome.storage.local.set({ queueAutoclearHours }); } catch {}
  sweepStaleQueue();
}

// ══════════════════════════════════════════════════════════════
// BACKEND CONNECTION
// ══════════════════════════════════════════════════════════════
function checkBackend(){
  const dot=$('backendDot'),txt=$('backendTxt');
  dot.className='dot checking'; txt.textContent='Checking…';

  fetch(API+'/health',{signal:AbortSignal.timeout(2000)})
    .then(r=>r.json())
    .then(d=>{
      backendOnline=true;
      dot.className='dot on'; txt.textContent='Engine online';
      // Remove offline message if present
      const msg=document.querySelector('.offline-msg');
      if(msg)msg.remove();
    })
    .catch(()=>{
      backendOnline=false;
      dot.className='dot off'; txt.textContent='Engine offline';
      // Show offline notice
      if(!document.querySelector('.offline-msg')){
        const div=document.createElement('div');
        div.className='offline-msg';
        div.innerHTML='<b>Freq.Phull engine not detected</b>Open the Freq.Phull desktop app first, then reopen this panel. The extension needs the app running to download YouTube audio.';
        $('p0').insertBefore(div,$('p0').firstChild);
      }
    });

  // Re-check every 10s
  setTimeout(checkBackend,10000);
}

// ══════════════════════════════════════════════════════════════
// YOUTUBE CARD
// ══════════════════════════════════════════════════════════════
function showYT(d){
  $('yttitle').textContent=d.title||'—';
  $('ytch').textContent=d.channel||'';
  if(d.thumbnail)$('ytimg').src=d.thumbnail;
  ytUrl=d.url||'';
  $('ytcard').classList.remove('hide');
  maybeShowPlaylistLink();
}

// ══════════════════════════════════════════════════════════════
// GRAB & ANALYZE — uses the local backend's /download endpoint
// Flow: /download (SSE with progress) → /convert-wav → decode → analyze
// ══════════════════════════════════════════════════════════════
// Add a track to the download queue without touching the YT card —
// used by the playlist grabber. Skips anything already waiting/active.
function enqueueTrack(title, url, fmt){
  const norm = (u) => {
    try { const x = new URL(u); return (x.host + x.pathname + (x.searchParams.get('v') || '')).toLowerCase(); }
    catch { return (u||'').toLowerCase(); }
  };
  const n = norm(url);
  const existing = queue.find(q => norm(q.url) === n);
  if(existing && (existing.status === 'waiting' || existing.status === 'downloading')) return false;
  queue.push({
    id: queueNextId++, url, fmt: fmt || ytFmt,
    title: title || 'YouTube audio', thumbnail: '',
    status: 'waiting', progress: 0, addedAt: Date.now(),
  });
  return true;
}

// ── Playlist grabber (0.1.1) ───────────────────────────────────────
// When the current video belongs to a playlist (&list= in the URL), the
// YT card shows a "Grab playlist…" link. It scrapes the visible playlist
// from the page (via content script), shows a checkbox picker, and
// queues the selection through the parallel download engine.
let playlistData = null;

function maybeShowPlaylistLink(){
  const link = $('pl-link');
  if(!link) return;
  const hasList = /[?&]list=/.test(ytUrl || '');
  link.classList.toggle('hide', !hasList);
}

function openPlaylistPicker(){
  st('Reading playlist…','spin');
  chrome.runtime.sendMessage({type:'get-playlist-info'}, (r)=>{
    if(chrome.runtime.lastError || !r || r.error || !r.items || !r.items.length){
      st('Could not read playlist — scroll it into view and retry','err');
      return;
    }
    playlistData = r;
    st('Ready','ok');
    const box = $('pl-modal');
    $('pl-name').textContent = (r.name || 'Playlist') + ' — ' + r.items.length + ' videos';
    $('pl-list').innerHTML = r.items.map((it, i) => `
      <label class="pl-row">
        <input type="checkbox" class="pl-cb" data-i="${i}" checked/>
        <span class="pl-title">${(it.title||'').replace(/</g,'&lt;')}</span>
      </label>`).join('');
    box.classList.remove('hide');
  });
}

function plSetAll(on){
  document.querySelectorAll('.pl-cb').forEach(cb => cb.checked = on);
}

function plQueueSelected(){
  if(!playlistData) return;
  const picked = Array.from(document.querySelectorAll('.pl-cb'))
    .filter(cb => cb.checked)
    .map(cb => playlistData.items[parseInt(cb.dataset.i,10)])
    .filter(Boolean);
  if(!picked.length){ showNotification('Nothing selected','info'); return; }
  let added = 0;
  for(const it of picked) if(enqueueTrack(it.title, it.url, ytFmt)) added++;
  $('pl-modal').classList.add('hide');
  updateQueueUI();
  showNotification('Added '+added+' to queue ('+(picked.length-added)+' already queued)','info');
  processQueue();
}

function doGrab(){
  if(!ytUrl){st('No YouTube URL','err');return;}
  if(!backendOnline){st('Start the Freq.Phull desktop app first','err');return;}

  // Normalize URL for dedup — treats different param orders / trailing
  // slashes as the same video. Same algorithm as the desktop app (15l).
  const norm = (u) => {
    try {
      const x = new URL(u);
      return (x.host + x.pathname + (x.searchParams.get('v') || '')).toLowerCase();
    } catch { return (u||'').toLowerCase(); }
  };
  const normUrl = norm(ytUrl);

  // Look for existing items in the queue. Behavior depends on the
  // current status of that match:
  //   waiting/downloading → already queued, just pulse + bail
  //   done                → confirm before re-downloading
  //   error               → silent re-add (errors are expected retries)
  const existing = queue.find(q => norm(q.url) === normUrl);
  if(existing){
    if(existing.status === 'waiting' || existing.status === 'downloading'){
      showNotification('Already in queue','info');
      pulseQueueItem(existing.id);
      return;
    }
    if(existing.status === 'done'){
      pulseQueueItem(existing.id);
      const when = existing.finishedAt
        ? Math.max(1, Math.round((Date.now() - existing.finishedAt) / 60000))
        : null;
      const whenStr = when ? (when < 60 ? when+' min ago' : Math.round(when/60)+'h ago') : 'this session';
      const ok = confirm(
        `You already grabbed this ${whenStr}.\n\n"${(existing.title||'Track').slice(0,60)}"\nFormat: ${(existing.fmt||'mp3').toUpperCase()}\n\nGrab again anyway?`
      );
      if(!ok){
        showNotification('Already grabbed — see queue list', 'info');
        return;
      }
      // Fall through and add as a new item
    }
  }

  const item = {
    id: queueNextId++,
    url: ytUrl,
    fmt: ytFmt,
    title: $('yttitle')?.textContent || 'YouTube audio',
    thumbnail: $('ytimg')?.src || '',
    status: 'waiting',
    progress: 0,
    addedAt: Date.now(),
  };
  queue.push(item);
  updateQueueUI();
  const pending = queue.filter(q => q.status==='waiting'||q.status==='downloading').length;
  showNotification('Added to queue (' + pending + ' pending)', 'info');
  processQueue();
}

// Briefly draw the user's attention to a queue row — used when they
// paste a URL that's already done so they can find the file they
// already grabbed. CSS class drives the animation.
function pulseQueueItem(id){
  setTimeout(()=>{
    const row = document.querySelector(`.qi[data-id="${id}"]`);
    if(!row) return;
    row.classList.remove('dup-pulse');
    void row.offsetWidth;
    row.classList.add('dup-pulse');
    row.scrollIntoView({behavior:'smooth', block:'nearest'});
    setTimeout(()=>row.classList.remove('dup-pulse'), 5000);
  }, 50);
}

function updateQueueUI(){
  const el=$('queueList');
  const btn=$('grabBtn');
  if(!el)return;
  const pending = queue.filter(q => q.status==='waiting'||q.status==='downloading').length;

  // Hide the panel entirely when there's nothing to show (no pending,
  // no completed). Once anything's been added this session, it stays.
  if(queue.length === 0){
    el.innerHTML=''; el.classList.add('hide');
    if(btn){btn.disabled=false; btn.textContent='⬇ Grab & Analyze';}
    return;
  }

  el.classList.remove('hide');
  if(btn){
    btn.disabled=false;
    btn.textContent = pending > 0 ? '⬇ Add to Queue ('+pending+')' : '⬇ Grab & Analyze';
  }

  // Order: active items first, finished below. Within each group keep
  // insertion order so the user can predict where their latest grab
  // shows up.
  const active = queue.filter(q => q.status==='waiting'||q.status==='downloading');
  const finished = queue.filter(q => q.status==='done'||q.status==='error');
  const ordered = [...active, ...finished];

  // Header with title, count, "Clear completed". No auto-clear dropdown
  // in the queue itself — that lives in Settings on the desktop and
  // here it's exposed via chrome.storage (settable from a future panel
  // settings section if you add one).
  const finishedCount = finished.length;
  el.innerHTML =
    '<div class="qhdr">' +
      '<span class="qhttl">Downloads</span>' +
      '<span class="qcount">'+queue.length+'</span>' +
      '<span class="qf"></span>' +
      (finishedCount>0 ? '<button class="qclear" id="qclear-btn">Clear completed</button>' : '') +
    '</div>' +
    ordered.map(renderQueueRow).join('');

  // Wire actions after innerHTML
  const clearBtn = document.getElementById('qclear-btn');
  if(clearBtn) clearBtn.addEventListener('click', clearCompletedQueue);
  ordered.forEach(q => {
    const cancel = document.getElementById('qi-cancel-'+q.id);
    if(cancel) cancel.addEventListener('click', ()=>removeQueueItem(q.id));
    const open = document.getElementById('qi-open-'+q.id);
    if(open) open.addEventListener('click', ()=>openInPanel(q));
  });
}

function renderQueueRow(q){
  // Status icon + label
  const ICO = {
    waiting: '⏸',
    downloading: '⏳',
    done: '✓',
    error: '✕',
  };
  const lbl = {
    waiting: 'Waiting',
    downloading: 'Downloading… '+Math.round(q.progress||0)+'%',
    done: 'Ready',
    error: 'Failed' + (q.error ? ' — '+q.error.slice(0,30) : ''),
  }[q.status];

  // Right-side actions per status
  let actions = '';
  if(q.status === 'waiting'){
    actions = `<button class="qx" id="qi-cancel-${q.id}" title="Remove from queue">✕</button>`;
  } else if(q.status === 'done'){
    actions = `<button class="qopen" id="qi-open-${q.id}" title="Load in player">▶</button>`;
  }
  const title = (q.title||'Track').slice(0, 40);
  const fmtPill = `<span class="qfmt">${(q.fmt||'mp3').toUpperCase()}</span>`;
  const prog = q.status === 'downloading' ? Math.round(q.progress||0) : 0;
  // Use data-id so pulseQueueItem can find this row by id
  return `
    <div class="qi ${q.status}" data-id="${q.id}">
      <span class="qico ${q.status}">${ICO[q.status]}</span>
      <div class="qinfo">
        <div class="qn">${escapeHtml(title)}</div>
        <div class="qmeta">${fmtPill}<span>${escapeHtml(lbl)}</span></div>
      </div>
      ${actions}
      <div class="qbar" style="width:${prog}%"></div>
    </div>
  `;
}

// Tiny HTML escaper — the extension didn't have one because content
// never came from untrusted sources before, but queue items now show
// titles from YouTube metadata which can contain HTML chars.
function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function removeQueueItem(id){
  const idx = queue.findIndex(q => q.id === id);
  if(idx < 0) return;
  if(queue[idx].status === 'downloading'){
    showNotification('Cannot remove an item that is downloading', 'info');
    return;
  }
  queue.splice(idx, 1);
  updateQueueUI();
}

function clearCompletedQueue(){
  queue = queue.filter(q => q.status==='waiting' || q.status==='downloading');
  updateQueueUI();
}

// Open a done item back into the analyzer. Refetches the audio from
// the backend by its known fullPath. Falls back to /file if convert-wav
// fails — same fallback chain as the original grab flow.
async function openInPanel(q){
  if(!q.fullPath){
    showNotification('Source path unavailable', 'err');
    return;
  }
  st('Loading…', 'spin');
  try{
    let audioBuf;
    const audioResp = await fetch(API+'/convert-wav?path='+encodeURIComponent(q.fullPath));
    if(audioResp.ok){
      audioBuf = await audioResp.arrayBuffer();
    } else {
      const fallback = await fetch(API+'/file?path='+encodeURIComponent(q.fullPath));
      if(!fallback.ok) throw new Error('File not found');
      audioBuf = await fallback.arrayBuffer();
    }
    fN = q.filename || q.title || 'audio';
    lastFilePath = q.fullPath;
    lastHistoryId = q.historyId || null;
    await loadBuf(audioBuf, fN);
    st('✓ Loaded — '+fN, 'ok');
  } catch(e){
    showNotification('Could not load: '+e.message, 'err');
    st('Error: '+e.message, 'err');
  }
}

// ── Auto-clear sweep ────────────────────────────────────────────────────
// Periodically drop done/error items older than the configured threshold.
// Same model as desktop patches 15m/15p. Active items are never swept.
function sweepStaleQueue(){
  if(queueAutoclearHours <= 0) return;
  if(!queue.length) return;
  const cutoff = Date.now() - queueAutoclearHours * 3600 * 1000;
  const before = queue.length;
  queue = queue.filter(q => {
    if(q.status==='waiting' || q.status==='downloading') return true;
    if(!q.finishedAt) return true;
    return q.finishedAt >= cutoff;
  });
  if(queue.length !== before) updateQueueUI();
}

// ══════════════════════════════════════════════════════════════
// PARALLEL DOWNLOAD ENGINE (patch 11)
// ══════════════════════════════════════════════════════════════
// The queue used to be strictly serial — one EventSource at a time, so a
// long WAV grab blocked everything queued behind it. yt-dlp downloads are
// network-bound, not CPU-bound, so the backend handles a few at once
// without breaking a sweat. We now run up to `maxParallel` downloads
// concurrently (default 2, configurable 1-3 in Settings).
//
// Per-row progress bars were already item-scoped; only the global strip
// above the queue needed multi-download awareness (it shows an average +
// "N downloading" when more than one is active).
//
// Auto-loading into the player also changed: with serial downloads every
// finished track was decoded + analyzed immediately, which is fine when
// they arrive one-by-one but causes pointless decode churn when two land
// seconds apart. Now only the LAST finisher (nothing else active or
// waiting) auto-loads; earlier ones keep their "Open" button in the row.
let activeDownloads = 0;
let maxParallel = 2;

function processQueue(){
  while(activeDownloads < maxParallel){
    const item = queue.find(q => q.status === 'waiting');
    if(!item) break;
    startDownload(item);
  }
  queueProcessing = activeDownloads > 0;
  if(!queueProcessing) updateQueueUI();
}

function setMaxParallel(v){
  const n = Math.min(3, Math.max(1, parseInt(v, 10) || 2));
  maxParallel = n;
  try { chrome.storage.local.set({ maxParallel: n }); } catch {}
  // More slots may have opened up — fill them immediately.
  processQueue();
}

// Update the global progress strip from ALL active downloads.
function updateGlobalProg(){
  const active = queue.filter(q => q.status === 'downloading');
  if(!active.length) return;
  if(active.length === 1){
    const p = Math.round(active[0].progress || 0);
    $('progfill').style.width = p + '%';
    $('proglbl').textContent = p + '%';
  } else {
    const avg = active.reduce((s, q) => s + (q.progress || 0), 0) / active.length;
    $('progfill').style.width = Math.round(avg) + '%';
    $('proglbl').textContent = active.length + ' downloading — ' + Math.round(avg) + '%';
  }
}

function startDownload(item){
  activeDownloads++;
  queueProcessing = true;
  item.status = 'downloading';
  item.progress = 0;
  updateQueueUI();

  st('Downloading: '+item.title.slice(0,35)+'…','spin');
  $('progwrap').classList.remove('hide');
  updateGlobalProg();

  // Called from every terminal path (done/error/connection lost) exactly
  // once. Frees the slot and pulls the next waiting item in.
  let finished = false;
  function release(){
    if(finished) return;
    finished = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    if(activeDownloads === 0 && !queue.some(q => q.status === 'waiting')){
      queueProcessing = false;
      setTimeout(()=>{ if(activeDownloads===0) $('progwrap').classList.add('hide'); }, 2000);
    }
    setTimeout(processQueue, 400);
  }

  const params=new URLSearchParams({url:item.url,format:item.fmt});
  const es=new EventSource(API+'/download?'+params);

  es.addEventListener('progress',e=>{
    const p=JSON.parse(e.data).progress;
    item.progress = p;
    updateGlobalProg();
    // Update just this row's progress bar without re-rendering the
    // whole list (avoids button-click target jitter)
    const bar = document.querySelector(`.qi[data-id="${item.id}"] .qbar`);
    if(bar) bar.style.width = Math.round(p)+'%';
    const meta = document.querySelector(`.qi[data-id="${item.id}"] .qmeta span:not(.qfmt)`);
    if(meta) meta.textContent = 'Downloading… '+Math.round(p)+'%';
  });

  es.addEventListener('status',e=>{
    st(JSON.parse(e.data).message,'spin');
  });

  es.addEventListener('done',async e=>{
    es.close();
    const d=JSON.parse(e.data);

    // Stamp the item with done state + the info needed for "Load again"
    item.status = 'done';
    item.progress = 100;
    item.finishedAt = Date.now();
    item.filename = d.filename;
    item.fullPath = d.fullPath;
    item.historyId = d.historyId || null;

    // Auto-match folder tags on the shared desktop DB — same call the
    // desktop app makes after its own downloads, so extension grabs get
    // tagged into seed-matching Stockpile folders too. Best-effort.
    if(item.historyId){
      try{
        const am = await fetch(API+'/stockpile/tracks/'+item.historyId+'/auto-match',{
          method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
        });
        const amJ = await am.json();
        if(amJ.tagged && amJ.tagged.length){
          showNotification('✓ Tagged into: '+amJ.tagged.map(t=>t.folder_name).join(', '),'info');
        }
      }catch{}
    }

    // Patch (0.1.4): we no longer block the UI on auto-load.
    //
    // Previously: only the LAST finisher auto-loaded; others stayed in
    // queue. But even that last auto-load blocked the panel for several
    // seconds (decodeAudioData + in-browser BPM/key analysis), making
    // "Grab another track" feel dead while the previous one was finishing.
    //
    // Now: status toast + queue + history all update immediately, the
    // slot is released right away so the next grab can start, and the
    // decode/analyze runs AFTER the current task in a setTimeout — the
    // user can queue the next track and it's already downloading before
    // the previous one finishes loading into the in-panel player.
    showNotification('✓ Downloaded: '+(d.filename||'Track').slice(0,35),'done');
    updateQueueUI();
    if(backendOnline) loadHist();
    release();

    const othersBusy = activeDownloads > 0 || queue.some(q => q.status === 'waiting');
    if(othersBusy){
      st('✓ '+ (d.filename||'Track').slice(0,30) + ' — queued for review','ok');
      return; // skip auto-load; user can Open from queue
    }

    $('progfill').style.width='100%';
    $('proglbl').textContent='✓ '+d.filename;
    // Deferred so any pending Grab click handlers run before the
    // expensive decode starts.
    setTimeout(async () => {
    st('Loading audio…','spin');

    try{
      const audioResp=await fetch(API+'/convert-wav?path='+encodeURIComponent(d.fullPath));
      if(!audioResp.ok) {
        const fallback=await fetch(API+'/file?path='+encodeURIComponent(d.fullPath));
        if(!fallback.ok) throw new Error('File not found — path may contain special characters');
        const audioBuf=await fallback.arrayBuffer();
        fN=d.filename||'youtube';
        lastFilePath=d.fullPath||null;
        lastHistoryId=d.historyId||null;
        await loadBuf(audioBuf,fN);
      } else {
        const audioBuf=await audioResp.arrayBuffer();
        fN=d.filename||'youtube';
        lastFilePath=d.fullPath||null;
        lastHistoryId=d.historyId||null;
        await loadBuf(audioBuf,fN);
      }

      if(lastFilePath){
        st('✓ Ready — use Export WAV to save to Downloads','ok');
      }

      showNotification('✓ ' + (fN||'Track').slice(0,30) + ' — ' + (cB||'?') + ' BPM · ' + (cK||'?') + ' ' + (cM||''), 'done', ()=>{
        document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
        document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
        document.querySelector('.tabs button[data-i="0"]').classList.add('on');
        $('p0').classList.add('on');
      });

    }catch(err){
      st('Load error: '+err.message,'err');
      showNotification('✕ Failed: '+err.message.slice(0,40),'err');
    }
    // updateQueueUI + loadHist + release already ran above, before the
    // deferred decode started — see the patch comment further up.
    }, 0);
  });

  es.addEventListener('error',e=>{
    es.close();
    let msg='Download failed';
    try{msg=JSON.parse(e.data).message;}catch{}
    // Server now emits actionable text when ffmpeg/yt-dlp are missing —
    // see desktop patches 15c/15d. The full message goes into both the
    // status bar and a notification so the user can read it before it
    // fades. We don't truncate ENOENT-style messages because they
    // contain the exact path the user needs to see.
    st(msg,'err');
    showNotification('✕ '+msg.slice(0,80),'err');
    // Stamp the item as errored — keep it in the queue so the row
    // shows the error inline and the user can see what failed.
    item.status = 'error';
    item.error = msg;
    item.finishedAt = Date.now();
    updateQueueUI();
    release();
  });

  es.onerror=()=>{
    if(es.readyState===EventSource.CLOSED)return;
    es.close();
    st('Connection to engine lost','err');
    // Same treatment as a regular error — mark this item failed, move on.
    item.status = 'error';
    item.error = 'Connection lost';
    item.finishedAt = Date.now();
    updateQueueUI();
    release();
  };
}

// ── Notification system ───────────────────────────────────────────────────────
let notifTimer=null;
function showNotification(msg, type, onClick){
  let el=$('notif');
  if(!el){
    el=document.createElement('div');
    el.id='notif';el.className='notif';
    document.body.appendChild(el);
  }
  el.innerHTML='<div class="notif-dot '+(type||'info')+'"></div><span class="notif-msg">'+msg+'</span><div class="notif-timer"></div>';
  el.className='notif show '+(type||'info');
  el.onclick=()=>{
    el.className='notif';
    if(onClick) onClick();
  };
  clearTimeout(notifTimer);
  // Auto-dismiss after 6s with smooth timer
  const timer=el.querySelector('.notif-timer');
  if(timer) timer.style.animation='notifShrink 6s linear forwards';
  notifTimer=setTimeout(()=>{el.className='notif';},6000);
}

function st(msg,type){$('sbar').classList.remove('hide');$('smsg').textContent=msg;$('sdot').className='sd '+(type||'');}

// ══════════════════════════════════════════════════════════════
// FILE DROP
// ══════════════════════════════════════════════════════════════
function readF(f){fN=f.name;lastFilePath=null;lastHistoryId=null;const r=new FileReader();r.onload=ev=>loadBuf(ev.target.result,f.name);r.readAsArrayBuffer(f);}

// ══════════════════════════════════════════════════════════════
// LOAD AUDIO BUFFER → ANALYZE
// ══════════════════════════════════════════════════════════════
async function loadBuf(arrBuf,name){
  try{
    if(!ax)ax=new AudioContext({sampleRate:44100});
    if(ax.state==='suspended')await ax.resume();
    ab=await ax.decodeAudioData(arrBuf instanceof ArrayBuffer?arrBuf.slice(0):arrBuf);
  }catch(e){st('Decode error: '+e.message,'err');return;}
  if(pl)stopA();if(gn){try{gn.disconnect();}catch{}gn=null;}
  pO=0;pV=0;$('psl').value=0;
  $('results').classList.remove('hide');$('player').classList.remove('hide');
  $('pname').textContent=name;zeroM();
  drawW(ab);$('tt').textContent='0:00/'+fm(ab.duration);
  $('xdur').textContent=Math.round(ab.duration);
  $('xbpm').textContent='…';$('xkey').textContent='…';$('xmode').textContent='…';

  const tag=$('analysisTag');
  const kcEl=$('keycands');
  kcEl.classList.add('hide');

  // ── INSTANT PREVIEW (JS analysis) ──
  tag.className='atag preview';tag.textContent='⏳ PREVIEW — analyzing…';tag.classList.remove('hide');
  st('Quick preview…','spin');

  const[b,k]=await Promise.all([dBPM(ab),dKey(ab)]);
  cB=Math.round(b.bpm);cK=k.key;cM=k.mode;
  $('xbpm').textContent=cB;$('xkey').textContent=cK;$('xmode').textContent=cM;

  if(k.confidence<0.5&&k.candidates&&k.candidates.length>1){
    kcEl.classList.remove('hide');
    kcEl.innerHTML='<div class="kc-warn">LOW CONFIDENCE — verify before using autotune:</div>'+
      k.candidates.map((c,i)=>'<span class="kc-pill'+(i===0?' kc-best':'')+'">'+c.key+' '+c.mode+' <small>'+c.camelot+'</small></span>').join('');
  }

  renderChords(cK,cM);renderCam(cK,cM);updPK(0);
  mBpm=cB;$('metnum').textContent=mBpm;$('metsl').value=mBpm;
  tag.textContent='⚠ PREVIEW — results may differ from final analysis';

  // ── PRO ANALYSIS (Python engine via backend) ──
  if(backendOnline&&lastFilePath){
    tag.className='atag running';tag.textContent='⏳ Running pro analysis engine…';
    st('Running pro analysis…','spin');

    try{
      const es=new EventSource(API+'/analyze?path='+encodeURIComponent(lastFilePath));

      es.addEventListener('done',e=>{
        es.close();
        const r=JSON.parse(e.data);

        // Replace preview values with accurate ones
        if(r.bpm) cB=Math.round(r.bpm);
        if(r.key) cK=r.key;
        if(r.mode) cM=r.mode;
        $('xbpm').textContent=cB;
        $('xkey').textContent=cK;
        $('xmode').textContent=cM;

        // Update key candidates from pro engine
        if(r.key_candidates&&r.key_candidates.length>1&&(r.key_confidence||0)<0.5){
          kcEl.classList.remove('hide');
          kcEl.innerHTML='<div class="kc-warn">LOW CONFIDENCE — verify before using autotune:</div>'+
            r.key_candidates.map((c,i)=>'<span class="kc-pill'+(i===0?' kc-best':'')+'">'+c.key+' '+c.mode+' <small>'+(c.camelot||'')+'</small></span>').join('');
        }else{
          kcEl.classList.add('hide');
        }

        renderChords(cK,cM);renderCam(cK,cM);updPK(0);
        mBpm=cB;$('metnum').textContent=mBpm;$('metsl').value=mBpm;

        // Write accurate results back to history DB
        if(lastHistoryId){
          fetch(API+'/history/'+lastHistoryId+'/analysis',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({bpm:cB,key_note:cK,key_mode:cM})
          }).catch(()=>{});
        }

        // Show accurate tag
        tag.className='atag accurate';
        tag.textContent='✓ ACCURATE';
        st(cB+' BPM — '+cK+' '+cM,'ok');
        setTimeout(()=>$('sbar').classList.add('hide'),3000);
      });

      es.addEventListener('error',e=>{
        es.close();
        // Pro failed — keep preview, mark it
        if(lastHistoryId){
          fetch(API+'/history/'+lastHistoryId+'/analysis',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({bpm:cB,key_note:cK,key_mode:cM})
          }).catch(()=>{});
        }
        tag.className='atag preview';
        tag.textContent='⚠ PREVIEW ONLY — pro engine unavailable';
        st(cB+' BPM — '+cK+' '+cM+' (preview)','ok');
        setTimeout(()=>$('sbar').classList.add('hide'),4000);
      });

      es.onerror=()=>{
        if(es.readyState!==EventSource.CLOSED) es.close();
      };

    }catch{
      tag.className='atag preview';
      tag.textContent='⚠ PREVIEW ONLY — could not reach engine';
      st(cB+' BPM — '+cK+' '+cM+' (preview)','ok');
      setTimeout(()=>$('sbar').classList.add('hide'),4000);
    }
  }else if(!backendOnline){
    // No backend — preview only
    tag.className='atag preview';
    tag.textContent='⚠ PREVIEW — start desktop app for accurate results';
    st(cB+' BPM — '+cK+' '+cM+' (preview)','ok');
    setTimeout(()=>$('sbar').classList.add('hide'),4000);
  }else{
    // Backend online but no file path (dropped file)
    tag.className='atag preview';
    tag.textContent='⚠ PREVIEW — drop from YouTube grab for pro analysis';
    setTimeout(()=>$('sbar').classList.add('hide'),4000);
  }

  // Save to local storage as fallback
  saveH({title:name,bpm:cB,key_note:cK,key_mode:cM,camelot:CAM[cK+' '+cM]||'—',duration:ab.duration,file_path:lastFilePath||null,thumbnail:$('ytimg')?.src||null,created_at:new Date().toISOString()});
}

function zeroM(){for(let i=0;i<6;i++){const e=$('s'+i);if(e){e.style.width='0%';e.style.background='#4caf50';}}['mL','mR'].forEach(i=>{const e=$(i);if(e)e.style.width='0%';});['pL','pR'].forEach(i=>{const e=$(i);if(e)e.style.left='0%';});['xlufs','xshort','xpeak','xrms'].forEach(i=>{const e=$(i);if(e)e.textContent='-∞';});$('xdr').textContent='—';}

// ══════════════════════════════════════════════════════════════
// WAVEFORM
// ══════════════════════════════════════════════════════════════
function drawW(b){const c=$('wave'),w=$('ww');if(!w.offsetWidth){requestAnimationFrame(()=>drawW(b));return;}const dp=devicePixelRatio||1;c.width=w.offsetWidth*dp;c.height=w.offsetHeight*dp;const x=c.getContext('2d');x.scale(dp,dp);const d=b.getChannelData(0),W=w.offsetWidth,H=w.offsetHeight,step=Math.ceil(d.length/W);x.clearRect(0,0,W,H);for(let i=0;i<W;i++){let mn=1,mx=-1;for(let j=0;j<step;j++){const s=d[i*step+j]||0;if(s<mn)mn=s;if(s>mx)mx=s;}x.strokeStyle='rgba(255,255,255,'+(0.12+Math.abs(mx-mn)*0.4)+')';x.lineWidth=1;x.beginPath();x.moveTo(i,((1+mn)/2)*H);x.lineTo(i,((1+mx)/2)*H);x.stroke();}}

// ══════════════════════════════════════════════════════════════
// PLAYBACK
// ══════════════════════════════════════════════════════════════
function togglePlay(){if(!ab)return;pl?stopA():playA();}
function playA(){if(!ab)return;if(ax.state==='suspended')ax.resume();sn=ax.createBufferSource();sn.buffer=ab;sn.playbackRate.value=Math.pow(2,pV/12);gn=ax.createGain();gn.gain.value=mut?0:vol;gn.connect(ax.destination);sn.connect(gn);sn.start(0,pO%ab.duration);sT=ax.currentTime;pl=true;$('pico').innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';sn.onended=()=>{if(pl){pl=false;pO=0;resetP();setPI();stopVU();}};raf();startVU();}
function stopA(){try{sn?.stop();}catch{}pO+=ax.currentTime-sT;pl=false;cancelAnimationFrame(rI);setPI();stopVU();}
function setVol(v){v=parseInt(v);vol=v===0?0:Math.pow(10,((v/100)*40-40)/20);mut=false;if(gn)gn.gain.value=vol;}
function toggleMute(){mut=!mut;if(gn)gn.gain.value=mut?0:vol;}
function setPI(){$('pico').innerHTML='<polygon points="5,3 19,12 5,21"/>';}
function resetP(){$('skf').style.width='0%';$('pb').style.left='0%';if(ab)$('tt').textContent='0:00/'+fm(ab.duration);setPI();}
function raf(){if(!pl)return;const e=(ax.currentTime-sT)+pO,p=Math.min(e/ab.duration,1)*100;$('skf').style.width=p+'%';$('pb').style.left=p+'%';$('tt').textContent=fm(e)+'/'+fm(ab.duration);rI=requestAnimationFrame(raf);}
function seekW(e){doSeek(e,$('ww'));}function seekB(e){doSeek(e,$('skbar'));}
function doSeek(e,el){if(!ab)return;const r=el.getBoundingClientRect(),p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),n=p*ab.duration;if(pl){if(sn){sn.onended=null;try{sn.stop();}catch{}}pl=false;cancelAnimationFrame(rI);stopVU();pO=n;playA();}else{pO=n;$('skf').style.width=(p*100)+'%';$('pb').style.left=(p*100)+'%';$('tt').textContent=fm(pO)+'/'+fm(ab.duration);}}
function setPitch(v){pV=parseInt(v);$('plbl').textContent=v>0?'+'+v:v;if(sn)sn.playbackRate.value=Math.pow(2,pV/12);updPK(pV);}
function updPK(s){if(!cK)return;const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];$('pkey').textContent=N[((N.indexOf(cK)+s)%12+12)%12]+' '+(cM||'');}

// ══════════════════════════════════════════════════════════════
// VU METERING (K-weighted LUFS)
// ══════════════════════════════════════════════════════════════
class KW{constructor(sr){const K=Math.tan(Math.PI*1682/sr),d=1+K/.707+K*K;this.b1=[(1.585+1.259*K/.707+K*K)/d,2*(K*K-1.585)/d,(1.585-1.259*K/.707+K*K)/d];this.a1=[1,2*(K*K-1)/d,(1-K/.707+K*K)/d];const K2=Math.tan(Math.PI*38.14/sr),d2=1+K2/.5+K2*K2;this.b2=[1/d2,-2/d2,1/d2];this.a2=[1,2*(K2*K2-1)/d2,(1-K2/.5+K2*K2)/d2];this.z=[0,0,0,0];}p(x){const y1=this.b1[0]*x+this.z[0];this.z[0]=this.b1[1]*x-this.a1[1]*y1+this.z[1];this.z[1]=this.b1[2]*x-this.a1[2]*y1;const y2=this.b2[0]*y1+this.z[2];this.z[2]=this.b2[1]*y1-this.a2[1]*y2+this.z[3];this.z[3]=this.b2[2]*y1-this.a2[2]*y2;return y2;}blk(s){const o=new Float32Array(s.length);for(let i=0;i<s.length;i++)o[i]=this.p(s[i]);return o;}}
let kwL,kwR,anL,anR,vuI,lufs=[],rmsW=[],phL=-144,phR=-144,pht=0,tpM=-144,fsb=0;
function startVU(){cancelAnimationFrame(vuI);lufs=[];rmsW=[];tpM=-144;phL=-144;phR=-144;pht=0;fsb=0;if(!gn||!ax)return;kwL=new KW(ax.sampleRate);kwR=new KW(ax.sampleRate);const isSt=ab&&ab.numberOfChannels>=2;anL=ax.createAnalyser();anL.fftSize=2048;anL.smoothingTimeConstant=0;if(isSt){const sp=ax.createChannelSplitter(2);gn.connect(sp);anR=ax.createAnalyser();anR.fftSize=2048;anR.smoothingTimeConstant=0;sp.connect(anL,0);sp.connect(anR,1);const mg=ax.createChannelMerger(2),sg=ax.createGain();sg.gain.value=0;anL.connect(mg,0,0);anR.connect(mg,0,1);mg.connect(sg);sg.connect(ax.destination);}else{const sg=ax.createGain();sg.gain.value=0;gn.connect(anL);anL.connect(sg);sg.connect(ax.destination);anR=anL;}
const N=2048,BF=24;let bL=0,bR=0,bc=0;const fb=new Float32Array(N/2+1),tL=new Float32Array(N),tR=new Float32Array(N);let fc=0;
function tk(){if(!pl)return;vuI=requestAnimationFrame(tk);fc++;anL.getFloatTimeDomainData(tL);anR.getFloatTimeDomainData(tR);const kL=kwL.blk(tL),kR=kwR.blk(tR);let pLL=0,pRR=0,sqL=0,sqR=0,kwSL=0,kwSR=0;for(let i=0;i<N;i++){const al=Math.abs(tL[i]),ar=Math.abs(tR[i]);if(al>pLL)pLL=al;if(ar>pRR)pRR=ar;sqL+=tL[i]*tL[i];sqR+=tR[i]*tR[i];kwSL+=kL[i]*kL[i];kwSR+=kR[i]*kR[i];}
const dL=pLL>0?Math.max(-60,20*Math.log10(pLL)):-60,dR=pRR>0?Math.max(-60,20*Math.log10(pRR)):-60;rmsW.push((sqL+sqR)/2/N);if(rmsW.length>18)rmsW.shift();const rms=rmsW.reduce((a,b)=>a+b,0)/rmsW.length,rD=rms>1e-10?Math.max(-60,10*Math.log10(rms)):-60;const tp=Math.max(pLL,pRR);if(tp>Math.pow(10,tpM/20))tpM=20*Math.log10(tp);bL+=kwSL/N;bR+=kwSR/N;bc++;fsb++;if(fsb>=BF){const bp=(bL+bR)/2/bc;if(bp>1e-10)lufs.push(bp);if(lufs.length>150)lufs.shift();bL=0;bR=0;bc=0;fsb=0;}if(dL>phL){phL=dL;pht=0;}if(dR>phR){phR=dR;pht=0;}pht++;if(pht>90){phL-=.3;phR-=.3;if(phL<-60)phL=-60;if(phR<-60)phR=-60;}
uM('L',dL,phL);uM('R',dR,phR);$('vL').textContent=dL<=-59.9?'-∞':dL.toFixed(1);$('vR').textContent=dR<=-59.9?'-∞':dR.toFixed(1);
if(fc%6===0){let iL=null;if(lufs.length>=4){const ag=1e-7,g1=lufs.filter(p=>p>ag);if(g1.length){const m=g1.reduce((a,b)=>a+b,0)/g1.length,rg=m*.1,g2=g1.filter(p=>p>rg);if(g2.length)iL=-.691+10*Math.log10(g2.reduce((a,b)=>a+b,0)/g2.length);}}const sb=lufs.slice(-8),sL=sb.length>1?-.691+10*Math.log10(sb.reduce((a,b)=>a+b,0)/sb.length):null;$('xlufs').textContent=iL!=null?iL.toFixed(1):'-∞';$('xshort').textContent=sL!=null?sL.toFixed(1):'-∞';$('xpeak').textContent=tpM>-144?tpM.toFixed(1):'-∞';$('xrms').textContent=rD<=-59.9?'-∞':rD.toFixed(1);$('xdr').textContent=rD>-60&&tpM>-144?Math.round(tpM-rD):'—';
anL.getFloatFrequencyData(fb);const ny=ax.sampleRate/2,bHz=ny/(N/2);const bP=(lo,hi)=>{const i0=Math.max(1,Math.floor(lo/bHz)),i1=Math.min(fb.length-1,Math.ceil(hi/bHz));if(i1<=i0)return-80;let s=0,c=0;for(let i=i0;i<=i1;i++){s+=Math.pow(10,fb[i]/10);c++;}return c>0?10*Math.log10(s/c):-80;};
[[20,60],[60,250],[250,500],[500,2e3],[2e3,6e3],[6e3,2e4]].forEach(([lo,hi],idx)=>{const f=$('s'+idx);if(!f)return;const p=Math.max(0,Math.min(100,(bP(lo,hi)+80)/70*100));f.style.width=p+'%';f.style.background=p>88?'#e84040':p>68?'#f59e0b':'#4caf50';});}}tk();}
function uM(ch,db,pk){const f=$('m'+ch),p=$('p'+ch);if(!f)return;f.style.width=Math.max(0,Math.min(100,(db+60)/60*100))+'%';f.style.background=db>-3?'#e84040':db>-12?'#f59e0b':'#4caf50';if(p)p.style.left=Math.max(0,Math.min(100,(pk+60)/60*100))+'%';}
function stopVU(){cancelAnimationFrame(vuI);['L','R'].forEach(c=>{const f=$('m'+c),p=$('p'+c),v=$('v'+c);if(f)f.style.width='0%';if(p)p.style.left='0%';if(v)v.textContent='-∞';});['xlufs','xshort','xpeak','xrms'].forEach(i=>{const e=$(i);if(e)e.textContent='-∞';});$('xdr').textContent='—';for(let i=0;i<6;i++){const e=$('s'+i);if(e){e.style.width='0%';e.style.background='#4caf50';}}lufs=[];rmsW=[];tpM=-144;}

// ══════════════════════════════════════════════════════════════
// DRAG GHOST
// ══════════════════════════════════════════════════════════════
function paintGhost(canvas,buf){
  const W=200,H=48;canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='rgba(8,8,8,0.5)';ctx.fillRect(0,0,W,H);
  const d=buf.getChannelData(0),step=Math.ceil(d.length/W);
  for(let i=0;i<W;i++){let mn=1,mx=-1;for(let j=0;j<step;j++){const s=d[i*step+j]||0;if(s<mn)mn=s;if(s>mx)mx=s;}
  ctx.strokeStyle='rgba(255,255,255,'+(0.2+Math.abs(mx-mn)*0.6)+')';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(i,((1+mn)/2)*H);ctx.lineTo(i,((1+mx)/2)*H);ctx.stroke();}
}

// ══════════════════════════════════════════════════════════════
// EXPORT / BPM / KEY / CHORDS / CAMELOT / WAV ENCODER
// ══════════════════════════════════════════════════════════════
function exportWAV(){if(!ab)return;const w=encW(ab),b=new Blob([w],{type:'audio/wav'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=(fN||'audio').replace(/\.[^.]+$/,'')+'.wav';a.click();URL.revokeObjectURL(u);}

async function dBPM(b){
  const sr=b.sampleRate,d=b.getChannelData(0);
  // Skip first 5s (intro), analyze 20s
  const startSec=d.length>sr*20?5:0, durSec=20;
  const s0=Math.floor(startSec*sr), s1=Math.min(s0+Math.floor(durSec*sr),d.length);
  const samples=d.slice(s0,s1);
  if(samples.length<sr*3)return{bpm:120};

  // Onset detection: energy difference in sub-bands
  const fS=1024,h=256,onsets=[];
  let prevE=0;
  for(let i=0;i+fS<samples.length;i+=h){
    let e=0;
    // Emphasize high frequencies (percussive) by weighting
    for(let j=0;j<fS;j++){
      const s=samples[i+j];
      e+=s*s;
      // Simple high-pass emphasis: add derivative energy
      if(j>0) e+=(samples[i+j]-samples[i+j-1])**2 * 2;
    }
    const flux=Math.max(0,e-prevE);
    onsets.push(flux);
    prevE=e;
  }
  if(onsets.length<20)return{bpm:120};
  const fps=sr/h;

  // Adaptive threshold
  const onset=new Float32Array(onsets.length);
  const mW=Math.floor(fps*0.5)|1;
  for(let i=0;i<onsets.length;i++){
    const lo=Math.max(0,i-Math.floor(mW/2)),hi=Math.min(onsets.length,i+Math.floor(mW/2)+1);
    let sum=0;for(let j=lo;j<hi;j++)sum+=onsets[j];
    onset[i]=Math.max(0,onsets[i]-sum/(hi-lo)*1.3);
  }
  let mx=0;for(let i=0;i<onset.length;i++)if(onset[i]>mx)mx=onset[i];
  if(mx>0)for(let i=0;i<onset.length;i++)onset[i]/=mx;

  // Autocorrelation at 0.5 BPM steps
  let bestBpm=120,bestSc=-1;
  for(let b2=120;b2<=400;b2++){
    const bpm=b2/2,period=fps*60/bpm,pi=Math.floor(period);
    if(pi+1>=onset.length)continue;
    const frac=period-pi;let sc=0;const nAc=onset.length-pi-1;
    for(let i=0;i<nAc;i++)sc+=onset[i]*(onset[pi+i]*(1-frac)+onset[pi+i+1]*frac);
    if(sc>bestSc){bestSc=sc;bestBpm=bpm;}
  }

  // Octave check
  for(const cand of[bestBpm*2,bestBpm/2]){
    if(cand<55||cand>210)continue;
    const period=fps*60/cand,pi=Math.floor(period);
    if(pi+1>=onset.length)continue;
    const frac=period-pi;let sc=0;const nAc=onset.length-pi-1;
    for(let i=0;i<nAc;i++)sc+=onset[i]*(onset[pi+i]*(1-frac)+onset[pi+i+1]*frac);
    const bonus=(cand>=70&&cand<=160)?1.05:0.95;
    if(sc*bonus>bestSc){bestSc=sc;bestBpm=cand;}
  }
  return{bpm:Math.round(bestBpm*10)/10};
}

// Proper key detection using FFT-based chroma extraction via OfflineAudioContext
async function dKey(b){
  const sr=b.sampleRate,len=b.length;
  const analyzeLen=Math.min(len,sr*30);
  const fftSize=8192,hop=fftSize/2;
  const chroma=new Float64Array(12);
  const NT=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  const monoBuf=new Float32Array(analyzeLen);
  const srcData=b.getChannelData(0);
  for(let i=0;i<analyzeLen;i++) monoBuf[i]=srcData[i]||0;

  const binHz=sr/fftSize;
  const hann=new Float64Array(fftSize);
  for(let i=0;i<fftSize;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));
  const loIdx=Math.max(1,Math.floor(60/binHz));
  const hiIdx=Math.min(fftSize/2-1,Math.ceil(2000/binHz));

  let frameCount=0;
  for(let pos=0;pos+fftSize<=analyzeLen;pos+=hop){
    const frame=new Float64Array(fftSize);
    for(let i=0;i<fftSize;i++) frame[i]=monoBuf[pos+i]*hann[i];
    for(let k=loIdx;k<=hiIdx;k++){
      const freq=k*binHz;
      if(freq<60||freq>2000) continue;
      let re=0,im=0;const w=2*Math.PI*k/fftSize;
      for(let n=0;n<fftSize;n++){re+=frame[n]*Math.cos(w*n);im-=frame[n]*Math.sin(w*n);}
      const mag=Math.sqrt(re*re+im*im)/fftSize;
      const pc=((Math.round(69+12*Math.log2(freq/440))%12)+12)%12;
      chroma[pc]+=mag*mag;
    }
    frameCount++;
  }

  if(frameCount===0) return{key:'C',mode:'major',confidence:0.1,candidates:[]};

  const nm=a=>{const s=a.reduce((x,y)=>x+y,1e-12);return a.map(v=>v/s);};
  const cn=nm(Array.from(chroma));

  // Multi-profile Pearson correlation — matches Python engine
  const profiles=[
    {maj:[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],min:[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17],w:1.0},
    {maj:[.2410,0,.1473,0,.1708,0,0,.2228,0,.1303,0,.1551],min:[.2362,0,.1336,.1737,0,.1569,0,.2245,0,0,0,.1619],w:1.8},
    {maj:[.2257,.0015,.1419,.0045,.1599,.0789,.0026,.2104,.003,.1139,.0027,.1489],min:[.2222,.0025,.1245,.1624,.0012,.1477,.0021,.2152,.0813,.0031,.0854,.1522],w:1.5},
  ];
  function pearson(a,b){const n=a.length;let sA=0,sB=0;for(let i=0;i<n;i++){sA+=a[i];sB+=b[i];}const mA=sA/n,mB=sB/n;let num=0,dA=0,dB=0;for(let i=0;i<n;i++){const da=a[i]-mA,db=b[i]-mB;num+=da*db;dA+=da*da;dB+=db*db;}const d=Math.sqrt(dA)*Math.sqrt(dB);return d>1e-10?num/d:0;}
  const scores={};let totalW=0;
  for(const p of profiles) totalW+=p.w*2;
  for(const p of profiles){
    for(const[pf,mode]of[[p.maj,'major'],[p.min,'minor']]){
      const pn=nm(pf);
      for(let r=0;r<12;r++){
        const rot=nm([...pn.slice(12-r),...pn.slice(0,12-r)]);
        const k=NT[r]+' '+mode;
        scores[k]=(scores[k]||0)+pearson(cn,rot)*p.w/totalW;
      }
    }
  }
  const sorted=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  const[bK,bM]=sorted[0][0].split(' ');
  const gap=sorted[0][1]-(sorted[1]?sorted[1][1]:0);
  const range=sorted[0][1]-sorted[sorted.length-1][1];
  const conf=Math.min(0.95,Math.max(0.15,gap/(range+1e-10)));
  const cands=sorted.slice(0,3).map(([k,s])=>{const[key,mode]=k.split(' ');return{key,mode,score:Math.round(s*1000)/1000,camelot:CAM[k]||'?'};});
  return{key:bK,mode:bM,confidence:conf,candidates:cands};
}

function renderChords(key,mode){const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],r=N.indexOf(key);const md=[0,2,4,5,7,9,11],nd=[0,2,3,5,7,8,10],mq=[1,0,0,1,1,0,0],nq=[0,0,1,0,0,1,1],dg=mode==='major'?md:nd,q=mode==='major'?mq:nq;const pr=mode==='major'?[[0,3,4,0,'I–IV–V–I'],[0,5,3,4,'I–vi–IV–V'],[0,4,5,3,'I–V–vi–IV']]:[[0,3,4,0,'i–iv–v–i'],[0,6,2,4,'i–VII–III–v'],[0,5,6,3,'i–VI–VII–iv']];$('chords').innerHTML=pr.map(([a,b,c,d,l])=>'<div class="cr">'+[a,b,c,d].map(i=>'<span class="p">'+N[(r+dg[i])%12]+(q[i]?'':'m')+'</span>').join('')+'<span class="ro">'+l+'</span></div>').join('');}
const CAM={'C major':'8B','G major':'9B','D major':'10B','A major':'11B','E major':'12B','B major':'1B','F# major':'2B','C# major':'3B','G# major':'4B','D# major':'5B','A# major':'6B','F major':'7B','A minor':'8A','E minor':'9A','B minor':'10A','F# minor':'11A','C# minor':'12A','G# minor':'1A','D# minor':'2A','A# minor':'3A','F minor':'4A','C minor':'5A','G minor':'6A','D minor':'7A'};
function renderCam(key,mode){const self=CAM[key+' '+mode];if(!self){$('camgrid').innerHTML='';return;}const n=parseInt(self),l=self.slice(-1),comp=new Set([self,((n-2+12)%12+1)+l,(n%12+1)+l,n+(l==='A'?'B':'A')]);$('camgrid').innerHTML=Object.entries(CAM).map(([nm,cd])=>'<div class="ck'+(cd===self?' self':comp.has(cd)?' match':'')+'" title="'+nm+'">'+cd+'<span>'+nm.split(' ')[0]+'</span></div>').join('');}

function encW(ab){const nc=ab.numberOfChannels,sr=ab.sampleRate,len=ab.length,ds=len*nc*2,bs=44+ds,bf=new ArrayBuffer(bs),v=new DataView(bf);function w(o,s){for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));}w(0,'RIFF');v.setUint32(4,36+ds,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nc,true);v.setUint32(24,sr,true);v.setUint32(28,sr*nc*2,true);v.setUint16(32,nc*2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,ds,true);const chs=[];for(let c=0;c<nc;c++)chs.push(ab.getChannelData(c));let off=44;for(let i=0;i<len;i++){for(let c=0;c<nc;c++){const s=Math.max(-1,Math.min(1,chs[c][i]));v.setInt16(off,s<0?s*0x8000:s*0x7FFF,true);off+=2;}}return bf;}

// ══════════════════════════════════════════════════════════════
// NOTES / HISTORY / METRONOME / TAP / SCALE
// ══════════════════════════════════════════════════════════════
let nT=null;
function saveNote(){clearTimeout(nT);nT=setTimeout(()=>{chrome.storage.local.get('fp_n',r=>{const n=r.fp_n||{};n[fN]=$('notesbox').value;chrome.storage.local.set({fp_n:n});});},1200);}
function saveH(e){chrome.storage.local.get('fp_h',r=>{hist=r.fp_h||[];hist.unshift(e);if(hist.length>200)hist=hist.slice(0,200);chrome.storage.local.set({fp_h:hist});});}
// Tracks the highest history id we've rendered, so when new rows arrive
// (e.g. a download finished in THIS panel, or in the desktop app, or in
// another browser window) we can pulse just the new ones instead of
// silently swapping the list. Set after the first render.
let _lastSeenHistId = 0;
let _histPollInterval = null;

function loadHist(){
  // Try backend history first (shared with desktop app)
  if(backendOnline){
    fetch(API+'/history').then(r=>r.json()).then(rows=>{
      hist=rows||[];
      renderHist();
    }).catch(()=>{
      // Fallback to local
      chrome.storage.local.get('fp_h',r=>{hist=r.fp_h||[];renderHist();});
    });
  }else{
    chrome.storage.local.get('fp_h',r=>{hist=r.fp_h||[];renderHist();});
  }
}

// Lightweight live-refresh: when the History tab is the active pane AND
// the backend is online, re-fetch history every few seconds. New rows
// (from this panel, the desktop app, or another window) appear and get
// a brief pulse. We only poll while History is visible to avoid wasting
// requests — most of the time the user is on Analyze/Tools.
function startHistLivePoll(){
  if(_histPollInterval) return;
  _histPollInterval = setInterval(()=>{
    const histPaneVisible = document.getElementById('p2')?.classList.contains('on');
    if(!histPaneVisible || !backendOnline) return;
    fetch(API+'/history').then(r=>r.json()).then(rows=>{
      if(!Array.isArray(rows)) return;
      // Only re-render if something actually changed — compare the top
      // id and the length. Cheap dirty-check avoids needless DOM churn.
      const topId = rows.length ? (rows[0].id||0) : 0;
      if(topId !== (hist[0]?.id||0) || rows.length !== hist.length){
        hist = rows;
        renderHist();
      }
    }).catch(()=>{});
  }, 4000);
}
function renderHist(){const q=($('hsrch')?.value||'').toLowerCase(),l=$('hlist');const rows=hist.filter(h=>!q||(h.title||'').toLowerCase().includes(q));if(!rows.length){l.innerHTML='<div class="he">'+(q?'No matches':'No history yet')+'</div>';return;}
// Determine which rows are "new" since the last render so we can pulse
// them. On the very first render we set the baseline without pulsing
// (otherwise every row would pulse on panel open).
const prevSeen = _lastSeenHistId;
const maxId = rows.reduce((m,h)=>Math.max(m, h.id||0), 0);
l.innerHTML=rows.map((h,i)=>{
  const thumb=h.thumbnail?'<img class="hr-thumb" src="'+h.thumbnail+'" alt=""/>':'<div class="hr-thumb hr-nothumb"></div>';
  const bpm=h.bpm?Math.round(h.bpm):'';
  const key=h.key_note?(h.key_note+' '+(h.key_mode||'')):'';
  const dur=h.duration?Math.round(h.duration)+'s':'';
  const fmt=h.format?h.format.toUpperCase():'';
  const date=(h.created_at||'').slice(0,16);
  // Mark rows newer than what we'd seen before as pulse targets — but
  // only when this isn't the first-ever render (prevSeen>0).
  const isNew = prevSeen > 0 && (h.id||0) > prevSeen;
  return '<div class="hr'+(isNew?' row-pulse':'')+'" data-idx="'+i+'">'+thumb+'<div class="i"><b>'+(h.title||'?')+'</b><small>'+[h.channel,date,dur].filter(Boolean).join(' · ')+'</small></div><div class="bg">'+(bpm?'<span>'+bpm+'</span>':'')+(key?'<span>'+key+'</span>':'')+(fmt?'<span>'+fmt+'</span>':'')+'</div></div>';
}).join('');
// Update the baseline so the next render only pulses things newer still.
_lastSeenHistId = maxId;
l.querySelectorAll('.hr').forEach(row=>{
  row.addEventListener('click',()=>{
    const idx=parseInt(row.dataset.idx);
    const filtered=hist.filter(h=>!q||(h.title||'').toLowerCase().includes(q));
    const h=filtered[idx];
    if(h) loadFromHist(h);
  });
  // Clean up the pulse class after it finishes so re-renders don't
  // re-trigger it on the same row.
  if(row.classList.contains('row-pulse')){
    setTimeout(()=>row.classList.remove('row-pulse'), 4000);
  }
});
}

async function loadFromHist(h){
  if(h.file_path&&backendOnline){
    st('Loading '+h.title+'…','spin');
    // Switch to analyze tab
    document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
    document.querySelector('.tabs button[data-i="0"]').classList.add('on');
    $('p0').classList.add('on');
    try{
      const r=await fetch(API+'/convert-wav?path='+encodeURIComponent(h.file_path));
      if(!r.ok) throw new Error('File not found — may have been moved');
      const wavBuf=await r.arrayBuffer();
      fN=h.title||'audio';
      lastFilePath=h.file_path;
      lastHistoryId=h.id||null;
      // Set thumbnail if available
      if(h.thumbnail&&$('ytimg')){$('ytimg').src=h.thumbnail;}
      await loadBuf(wavBuf,fN);
    }catch(e){
      st('Could not load: '+e.message,'err');
    }
  }else if(h.file_path&&!backendOnline){
    st('Start the Freq.Phull app to reload tracks','err');
  }else{
    st('No file path saved for this track','err');
  }
}
function clearH(){
  if(!confirm('Clear local history? (Backend history is managed from the desktop app)'))return;
  chrome.storage.local.set({fp_h:[]});
  loadHist();
}

function toggleMet(){if(mOn){mOn=false;clearTimeout(mI);$('metbtn').textContent='Start';document.querySelectorAll('.bd').forEach(d=>d.classList.remove('lit'));}else{mOn=true;mB=0;$('metbtn').textContent='Stop';if(!mC)mC=new AudioContext();schB();}}
function schB(){if(!mOn)return;const sig=parseInt($('metsig').value),w=$('metbeat');if(w.children.length!==sig)w.innerHTML=Array(sig).fill('<div class="bd"></div>').join('');document.querySelectorAll('.bd').forEach((d,i)=>d.classList.toggle('lit',i===mB));const o=mC.createOscillator(),g=mC.createGain();o.connect(g);g.connect(mC.destination);o.frequency.value=mB===0?1e3:600;g.gain.setValueAtTime(.3,mC.currentTime);g.gain.exponentialRampToValueAtTime(.001,mC.currentTime+.08);o.start();o.stop(mC.currentTime+.08);mB=(mB+1)%sig;mI=setTimeout(schB,6e4/mBpm);}
function tapB(){const now=performance.now();taps.push(now);if(taps.length>8)taps.shift();if(taps.length<2){$('tapc').textContent='keep tapping…';return;}const avg=taps.slice(1).reduce((s,t,i)=>s+(t-taps[i]),0)/(taps.length-1);$('tapn').textContent=Math.round(6e4/avg);$('tapc').textContent=taps.length+' taps';clearTimeout(window._tt);window._tt=setTimeout(()=>{taps=[];$('tapn').textContent='—';$('tapc').textContent='tap at least 4 times';},2500);}
function renderRef(){const key=$('rk')?.value||'C',mode=$('rm')?.value||'major';const N=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],r=N.indexOf(key);const steps=mode==='major'?[0,2,4,5,7,9,11]:[0,2,3,5,7,8,10],sc=steps.map(s=>N[(r+s)%12]);const mq=['maj','min','min','maj','maj','min','dim'],nq=['min','dim','maj','min','min','maj','maj'],q=mode==='major'?mq:nq;const rm=mode==='major'?['I','ii','iii','IV','V','vi','vii°']:['i','ii°','III','iv','v','VI','VII'];$('rout').innerHTML='<div style="margin-bottom:4px;font-size:9px;color:var(--m)">'+sc.join(' · ')+'</div><div style="display:flex;flex-wrap:wrap;gap:2px">'+sc.map((n,i)=>'<div class="sn"><div class="r">'+rm[i]+'</div><div class="n">'+n+'</div><div class="q">'+q[i]+'</div></div>').join('')+'</div>';}
function fm(s){s=Math.max(0,s||0);return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');}
