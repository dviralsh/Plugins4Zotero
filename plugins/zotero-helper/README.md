# ZoteroHelper

Features:

1. **Instant translation on selection.** Select text with the mouse and the Hebrew translation appears in the popup next to your selection — no highlight needed.
2. **Translation saved on highlights.** When you create a **highlight** or **underline**, the Hebrew translation is stored as the annotation's comment (unless it already has a comment or was synced from another device).
3. **AI summary (local, via Ollama).** Right-click inside the PDF and choose **AI summary of this paper (Ollama)**. The paper's text is sent to your own local [Ollama](https://ollama.com) server and the summary is saved as a child note (tagged `ai-summary`) of the item.
   - Ollama uses the GPU automatically when it can; if that attempt fails the plugin retries on CPU only. The note says which device was used.
   - **Auto-start:** if Ollama isn't running and the host is local, the plugin runs `ollama serve` itself on that host/port, waits for it, and stops it when Zotero closes (it never stops a server it didn't start). Set `...ollamaAutoStart` to `false` to disable. The executable is found on `PATH` or in the usual install locations; override with `...ollamaPath`.
   - **Intel/integrated GPU:** set `...ollamaIntegratedGPU` to `true` to start the server with `OLLAMA_VULKAN=1` and `OLLAMA_IGPU_ENABLE=1`. Combine with `...ollamaHost` = `http://127.0.0.1:11555` to keep it separate from a normal Ollama on port 11434.
   - If Ollama isn't reachable, or no model is installed, a message tells you what to do (e.g. `ollama pull llama3.2`).
   - Prefs (Config Editor): `extensions.plugins4zotero.hebrewtranslate.ollamaModel` (default: first installed chat model), `...ollamaHost` (default `http://localhost:11434`), `...summaryMaxChars` (default 24000 — longer papers are truncated).

- Only short selections are translated (default: up to 5 words). Change the limit via the hidden pref `extensions.plugins4zotero.hebrewtranslate.maxWords` in the Config Editor.
- Translation uses public, key-less web endpoints (Google Translate, with fallbacks). **The selected text is sent to these services.** They are unofficial and may change or rate-limit (HTTP 429); results are cached to reduce requests.

Requires Zotero 7 or newer. Build with `scripts/build.sh zotero-helper`, then install the `.xpi` via *Tools → Plugins → ⚙ → Install Plugin From File*.

## Link instead of duplicate

When you add an item that already exists in the same library (browser connector, import, "Add item by identifier", drag-and-drop, manual entry), the plugin does **not** keep the new copy. Instead the *existing* item is added to the collection(s) the new item was saved to (in Zotero one item can live in many collections) and the new copy goes to the Trash. A notification appears with an **Undo** button.

**How a duplicate is recognised** (first hit wins; only items in the same library, never the Trash by default):
1. DOI (case-insensitive, URL prefix ignored; also read from *Extra*)
2. ISBN (ISBN-10 and ISBN-13 are treated as equal)
3. arXiv ID, PMID, URL (tracking parameters and bare domains ignored)
4. Fallback: normalized title (case, punctuation, accents ignored) **and** first author's last name **and** year must all agree. Titles under 8 characters never match.

If several items match, the oldest (lowest *Date Added*) is used. Items of different types (e.g. preprint vs. journal article) are not linked unless you enable that. Standalone attachments and notes, synced items, and read-only libraries are never touched.

**What is carried over** from the new copy to the existing item (never overwriting fields): tags, child notes, child attachments (unless an equivalent PDF/note is already there) and related-item links. Attachments that a connector saves a moment *after* the item are moved too.

**Settings** (Settings → ZoteroHelper): enable/disable; matching strictness (identifiers only, or identifiers + title/author/year); what to do with the new copy (Trash, delete permanently, ask); merge tags/notes/attachments on/off; notification on/off; match across item types; what to do when the existing item is in the Trash (don't deduplicate, or restore it); what to do when the duplicate was added with no collection selected (Trash it or leave it alone).

Note: Zotero's own **Duplicate Item** command also creates a new item, so it is treated like any other add. Turn the feature off (or choose "Ask") if you use it.

Run the tests with `node --test tests/*.test.mjs` (Node 22+).
