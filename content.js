console.log("Lingo It content script loaded");

const DEFAULT_SETTINGS = {
  enabled: false,
  targetLang: "es",
  highlight: false,
};

const MAX_CONCURRENT_REQUESTS = 4;
const MIN_TEXT_LEN = 2;
const BATCH_SIZE = 35;

let settings = { ...DEFAULT_SETTINGS };

// Track originals so we can restore, and avoid double-translation.
const originalTextByNode = new WeakMap();
const translatedByNode = new WeakMap(); // { targetLang, translated }
const touchedNodes = new Set();

// Cache translations by (targetLang + text).
const translationCache = new Map();

let observer = null;
let scheduledScan = null;
let activeRequests = 0;
const requestQueue = [];

let lastErrorMessage = "";

function isElementSkippable(el) {
  if (!el) return true;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (!tag) return true;

  if (
    tag === "script" ||
    tag === "style" ||
    tag === "noscript" ||
    tag === "svg" ||
    tag === "canvas" ||
    tag === "textarea" ||
    tag === "input" ||
    tag === "select" ||
    tag === "option"
  ) {
    return true;
  }

  if (el.isContentEditable) return true;

  return false;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;

  // Cheap offscreen check; avoids lots of work on huge pages.
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return true;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getTextNodes(root = document.body) {
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isElementSkippable(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
      const normalized = normalizeText(node.nodeValue);
      if (normalized.length < MIN_TEXT_LEN) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let n = walker.nextNode();
  while (n) {
    nodes.push(n);
    n = walker.nextNode();
  }
  return nodes;
}

function scheduleTranslateNewContent() {
  if (!settings.enabled) return;
  if (scheduledScan) return;
  scheduledScan = setTimeout(() => {
    scheduledScan = null;
    translatePage();
  }, 250);
}

function recordError(err) {
  const msg = err?.message || String(err);
  lastErrorMessage = msg;
  // Visible in the page console for debugging.
  console.warn("[Lingo It] Translation error:", msg);
}

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
    const job = requestQueue.shift();
    activeRequests += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve)
      .catch((err) => {
        recordError(err);
        job.reject(err);
      })
      .finally(() => {
        activeRequests -= 1;
        pumpQueue();
      });
  }
}

function translateInBackground(text, targetLang) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "translate", text, targetLang }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res?.ok) {
        reject(new Error(res?.error || "Translation failed"));
        return;
      }
      resolve(res.translation);
    });
  });
}

function translateBatchInBackground(texts, targetLang) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "translateBatch", texts, targetLang }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res?.ok) {
        reject(new Error(res?.error || "Translation failed"));
        return;
      }
      resolve(res.translations || []);
    });
  });
}

