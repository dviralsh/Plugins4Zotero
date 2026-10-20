# Hebrew Translate

Two things happen in Zotero's PDF reader:

1. **Instant translation on selection.** Select text with the mouse and the Hebrew translation appears in the popup next to your selection — no highlight needed.
2. **Translation saved on highlights.** When you create a **highlight** or **underline**, the Hebrew translation is stored as the annotation's comment (unless it already has a comment or was synced from another device).

- Only short selections are translated (default: up to 5 words). Change the limit via the hidden pref `extensions.plugins4zotero.hebrewtranslate.maxWords` in the Config Editor.
- Translation uses public, key-less web endpoints (Google Translate, with fallbacks). **The selected text is sent to these services.** They are unofficial and may change or rate-limit (HTTP 429); results are cached to reduce requests.

Requires Zotero 7 or newer. Build with `scripts/build.sh hebrew-translate`, then install the `.xpi` via *Tools → Plugins → ⚙ → Install Plugin From File*.
