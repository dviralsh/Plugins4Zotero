/* global Zotero, Services */
"use strict";

const PREF_MAX_WORDS = "extensions.plugins4zotero.hebrewtranslate.maxWords";
const TARGET_LANG = "iw"; // Google Translate code for Hebrew
const TEXT_TYPES = ["highlight", "underline"];

const PLUGIN_ID = "zoterohelper@plugins4zotero";

let observerID = null;
const inFlight = new Set();
const cache = new Map(); // text -> translation, avoids repeat requests / rate limits

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
	await Zotero.initializationPromise;
	if (Zotero.Prefs.get(PREF_MAX_WORDS, true) === undefined) {
		Zotero.Prefs.set(PREF_MAX_WORDS, 5, true);
	}
	observerID = Zotero.Notifier.registerObserver(
		{
			notify: async (event, type, ids) => {
				if (event !== "add" || type !== "item") return;
				for (const id of ids) {
					try {
						await handleItem(id);
					}
					catch (e) {
						Zotero.logError(e);
					}
				}
			},
		},
		["item"],
		"zoterohelper"
	);
	Zotero.Reader.registerEventListener("renderTextSelectionPopup", onSelectionPopup, PLUGIN_ID);

	// Each feature is isolated so a problem in one can never break the others.
	try {
		Services.scriptloader.loadSubScript(rootURI + "linkdup.js");
		LinkDup.init();
		Zotero.PreferencePanes.register({
			pluginID: PLUGIN_ID,
			src: rootURI + "prefs.xhtml",
			label: "ZoteroHelper",
		});
	}
	catch (e) {
		Zotero.logError(e);
	}

	try {
		Services.scriptloader.loadSubScript(rootURI + "summary.js");
		Zotero.Reader.registerEventListener("createViewContextMenu", Summary.onViewContextMenu, PLUGIN_ID);
		Zotero.debug("[zoterohelper] AI summary menu registered");
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function shutdown() {
	if (typeof LinkDup !== "undefined") LinkDup.shutdown();
	Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onSelectionPopup);
	if (typeof Summary !== "undefined") {
		Zotero.Reader.unregisterEventListener("createViewContextMenu", Summary.onViewContextMenu);
		Summary.stopServer(); // only the server this plugin started itself
	}
	if (observerID) {
		Zotero.Notifier.unregisterObserver(observerID);
		observerID = null;
	}
}

// Shows the translation inside the popup that appears when text is selected,
// before (and without) creating any highlight.
function onSelectionPopup(event) {
	const { doc, append, params } = event;
	const text = (params.annotation && params.annotation.text || "").trim();
	if (!text || text.split(/\s+/).length > getMaxWords()) return;

	const box = doc.createElement("div");
	box.setAttribute("dir", "rtl");
	box.style.cssText = "padding:6px 8px;max-width:320px;font-size:14px;user-select:text;";
	box.textContent = cache.get(text) || "…";
	append(box);

	if (!cache.has(text)) {
		translate(text)
			.then((t) => { if (t) box.textContent = t; else box.remove(); })
			.catch((e) => { Zotero.logError(e); box.remove(); });
	}
}

function getMaxWords() {
	return Zotero.Prefs.get(PREF_MAX_WORDS, true) || 5;
}

async function handleItem(id) {
	const item = Zotero.Items.get(id);
	if (!item || !item.isAnnotation()) return;
	if (!TEXT_TYPES.includes(item.annotationType)) return;
	if (item.annotationComment) return;
	if (inFlight.has(id)) return;

	// Annotations created locally are unsynced until the next upload; ones that
	// arrive from another device are saved by the sync engine already marked synced.
	if (item.synced) return;
	if (Zotero.Sync.Runner && Zotero.Sync.Runner.syncInProgress) return;

	const text = (item.annotationText || "").trim();
	if (!text) return;
	if (text.split(/\s+/).length > getMaxWords()) return;

	inFlight.add(id);
	try {
		const translation = await translate(text);
		if (!translation || translation.toLowerCase() === text.toLowerCase()) return;
		// Re-read: user may have typed a comment while we were waiting
		if (item.annotationComment) return;
		item.annotationComment = translation;
		await item.saveTx();
	}
	finally {
		inFlight.delete(id);
	}
}

// Uses public, key-less endpoints. Google's web endpoint rate-limits (HTTP 429),
// so fall back to a second Google endpoint, then to MyMemory.
async function translate(text) {
	if (cache.has(text)) return cache.get(text);
	const q = encodeURIComponent(text);
	const attempts = [
		async () => {
			const r = await request("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl="
				+ TARGET_LANG + "&dt=t&q=" + q);
			return r[0].map(seg => seg[0]).join("");
		},
		async () => {
			const r = await request("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl="
				+ TARGET_LANG + "&q=" + q);
			return Array.isArray(r[0]) ? r[0][0] : r[0];
		},
		async () => {
			const r = await request("https://api.mymemory.translated.net/get?q=" + q + "&langpair=Autodetect|he");
			return r.responseData.translatedText;
		},
	];
	for (const attempt of attempts) {
		try {
			const result = ((await attempt()) || "").trim();
			if (result) {
				cache.set(text, result);
				return result;
			}
		}
		catch (e) {
			Zotero.debug("[zoterohelper] endpoint failed: " + e);
		}
	}
	return null;
}

async function request(url) {
	const req = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 10000 });
	return req.response;
}
