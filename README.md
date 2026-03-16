# Lingo It (browser extension)

Universal "translate this page" toggle powered by the Lingo.dev API.

## What it is

`Lingo It` is a Manifest V3 Chrome/Edge extension that translates the **visible text on the current page** into a target language (Spanish/French/Arabic by default). It also supports translating `img` `alt`/`title` text.

## What it's used for

- Quickly reading pages in another language without leaving the site
- Translating dynamic pages (feeds, SPAs) as new content appears
- A simple "on/off + restore" workflow instead of per-selection translation

## How to use it

### 1) Load the extension (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`lingo-browser`)

### 2) Set your Lingo.dev API key

1. Open the extension's **Options** page
2. Paste your **Lingo.dev API key**
3. Click **Save**

Notes:
- The API key is stored in `chrome.storage.local`.
- Advanced: you can also set a custom API URL and optional Engine ID.

### 3) Translate a page

1. Open any website
2. Click the extension icon to open the popup
3. Choose a target language
4. Click **Apply** (or toggle **Enabled** on)

While translating, the popup shows a progress meter and status messages.

### 4) Controls (popup)

- **Enabled**: toggles translation on/off for the active tab
- **Translate to**: changes the target language (re-translates when enabled)
- **Highlight**: outlines translated elements on the page
- **Emergency**: prioritizes translating content containing keywords like "help", "danger", "police", "hospital"
- **Auto on site**: remembers "enabled + language" for the current hostname
- **Images**: translates `img` `alt` and `title` attributes
- **Restore**: puts the page back to the original text/attributes
- **Stop**: cancels the current translation queue/backfill (keeps what's already translated); toggle **Enabled** off to fully stop

## How it works (high level)

- `content.js` runs on every page (`<all_urls>`) and:
  - finds visible text nodes (skips inputs, textareas, scripts, styles, SVG, etc.)
  - batches unique source strings and requests translations via `chrome.runtime.sendMessage`
  - applies translations in-place and remembers originals so **Restore** can revert them
  - watches for DOM changes (MutationObserver) and translates newly added/changed content
  - prioritizes the viewport first, then backfills the rest during idle time
- `background.js` (service worker) receives translate requests and calls:
  - `POST {apiUrl}/process/localize` with `sourceLocale: "auto"` and `targetLocale`
  - it deduplicates and batches requests, and caches responses in-memory (best effort)

## Files

- `manifest.json`: MV3 config (content script, service worker, popup, options)
- `content.js`: page scanning, batching, applying/restoring translations
- `background.js`: Lingo.dev API client + batch handling
- `pop.html` / `pop.js` / `style.css`: popup UI + controls
- `options.html` / `options.js` / `options.css`: API key + advanced settings
- `icons/`: extension icons

## Permissions & privacy

- Permissions:
  - `activeTab`: send messages to the current tab's content script
  - `storage`: store settings (API key in local storage; UI/site preferences in sync)
  - Host access: `https://*.lingo.dev/*` to call the translation API
- Data sent off-device:
  - The extension sends page text (and optionally image `alt`/`title`) to Lingo.dev for translation.
  - It does not save full page content to disk; it keeps an in-memory cache while the service worker stays alive.

## Troubleshooting

- "Missing Lingo.dev API key": open **Options** and set the key, then retry.
- No text translates: some pages render text in ways a DOM text-walker can't see (canvas, images, some shadow DOM).
- Iframes: this extension doesn't currently inject into all frames.

## Development notes

There's no build step. Edit files and reload the extension in `chrome://extensions` to test changes.
