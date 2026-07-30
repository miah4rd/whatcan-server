
let _mr = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_START") {
    startRec(msg.apiBase).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "OFFSCREEN_STOP") {
    if (_mr && _mr.state === "recording") _mr.stop();
    sendResponse({ ok: true });
  }
});

async function startRec(apiBase) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return { ok: false, error: err.name + ": " + err.message };
  }

  return new Promise((resolve) => {
    const chunks = [];
    _mr = new MediaRecorder(stream);

    _mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    _mr.onstop = async () => {
      _mr = null;
      stream.getTracks().forEach(t => t.stop());
      if (!chunks.length) { resolve({ ok: true, text: "" }); return; }
      try {
        const mimeType = chunks[0].type || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        const resp = await fetch(apiBase + "/transcribe", {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: blob,
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        resolve({ ok: true, text: data.text || "" });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    };

    _mr.start();
    chrome.runtime.sendMessage({ type: "OFFSCREEN_RECORDING" }).catch(() => {});
    // Auto-stop after 60s
    setTimeout(() => { if (_mr && _mr.state === "recording") _mr.stop(); }, 60000);
  });
}
