const DEFAULTS = {
  lingoApiKey: "",
  lingoApiUrl: "https://api.lingo.dev",
  lingoEngineId: "",
  lingoSessionId: "",
};

// Best-effort in-memory cache; service workers can be evicted at any time.
const cache = new Map(); // key -> translation

const MAX_BATCH_ITEMS = 40;

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    apiKey: String(stored.lingoApiKey || "").trim(),
    apiUrl: String(stored.lingoApiUrl || "https://api.lingo.dev").trim().replace(/\/+$/, ""),
    engineId: String(stored.lingoEngineId || "").trim(),
    sessionId: String(stored.lingoSessionId || "").trim(),
  };
}

async function ensureSessionId() {
  const { sessionId } = await getConfig();
  if (sessionId) return sessionId;
  const next = crypto?.randomUUID ? crypto.randomUUID() : String(Date.now());
  await chrome.storage.local.set({ lingoSessionId: next });
  return next;
}

function parseLocalizedText(json) {
  // The Python SDK returns `{ data: { text: "..." } }` for localize_text.
  const candidates = [json?.data?.text, json?.text, json?.data?.translation, json?.translation];
  for (const c of candidates) {
    if (typeof c === "string" && c.length) return c;
  }
  return null;
}

function parseLocalizedDataObject(json) {
  // For object localization, the API returns `{ data: { key: "translated", ... } }`.
  if (json && typeof json === "object" && json.data && typeof json.data === "object") return json.data;
  return null;
}

async function localizeDataViaLingo(dataObj, targetLocale) {
  const cfg = await getConfig();
  if (!cfg.apiKey) throw new Error("Missing Lingo.dev API key (open extension options).");
  if (!cfg.apiUrl) throw new Error("Missing Lingo.dev API URL (open extension options).");

  const sessionId = await ensureSessionId();
  const url = `${cfg.apiUrl}/process/localize`;

  const requestData = {
    params: { fast: true },
    // Lingo.dev expects a string; use "auto" for detection.
    sourceLocale: "auto",
    targetLocale,
    data: dataObj,
    sessionId,
  };

  if (cfg.engineId) requestData.engineId = cfg.engineId;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-API-Key": cfg.apiKey,
    },
    body: JSON.stringify(requestData),
    signal: controller.signal,
  });

  clearTimeout(t);

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    const preview = bodyText ? ` (${bodyText.slice(0, 200)})` : "";
    throw new Error(`Lingo.dev request failed: ${response.status} @ ${url}${preview}`);
  }

  const json = bodyText ? JSON.parse(bodyText) : {};
  const localizedObj = parseLocalizedDataObject(json);
  if (!localizedObj) throw new Error("Lingo.dev returned an unexpected response shape.");
  return localizedObj;
}

async function localizeTextViaLingo(text, targetLocale) {
  const localizedObj = await localizeDataViaLingo({ text }, targetLocale);
  const localized = localizedObj.text;
  if (typeof localized !== "string") throw new Error("Lingo.dev returned an unexpected response shape.");
  return localized;
}

async function localizeBatchViaLingo(texts, targetLocale) {
  if (!Array.isArray(texts)) throw new Error("Missing texts");
  const items = texts.slice(0, MAX_BATCH_ITEMS);
  const data = {};
  for (let i = 0; i < items.length; i += 1) {
    data[`t${i}`] = String(items[i] ?? "");
  }

  const localizedObj = await localizeDataViaLingo(data, targetLocale);
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const v = localizedObj[`t${i}`];
    out.push(typeof v === "string" ? v : "");
  }
  return out;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      if (request?.action !== "translate" && request?.action !== "translateBatch") {
        sendResponse({ ok: false, error: "Unknown action" });
        return;
      }

      const targetLang = String(request?.targetLang || "");
      if (!targetLang) return sendResponse({ ok: false, error: "Missing targetLang" });

      if (request.action === "translate") {
        const text = String(request?.text || "");
        if (!text.trim()) return sendResponse({ ok: false, error: "Missing text" });

        const cacheKey = `${targetLang}::${text}`;
        if (cache.has(cacheKey)) return sendResponse({ ok: true, translation: cache.get(cacheKey) });

        const translation = await localizeTextViaLingo(text, targetLang);
        cache.set(cacheKey, translation);
        return sendResponse({ ok: true, translation });
      }

      // translateBatch
      const texts = Array.isArray(request?.texts) ? request.texts : null;
      if (!texts || texts.length === 0) return sendResponse({ ok: false, error: "Missing texts" });

      // De-dup + cache, but preserve order.
      const unique = [];
      const uniqueIndexByText = new Map();
      const order = [];
      for (const t of texts) {
        const s = String(t ?? "");
        order.push(s);
        if (uniqueIndexByText.has(s)) continue;
        uniqueIndexByText.set(s, unique.length);
        unique.push(s);
      }

      const uniqueTranslations = new Array(unique.length).fill(null);
      const missing = [];
      const missingIdx = [];
      for (let i = 0; i < unique.length; i += 1) {
        const cacheKey = `${targetLang}::${unique[i]}`;
        if (cache.has(cacheKey)) {
          uniqueTranslations[i] = cache.get(cacheKey);
        } else {
          missing.push(unique[i]);
          missingIdx.push(i);
        }
      }

      // Fetch missing in chunks.
      for (let i = 0; i < missing.length; i += MAX_BATCH_ITEMS) {
        const chunk = missing.slice(i, i + MAX_BATCH_ITEMS);
        const translatedChunk = await localizeBatchViaLingo(chunk, targetLang);
        for (let j = 0; j < chunk.length; j += 1) {
          const text = chunk[j];
          const tr = translatedChunk[j] || "";
          const originalIndex = missingIdx[i + j];
          uniqueTranslations[originalIndex] = tr;
          cache.set(`${targetLang}::${text}`, tr);
        }
      }

      const translations = order.map((s) => {
        const idx = uniqueIndexByText.get(s);
        return idx === undefined ? "" : uniqueTranslations[idx] || "";
      });

      return sendResponse({ ok: true, translations });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
