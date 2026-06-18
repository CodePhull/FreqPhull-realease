chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(()=>{});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'open-panel') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.sidePanel.open({ tabId }).then(() => {
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'video-info', data: msg.data }).catch(()=>{});
        }, 600);
      }).catch(()=>{});
    }
  }

  // Auto-update: content.js sends new video info when user navigates
  if (msg.type === 'yt-info-update') {
    chrome.runtime.sendMessage({ type: 'video-info', data: msg.data }).catch(()=>{});
  }

  if (msg.type === 'get-playlist-info') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('youtube.com') && tab.url.includes('list=')) {
        chrome.tabs.sendMessage(tab.id, { type: 'playlist-info' }, (r) => {
          sendResponse(chrome.runtime.lastError ? { error: 'Reload page' } : r);
        });
      } else {
        sendResponse({ error: 'no-playlist' });
      }
    });
    return true;
  }
  if (msg.type === 'get-yt-info') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
        chrome.tabs.sendMessage(tab.id, { type: 'info' }, (r) => {
          sendResponse(chrome.runtime.lastError ? { error: 'Reload page' } : r);
        });
      } else {
        sendResponse({ error: 'no-yt' });
      }
    });
    return true;
  }
});

// ── Keep the panel's YT card in sync with the tab the user is LOOKING at ──
// content.js only reports SPA navigation within its own tab. If the user
// switches to a different YouTube tab (the normal "queue up beats in 5
// tabs" workflow), the card kept showing the old video — so during a
// download it looked like you couldn't select the next track until the
// download finished and something re-rendered. These two listeners push
// fresh video info whenever the active tab changes or finishes loading a
// watch URL, so Grab always targets what's on screen.
function pushTabInfo(tabId, url) {
  if (!url || !url.includes('youtube.com/watch')) return;
  chrome.tabs.sendMessage(tabId, { type: 'info' }, (r) => {
    if (chrome.runtime.lastError || !r || r.error) return;
    chrome.runtime.sendMessage({ type: 'video-info', data: r }).catch(() => {});
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    pushTabInfo(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.active) return;
  pushTabInfo(tabId, tab.url);
});


// ════════════════════════════════════════════════════════════════════
// Extension update check (v4.3.0)
// ════════════════════════════════════════════════════════════════════
// Periodically asks GitHub for the latest commit SHA of the
// freqpull-ext folder in the releases repo. If the SHA changes, we
// store both the new SHA and a flag for the panel to show a soft
// banner inviting the user to grab the new build. The user can also
// click the banner to open the repo page directly.
//
// Rate-limited generously (every 6h) so we stay well under GitHub's
// 60 req/hr unauthenticated limit even with many concurrent users.

const EXT_REPO_OWNER = 'CodePhull';
const EXT_REPO_NAME  = 'FreqPhull-realease';
const EXT_FOLDER     = 'freqpull-ext';
const EXT_CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const EXT_CHECK_KEY_SHA  = 'extLatestSha';
const EXT_CHECK_KEY_SEEN = 'extLastSeenSha';
const EXT_CHECK_KEY_AT   = 'extLastCheckedAt';

async function checkExtensionUpdates() {
  try {
    const url = 'https://api.github.com/repos/' + EXT_REPO_OWNER + '/' + EXT_REPO_NAME +
                '/commits?path=' + encodeURIComponent(EXT_FOLDER) + '&per_page=1';
    const r = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) return; // rate-limited or transient — try next interval
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return;
    const latestSha = arr[0].sha;
    const latestUrl = arr[0].html_url;
    const latestMsg = (arr[0].commit && arr[0].commit.message || '').split('\n')[0].slice(0, 120);
    chrome.storage.local.set({
      [EXT_CHECK_KEY_SHA]: latestSha,
      extLatestUrl: latestUrl,
      extLatestMsg: latestMsg,
      [EXT_CHECK_KEY_AT]: Date.now(),
    });
  } catch (e) {
    // Network down, GitHub blocked, whatever — silent. Try next interval.
  }
}

// Boot kick: 8s after install/load so we don't compete with other
// startup work, then every 6h.
setTimeout(checkExtensionUpdates, 8000);
setInterval(checkExtensionUpdates, EXT_CHECK_INTERVAL_MS);
