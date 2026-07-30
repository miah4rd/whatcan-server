
chrome.runtime.onInstalled.addListener(({ reason }) => {
  // options page removed
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "COPILOT_TOGGLE" }); } catch {}
});

let _voiceTabId = null;
let _voiceTarget = null;

async function sendOffscreen(msg) {
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await chrome.runtime.sendMessage(msg);
      if (resp !== undefined) return resp;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("Offscreen not responding");
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (!has) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["USER_MEDIA"],
      justification: "Record microphone audio for AI transcription",
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "VOICE_START") {
    _voiceTabId = sender.tab ? sender.tab.id : null;
    _voiceTarget = msg.target || null;
    (async () => {
      try {
        await ensureOffscreen();
        const resp = await sendOffscreen({ type: "OFFSCREEN_START", apiBase: msg.apiBase });
        const text = (resp && resp.text) ? resp.text : "";
        const err  = (resp && resp.error) ? resp.error : ((!resp || !resp.ok) ? "Recording failed" : null);
        if (_voiceTabId != null) {
          chrome.tabs.sendMessage(_voiceTabId, { type: "VOICE_RESULT", text, error: err, target: _voiceTarget }).catch(() => {});
          _voiceTabId = null;
          _voiceTarget = null;
        }
        chrome.offscreen.closeDocument().catch(() => {});
      } catch (err) {
        if (_voiceTabId != null) {
          chrome.tabs.sendMessage(_voiceTabId, { type: "VOICE_RESULT", text: "", error: err.message, target: _voiceTarget }).catch(() => {});
          _voiceTabId = null;
          _voiceTarget = null;
        }
        chrome.offscreen.closeDocument().catch(() => {});
      }
    })();
    return false;
  }
  if (msg.type === "VOICE_STOP") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
    return false;
  }
  if (msg.type === "OFFSCREEN_RECORDING") {
    if (_voiceTabId != null) {
      chrome.tabs.sendMessage(_voiceTabId, { type: "VOICE_RECORDING", target: _voiceTarget }).catch(() => {});
    }
    return false;
  }
});
