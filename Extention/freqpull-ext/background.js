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
