const DEFAULT_SETTINGS = {
  enabled: false,
  targetLang: "es",
  highlight: false,
  emergencyMode: false,
  translateAttributes: true,
  uiTheme: "auto", // auto | light | dark
};

function setStatus(text) {
  document.getElementById("status").textContent = text || "";
}

function setMeter(pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  document.getElementById("meterBar").style.width = `${v}%`;
}

function applyTheme(theme) {
  const t = theme || "auto";
  if (t === "auto") {
    delete document.documentElement.dataset.theme;
    return;
  }
  document.documentElement.dataset.theme = t;
}

function nextTheme(theme) {
  if (theme === "auto") return "dark";
  if (theme === "dark") return "light";
  return "auto";
}

function missingKey(message) {
  return /missing lingo\.dev api key/i.test(message || "");
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendToActiveTab(message) {
  return new Promise(async resolve => {
    const tabId = await getActiveTabId();
    if (!tabId) return resolve({ ok: false, error: "No active tab" });

    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve(response || { ok: true });
    });
  });
}

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

async function getHostname() {
  try {
    const url = await getActiveTabUrl();
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    sitePrefs: {},
  });
  document.getElementById("enabled").checked = !!stored.enabled;
  document.getElementById("language").value = stored.targetLang || "es";
  document.getElementById("highlight").checked = !!stored.highlight;
  document.getElementById("emergency").checked = !!stored.emergencyMode;
  document.getElementById("attrs").checked = stored.translateAttributes !== false;
  applyTheme(stored.uiTheme || "auto");
  syncLanguageDropdown();

  const host = await getHostname();
  const pref = host ? stored.sitePrefs?.[host] : null;
  document.getElementById("autoSite").checked = !!pref?.enabled;
}

async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  // Also notify the content script so it can react without reload.
  await sendToActiveTab({ action: "settingsChanged", patch });
}

async function updateSitePref(hostname, prefPatch) {
  const stored = await chrome.storage.sync.get({ sitePrefs: {} });
  const next = { ...(stored.sitePrefs || {}) };
  next[hostname] = { ...(next[hostname] || {}), ...(prefPatch || {}) };
  await chrome.storage.sync.set({ sitePrefs: next });
  await sendToActiveTab({ action: "sitePrefChanged", hostname, pref: next[hostname] });
}

