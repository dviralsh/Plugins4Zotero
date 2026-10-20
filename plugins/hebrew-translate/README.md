# Hebrew Translate

Three things in Zotero's PDF reader:

1. **Instant translation on selection.** Select text with the mouse and the Hebrew translation appears in the popup next to your selection — no highlight needed.
2. **Translation saved on highlights.** When you create a **highlight** or **underline**, the Hebrew translation is stored as the annotation's comment (unless it already has a comment or was synced from another device).
3. **AI summary (local, via Ollama).** Right-click inside the PDF and choose **AI summary of this paper (Ollama)**. The paper's text is sent to your own local [Ollama](https://ollama.com) server and the summary is saved as a child note (tagged `ai-summary`) of the item.
   - Ollama uses the GPU automatically when it can; if that attempt fails the plugin retries on CPU only. The note says which device was used.
   - If Ollama isn't reachable, or no model is installed, a message tells you what to do (e.g. `ollama pull llama3.2`).
   - Prefs (Config Editor): `extensions.plugins4zotero.hebrewtranslate.ollamaModel` (default: first installed chat model), `...ollamaHost` (default `http://localhost:11434`), `...summaryMaxChars` (default 24000 — longer papers are truncated).

- Only short selections are translated (default: up to 5 words). Change the limit via the hidden pref `extensions.plugins4zotero.hebrewtranslate.maxWords` in the Config Editor.
- Translation uses public, key-less web endpoints (Google Translate, with fallbacks). **The selected text is sent to these services.** They are unofficial and may change or rate-limit (HTTP 429); results are cached to reduce requests.

Requires Zotero 7 or newer. Build with `scripts/build.sh hebrew-translate`, then install the `.xpi` via *Tools → Plugins → ⚙ → Install Plugin From File*.
