function getInfo() {
  const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string');
  const title = el?.textContent?.trim() || document.title.replace(/ - YouTube$/, '') || '?';
  const ch = document.querySelector('#channel-name a, ytd-channel-name a')?.textContent?.trim() || '';
  const vid = new URLSearchParams(location.search).get('v') || '';
  return {
    title, channel: ch, videoId: vid, url: location.href,
    thumbnail: vid ? 'https://img.youtube.com/vi/' + vid + '/hqdefault.jpg' : ''
  };
}

function inject() {
  if (document.getElementById('fp-btn')) return;
  if (!location.href.includes('youtube.com/watch')) return;
  const boxes = ['#actions.ytd-watch-metadata', '#top-level-buttons-computed', '#menu.ytd-watch-metadata'];
  let box = null;
  for (const s of boxes) { box = document.querySelector(s); if (box) break; }
  if (!box) return;
  const b = document.createElement('button');
  b.id = 'fp-btn';
  b.innerHTML = '<img src="' + chrome.runtime.getURL('icons/icon32.png') + '" class="fp-i"/><span>Freq.Phull</span>';
  b.onclick = () => {
    chrome.runtime.sendMessage({ type: 'open-panel', data: getInfo() });
    b.querySelector('span').textContent = '✓ Opened';
    setTimeout(() => b.querySelector('span').textContent = 'Freq.Phull', 1500);
  };
  box.appendChild(b);
}

// Scrape the playlist visible on the current page. Two contexts:
//   • /playlist?list=…  → full playlist page (ytd-playlist-video-renderer)
//   • /watch?v=…&list=… → playlist side panel (ytd-playlist-panel-video-renderer)
// Returns lightweight {title, url} entries; the panel queues them through
// the normal /download path one by one, so no yt-dlp playlist flags needed.
function getPlaylistInfo() {
  const out = [];
  const seen = new Set();
  const push = (title, href) => {
    if (!href) return;
    const m = href.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    out.push({ title: (title || '').trim() || m[1], url: 'https://www.youtube.com/watch?v=' + m[1] });
  };
  // Full playlist page
  document.querySelectorAll('ytd-playlist-video-renderer').forEach(el => {
    const a = el.querySelector('a#video-title');
    if (a) push(a.textContent, a.getAttribute('href'));
  });
  // Watch-page playlist side panel
  if (!out.length) {
    document.querySelectorAll('ytd-playlist-panel-video-renderer').forEach(el => {
      const a = el.querySelector('a#wc-endpoint, a.yt-simple-endpoint');
      const tEl = el.querySelector('#video-title');
      if (a) push(tEl ? (tEl.getAttribute('title') || tEl.textContent) : '', a.getAttribute('href'));
    });
  }
  const nameEl = document.querySelector('ytd-playlist-panel-renderer #header-description a, yt-formatted-string.ytd-playlist-header-renderer, h1.ytd-playlist-header-renderer');
  return {
    name: nameEl ? nameEl.textContent.trim() : 'Playlist',
    listId: new URLSearchParams(location.search).get('list') || '',
    items: out.slice(0, 200),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'info') sendResponse(getInfo());
  if (msg.type === 'playlist-info') sendResponse(getPlaylistInfo());
});

let last = '';
new MutationObserver(() => {
  if (location.href !== last) {
    last = location.href;
    const old = document.getElementById('fp-btn'); if (old) old.remove();
    if (last.includes('/watch')) {
      setTimeout(inject, 1200);
      setTimeout(inject, 3000);
      // Auto-send new video info to panel so ytUrl updates immediately
      setTimeout(() => {
        const info = getInfo();
        if (info.videoId) chrome.runtime.sendMessage({ type: 'yt-info-update', data: info });
      }, 800);
      setTimeout(() => {
        const info = getInfo();
        if (info.videoId) chrome.runtime.sendMessage({ type: 'yt-info-update', data: info });
      }, 2500);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
setTimeout(inject, 1200); setTimeout(inject, 3500);
