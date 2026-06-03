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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'info') sendResponse(getInfo());
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