async function translateText(text, targetLang) {
  const cacheKey = `${targetLang}::${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const translated = await translateInBackground(text, targetLang);

  translationCache.set(cacheKey, translated);
  return translated;
}

async function translateBatch(texts, targetLang) {
  const out = new Array(texts.length);
  const missing = [];
  const missingIdx = [];

  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    const cacheKey = `${targetLang}::${t}`;
    if (translationCache.has(cacheKey)) {
      out[i] = translationCache.get(cacheKey);
    } else {
      missing.push(t);
      missingIdx.push(i);
    }
  }

  if (missing.length) {
    const translated = await translateBatchInBackground(missing, targetLang);
    for (let i = 0; i < missing.length; i += 1) {
      const tr = translated[i] || "";
      const idx = missingIdx[i];
      out[idx] = tr;
      translationCache.set(`${targetLang}::${missing[i]}`, tr);
    }
  }

  return out.map((v) => (typeof v === "string" ? v : ""));
}

function applyTranslationToNode(textNode, translated) {
  if (!originalTextByNode.has(textNode)) {
    originalTextByNode.set(textNode, textNode.nodeValue);
  }
  touchedNodes.add(textNode);
  translatedByNode.set(textNode, { targetLang: settings.targetLang, translated });
  textNode.nodeValue = translated;

  // Optional: simple highlight by styling the parent element.
  if (settings.highlight && textNode.parentElement) {
    textNode.parentElement.style.outline = "1px solid rgba(55, 211, 167, 0.45)";
    textNode.parentElement.style.outlineOffset = "1px";
  }
}

async function translatePage({ limit = null, awaitCompletion = false } = {}) {
  if (!settings.enabled) return { ok: true, skipped: true };
  const targetLang = settings.targetLang;
  const nodesAll = getTextNodes();
  const nodes = typeof limit === "number" ? nodesAll.slice(0, Math.max(0, limit)) : nodesAll;

  let candidates = 0;
  let queued = 0;
  let translated = 0;
  let failed = 0;
  const pending = [];

  // Collect nodes by source text so we can batch.
  const nodesBySource = new Map(); // source -> Node[]
  for (const node of nodes) {
    const normalized = normalizeText(node.nodeValue);
    if (normalized.length < MIN_TEXT_LEN) continue;

    // If this node was already translated to the same target, skip.
    const prev = translatedByNode.get(node);
    if (prev && prev.targetLang === targetLang && prev.translated === node.nodeValue) continue;

    const source = normalizeText(originalTextByNode.get(node) || node.nodeValue);
    if (source.length < MIN_TEXT_LEN) continue;

    candidates += 1;
    const list = nodesBySource.get(source) || [];
    list.push(node);
    nodesBySource.set(source, list);
  }

  const sources = Array.from(nodesBySource.keys());
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const chunk = sources.slice(i, i + BATCH_SIZE);
    const p = enqueueRequest(async () => {
      const translations = await translateBatch(chunk, targetLang);
      // Only apply if still enabled and language unchanged.
      if (!settings.enabled || settings.targetLang !== targetLang) return 0;

      let applied = 0;
      for (let j = 0; j < chunk.length; j += 1) {
        const source = chunk[j];
        const tr = translations[j] || "";
        const nodeList = nodesBySource.get(source) || [];
        for (const node of nodeList) {
          if (!node.parentElement || !node.parentElement.isConnected) continue;
          applyTranslationToNode(node, tr);
          applied += 1;
        }
      }
      return applied;
    })
      .then((applied) => {
        translated += applied || 0;
      })
      .catch(() => {
        // Count a batch failure as failures for its chunk size (approx).
        failed += chunk.length;
      });

    queued += 1;
    if (awaitCompletion) pending.push(p);
  }

  if (awaitCompletion && pending.length) {
    await Promise.allSettled(pending);
  }

  return {
    ok: true,
    candidates,
    queued,
    translated,
    failed,
    lastError: lastErrorMessage,
  };
}

function restorePage() {
  for (const node of Array.from(touchedNodes)) {
    if (!node?.parentElement || !node.parentElement.isConnected) {
      touchedNodes.delete(node);
      continue;
    }

    if (originalTextByNode.has(node)) {
      node.nodeValue = originalTextByNode.get(node);
      translatedByNode.delete(node);
    }

    if (node.parentElement) {
      node.parentElement.style.outline = "";
      node.parentElement.style.outlineOffset = "";
    }
  }
  return { ok: true };
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(() => scheduleTranslateNewContent());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function stopObserver() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...stored };
}

async function applySettingsPatch(patch) {
  settings = { ...settings, ...(patch || {}) };
  if (settings.enabled) {
    startObserver();
  } else {
    stopObserver();
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      if (request?.action === "settingsChanged") {
        await applySettingsPatch(request.patch);
        if (settings.enabled) {
          // If the language changed, restore then re-translate immediately without reload.
          if (request.patch && typeof request.patch.targetLang === "string") {
            restorePage();
          }
          translatePage();
        }
        sendResponse({ ok: true });
        return;
      }

      if (request?.action === "translateNow") {
        await applySettingsPatch({ enabled: true });
        lastErrorMessage = "";

        // Probe request so the popup can show auth/API problems immediately.
        try {
          await translateText("Hello", settings.targetLang);
        } catch (err) {
          recordError(err);
          sendResponse({ ok: false, error: lastErrorMessage || "Translation probe failed" });
          return;
        }

        // Translate a limited set and await, so the user sees something change right away.
        const res = await translatePage({ limit: 80, awaitCompletion: true });
        // Keep going in the background for the rest of the page.
        translatePage();
        sendResponse(res);
        return;
      }

      if (request?.action === "restoreNow") {
        await applySettingsPatch({ enabled: false });
        const res = restorePage();
        sendResponse(res);
        return;
      }

      sendResponse({ ok: false, error: "Unknown action" });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

(async function init() {
  await loadSettings();
  if (settings.enabled) {
    startObserver();
    translatePage();
  }
})();
