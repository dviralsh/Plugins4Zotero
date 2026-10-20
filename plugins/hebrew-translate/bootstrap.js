/* global Zotero, Services */
"use strict";

const PREF_MAX_WORDS = "extensions.plugins4zotero.hebrewtranslate.maxWords";
const TARGET_LANG = "iw"; // Google Translate code for Hebrew
const FRESH_MS = 30 * 1000; // only translate annotations created just now
const TEXT_TYPES = ["highlight", "underline"];

let observerID = null;
const inFlight = new Set();

function install() {}
function uninstall() {}

async function startup() {
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
		"hebrew-translate"
	);
}

function shutdown() {
	if (observerID) {
		Zotero.Notifier.unregisterObserver(observerID);
		observerID = null;
	}
}

async function handleItem(id) {
	const item = Zotero.Items.get(id);
	if (!item || !item.isAnnotation()) return;
	if (!TEXT_TYPES.includes(item.annotationType)) return;
	if (item.annotationComment) return;
	if (inFlight.has(id)) return;

	const added = Zotero.Date.sqlToDate(item.dateAdded, true);
	if (!added || Date.now() - added.getTime() > FRESH_MS) return; // e.g. synced

	const text = (item.annotationText || "").trim();
	if (!text) return;
	const maxWords = Zotero.Prefs.get(PREF_MAX_WORDS, true) || 5;
	if (text.split(/\s+/).length > maxWords) return;

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

// Uses the public, key-less Google Translate web endpoint.
async function translate(text) {
	const url = "https://translate.googleapis.com/translate_a/single?client=gtx"
		+ "&sl=auto&tl=" + TARGET_LANG + "&dt=t&q=" + encodeURIComponent(text);
	const req = await Zotero.HTTP.request("GET", url, {
		responseType: "json",
		timeout: 10000,
	});
	const segments = req.response && req.response[0];
	if (!Array.isArray(segments)) return null;
	return segments.map(s => s[0]).join("").trim();
}
