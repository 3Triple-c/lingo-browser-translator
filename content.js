console.log("Lingo It content script loaded");

const DEFAULT_SETTINGS = {
  enabled: false,
  targetLang: "es",
  highlight: false,
  emergencyMode: false,
  translateAttributes: true,
};

const MAX_CONCURRENT_REQUESTS = 4;
const MIN_TEXT_LEN = 2;
const BATCH_SIZE = 35;

let settings = { ...DEFAULT_SETTINGS };

// Track originals so we can restore, and avoid double-translation.
const originalTextByNode = new WeakMap();
const translatedByNode = new WeakMap(); // { targetLang, translated }
const touchedNodes = new Set();

const originalAttrsByEl = new WeakMap(); // Element -> Map(attr -> original)
const touchedAttrsByEl = new WeakMap(); // Element -> Set(attr)
const touchedAttrEls = new Set(); // Element

// Cache translations by (targetLang + text).
const translationCache = new Map();

let observer = null;
let scheduledScan = null;
let activeRequests = 0;
const requestQueue = [];

let lastErrorMessage = "";
let translationRunId = 0;
let activeRunId = 0;
let lastStatus = { total: 0, done: 0, failed: 0, message: "" };
let scheduledViewportScan = null;
let scheduledBackfill = null;
let backfillState = null; // { runId, targetLang, sources, itemsBySource, index }

const EMERGENCY_KEYWORDS = ["fire", "help", "danger", "emergency", "warning", "police", "hospital"];

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

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return true;
}

