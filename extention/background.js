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
