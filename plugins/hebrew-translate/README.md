# Hebrew Translate

When you create a **highlight** or **underline** annotation in Zotero's PDF reader, this plugin translates the selected text to Hebrew and stores the result as the annotation's comment.

- Only short selections are translated (default: up to 5 words). Change the limit via the hidden pref `extensions.plugins4zotero.hebrewtranslate.maxWords` in the Config Editor.
- Annotations that already have a comment, or that were synced from another device, are left alone.
- Translation uses the public Google Translate web endpoint (no API key). **The selected text is sent to Google.** The endpoint is unofficial and may change or rate-limit.

Requires Zotero 7. Build with `scripts/build.sh hebrew-translate`, then install the `.xpi` via *Tools → Plugins → ⚙ → Install Plugin From File*.