function isElementInViewport(el, marginPx = 150) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const top = rect.top;
  const bottom = rect.bottom;
  const vpTop = 0 - marginPx;
  const vpBottom = (window.innerHeight || document.documentElement.clientHeight || 0) + marginPx;
  return bottom >= vpTop && top <= vpBottom;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getTextNodes(root = document.body, { onlyInViewport = false } = {}) {
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isElementSkippable(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
      if (onlyInViewport && !isElementInViewport(parent)) return NodeFilter.FILTER_REJECT;
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

function scheduleViewportTranslate() {
  if (!settings.enabled) return;
  if (scheduledViewportScan) return;
  scheduledViewportScan = setTimeout(() => {
    scheduledViewportScan = null;
    // Translate newly visible content quickly without re-queuing the entire page.
    translatePage({ limit: 140, onlyInViewport: true });
  }, 200);
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

function clearQueue() {
  requestQueue.length = 0;
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

function isEmergencyText(text) {
  const t = (text || "").toLowerCase();
  return EMERGENCY_KEYWORDS.some(k => t.includes(k));
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

function getOriginalAttr(el, attr) {
  const map = originalAttrsByEl.get(el);
  return map ? map.get(attr) : undefined;
}

function setOriginalAttr(el, attr, value) {
  let map = originalAttrsByEl.get(el);
  if (!map) {
    map = new Map();
    originalAttrsByEl.set(el, map);
  }
  if (!map.has(attr)) map.set(attr, value);
}

function markTouchedAttr(el, attr) {
  let set = touchedAttrsByEl.get(el);
  if (!set) {
    set = new Set();
    touchedAttrsByEl.set(el, set);
  }
  set.add(attr);
  touchedAttrEls.add(el);
}

function applyTranslationToAttr(el, attr, translated) {
  const prev = el.getAttribute(attr);
  if (prev === null) return;
  setOriginalAttr(el, attr, prev);
  markTouchedAttr(el, attr);
  el.setAttribute(attr, translated);
}

function getAttributeItems({ onlyInViewport = false } = {}) {
  if (!settings.translateAttributes) return [];
  const out = [];
  const els = document.querySelectorAll("img[alt], img[title]");
  for (const el of els) {
    if (!(el instanceof Element)) continue;
    if (!isElementVisible(el)) continue;
    if (onlyInViewport && !isElementInViewport(el)) continue;

    for (const attr of ["alt", "title"]) {
      const v = el.getAttribute(attr);
      const norm = normalizeText(v);
      if (!norm || norm.length < MIN_TEXT_LEN) continue;
      out.push({ el, attr, text: norm, emergency: settings.emergencyMode && isEmergencyText(norm) });
    }
  }
  return out;
}

async function loadSettingsForSite() {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    sitePrefs: {},
  });
  let next = { ...DEFAULT_SETTINGS, ...stored };

  try {
    const host = location.hostname || "";
    const pref = host ? stored.sitePrefs?.[host] : null;
    if (pref?.enabled) {
      next.enabled = true;
      if (typeof pref.targetLang === "string" && pref.targetLang) next.targetLang = pref.targetLang;
    }
  } catch {
    // Ignore.
  }

  settings = next;
}

function updateStatus(patch) {
  lastStatus = { ...lastStatus, ...(patch || {}) };
}

function scheduleBackfill() {
  if (!settings.enabled) return;
  if (scheduledBackfill) return;
  const cb = () => {
    scheduledBackfill = null;
    translateBackfillChunk();
  };
  if (typeof requestIdleCallback === "function") {
    scheduledBackfill = requestIdleCallback(cb, { timeout: 1200 });
  } else {
    scheduledBackfill = setTimeout(cb, 250);
  }
}

function cancelBackfill() {
  if (!scheduledBackfill) return;
  if (typeof scheduledBackfill === "number") clearTimeout(scheduledBackfill);
  else if (typeof cancelIdleCallback === "function") cancelIdleCallback(scheduledBackfill);
  scheduledBackfill = null;
  backfillState = null;
}

function buildItemsBySource({ onlyInViewport = false } = {}) {
  const nodesAll = getTextNodes(document.body, { onlyInViewport });
  const itemsBySource = new Map(); // source -> { nodes: Node[], attrs: [] }

  for (const node of nodesAll) {
    const normalized = normalizeText(node.nodeValue);
    if (normalized.length < MIN_TEXT_LEN) continue;
    const prev = translatedByNode.get(node);
    if (prev && prev.targetLang === settings.targetLang && prev.translated === node.nodeValue) continue;

    const source = normalizeText(originalTextByNode.get(node) || node.nodeValue);
    if (source.length < MIN_TEXT_LEN) continue;

    const entry = itemsBySource.get(source) || { nodes: [], attrs: [] };
    entry.nodes.push(node);
    itemsBySource.set(source, entry);
  }

  const attrItems = getAttributeItems({ onlyInViewport });
  for (const it of attrItems) {
    const entry = itemsBySource.get(it.text) || { nodes: [], attrs: [] };
    entry.attrs.push(it);
    itemsBySource.set(it.text, entry);
  }

  return itemsBySource;
}

function buildSources(itemsBySource) {
  let sources = Array.from(itemsBySource.keys());
  if (settings.emergencyMode) {
    sources.sort((a, b) => {
      const ae = isEmergencyText(a) ? 1 : 0;
      const be = isEmergencyText(b) ? 1 : 0;
      return be - ae;
    });
  }
  return sources;
}

function translateBackfillChunk() {
  if (!settings.enabled) return;
  if (!backfillState || backfillState.runId !== activeRunId || backfillState.targetLang !== settings.targetLang) {
    return;
  }

  const { sources, itemsBySource } = backfillState;
  if (backfillState.index >= sources.length) {
    updateStatus({ message: "Done" });
    return;
  }

  const targetLang = settings.targetLang;
  const runId = activeRunId;
  const start = backfillState.index;
  const end = Math.min(sources.length, start + BATCH_SIZE * 2);
  backfillState.index = end;

  const chunkSources = sources.slice(start, end);
  enqueueRequest(async () => {
    if (runId !== activeRunId) return 0;
    const translations = await translateBatch(chunkSources, targetLang);
    if (!settings.enabled || settings.targetLang !== targetLang || runId !== activeRunId) return 0;

    let applied = 0;
    for (let j = 0; j < chunkSources.length; j += 1) {
      const source = chunkSources[j];
      const tr = translations[j] || "";
      const entry = itemsBySource.get(source) || { nodes: [], attrs: [] };
      for (const node of entry.nodes) {
        if (!node.parentElement || !node.parentElement.isConnected) continue;
        applyTranslationToNode(node, tr);
        applied += 1;
      }
      for (const it of entry.attrs) {
        if (!it.el || !it.el.isConnected) continue;
        applyTranslationToAttr(it.el, it.attr, tr);
      }
    }
    updateStatus({
      done: Math.min(lastStatus.total, lastStatus.done + chunkSources.length),
      message: `Translated ${applied} (backfill)`,
    });
    return applied;
  }).catch(() => {});

  // Keep filling in idle time.
  scheduleBackfill();
}

async function translatePage({ limit = null, awaitCompletion = false, onlyInViewport = false, updateTotals = true } = {}) {
  if (!settings.enabled) return { ok: true, skipped: true };
  const targetLang = settings.targetLang;
  const nodesAll = getTextNodes(document.body, { onlyInViewport });
  const nodes = typeof limit === "number" ? nodesAll.slice(0, Math.max(0, limit)) : nodesAll;

  let candidates = 0;
  let queued = 0;
  let translated = 0;
  let failed = 0;
  const pending = [];
  const runId = activeRunId;

  // Collect items by source text so we can batch.
  const itemsBySource = new Map(); // source -> { nodes: [], attrs: [] }
  for (const node of nodes) {
    const normalized = normalizeText(node.nodeValue);
    if (normalized.length < MIN_TEXT_LEN) continue;
    const prev = translatedByNode.get(node);
    if (prev && prev.targetLang === targetLang && prev.translated === node.nodeValue) continue;
    const source = normalizeText(originalTextByNode.get(node) || node.nodeValue);
    if (source.length < MIN_TEXT_LEN) continue;
    candidates += 1;
    const entry = itemsBySource.get(source) || { nodes: [], attrs: [] };
    entry.nodes.push(node);
    itemsBySource.set(source, entry);
  }

  const attrItems = getAttributeItems({ onlyInViewport });
  for (const it of attrItems) {
    candidates += 1;
    const entry = itemsBySource.get(it.text) || { nodes: [], attrs: [] };
    entry.attrs.push(it);
    itemsBySource.set(it.text, entry);
  }

  const sources = buildSources(itemsBySource);

  if (updateTotals) updateStatus({ total: sources.length, done: 0, failed: 0, message: "Translating..." });
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const chunk = sources.slice(i, i + BATCH_SIZE);
    const p = enqueueRequest(async () => {
      if (runId !== activeRunId) return 0;
      const translations = await translateBatch(chunk, targetLang);
      // Only apply if still enabled and language unchanged.
      if (!settings.enabled || settings.targetLang !== targetLang || runId !== activeRunId) return 0;

      let applied = 0;
      for (let j = 0; j < chunk.length; j += 1) {
        const source = chunk[j];
        const tr = translations[j] || "";
        const entry = itemsBySource.get(source) || { nodes: [], attrs: [] };
        for (const node of entry.nodes) {
          if (!node.parentElement || !node.parentElement.isConnected) continue;
          applyTranslationToNode(node, tr);
          applied += 1;
        }
        for (const it of entry.attrs) {
          if (!it.el || !it.el.isConnected) continue;
          applyTranslationToAttr(it.el, it.attr, tr);
        }
      }
      updateStatus({
        done: Math.min(lastStatus.total, lastStatus.done + chunk.length),
        message: `Translated ${translated + applied} items`,
      });
      return applied;
    })
      .then((applied) => {
        translated += applied || 0;
      })
      .catch(() => {
        // Count a batch failure as failures for its chunk size (approx).
        failed += chunk.length;
        updateStatus({
          done: Math.min(lastStatus.total, lastStatus.done + chunk.length),
          failed: lastStatus.failed + chunk.length,
          message: `Translated ${translated} items (errors)`,
        });
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
  for (const el of Array.from(touchedAttrEls)) {
    if (!el || !el.isConnected) {
      touchedAttrEls.delete(el);
      continue;
    }
    const attrs = touchedAttrsByEl.get(el);
    const originals = originalAttrsByEl.get(el);
    if (!attrs || !originals) continue;
    for (const a of attrs) {
      if (originals.has(a)) el.setAttribute(a, originals.get(a));
    }
  }
  updateStatus({ total: 0, done: 0, failed: 0, message: "" });
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

  window.addEventListener("scroll", scheduleViewportTranslate, { passive: true });
}

function stopObserver() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
  window.removeEventListener("scroll", scheduleViewportTranslate);
}

async function loadSettings() {
  await loadSettingsForSite();
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
        if (request?.patch && request.patch.enabled === false) {
          // Stop any work when toggled off from the popup.
          activeRunId = ++translationRunId;
          clearQueue();
          cancelBackfill();
          updateStatus({ total: 0, done: 0, failed: 0, message: "" });
          sendResponse({ ok: true });
          return;
        }

        if (settings.enabled) {
          // Seamless retarget: keep current text until replacements arrive.
          activeRunId = ++translationRunId;
          cancelBackfill();
          clearQueue();
          translatePage();
          // Restart backfill with new settings/lang.
          const itemsBySource = buildItemsBySource({ onlyInViewport: false });
          const sources = buildSources(itemsBySource);
          backfillState = { runId: activeRunId, targetLang: settings.targetLang, sources, itemsBySource, index: 0 };
          updateStatus({ total: sources.length, done: 0, failed: 0, message: "Translating..." });
          scheduleBackfill();
        }
        sendResponse({ ok: true });
        return;
      }

      if (request?.action === "sitePrefChanged") {
        // Re-load computed settings (global + per-site).
        await loadSettingsForSite();
        if (settings.enabled) {
          activeRunId = ++translationRunId;
          cancelBackfill();
          clearQueue();
          startObserver();
          const itemsBySource = buildItemsBySource({ onlyInViewport: false });
          const sources = buildSources(itemsBySource);
          backfillState = { runId: activeRunId, targetLang: settings.targetLang, sources, itemsBySource, index: 0 };
          updateStatus({ total: sources.length, done: 0, failed: 0, message: "Translating..." });
          translatePage({ onlyInViewport: true, limit: 120, updateTotals: false });
          scheduleBackfill();
        } else {
          stopObserver();
        }
        sendResponse({ ok: true });
        return;
      }

      if (request?.action === "translateNow") {
        await applySettingsPatch({ enabled: true });
        lastErrorMessage = "";
        activeRunId = ++translationRunId;
        clearQueue();
        cancelBackfill();
        updateStatus({ total: 0, done: 0, failed: 0, message: "Starting..." });

        // Probe request so the popup can show auth/API problems immediately.
        try {
          await translateText("Hello", settings.targetLang);
        } catch (err) {
          recordError(err);
          sendResponse({ ok: false, error: lastErrorMessage || "Translation probe failed" });
          return;
        }

        // Build full backfill plan (so progress is meaningful).
        const itemsBySource = buildItemsBySource({ onlyInViewport: false });
        const sources = buildSources(itemsBySource);
        backfillState = { runId: activeRunId, targetLang: settings.targetLang, sources, itemsBySource, index: 0 };
        updateStatus({ total: sources.length, done: 0, failed: 0, message: "Translating..." });

        // Translate what the user can see first, then continue in idle time.
        const res = await translatePage({
          limit: 120,
          awaitCompletion: true,
          onlyInViewport: true,
          updateTotals: false,
        });
        scheduleBackfill();
        sendResponse(res);
        return;
      }

      if (request?.action === "restoreNow") {
        await applySettingsPatch({ enabled: false });
        activeRunId = ++translationRunId;
        clearQueue();
        cancelBackfill();
        const res = restorePage();
        sendResponse(res);
        return;
      }

      if (request?.action === "stopNow") {
        activeRunId = ++translationRunId;
        clearQueue();
        cancelBackfill();
        updateStatus({ message: "Stopped" });
        sendResponse({ ok: true });
        return;
      }

      if (request?.action === "getStatus") {
        sendResponse({ ok: true, status: lastStatus });
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
  await loadSettingsForSite();
  if (settings.enabled) {
    startObserver();
    activeRunId = ++translationRunId;
    translatePage({ onlyInViewport: true });
    translatePage({ onlyInViewport: false });
  }
})();