async function pollProgressForAWhile(ms = 3500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await sendToActiveTab({ action: "getStatus" });
    if (res?.ok && res.status) {
      const pct = res.status.total ? (100 * res.status.done) / res.status.total : 0;
      setMeter(pct);
      if (typeof res.status.message === "string" && res.status.message) setStatus(res.status.message);
      if (res.status.done >= res.status.total && res.status.total > 0) break;
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

function setDropdownOpen(open) {
  const btn = document.getElementById("languageBtn");
  const menu = document.getElementById("languageMenu");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) menu.dataset.open = "true";
  else delete menu.dataset.open;
}

function syncLanguageDropdown() {
  const select = document.getElementById("language");
  const label = document.getElementById("languageLabel");
  const menu = document.getElementById("languageMenu");

  const opt = select.selectedOptions?.[0];
  label.textContent = opt ? opt.textContent : select.value;

  menu.querySelectorAll(".ddItem").forEach((el) => {
    const v = el.getAttribute("data-value");
    el.setAttribute("aria-selected", v === select.value ? "true" : "false");
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  setMeter(0);

  document.getElementById("theme").addEventListener("click", async () => {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const next = nextTheme(stored.uiTheme || "auto");
    applyTheme(next);
    await saveSettings({ uiTheme: next });
  });

  // Custom language dropdown
  document.getElementById("languageBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const open = document.getElementById("languageBtn").getAttribute("aria-expanded") === "true";
    setDropdownOpen(!open);
  });

  document.getElementById("languageMenu").addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".ddItem");
    if (!btn) return;
    const value = btn.getAttribute("data-value");
    if (!value) return;
    const select = document.getElementById("language");
    select.value = value;
    syncLanguageDropdown();
    setDropdownOpen(false);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  document.addEventListener("click", (e) => {
    const dd = document.getElementById("languageDropdown");
    if (!dd.contains(e.target)) setDropdownOpen(false);
  });

  document.getElementById("enabled").addEventListener("change", async e => {
    setStatus("");
    await saveSettings({ enabled: e.target.checked });
    setStatus(
      e.target.checked ? "Translation enabled" : "Translation disabled",
    );
    if (!e.target.checked) setMeter(0);
  });

  document.getElementById("language").addEventListener("change", async e => {
    const targetLang = e.target.value;
    syncLanguageDropdown();
    setStatus("");
    await saveSettings({ targetLang });

    if (document.getElementById("enabled").checked) {
      setStatus("Switching language...");
      setMeter(5);
      const res = await sendToActiveTab({ action: "translateNow" });
      if (res?.ok) {
        setStatus(`Translated: ${res.translated || 0}`);
        pollProgressForAWhile();
      } else {
        setStatus(`Error: ${res?.error || "Unknown"}`);
      }
    }
  });

  document.getElementById("highlight").addEventListener("change", async e => {
    await saveSettings({ highlight: e.target.checked });
    if (document.getElementById("enabled").checked) pollProgressForAWhile(1200);
  });

  document.getElementById("emergency").addEventListener("change", async e => {
    await saveSettings({ emergencyMode: e.target.checked });
    if (document.getElementById("enabled").checked) {
      setStatus("Re-prioritizing...");
      setMeter(5);
      const res = await sendToActiveTab({ action: "translateNow" });
      if (!res?.ok) setStatus(`Error: ${res?.error || "Unknown"}`);
      pollProgressForAWhile();
    }
  });

  document.getElementById("attrs").addEventListener("change", async e => {
    await saveSettings({ translateAttributes: e.target.checked });
    if (document.getElementById("enabled").checked) {
      setStatus("Updating...");
      setMeter(5);
      const res = await sendToActiveTab({ action: "translateNow" });
      if (!res?.ok) setStatus(`Error: ${res?.error || "Unknown"}`);
      pollProgressForAWhile();
    }
  });

  document.getElementById("autoSite").addEventListener("change", async e => {
    const host = await getHostname();
    if (!host) {
      setStatus("Can't read site hostname.");
      return;
    }
    await updateSitePref(host, {
      enabled: e.target.checked,
      targetLang: document.getElementById("language").value,
    });
    setStatus(e.target.checked ? "Auto enabled for this site." : "Auto disabled for this site.");
  });

  document.getElementById("apply").addEventListener("click", async () => {
    setStatus("");
    const targetLang = document.getElementById("language").value;
    await saveSettings({ targetLang, enabled: true });
    setStatus("Starting translation...");
    setMeter(5);
    const res = await sendToActiveTab({ action: "translateNow" });
    if (res?.ok) {
      if ((res.translated || 0) === 0 && (res.failed || 0) === 0) {
        setStatus("No translatable text found on this page.");
        setMeter(0);
        return;
      }
      const parts = [];
      parts.push(`Translated: ${res.translated || 0}`);
      if ((res.failed || 0) > 0) parts.push(`Failed: ${res.failed}`);
      setStatus(parts.join("  |  "));
      pollProgressForAWhile();
      return;
    }

    const msg = res?.error || "Unknown";
    if (missingKey(msg)) {
      setStatus(
        "Missing API key. Open extension options to set your Lingo.dev key.",
      );
      chrome.runtime.openOptionsPage?.();
      return;
    }
    setStatus(`Error: ${msg}`);
    setMeter(0);
  });

  document.getElementById("restore").addEventListener("click", async () => {
    setStatus("");
    await saveSettings({ enabled: false });
    const res = await sendToActiveTab({ action: "restoreNow" });
    setStatus(res?.ok ? "Restored" : `Error: ${res?.error || "Unknown"}`);
    setMeter(0);
  });

  document.getElementById("stop").addEventListener("click", async () => {
    setStatus("Stopping...");
    const res = await sendToActiveTab({ action: "stopNow" });
    setStatus(res?.ok ? "Stopped" : `Error: ${res?.error || "Unknown"}`);
  });

  document.getElementById("options").addEventListener("click", async () => {
    chrome.runtime.openOptionsPage?.();
  });
});
