// ╔════════════════════════════════════════════════════════════════════════╗
// ║  Mini-DAW for Freq.Phull                                                ║
// ║  ─────────────────────                                                  ║
// ║  Full-page timeline editor that opens after stems are separated.        ║
// ║  Lets the user cut, move, and trim clips per stem track + adjust        ║
// ║  per-track mute/solo/volume. Plays back the arrangement and exports     ║
// ║  to a single mixdown WAV.                                               ║
// ║                                                                          ║
// ║  Data model (all in `dawState`):                                        ║
// ║    tracks: array of { stemIndex, name, color, clips[], muted, soloed,   ║
// ║                       volume, gainNode, height }                        ║
// ║    clips:  array per track of { id, startTime, duration, bufferOffset } ║
// ║      • startTime    = where the clip BEGINS on the timeline (seconds)   ║
// ║      • duration     = how long the clip plays                           ║
// ║      • bufferOffset = where in the source buffer the clip starts        ║
// ║      So splitting a clip means [0..S][S..end] → two clips, second has   ║
// ║      bufferOffset = first.bufferOffset + S and startTime = original     ║
// ║      startTime + S. Trimming means adjusting startTime + duration +     ║
// ║      bufferOffset together so the audio stays at the same wall-clock    ║
// ║      content.                                                            ║
// ║                                                                          ║
// ║  Playback:                                                              ║
// ║    On play, walk every clip in every track that's in the future of      ║
// ║    playhead. For each, schedule a BufferSourceNode → trackGain →        ║
// ║    masterGain → destination, with the right start delay + offset +      ║
// ║    duration. Stop all via a generation counter so a quick               ║
// ║    pause/resume doesn't leak audio from old sources.                    ║
// ║                                                                          ║
// ║  Rendering:                                                             ║
// ║    Each track has a <canvas> spanning the timeline. We blit the         ║
// ║    pre-computed peaks (already in sepAudioMap[i].buffer) sliced per     ║
// ║    clip onto its visible region. Pan/zoom changes trigger a full       ║
// ║    repaint; clip drag/resize re-paints just the affected track.         ║
// ╚════════════════════════════════════════════════════════════════════════╝

// ── State ────────────────────────────────────────────────────────────────
let dawState = null;
let dawCtx = null;          // dedicated AudioContext for DAW playback
let dawMasterGain = null;   // master output
let dawSourcesGen = 0;      // generation counter — increments on every stop
let dawActiveSources = [];  // currently-scheduled BufferSourceNodes
let dawIsPlaying = false;
let dawPlayheadTime = 0;    // seconds from timeline start
let dawPlayStartCtxTime = 0; // audioCtx.currentTime when play() started
let dawPlayStartHeadTime = 0; // playheadTime when play() started
let dawRaf = null;
let dawPxPerSec = 80;       // zoom level: 80px = 1 second by default
let dawTotalDuration = 0;   // longest track length, sets timeline width
let dawDragState = null;    // active mouse interaction: { type, trackIdx, clipIdx, ... }

// Track height in px; rows are uniform. Wider than the legacy mixer rows
// because we now show waveforms across the full clip width.
const DAW_TRACK_HEIGHT = 96;
const DAW_HEADER_HEIGHT = 36;     // ruler row at top
const DAW_TRACK_HEAD_WIDTH = 220; // left-side per-track controls width (name, M, S, vol, pan)

// Stem color palette — same as the existing mixer so users see consistent
// per-stem coloring across compact and DAW views.
const DAW_STEM_COLORS = {
  vocals: '#7ed982', vocal: '#7ed982', voice: '#7ed982',
  drums: '#ff9966', drum: '#ff9966', percussion: '#ff9966',
  bass: '#66aaff',
  guitar: '#ffb84d',
  piano: '#c490ff', keys: '#c490ff',
  other: '#999999', instrumental: '#999999',
  lead_vocal: '#a8ff8a', back_vocal: '#7ed982', sample_vocal: '#5dbf66'
};

function _dawColorFor(name) {
  const n = (name || '').toLowerCase();
  for (const key of Object.keys(DAW_STEM_COLORS)) {
    if (n.indexOf(key) >= 0) return DAW_STEM_COLORS[key];
  }
  return '#999';
}

// ── Public API ───────────────────────────────────────────────────────────

// Called from the Separator results screen. Initializes state from the
// current sepAudioMap, mounts the DAW DOM, and animates it in.
function openMiniDAW() {
  if (!sepAudioMap || Object.keys(sepAudioMap).length === 0) {
    if (typeof showAppNotification === 'function') {
      showAppNotification('No stems to load', 'info');
    }
    return;
  }

  // Lazily build Web Audio AudioBuffers from the raw WAV bytes the mixer
  // already cached. The mixer pipeline uses MediaElementSource bindings,
  // which can't be scheduled against a timeline — the DAW needs proper
  // AudioBuffers driven by BufferSourceNode. We decode here once on first
  // open, then keep the buffer on the entry for subsequent reopens.
  // Done synchronously since parseWAV is fast (~30ms per 30MB stem).
  _dawEnsureCtx();
  let decodedAny = false;
  for (const k of Object.keys(sepAudioMap)) {
    const entry = sepAudioMap[k];
    if (!entry) continue;
    if (entry.buffer) { decodedAny = true; continue; }
    if (!entry.rawWavBytes) continue;
    try {
      // parseWAV is defined in app.js — reads RIFF/WAVE/fmt/data chunks
      // and returns a real AudioBuffer. Avoids decodeAudioData which
      // hangs in packaged Electron on Windows.
      entry.buffer = parseWAV(entry.rawWavBytes, dawCtx);
      decodedAny = true;
    } catch (e) {
      if (typeof diagLog === 'function') {
        diagLog('DAW: failed to decode stem ' + k + ': ' + e.message, 'err');
      }
    }
  }
  if (!decodedAny) {
    if (typeof showAppNotification === 'function') {
      showAppNotification('Stems not ready yet — wait a moment', 'info');
    }
    return;
  }

  // Build the track list from sepAudioMap. We only include stems that have
  // a decoded buffer — anything still loading is skipped (rare; usually all
  // are loaded by the time the user clicks Open DAW).
  const tracks = [];
  // Use stemOrder so we respect the user's reordering from the mixer view.
  const order = (typeof stemOrder !== 'undefined' && Array.isArray(stemOrder) && stemOrder.length)
                ? stemOrder
                : Object.keys(sepAudioMap).map(k => parseInt(k));
  for (const idx of order) {
    const entry = sepAudioMap[idx];
    if (!entry || !entry.buffer) continue;
    const name = _dawStemName(entry.path);
    tracks.push({
      stemIndex: idx,
      name,
      color: _dawColorFor(name),
      buffer: entry.buffer,        // shared reference; we don't mutate
      sampleRate: entry.buffer.sampleRate,
      duration: entry.buffer.duration,
      peaks: entry.peaks,          // existing precomputed peaks (1px resolution)
      // Initial single clip spanning the entire buffer
      clips: [{
        id: 'c_' + idx + '_0',
        startTime: 0,
        duration: entry.buffer.duration,
        bufferOffset: 0
      }],
      muted: entry.muted || false,
      soloed: entry.soloed || false,
      volume: typeof entry.volume === 'number' ? entry.volume : 1.0,
      pan: typeof entry.pan === 'number' ? entry.pan : 0,  // center default
      gainNode: null,   // assigned on first play
      panNode: null,    // assigned on first play (StereoPannerNode)
    });
  }

  if (tracks.length === 0) {
    if (typeof showAppNotification === 'function') {
      showAppNotification('Stems not ready yet — wait a moment', 'info');
    }
    return;
  }

  dawState = {
    tracks,
    selectedClip: null,    // { trackIdx, clipIdx } or null
    nextClipId: 1000       // monotonic ID counter for split clips
  };
  dawTotalDuration = Math.max(...tracks.map(t => t.duration));
  dawPlayheadTime = 0;
  dawIsPlaying = false;

  // Stop any audio still playing from the legacy mixer — they share the
  // audio output device and we don't want double playback.
  try { if (typeof stopAllStems === 'function') stopAllStems(); } catch {}
  try { if (typeof mixerStopAll === 'function') mixerStopAll(); } catch {}

  _dawMountDOM();
  _dawAnimateOpen();
  _dawRenderAll();
}

