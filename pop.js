const DEFAULT_SETTINGS = {
  enabled: false,
  targetLang: "es",
  highlight: false,
};

function setStatus(text) {
  document.getElementById("status").textContent = text || "";
}

function looksLikeMissingKey(message) {
  return /missing lingo\.dev api key/i.test(message || "");
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendToActiveTab(message) {
  return new Promise(async (resolve) => {
    const tabId = await getActiveTabId();
    if (!tabId) return resolve({ ok: false, error: "No active tab" });

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve(response || { ok: true });
    });
  });
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  document.getElementById("enabled").checked = !!stored.enabled;
  document.getElementById("language").value = stored.targetLang || "es";
}

async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  // Also notify the content script so it can react without reload.
  await sendToActiveTab({ action: "settingsChanged", patch });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("enabled").addEventListener("change", async (e) => {
    setStatus("");
    await saveSettings({ enabled: e.target.checked });
    setStatus(e.target.checked ? "Translation enabled" : "Translation disabled");
  });

  document.getElementById("apply").addEventListener("click", async () => {
    setStatus("");
    const targetLang = document.getElementById("language").value;
    await saveSettings({ targetLang, enabled: true });
    setStatus("Starting translation...");
    const res = await sendToActiveTab({ action: "translateNow" });
    if (res?.ok) {
      if ((res.translated || 0) === 0 && (res.failed || 0) === 0) {
        setStatus("No translatable text found on this page.");
        return;
      }
      const parts = [];
      parts.push(`Translated: ${res.translated || 0}`);
      if ((res.failed || 0) > 0) parts.push(`Failed: ${res.failed}`);
      setStatus(parts.join("  |  "));
      return;
    }

    const msg = res?.error || "Unknown";
    if (looksLikeMissingKey(msg)) {
      setStatus("Missing API key. Open extension options to set your Lingo.dev key.");
      chrome.runtime.openOptionsPage?.();
      return;
    }
    setStatus(`Error: ${msg}`);
  });

  document.getElementById("restore").addEventListener("click", async () => {
    setStatus("");
    await saveSettings({ enabled: false });
    const res = await sendToActiveTab({ action: "restoreNow" });
    setStatus(res?.ok ? "Restored" : `Error: ${res?.error || "Unknown"}`);
  });
});
