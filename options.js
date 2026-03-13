const DEFAULTS = {
  lingoApiKey: "",
  lingoApiUrl: "https://api.lingo.dev",
  lingoEngineId: "",
};

function setStatus(text) {
  document.getElementById("status").textContent = text || "";
}

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("apiKey").value = stored.lingoApiKey || "";
  document.getElementById("apiUrl").value = stored.lingoApiUrl || "https://api.lingo.dev";
  document.getElementById("engineId").value = stored.lingoEngineId || "";
  setStatus(stored.lingoApiKey ? "API key is set." : "No API key saved yet.");
}

async function save() {
  const value = document.getElementById("apiKey").value.trim();
  const apiUrl = document.getElementById("apiUrl").value.trim() || "https://api.lingo.dev";
  const engineId = document.getElementById("engineId").value.trim();
  await chrome.storage.local.set({
    lingoApiKey: value,
    lingoApiUrl: apiUrl,
    lingoEngineId: engineId,
    lingoStrategy: null,
  });
  setStatus(value ? "Saved." : "Cleared.");
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  document.getElementById("save").addEventListener("click", save);
});