// Tear down the DAW. Stops playback, unmounts DOM, releases audio nodes.
function closeMiniDAW() {
  _dawStopPlayback();
  if (dawRaf) { cancelAnimationFrame(dawRaf); dawRaf = null; }
  const overlay = document.getElementById('daw-overlay');
  if (overlay) {
    overlay.classList.add('out');
    setTimeout(() => {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 340);
  }
  // Don't fully tear down dawCtx — keep it warm in case user reopens.
  // The sources are already disconnected on stop.
  dawState = null;
}

// ── Stem name detection (from file path) ──────────────────────────────────
function _dawStemName(filePath) {
  if (!filePath) return 'stem';
  const base = filePath.split(/[\\/]/).pop() || '';
  // Common patterns: "vocals.wav", "stem_vocals.wav", "song (Vocals).wav"
  const m = base.match(/(vocals|drums|bass|guitar|piano|other|lead[-_ ]?vocal|back(?:ing)?[-_ ]?vocal|sample[-_ ]?vocal|instrumental)/i);
  if (m) return m[1].toLowerCase().replace(/[-_ ]/g, '_');
  // Fallback: filename without extension
  return base.replace(/\.[^.]+$/, '').toLowerCase();
}

// ── DOM mount ────────────────────────────────────────────────────────────
function _dawMountDOM() {
  // Remove any leftover overlay first (defensive)
  const old = document.getElementById('daw-overlay');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const overlay = document.createElement('div');
  overlay.id = 'daw-overlay';
  overlay.className = 'daw-overlay';
  overlay.innerHTML = `
    <div class="daw-header">
      <div class="daw-header-left">
        <button class="daw-back-btn" id="daw-back-btn" type="button" title="Back to mixer (Esc)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          <span>Mixer</span>
        </button>
        <div class="daw-title">Mini-DAW</div>
      </div>
      <div class="daw-toolbar">
        <!-- Tool mode buttons — left-most group -->
        <div class="daw-tool-group" role="group" aria-label="Tools">
          <button class="daw-tool" id="daw-tool-select" type="button" data-tool="select" title="Select (V) — click to select, drag clip to move, drag edges to trim">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 2 21 12 12 14 9 21 3 2"/></svg>
          </button>
          <button class="daw-tool" id="daw-tool-cut" type="button" data-tool="cut" title="Scissors (C) — click on a clip to split at that exact point">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          </button>
        </div>
        <!-- Transport — center group -->
        <div class="daw-tool-group" role="group" aria-label="Transport">
          <button class="daw-tbtn" id="daw-play-btn" type="button" title="Play / Pause (Space)">
            <svg id="daw-play-svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <button class="daw-tbtn-stop" id="daw-stop-btn" type="button" title="Stop (Esc)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14"/></svg>
          </button>
          <div class="daw-time" id="daw-time">0:00 / 0:00</div>
        </div>
        <!-- Edit actions -->
        <div class="daw-tool-group" role="group" aria-label="Edit">
          <button class="daw-tool" id="daw-split-btn" type="button" title="Split at playhead (S)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="6 9 12 3 18 9"/></svg>
          </button>
          <button class="daw-tool" id="daw-delete-btn" type="button" title="Delete selected clip (Del)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </div>
      <div class="daw-header-right">
        <!-- Master fader. Slider 0..1.5 with current value in dB shown next.
             Stored in localStorage so the user's level setting persists
             between sessions. Defaults to 0.85 (-1.4 dB) which gives the
             limiter chain comfortable headroom on typical mixes. -->
        <div class="daw-master-fader" title="Master volume — Ctrl+Click to reset">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted);flex-shrink:0">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
          <input class="daw-master-vol-slider" id="daw-master-vol-slider" type="range" min="0" max="1.5" step="0.01" value="${dawMasterVolume}" title="Master volume">
          <span class="daw-master-vol-db" id="daw-master-vol-db">${dawMasterVolume <= 0.001 ? '−∞' : (20 * Math.log10(dawMasterVolume)).toFixed(1) + ' dB'}</span>
        </div>
        <div class="daw-tool-group">
          <button class="daw-tbtn-sm" id="daw-zoom-out-btn" type="button" title="Zoom out (−)">−</button>
          <button class="daw-tbtn-sm" id="daw-zoom-in-btn" type="button" title="Zoom in (+)">+</button>
        </div>
        <button class="daw-export-btn" id="daw-export-btn" type="button" title="Export mixdown WAV">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Export</span>
        </button>
      </div>
    </div>
    <div class="daw-body">
      <div class="daw-tracks-area" id="daw-tracks-area">
        <div class="daw-ruler-wrap">
          <div class="daw-track-head daw-ruler-head"></div>
          <canvas class="daw-ruler" id="daw-ruler" height="${DAW_HEADER_HEIGHT}"></canvas>
        </div>
        <div class="daw-tracks" id="daw-tracks"></div>
      </div>
    </div>
    <div class="daw-hint" id="daw-hint">
      <span>Space play · S split at playhead · V select · B/C scissors · Ctrl+Wheel zoom · Shift+Wheel scroll · Del to delete · Esc to close</span>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Bind buttons via addEventListener instead of inline onclick ────────────
  // Inline onclick attributes resolve via global scope, which works for
  // top-level function decls in scripts BUT can be flaky if the SVG inside
  // the button absorbs the click before it bubbles. Binding directly to the
  // button (not its children) + using pointer-events:none on child SVGs
  // (added in CSS) ensures every click reliably lands on the button itself.
  //
  // Defensive: also wire mousedown as backup AND register a delegated
  // click handler on the overlay so even if the button-direct bind fails
  // for some weird Electron reason, the delegated handler picks it up
  // when the click bubbles to the overlay.
  const HANDLERS = {
    'daw-back-btn':     () => closeMiniDAW(),
    'daw-tool-select':  () => _dawSetTool('select'),
    'daw-tool-cut':     () => _dawSetTool('cut'),
    'daw-play-btn':     () => dawTogglePlay(),
    'daw-stop-btn':     () => dawStop(),
    'daw-split-btn':    () => dawSplitAtPlayhead(),
    'daw-delete-btn':   () => dawDeleteSelectedClip(),
    'daw-zoom-out-btn': () => dawZoom(-1),
    'daw-zoom-in-btn':  () => dawZoom(1),
    'daw-export-btn':   () => dawExportMixdown(),
  };
  for (const id of Object.keys(HANDLERS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      HANDLERS[id]();
    });
  }
  // Delegated fallback — if any click inside the header bubbles up without
  // hitting one of the direct bindings (e.g. event was fired on the SVG
  // child of a button before our pointer-events:none kicked in), walk up
  // to find the nearest [id^="daw-"] button and run its handler. Saves us
  // from edge cases where the direct bind silently fails.
  const header = overlay.querySelector('.daw-header');
  if (header) {
    header.addEventListener('click', (ev) => {
      // Find the closest button ancestor with a registered handler
      let node = ev.target;
      while (node && node !== header) {
        if (node.id && HANDLERS[node.id]) {
          ev.preventDefault();
          ev.stopPropagation();
          HANDLERS[node.id]();
          return;
        }
        node = node.parentNode;
      }
    }, true); // capture phase so we beat any other click handlers
  }

  // Master volume slider (oninput, not in HANDLERS because it's an input
  // not a button). Ctrl-click resets to default 0.85 (-1.4 dB).
  const masterSld = document.getElementById('daw-master-vol-slider');
  if (masterSld) {
    masterSld.addEventListener('input', (ev) => {
      dawSetMasterVolume(ev.target.value);
    });
    masterSld.addEventListener('click', (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        masterSld.value = '0.85';
        dawSetMasterVolume(0.85);
      }
    });
  }

  // Start in select mode
  _dawSetTool('select');

  // Bind ruler click for playhead positioning
  const ruler = document.getElementById('daw-ruler');
  if (ruler) {
    ruler.addEventListener('click', _dawRulerClick);
    ruler.addEventListener('mousemove', _dawRulerHover);
  }

  // Bind global keys (Space, S, V, C, Esc) while DAW open.
  // We use bubble phase (not capture) so when a button has focus and the
  // user hits Space, the browser's native button-click fires first and
  // our handler skips it. This was the source of the "Space works but
  // mouse click doesn't" bug — capture-phase keydown was racing the
  // implicit button click.
  document.addEventListener('keydown', _dawKeydown, false);

  // FL Studio-style mouse wheel handlers — only fire when the wheel event
  // originates inside the DAW. We use the daw-body as the scope so wheel
  // events outside the overlay (in case the user has something else open)
  // don't affect the DAW.
  const body = document.querySelector('.daw-body');
  if (body) {
    body.addEventListener('wheel', _dawWheel, { passive: false });
  }
}

// ── FL Studio-style mouse wheel ─────────────────────────────────────────
// Mirrors the most-loved zoom/scroll behaviors from FL Studio's playlist:
//   • Ctrl + wheel → zoom in/out (centered on cursor x for natural feel)
//   • Shift + wheel → scroll horizontally
//   • Plain wheel → scroll vertically (the browser default — we don't
//     intercept this, just let it through)
// Pending zoom batch — wheel events come in 5-30 per second on a fast
// scroll. Without coalescing, each one triggered a full canvas repaint
// chain. We accumulate the zoom factor and apply once per animation frame.
let _dawZoomPending = null;

function _dawWheel(ev) {
  // Plain wheel = let browser handle vertical scroll. No work for us.
  if (!ev.ctrlKey && !ev.shiftKey && !ev.metaKey) return;
  ev.preventDefault();

  const body = ev.currentTarget;

  if (ev.ctrlKey || ev.metaKey) {
    // Zoom — direction follows wheel sign. Compute the time-position under
    // the cursor BEFORE the zoom so we can scroll the view so the cursor
    // stays on the same point in the timeline after zoom (natural feel).
    const rect = body.getBoundingClientRect();
    const xInBody = ev.clientX - rect.left;
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;  // smaller per-tick step so coalesced zooms feel smooth

    // Accumulate into pending batch. Each wheel tick multiplies the factor;
    // when rAF fires we apply the cumulative product as a single zoom.
    if (_dawZoomPending) {
      _dawZoomPending.factor *= factor;
      _dawZoomPending.xInBody = xInBody; // last cursor pos wins
      return;
    }
    _dawZoomPending = { factor, xInBody };
    requestAnimationFrame(() => {
      const pending = _dawZoomPending;
      _dawZoomPending = null;
      if (!pending) return;
      const oldPx = dawPxPerSec;
      const newPx = Math.max(20, Math.min(400, oldPx * pending.factor));
      if (newPx === oldPx) return;
      // Re-compute the time-position under the cursor against the OLD scale
      // so the cursor stays glued to its content position after zoom.
      const scrollX = body.scrollLeft;
      const xInTimeline = pending.xInBody + scrollX - DAW_TRACK_HEAD_WIDTH;
      const timeAtCursor = Math.max(0, xInTimeline / oldPx);
      dawPxPerSec = newPx;
      _dawZoomRepaint();
      const newXInTimeline = timeAtCursor * dawPxPerSec;
      body.scrollLeft = newXInTimeline - pending.xInBody + DAW_TRACK_HEAD_WIDTH;
    });
    return;
  }
  if (ev.shiftKey) {
    // Horizontal scroll — speed = ~80px per wheel notch
    body.scrollLeft += (ev.deltaY > 0 ? 80 : -80);
    return;
  }
}

// Current tool mode — 'select' or 'cut'. In cut mode, clicking on a clip
// splits it at the click point instead of selecting/dragging. Persisted
// via dawState so the per-clip mouse handlers can branch on it.
let _dawCurrentTool = 'select';
function _dawSetTool(tool) {
  _dawCurrentTool = tool;
  for (const t of ['select', 'cut']) {
    const btn = document.getElementById('daw-tool-' + t);
    if (btn) btn.classList.toggle('on', t === tool);
  }
  // Change body cursor while in cut mode so users see the tool is active
  const body = document.getElementById('daw-overlay');
  if (body) body.classList.toggle('cut-mode', tool === 'cut');
}

function _dawAnimateOpen() {
  const overlay = document.getElementById('daw-overlay');
  if (!overlay) return;
  overlay.classList.add('opening');
  // Force reflow then transition
  void overlay.offsetWidth;
  requestAnimationFrame(() => {
    overlay.classList.remove('opening');
  });
}

// ── Rendering ────────────────────────────────────────────────────────────

function _dawRenderAll() {
  _dawRenderRuler();
  _dawRenderTracks();
  _dawRenderPlayhead();
  _dawUpdateTimeLabel();
}

function _dawTimelineWidthPx() {
  return Math.max(800, Math.ceil(dawTotalDuration * dawPxPerSec) + 200);
}

function _dawRenderRuler() {
  const canvas = document.getElementById('daw-ruler');
  if (!canvas) return;
  const w = _dawTimelineWidthPx();
  canvas.width = w;
  canvas.style.width = w + 'px';
  canvas.height = DAW_HEADER_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, DAW_HEADER_HEIGHT);
  // Background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, w, DAW_HEADER_HEIGHT);
  // Ticks: every second, with major label every 5s
  ctx.fillStyle = '#666';
  ctx.font = '10px Inter, sans-serif';
  ctx.textBaseline = 'middle';
  const totalSec = Math.ceil(w / dawPxPerSec);
  for (let s = 0; s <= totalSec; s++) {
    const x = Math.round(s * dawPxPerSec) + 0.5;
    const major = (s % 5 === 0);
    ctx.strokeStyle = major ? '#888' : '#333';
    ctx.beginPath();
    ctx.moveTo(x, major ? 14 : 22);
    ctx.lineTo(x, DAW_HEADER_HEIGHT - 2);
    ctx.stroke();
    if (major) {
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      ctx.fillStyle = '#aaa';
      ctx.fillText(mm + ':' + (ss < 10 ? '0' : '') + ss, x + 3, 8);
    }
  }
  // Playhead line is drawn on top of tracks separately; ruler shows a
  // small triangle at the playhead position too
  const ph = Math.round(dawPlayheadTime * dawPxPerSec) + 0.5;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(ph - 5, 0);
  ctx.lineTo(ph + 5, 0);
  ctx.lineTo(ph, 6);
  ctx.closePath();
  ctx.fill();
}

function _dawRenderTracks() {
  const wrap = document.getElementById('daw-tracks');
  if (!wrap || !dawState) return;
  wrap.innerHTML = '';
  const timelineW = _dawTimelineWidthPx();
  dawState.tracks.forEach((tr, ti) => {
    const row = document.createElement('div');
    row.className = 'daw-track-row';
    row.dataset.trackIdx = String(ti);
    row.style.height = DAW_TRACK_HEIGHT + 'px';
    // Header (left side): track name + mute/solo/volume
    const head = document.createElement('div');
    head.className = 'daw-track-head';
    head.style.width = DAW_TRACK_HEAD_WIDTH + 'px';
    head.innerHTML = `
      <div class="daw-track-name" style="color:${tr.color}">${_escapeHTML(_prettyName(tr.name))}</div>
      <div class="daw-track-controls">
        <button class="daw-mute-btn ${tr.muted ? 'on' : ''}" type="button" data-act="mute" title="Mute (M)">M</button>
        <button class="daw-solo-btn ${tr.soloed ? 'on-solo' : ''}" type="button" data-act="solo" title="Solo">S</button>
        <input class="daw-vol-slider" type="range" min="0" max="1" step="0.01" value="${tr.volume}" title="Volume">
      </div>
      <div class="daw-pan-row">
        <span class="daw-pan-label-l">L</span>
        <input class="daw-pan-slider" type="range" min="-1" max="1" step="0.01" value="${tr.pan || 0}" title="Pan — double-click to center">
        <span class="daw-pan-label-r">R</span>
      </div>
    `;
    // Bind reliably — same approach as toolbar buttons
    const muteBtn = head.querySelector('[data-act="mute"]');
    const soloBtn = head.querySelector('[data-act="solo"]');
    const volSld  = head.querySelector('.daw-vol-slider');
    const panSld  = head.querySelector('.daw-pan-slider');
    if (muteBtn) muteBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); dawToggleMute(ti); });
    if (soloBtn) soloBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); dawToggleSolo(ti); });
    if (volSld)  volSld.addEventListener('input', (ev) => { dawSetVolume(ti, ev.target.value); });
    if (panSld)  {
      panSld.addEventListener('input', (ev) => { dawSetPan(ti, ev.target.value); });
      // Double-click pan to center — standard DAW gesture
      panSld.addEventListener('dblclick', (ev) => { ev.preventDefault(); dawResetPan(ti); });
    }
    row.appendChild(head);
    // Lane (right side): full-width canvas + per-clip divs for hit detection
    const lane = document.createElement('div');
    lane.className = 'daw-track-lane';
    lane.style.width = timelineW + 'px';
    lane.style.height = DAW_TRACK_HEIGHT + 'px';
    // Canvas for waveform
    const cvs = document.createElement('canvas');
    cvs.className = 'daw-track-canvas';
    cvs.id = 'daw-track-canvas-' + ti;
    cvs.width = timelineW;
    cvs.height = DAW_TRACK_HEIGHT;
    cvs.style.width = timelineW + 'px';
    cvs.style.height = DAW_TRACK_HEIGHT + 'px';
    lane.appendChild(cvs);
    // Clip overlay divs — for click/drag hit testing. The canvas paints the
    // waveform; these divs sit on top transparent and absorb input.
    tr.clips.forEach((clip, ci) => {
      const cd = document.createElement('div');
      cd.className = 'daw-clip';
      cd.dataset.trackIdx = String(ti);
      cd.dataset.clipIdx = String(ci);
      const x = Math.round(clip.startTime * dawPxPerSec);
      const w = Math.max(8, Math.round(clip.duration * dawPxPerSec));
      cd.style.left = x + 'px';
      cd.style.width = w + 'px';
      cd.style.borderColor = tr.color + '99';
      cd.style.background = tr.color + '14';
      // Trim handles on each edge
      cd.innerHTML = `
        <div class="daw-clip-handle daw-clip-handle-l" data-side="l"></div>
        <div class="daw-clip-handle daw-clip-handle-r" data-side="r"></div>
      `;
      const handleL = cd.querySelector('.daw-clip-handle-l');
      const handleR = cd.querySelector('.daw-clip-handle-r');
      if (handleL) handleL.addEventListener('mousedown', (ev) => dawClipHandleDown(ev, ti, ci, 'l'));
      if (handleR) handleR.addEventListener('mousedown', (ev) => dawClipHandleDown(ev, ti, ci, 'r'));
      cd.addEventListener('mousedown', (ev) => _dawClipBodyDown(ev, ti, ci));
      lane.appendChild(cd);
    });
    row.appendChild(lane);
    wrap.appendChild(row);

    // Paint waveform now that canvas is in DOM
    _dawPaintTrackWaveform(ti);
  });
}

function _dawPaintTrackWaveform(ti) {
  const tr = dawState.tracks[ti];
  if (!tr) return;
  const canvas = document.getElementById('daw-track-canvas-' + ti);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Subtle track row background — alternating shades for readability
  ctx.fillStyle = ti % 2 === 0 ? '#0e0e0e' : '#101010';
  ctx.fillRect(0, 0, w, h);

  // Major-second grid lines (matches ruler). Batched into a single stroke
  // call by reusing the path with multiple moveTo/lineTo pairs.
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const totalSec = Math.ceil(w / dawPxPerSec);
  for (let s = 0; s <= totalSec; s += 5) {
    const x = Math.round(s * dawPxPerSec) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  if (!tr.peaks || tr.peaks.length === 0) return;
  const buffDur = tr.duration;
  const pxAmp = h * 0.45;
  const midY = h / 2;
  ctx.fillStyle = tr.color;
  ctx.globalAlpha = tr.muted ? 0.25 : 0.85;

  // ── Fast waveform paint ────────────────────────────────────────────────
  // Old code did one fillRect per pixel column — at high zoom that's 20-30k
  // separate draw calls per track, killing FPS during ctrl+wheel zoom.
  //
  // Fast path: build a single Path2D as a filled polygon (top edge of the
  // wave, then bottom edge going back). One ctx.fill() call regardless of
  // pixel width. Empirically 50-100× faster on a 5min track at zoom 200px/s.
  tr.clips.forEach(clip => {
    const clipX = Math.round(clip.startTime * dawPxPerSec);
    const clipW = Math.max(2, Math.round(clip.duration * dawPxPerSec));
    const srcStart = (clip.bufferOffset / buffDur) * tr.peaks.length;
    const srcEnd   = ((clip.bufferOffset + clip.duration) / buffDur) * tr.peaks.length;
    const srcLen   = Math.max(1, srcEnd - srcStart);

    // Cache locals for hot loop
    const peaks = tr.peaks;
    const path = new Path2D();
    // Top edge: walk left→right collecting (x, midY - amp) points
    path.moveTo(clipX, midY);
    for (let px = 0; px < clipW; px++) {
      const srcPos = srcStart + (px / clipW) * srcLen;
      const i0 = srcPos | 0;  // bitwise floor — faster than Math.floor
      const v = peaks[i0] || 0;
      const amp = v * pxAmp;
      path.lineTo(clipX + px, midY - (amp > 0.5 ? amp : 0.5));
    }
    // Bottom edge: walk right→left mirror
    for (let px = clipW - 1; px >= 0; px--) {
      const srcPos = srcStart + (px / clipW) * srcLen;
      const i0 = srcPos | 0;
      const v = peaks[i0] || 0;
      const amp = v * pxAmp;
      path.lineTo(clipX + px, midY + (amp > 0.5 ? amp : 0.5));
    }
    path.closePath();
    ctx.fill(path);
  });
  ctx.globalAlpha = 1;
}

function _dawRenderPlayhead() {
  // Single overlay line spanning all tracks. We use an absolutely
  // positioned div instead of canvas so we can move it without repainting.
  let line = document.getElementById('daw-playhead-line');
  if (!line) {
    line = document.createElement('div');
    line.id = 'daw-playhead-line';
    line.className = 'daw-playhead-line';
    const wrap = document.getElementById('daw-tracks-area');
    if (wrap) wrap.appendChild(line);
  }
  const x = Math.round(dawPlayheadTime * dawPxPerSec) + DAW_TRACK_HEAD_WIDTH;
  line.style.left = x + 'px';
}

function _dawUpdateTimeLabel() {
  const el = document.getElementById('daw-time');
  if (!el) return;
  el.textContent = _fmtTime(dawPlayheadTime) + ' / ' + _fmtTime(dawTotalDuration);
}

function _fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// ── Ruler interactions ──────────────────────────────────────────────────
function _dawRulerClick(ev) {
  const canvas = ev.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const t = Math.max(0, x / dawPxPerSec);
  _dawSetPlayhead(t);
}
function _dawRulerHover(ev) { /* future: show time tooltip */ }

function _dawSetPlayhead(t) {
  const wasPlaying = dawIsPlaying;
  if (wasPlaying) _dawStopPlayback();
  dawPlayheadTime = Math.max(0, Math.min(dawTotalDuration, t));
  _dawRenderRuler();
  _dawRenderPlayhead();
  _dawUpdateTimeLabel();
  if (wasPlaying) _dawStartPlayback();
}

// ── Keyboard ────────────────────────────────────────────────────────────
function _dawKeydown(ev) {
  // Only intercept when DAW is open
  if (!document.getElementById('daw-overlay')) return;
  // Don't steal keys from form inputs
  if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
  // If a button is focused and the user hits Space or Enter, let the browser
  // fire its native click instead of our handler. Otherwise users get a
  // double-trigger (browser click + our handler).
  const focusedBtn = ev.target && ev.target.tagName === 'BUTTON';
  if (ev.code === 'Space') {
    if (focusedBtn) return;  // let native button-click fire
    ev.preventDefault();
    dawTogglePlay();
  } else if (ev.code === 'KeyS' && !ev.ctrlKey && !ev.metaKey) {
    ev.preventDefault();
    dawSplitAtPlayhead();
  } else if (ev.code === 'KeyV' && !ev.ctrlKey && !ev.metaKey) {
    ev.preventDefault();
    _dawSetTool('select');
  } else if ((ev.code === 'KeyC' || ev.code === 'KeyB') && !ev.ctrlKey && !ev.metaKey) {
    // C = cut tool (our convention). B = slice tool (FL Studio convention).
    // Both map to the same scissor mode here so users coming from either
    // muscle-memory get what they expect.
    ev.preventDefault();
    _dawSetTool('cut');
  } else if ((ev.code === 'KeyM' || ev.code === 'KeyT') && !ev.ctrlKey) {
    // M = our mute key. T = FL Studio's "toggle mute" on selected. Both
    // mute the track containing the currently-selected clip.
    if (dawState && dawState.selectedClip) {
      ev.preventDefault();
      dawToggleMute(dawState.selectedClip.trackIdx);
    }
  } else if (ev.code === 'Escape') {
    ev.preventDefault();
    if (dawIsPlaying) dawStop(); else closeMiniDAW();
  } else if (ev.code === 'Delete' || ev.code === 'Backspace') {
    if (dawState && dawState.selectedClip) {
      ev.preventDefault();
      dawDeleteSelectedClip();
    }
  } else if (ev.code === 'NumpadAdd' || ev.code === 'Equal') {
    // FL-style numpad zoom in. Equal is "+" on non-numpad keyboards too.
    ev.preventDefault();
    dawZoom(1);
  } else if (ev.code === 'NumpadSubtract' || ev.code === 'Minus') {
    ev.preventDefault();
    dawZoom(-1);
  } else if (ev.code === 'Home') {
    // Jump playhead to start
    ev.preventDefault();
    _dawSetPlayhead(0);
  } else if (ev.code === 'End') {
    // Jump to last clip end across all tracks
    ev.preventDefault();
    let maxT = 0;
    if (dawState) dawState.tracks.forEach(t => t.clips.forEach(c => {
      const e = c.startTime + c.duration;
      if (e > maxT) maxT = e;
    }));
    _dawSetPlayhead(maxT);
  }
}

// ── Public action handlers ──────────────────────────────────────────────

function dawTogglePlay() {
  if (!dawState) return;
  if (dawIsPlaying) {
    _dawStopPlayback();
  } else {
    _dawStartPlayback();
  }
}

function dawStop() {
  if (!dawState) return;
  _dawStopPlayback();
  dawPlayheadTime = 0;
  _dawRenderRuler();
  _dawRenderPlayhead();
  _dawUpdateTimeLabel();
}

function dawZoom(dir) {
  const factor = dir > 0 ? 1.4 : 1 / 1.4;
  const newPx = Math.max(20, Math.min(400, dawPxPerSec * factor));
  if (newPx === dawPxPerSec) return;
  dawPxPerSec = newPx;
  _dawZoomRepaint();
}

// Zoom-only repaint: resizes the existing canvases/lanes to the new
// pixel-per-second scale and repaints. Does NOT rebuild the DOM — the
// expensive renderTracks() (createElement for each clip, attach listeners,
// build innerHTML for headers) was the FPS killer when zooming because
// every wheel tick triggered a full teardown/rebuild of all 7 tracks.
//
// What we DO update:
//   • Ruler canvas width + repaint
//   • Each track lane width
//   • Each track canvas width + repaint waveform
//   • Each clip div's left/width (positions in pixel space change with zoom)
//   • Playhead line position (also moves in pixel space)
// What we DON'T touch:
//   • Track header DOM (name, mute, solo, vol, pan)
//   • Clip div elements themselves (kept, just repositioned)
//   • Event listeners (kept)
function _dawZoomRepaint() {
  if (!dawState) return;
  const timelineW = _dawTimelineWidthPx();

  // Ruler
  const rulerCanvas = document.getElementById('daw-ruler');
  if (rulerCanvas) {
    rulerCanvas.width = timelineW;
    rulerCanvas.style.width = timelineW + 'px';
  }
  _dawRenderRuler();

  // Each track lane + canvas + clips
  dawState.tracks.forEach((tr, ti) => {
    const row = document.querySelector('.daw-track-row[data-track-idx="' + ti + '"]');
    if (!row) return;
    const lane = row.querySelector('.daw-track-lane');
    const canvas = document.getElementById('daw-track-canvas-' + ti);
    if (lane) lane.style.width = timelineW + 'px';
    if (canvas) {
      canvas.width = timelineW;
      canvas.style.width = timelineW + 'px';
    }
    // Reposition existing clip divs (don't rebuild — they keep their listeners)
    if (lane) {
      const clipEls = lane.querySelectorAll('.daw-clip');
      tr.clips.forEach((clip, ci) => {
        const el = clipEls[ci];
        if (!el) return;
        el.style.left = Math.round(clip.startTime * dawPxPerSec) + 'px';
        el.style.width = Math.max(8, Math.round(clip.duration * dawPxPerSec)) + 'px';
      });
    }
    // Repaint waveform with new scale
    _dawPaintTrackWaveform(ti);
  });

  _dawRenderPlayhead();
  _dawUpdateTimeLabel();
}

function dawToggleMute(ti) {
  if (!dawState || !dawState.tracks[ti]) return;
  dawState.tracks[ti].muted = !dawState.tracks[ti].muted;
  if (dawState.tracks[ti].gainNode) {
    _dawApplyTrackGain(ti);
  }
  _dawPaintTrackWaveform(ti);
  // Also refresh track row controls so M button color updates
  _dawRefreshTrackHead(ti);
}

function dawToggleSolo(ti) {
  if (!dawState || !dawState.tracks[ti]) return;
  dawState.tracks[ti].soloed = !dawState.tracks[ti].soloed;
  // Re-apply all gains (solo affects others)
  dawState.tracks.forEach((_, i) => {
    if (dawState.tracks[i].gainNode) _dawApplyTrackGain(i);
  });
  dawState.tracks.forEach((_, i) => _dawRefreshTrackHead(i));
}

function dawSetVolume(ti, v) {
  if (!dawState || !dawState.tracks[ti]) return;
  dawState.tracks[ti].volume = parseFloat(v) || 0;
  if (dawState.tracks[ti].gainNode) _dawApplyTrackGain(ti);
}

// Pan: -1 = full left, 0 = center, +1 = full right. StereoPannerNode does
// equal-power panning under the hood, so a centered signal moved fully
// to one side has the same perceived loudness.
function dawSetPan(ti, v) {
  if (!dawState || !dawState.tracks[ti]) return;
  const pan = Math.max(-1, Math.min(1, parseFloat(v) || 0));
  dawState.tracks[ti].pan = pan;
  const tr = dawState.tracks[ti];
  if (tr.panNode && dawCtx) {
    tr.panNode.pan.cancelScheduledValues(dawCtx.currentTime);
    tr.panNode.pan.setTargetAtTime(pan, dawCtx.currentTime, 0.01);
  }
  _dawRefreshTrackHead(ti);
}

// Reset pan to center — double-click handler on the pan knob
function dawResetPan(ti) {
  dawSetPan(ti, 0);
  // Update the slider visually too
  const row = document.querySelector('.daw-track-row[data-track-idx="' + ti + '"]');
  if (!row) return;
  const panEl = row.querySelector('.daw-pan-slider');
  if (panEl) panEl.value = '0';
}

function _dawRefreshTrackHead(ti) {
  const row = document.querySelector('.daw-track-row[data-track-idx="' + ti + '"]');
  if (!row) return;
  const tr = dawState.tracks[ti];
  const muteBtn = row.querySelector('.daw-mute-btn');
  const soloBtn = row.querySelector('.daw-solo-btn');
  if (muteBtn) muteBtn.classList.toggle('on', !!tr.muted);
  if (soloBtn) soloBtn.classList.toggle('on-solo', !!tr.soloed);
}

function _dawApplyTrackGain(ti) {
  const tr = dawState.tracks[ti];
  if (!tr || !tr.gainNode) return;
  // Solo logic: if ANY track is soloed, only soloed tracks play (others muted).
  const anySolo = dawState.tracks.some(t => t.soloed);
  const effectiveMuted = tr.muted || (anySolo && !tr.soloed);
  const targetGain = effectiveMuted ? 0 : tr.volume;
  // Quick ramp to avoid clicks when toggling
  const ctx = dawCtx;
  if (ctx) {
    tr.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    tr.gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
  } else {
    tr.gainNode.gain.value = targetGain;
  }
}

// ── Clip splitting (S key) ──────────────────────────────────────────────

function dawSplitAtPlayhead() {
  if (!dawState) return;
  const t = dawPlayheadTime;
  let didSplit = false;
  dawState.tracks.forEach(tr => {
    // Find clip(s) that contain the playhead position
    const newClips = [];
    tr.clips.forEach(clip => {
      const clipEnd = clip.startTime + clip.duration;
      if (t > clip.startTime + 0.02 && t < clipEnd - 0.02) {
        // Split here. Left half = [startTime, t-startTime]. Right half =
        // [t, clipEnd-t] with bufferOffset += (t - startTime).
        const cut = t - clip.startTime;
        const leftId = clip.id;
        const rightId = 'c_' + (dawState.nextClipId++);
        newClips.push({
          id: leftId,
          startTime: clip.startTime,
          duration: cut,
          bufferOffset: clip.bufferOffset
        });
        newClips.push({
          id: rightId,
          startTime: t,
          duration: clip.duration - cut,
          bufferOffset: clip.bufferOffset + cut
        });
        didSplit = true;
      } else {
        newClips.push(clip);
      }
    });
    tr.clips = newClips;
  });
  if (didSplit) {
    _dawRenderTracks();
    _dawRenderPlayhead();
    if (typeof showAppNotification === 'function') {
      showAppNotification('Split at ' + _fmtTime(t), 'info', null, 1500);
    }
  }
}

function dawDeleteSelectedClip() {
  if (!dawState || !dawState.selectedClip) return;
  const { trackIdx, clipIdx } = dawState.selectedClip;
  const tr = dawState.tracks[trackIdx];
  if (!tr || !tr.clips[clipIdx]) return;
  // Don't allow deleting the last clip on a track — would leave an empty
  // row with no way to recover the audio. (User can mute the track instead.)
  if (tr.clips.length <= 1) {
    if (typeof showAppNotification === 'function') {
      showAppNotification('Cannot delete the only clip on a track. Mute the track instead.', 'info', null, 2500);
    }
    return;
  }
  tr.clips.splice(clipIdx, 1);
  dawState.selectedClip = null;
  _dawRenderTracks();
  _dawRenderPlayhead();
}

// ── Clip dragging ───────────────────────────────────────────────────────
function _dawClipBodyDown(ev, ti, ci) {
  // Only fires on the clip body, not handles (handles call their own fn).
  if (ev.target.classList.contains('daw-clip-handle')) return;
  ev.preventDefault();
  ev.stopPropagation();

  // CUT TOOL: clicking inside a clip splits it at the click x-coordinate.
  // This is the "scissors at exactly where I clicked" behavior — different
  // from the S keyboard shortcut which always splits at the playhead.
  if (_dawCurrentTool === 'cut') {
    const laneEl = ev.currentTarget.parentElement;
    if (laneEl) {
      const rect = laneEl.getBoundingClientRect();
      const xInLane = ev.clientX - rect.left;
      const cutTime = Math.max(0, xInLane / dawPxPerSec);
      _dawSplitClipAtTime(ti, ci, cutTime);
    }
    return;
  }

  // SELECT TOOL: select + start drag-move
  dawState.selectedClip = { trackIdx: ti, clipIdx: ci };
  _dawHighlightSelectedClip();
  const clip = dawState.tracks[ti].clips[ci];
  dawDragState = {
    type: 'move',
    trackIdx: ti,
    clipIdx: ci,
    startX: ev.clientX,
    origStartTime: clip.startTime
  };
  document.addEventListener('mousemove', _dawDragMove);
  document.addEventListener('mouseup', _dawDragEnd, { once: true });
}

// Split a specific clip at an absolute timeline time (not playhead).
// Used by the cut tool when the user clicks inside a clip.
function _dawSplitClipAtTime(ti, ci, t) {
  if (!dawState || !dawState.tracks[ti]) return;
  const tr = dawState.tracks[ti];
  const clip = tr.clips[ci];
  if (!clip) return;
  // Bail if click is too close to either edge (would create a 0-length sliver)
  if (t < clip.startTime + 0.05 || t > clip.startTime + clip.duration - 0.05) return;
  const cut = t - clip.startTime;
  const rightId = 'c_' + (dawState.nextClipId++);
  const newRight = {
    id: rightId,
    startTime: t,
    duration: clip.duration - cut,
    bufferOffset: clip.bufferOffset + cut
  };
  // Shrink original to left half
  clip.duration = cut;
  // Insert new clip right after the original
  tr.clips.splice(ci + 1, 0, newRight);
  _dawRenderTracks();
  _dawRenderPlayhead();
  if (typeof showAppNotification === 'function') {
    showAppNotification('Split at ' + _fmtTime(t), 'info', null, 1200);
  }
}

// Visual highlight on the selected clip — a brighter border + slight glow.
// Cleared from all other clips so only one shows as selected at a time.
function _dawHighlightSelectedClip() {
  const all = document.querySelectorAll('.daw-clip');
  all.forEach(el => el.classList.remove('selected'));
  if (!dawState || !dawState.selectedClip) return;
  const { trackIdx, clipIdx } = dawState.selectedClip;
  const row = document.querySelector('.daw-track-row[data-track-idx="' + trackIdx + '"]');
  if (!row) return;
  const clipEls = row.querySelectorAll('.daw-clip');
  if (clipEls[clipIdx]) clipEls[clipIdx].classList.add('selected');
}

function dawClipHandleDown(ev, ti, ci, side) {
  ev.preventDefault();
  ev.stopPropagation();
  const clip = dawState.tracks[ti].clips[ci];
  dawDragState = {
    type: 'trim-' + side,
    trackIdx: ti,
    clipIdx: ci,
    startX: ev.clientX,
    origStartTime: clip.startTime,
    origDuration: clip.duration,
    origBufferOffset: clip.bufferOffset
  };
  document.addEventListener('mousemove', _dawDragMove);
  document.addEventListener('mouseup', _dawDragEnd, { once: true });
}

function _dawDragMove(ev) {
  if (!dawDragState || !dawState) return;
  const { type, trackIdx, clipIdx, startX } = dawDragState;
  const tr = dawState.tracks[trackIdx];
  const clip = tr.clips[clipIdx];
  if (!clip) return;
  const dxPx = ev.clientX - startX;
  const dxSec = dxPx / dawPxPerSec;
  if (type === 'move') {
    // Move whole clip in time; can't go below 0
    let newStart = Math.max(0, dawDragState.origStartTime + dxSec);
    clip.startTime = newStart;
  } else if (type === 'trim-l') {
    // Trim left edge: startTime increases, duration decreases, bufferOffset
    // increases by the same delta (so audio stays aligned to its content).
    // Don't cross the right edge (min duration 0.05s).
    const maxDelta = dawDragState.origDuration - 0.05;
    let delta = Math.min(maxDelta, Math.max(-dawDragState.origBufferOffset, dxSec));
    clip.startTime = dawDragState.origStartTime + delta;
    clip.duration = dawDragState.origDuration - delta;
    clip.bufferOffset = dawDragState.origBufferOffset + delta;
  } else if (type === 'trim-r') {
    // Trim right edge: just shrink/grow duration. Can't exceed the source
    // buffer (bufferOffset + duration <= buffer.duration).
    const maxRight = tr.duration - dawDragState.origBufferOffset;
    let newDur = Math.max(0.05, Math.min(maxRight, dawDragState.origDuration + dxSec));
    clip.duration = newDur;
  }
  // Live update: just the affected track + clip overlays
  _dawPaintTrackWaveform(trackIdx);
  _dawRefreshTrackClips(trackIdx);
}

function _dawDragEnd() {
  document.removeEventListener('mousemove', _dawDragMove);
  if (dawDragState) {
    // Final repaint
    _dawPaintTrackWaveform(dawDragState.trackIdx);
    _dawRefreshTrackClips(dawDragState.trackIdx);
    dawDragState = null;
    // Recompute total duration in case a clip got extended past it
    _dawRecomputeTotalDuration();
  }
}

function _dawRefreshTrackClips(ti) {
  // Update clip overlay DIVs in place (don't full re-render)
  const row = document.querySelector('.daw-track-row[data-track-idx="' + ti + '"]');
  if (!row) return;
  const lane = row.querySelector('.daw-track-lane');
  if (!lane) return;
  const tr = dawState.tracks[ti];
  const clips = lane.querySelectorAll('.daw-clip');
  tr.clips.forEach((clip, ci) => {
    const el = clips[ci];
    if (!el) return;
    el.style.left = Math.round(clip.startTime * dawPxPerSec) + 'px';
    el.style.width = Math.max(8, Math.round(clip.duration * dawPxPerSec)) + 'px';
  });
}

function _dawRecomputeTotalDuration() {
  if (!dawState) return;
  let max = 0;
  dawState.tracks.forEach(tr => {
    tr.clips.forEach(c => {
      const end = c.startTime + c.duration;
      if (end > max) max = end;
    });
  });
  if (Math.abs(max - dawTotalDuration) > 0.5) {
    dawTotalDuration = max;
    _dawRenderRuler();
  }
}

// ── Playback ─────────────────────────────────────────────────────────────

// Master fader value [0..1.5]. Persisted in localStorage so it survives
// re-opening the DAW. Wired into dawMasterGain on every change. The slider
// is in the toolbar; this var is the source of truth.
let dawMasterVolume = (() => {
  const v = parseFloat(localStorage.getItem('freqphull.dawMasterVol'));
  return (isFinite(v) && v >= 0 && v <= 1.5) ? v : 0.85;
})();
let dawLimiter = null;
let dawHardClip = null;  // WaveShaper, final safety net
let dawSafetyGain = null; // sits between limiter and clipper for extra trim

function _dawEnsureCtx() {
  if (!dawCtx) {
    dawCtx = new (window.AudioContext || window.webkitAudioContext)();
    // ── Master gain (user-controlled fader) ──
    // The visible master fader maps directly into this gain. Default 0.85
    // (about -1.4 dB) gives clean headroom — when 6 stems sum, the limiter
    // doesn't have to work too hard. Users can push up if they want louder,
    // but the limiter + hard-clipper below catch anything dangerous.
    dawMasterGain = dawCtx.createGain();
    dawMasterGain.gain.value = dawMasterVolume;

    // ── Brick-wall-ish limiter ──
    // DynamicsCompressorNode is NOT a true brick-wall. It's a fast
    // compressor: attack/release smoothing, ratio-based reduction. Transient
    // peaks below the attack window leak through. We configure it AS HARD
    // AS Web Audio allows:
    //   threshold: -6 dB   → start limiting early
    //   knee:      0       → no soft transition
    //   ratio:     20      → effective limiting above threshold
    //   attack:    0.001s  → 1ms, fastest the API allows
    //   release:   0.080s  → 80ms, musical
    // We follow this with a HARD CLIPPER (WaveShaperNode) that guarantees
    // nothing exits above ±1.0 no matter what. The clipper sounds harsher
    // than the compressor at peak but it's literally impossible to clip
    // your DAC after this — your ears are safe.
    dawLimiter = dawCtx.createDynamicsCompressor();
    dawLimiter.threshold.value = -6;
    dawLimiter.knee.value = 0;
    dawLimiter.ratio.value = 20;
    dawLimiter.attack.value = 0.001;
    dawLimiter.release.value = 0.080;

    // Trim before the clipper. The limiter can let through brief peaks up
    // to about -3 dBFS (because of its attack curve). We multiply by 0.9
    // here to lock everything under 0 dBFS before the safety clipper. The
    // result: clipper rarely engages, audio stays clean, but if a freak
    // transient sneaks through the clipper catches it anyway.
    dawSafetyGain = dawCtx.createGain();
    dawSafetyGain.gain.value = 0.9;

    // ── Hard clipper (final safety net) ──
    // WaveShaperNode with a tanh-like saturation curve clamped to ±1.
    // At normal levels the curve is linear (transparent); above the
    // clipping point (±0.95) it asymptotes to ±1, mathematically
    // GUARANTEEING the output never exceeds full-scale digital. This is
    // what stops ear-damaging spikes — even if everything else above fails.
    dawHardClip = dawCtx.createWaveShaper();
    dawHardClip.oversample = '2x';  // antialias the clipping harmonics
    dawHardClip.curve = _makeClipperCurve();

    // Chain: tracks → masterGain → limiter → safetyGain → hardClip → destination
    dawMasterGain.connect(dawLimiter);
    dawLimiter.connect(dawSafetyGain);
    dawSafetyGain.connect(dawHardClip);
    dawHardClip.connect(dawCtx.destination);
  }
  if (dawCtx.state === 'suspended') {
    try { dawCtx.resume(); } catch {}
  }
}

// Build a Float32Array clipping curve for WaveShaperNode. Input range
// [-1,1] maps to a tanh-saturated output [-1,1]. The transfer function
// is nearly linear for |x| < 0.7, smoothly bends to ±1 for |x| > 0.9.
// 4096 samples is enough resolution for inaudible quantization noise.
function _makeClipperCurve() {
  const N = 4096;
  const curve = new Float32Array(N);
  const drive = 1.2;  // gentle pre-saturation
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;  // -1..1
    // tanh saturation, but normalized so the curve actually reaches ±1
    // at the extremes (otherwise it asymptotes short and we lose headroom).
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

// Called by the UI slider when the user moves the master fader. Smoothly
// ramps the gain so adjustments don't click.
function dawSetMasterVolume(v) {
  const val = Math.max(0, Math.min(1.5, parseFloat(v) || 0));
  dawMasterVolume = val;
  localStorage.setItem('freqphull.dawMasterVol', String(val));
  if (dawMasterGain && dawCtx) {
    dawMasterGain.gain.cancelScheduledValues(dawCtx.currentTime);
    dawMasterGain.gain.setTargetAtTime(val, dawCtx.currentTime, 0.015);
  }
  // Update the dB display readout next to the slider
  const label = document.getElementById('daw-master-vol-db');
  if (label) {
    label.textContent = val <= 0.001 ? '−∞' :
                        (20 * Math.log10(val)).toFixed(1) + ' dB';
  }
}

function _dawStartPlayback() {
  if (!dawState || dawIsPlaying) return;

  // ── Hard-stop every other audio source in the app before starting ───────
  // The DAW shares the audio output device with:
  //   • The legacy stems mixer (HTMLAudioElement per stem via MediaElementSource)
  //   • The Analyzer (Web Audio source for the main player)
  //   • The mini player / global player
  // If any of these are still playing when we kick off the DAW, the user
  // hears two passes of audio overlapping. Pause them all defensively. The
  // sepAudioMap entries' Audio elements are paused directly because their
  // playback isn't always wired to a single "stop everything" function.
  try {
    if (typeof sepAudioMap !== 'undefined' && sepAudioMap) {
      for (const k of Object.keys(sepAudioMap)) {
        const e = sepAudioMap[k];
        if (!e || !e.audio) continue;
        try { e.audio.pause(); e.audio.currentTime = 0; } catch {}
      }
    }
  } catch {}
  try { if (typeof stopAllStems === 'function') stopAllStems(); } catch {}
  try { if (typeof mixerStopAll === 'function') mixerStopAll(); } catch {}
  try { if (typeof stopAudio === 'function' && typeof playing !== 'undefined' && playing) stopAudio(); } catch {}
  try { if (typeof stopGlobalPlay === 'function') stopGlobalPlay(); } catch {}
  try {
    if (typeof globalPlayer !== 'undefined' && globalPlayer && globalPlayer.audio) {
      try { globalPlayer.audio.pause(); } catch {}
    }
  } catch {}

  _dawEnsureCtx();
  const ctx = dawCtx;
  // Bump generation so any old scheduled sources from a previous play that
  // somehow leak through (shouldn't happen, but defensive) are ignored.
  dawSourcesGen++;
  const gen = dawSourcesGen;
  dawActiveSources = [];

  const playheadAtStart = dawPlayheadTime;
  const ctxStart = ctx.currentTime + 0.05; // small lookahead so first scheduled source isn't late
  dawPlayStartCtxTime = ctxStart;
  dawPlayStartHeadTime = playheadAtStart;

  dawState.tracks.forEach((tr, ti) => {
    // Build/refresh the gain + pan nodes for this track. Each track has its
    // own chain: BufferSource → trackGain → trackPan → masterGain. The pan
    // node is a StereoPannerNode which provides equal-power left/right
    // panning between -1 (full left) and +1 (full right). Stored on the
    // track so live changes can update it via dawSetPan().
    if (!tr.gainNode || tr.gainNode.context !== ctx) {
      tr.gainNode = ctx.createGain();
      tr.panNode = ctx.createStereoPanner();
      tr.gainNode.connect(tr.panNode);
      tr.panNode.connect(dawMasterGain);
    }
    if (typeof tr.pan === 'number' && tr.panNode) {
      tr.panNode.pan.value = Math.max(-1, Math.min(1, tr.pan));
    }
    _dawApplyTrackGain(ti);

    tr.clips.forEach(clip => {
      const clipEnd = clip.startTime + clip.duration;
      // Skip clips entirely before the playhead
      if (clipEnd <= playheadAtStart) return;
      // For clips that span the playhead, start mid-clip
      const clipPlayStart = Math.max(clip.startTime, playheadAtStart);
      const offsetInClip = clipPlayStart - clip.startTime;
      const playDuration = clip.duration - offsetInClip;
      if (playDuration <= 0) return;
      const sourceBufferOffset = clip.bufferOffset + offsetInClip;
      // Safety clamp on buffer offset
      const maxOffset = tr.buffer.duration - 0.001;
      const safeOffset = Math.min(sourceBufferOffset, maxOffset);
      if (safeOffset >= maxOffset) return;
      const safeDuration = Math.min(playDuration, tr.buffer.duration - safeOffset);
      if (safeDuration <= 0) return;

      const src = ctx.createBufferSource();
      src.buffer = tr.buffer;
      src.connect(tr.gainNode);
      const whenStart = ctxStart + (clipPlayStart - playheadAtStart);
      try {
        src.start(whenStart, safeOffset, safeDuration);
        dawActiveSources.push({ gen, source: src });
      } catch (e) {
        // start() can throw on already-started buffer; should never happen
        // since each source is fresh, but just in case.
      }
    });
  });

  dawIsPlaying = true;
  _dawUpdatePlayButton(true);
  // Start the render loop for playhead motion
  if (dawRaf) cancelAnimationFrame(dawRaf);
  const tick = () => {
    if (!dawIsPlaying || !dawCtx) return;
    const elapsed = dawCtx.currentTime - dawPlayStartCtxTime;
    dawPlayheadTime = dawPlayStartHeadTime + elapsed;
    if (dawPlayheadTime >= dawTotalDuration) {
      // Reached end — auto-stop
      _dawStopPlayback();
      dawPlayheadTime = dawTotalDuration;
      _dawRenderRuler();
      _dawRenderPlayhead();
      _dawUpdateTimeLabel();
      return;
    }
    _dawRenderPlayhead();
    _dawUpdateTimeLabel();
    // Repaint ruler triangle every ~100ms (not every frame, expensive)
    if (Math.floor(dawPlayheadTime * 10) !== Math.floor((dawPlayheadTime - elapsed) * 10)) {
      _dawRenderRuler();
    }
    dawRaf = requestAnimationFrame(tick);
  };
  dawRaf = requestAnimationFrame(tick);
}

function _dawStopPlayback() {
  if (!dawIsPlaying && dawActiveSources.length === 0) return;
  // Invalidate generation so any pending starts are no-ops
  dawSourcesGen++;
  dawActiveSources.forEach(s => {
    try { s.source.stop(0); } catch {}
    try { s.source.disconnect(); } catch {}
  });
  dawActiveSources = [];
  dawIsPlaying = false;
  if (dawRaf) { cancelAnimationFrame(dawRaf); dawRaf = null; }
  _dawUpdatePlayButton(false);
}

function _dawUpdatePlayButton(playing) {
  const svg = document.getElementById('daw-play-svg');
  if (!svg) return;
  svg.innerHTML = playing
    ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'
    : '<polygon points="5,3 19,12 5,21"/>';
}

// ── Export mixdown ──────────────────────────────────────────────────────
//
// Renders the current arrangement (all clips, with per-track volume,
// muting, soloing) to a single stereo WAV via OfflineAudioContext, then
// pipes the result to a download. Sample rate matches the first track's
// buffer (usually 44100 or 48000).
async function dawExportMixdown() {
  if (!dawState || dawState.tracks.length === 0) return;
  const sampleRate = dawState.tracks[0].sampleRate;
  const totalSec = dawTotalDuration;
  if (totalSec <= 0) return;

  if (typeof showAppNotification === 'function') {
    showAppNotification('Rendering mixdown…', 'info', null, 3000);
  }

  // Use OfflineAudioContext for fast non-realtime render. The mixdown
  // signal chain MIRRORS the live playback chain (master gain → limiter →
  // safety gain → hard-clipper → destination) so what you export sounds
  // exactly like what you hear in the DAW — including the hard-clipper
  // safety net. Without all four stages, exported mixdowns would clip
  // even though playback didn't.
  const offCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    2, Math.ceil(totalSec * sampleRate), sampleRate
  );
  const master = offCtx.createGain();
  master.gain.value = dawMasterVolume;
  const limiter = offCtx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.080;
  const safety = offCtx.createGain();
  safety.gain.value = 0.9;
  const clipper = offCtx.createWaveShaper();
  clipper.oversample = '2x';
  clipper.curve = _makeClipperCurve();
  master.connect(limiter);
  limiter.connect(safety);
  safety.connect(clipper);
  clipper.connect(offCtx.destination);

  const anySolo = dawState.tracks.some(t => t.soloed);
  dawState.tracks.forEach(tr => {
    const effectiveMuted = tr.muted || (anySolo && !tr.soloed);
    if (effectiveMuted) return;
    const gain = offCtx.createGain();
    gain.gain.value = tr.volume;
    // Per-track pan (same StereoPannerNode topology as live playback).
    // If the user adjusted pan on a track, the export preserves it.
    const panNode = offCtx.createStereoPanner();
    panNode.pan.value = typeof tr.pan === 'number' ? Math.max(-1, Math.min(1, tr.pan)) : 0;
    gain.connect(panNode);
    panNode.connect(master);
    tr.clips.forEach(clip => {
      const src = offCtx.createBufferSource();
      src.buffer = tr.buffer;
      src.connect(gain);
      const maxOffset = tr.buffer.duration - 0.001;
      const offset = Math.min(clip.bufferOffset, maxOffset);
      const dur = Math.min(clip.duration, tr.buffer.duration - offset);
      if (dur <= 0) return;
      try {
        src.start(clip.startTime, offset, dur);
      } catch {}
    });
  });

  try {
    const rendered = await offCtx.startRendering();
    const wavBlob = _audioBufferToWav(rendered);
    // Trigger download
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'freqphull-mixdown-' + Date.now() + '.wav';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    if (typeof showAppNotification === 'function') {
      showAppNotification('✓ Mixdown exported', 'ok', null, 3000);
    }
  } catch (e) {
    if (typeof showAppNotification === 'function') {
      showAppNotification('Export failed: ' + e.message, 'err', null, 5000);
    }
  }
}

// Convert AudioBuffer → 16-bit PCM WAV Blob. Standard interleaved stereo.
function _audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const len = buffer.length;
  const bitsPerSample = 16;
  const blockAlign = numCh * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = len * blockAlign;
  const headerSize = 44;
  const buf = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buf);
  // RIFF header
  _wstr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  _wstr(view, 8, 'WAVE');
  // fmt chunk
  _wstr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  _wstr(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  // Interleave + write samples
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function _wstr(view, off, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
}

// ── Helpers ──────────────────────────────────────────────────────────────
function _escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function _prettyName(n) {
  return String(n || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
