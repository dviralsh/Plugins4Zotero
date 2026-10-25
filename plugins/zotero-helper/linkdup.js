/* global Zotero, Services */
"use strict";

// "Link instead of duplicate": when a new regular item is added and the library
// already holds the same item, put the EXISTING item into the target
// collection(s) and trash the new copy instead of keeping a duplicate.
// Loaded into the bootstrap scope; only `var` declarations are used.

var LinkDup = {
	PREFIX: "extensions.plugins4zotero.linkdup.",
	DEFAULTS: {
		enabled: true,
		// "identifiers" | "identifiers+title"
		strictness: "identifiers+title",
		// "trash" | "delete" | "ask"
		newCopyAction: "trash",
		// move tags / notes / attachments / related links onto the existing item
		mergeChildren: true,
		notify: true,
		// existing match is in the Trash: "skip" (don't dedupe) | "restore"
		trashedExisting: "skip",
		// allow e.g. preprint <-> journal article to match
		allowCrossType: false,
		// new item landed in My Library with no collection: "trash" | "keep"
		noCollectionAction: "trash",
	},
	SETTLE_MS: 1500, // wait for connector/import saves to finish before looking
	LATE_CHILD_MS: 5 * 60 * 1000, // attachments saved after their parent

	observerID: null,
	pending: new Set(), // new regular item IDs waiting to be checked
	lateChildren: new Set(), // attachments/notes added to an already-replaced item
	replaced: new Map(), // new item ID -> { record, time }
	ownIDs: new Set(), // IDs touched by this module; their events are ignored
	gen: 0,
	processing: false,
	lastBatch: null,

	// Identifier types, in priority order. `sources` say where to read values
	// from (field names, optional SQL LIKE prefilter for the free-text Extra
	// field); `keys` turns a raw value into normalized match keys.
	IDTYPES: [
		{
			name: "doi",
			sources: [{ fields: ["DOI"] }, { fields: ["extra"], like: "%doi%" }],
			keys: v => LinkDup.normalizeDOI(v),
		},
		{
			name: "isbn",
			sources: [{ fields: ["ISBN"] }],
			keys: v => LinkDup.normalizeISBNs(v),
		},
		{
			name: "arxiv",
			sources: [
				{ fields: ["archiveID"] },
				{ fields: ["extra"], like: "%arxiv%" },
				{ fields: ["url"], like: "%arxiv.org%" },
			],
			keys: v => LinkDup.normalizeArxiv(v),
		},
		{
			name: "pmid",
			sources: [{ fields: ["extra"], like: "%pmid%" }],
			keys: v => LinkDup.normalizePMID(v),
		},
		{
			name: "url",
			sources: [{ fields: ["url"] }],
			keys: v => LinkDup.normalizeURL(v),
		},
	],

	// ---- settings ---------------------------------------------------------

	pref(name) {
		const v = Zotero.Prefs.get(LinkDup.PREFIX + name, true);
		return v === undefined || v === "" ? LinkDup.DEFAULTS[name] : v;
	},

	// ---- lifecycle --------------------------------------------------------

	init() {
		if (LinkDup.observerID) return;
		LinkDup.observerID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				try {
					LinkDup.onNotify(event, type, ids);
				}
				catch (e) {
					Zotero.logError(e);
				}
			},
		}, ["item", "collection-item"], "zoterohelper-linkdup");
		Zotero.debug("[linkdup] observer registered");
	},

	shutdown() {
		if (LinkDup.observerID) {
			Zotero.Notifier.unregisterObserver(LinkDup.observerID);
			LinkDup.observerID = null;
		}
		LinkDup.gen++; // cancels a scheduled flush
		LinkDup.pending.clear();
		LinkDup.lateChildren.clear();
		LinkDup.replaced.clear();
		LinkDup.ui.dismiss();
		Zotero.debug("[linkdup] shut down");
	},

	// ---- observer ---------------------------------------------------------

	onNotify(event, type, ids) {
		if (event !== "add" || !LinkDup.pref("enabled")) return;

		if (type === "item") {
			for (const id of ids) {
				if (LinkDup.ownIDs.has(id)) continue; // we created/touched it ourselves
				const item = Zotero.Items.get(id);
				if (!item) continue;
				if (item.isRegularItem()) {
					LinkDup.pending.add(id);
				}
				else if ((item.isAttachment() || item.isNote()) && LinkDup.replaced.has(item.parentItemID)) {
					LinkDup.lateChildren.add(id); // saved after its parent was replaced
				}
				// standalone attachments and notes are never deduplicated
			}
		}
		else if (type === "collection-item") {
			// Ids look like "<collectionID>-<itemID>". Only matters for timing: an item
			// dragged into a collection is NOT new and must never be deduplicated.
			const touchesPending = ids.some(k => LinkDup.pending.has(parseInt(String(k).split("-")[1], 10)));
			if (!touchesPending) return;
		}
		LinkDup.schedule();
	},

	schedule() {
		const gen = ++LinkDup.gen;
		Zotero.Promise.delay(LinkDup.SETTLE_MS).then(() => {
			if (gen === LinkDup.gen) return LinkDup.flush();
			return undefined;
		}).catch(e => Zotero.logError(e));
	},

	async flush() {
		if (LinkDup.processing) return; // re-entrancy guard; rescheduled below
		LinkDup.processing = true;
		try {
			const late = [...LinkDup.lateChildren];
			LinkDup.lateChildren.clear();
			if (late.length) await LinkDup.adoptLate(late);

			const ids = [...LinkDup.pending];
			LinkDup.pending.clear();
			if (ids.length) await LinkDup.processBatch(ids);
		}
		catch (e) {
			Zotero.logError(e);
		}
		finally {
			LinkDup.processing = false;
			LinkDup.expireReplaced();
			if (LinkDup.pending.size || LinkDup.lateChildren.size) LinkDup.schedule();
		}
	},

	expireReplaced() {
		const now = Date.now();
		for (const [id, v] of LinkDup.replaced) {
			if (now - v.time > LinkDup.LATE_CHILD_MS) LinkDup.replaced.delete(id);
		}
	},

	// ---- normalization ----------------------------------------------------

	normText(s) {
		return String(s || "")
			.normalize("NFD").replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	},

	normalizeDOI(v) {
		const m = String(v || "").match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
		if (!m) return [];
		let doi = m[1].toLowerCase();
		try { doi = decodeURIComponent(doi); } catch (e) { /* keep as is */ }
		return [doi.replace(/[.,;)\]]+$/, "")];
	},

	isbn13Check(d12) {
		let sum = 0;
		for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 ? 3 : 1);
		return String((10 - (sum % 10)) % 10);
	},

	// "0-306-40615-2", "978-0-306-40615-7", several per field -> unique ISBN-13s
	normalizeISBNs(v) {
		const out = new Set();
		for (const raw of String(v || "").split(/[\s,;]+/)) {
			const t = raw.replace(/-/g, "").toUpperCase();
			if (/^\d{13}$/.test(t)) {
				if (LinkDup.isbn13Check(t.slice(0, 12)) === t[12]) out.add(t);
			}
			else if (/^\d{9}[\dX]$/.test(t)) {
				const d12 = "978" + t.slice(0, 9);
				const isbn13 = d12 + LinkDup.isbn13Check(d12);
				// verify the ISBN-10 check digit before trusting it
				let sum = 0;
				for (let i = 0; i < 9; i++) sum += Number(t[i]) * (10 - i);
				const check = (11 - (sum % 11)) % 11;
				if ((check === 10 ? "X" : String(check)) === t[9]) out.add(isbn13);
			}
		}
		return [...out];
	},

	normalizeArxiv(v) {
		const m = String(v || "").match(
			/(?:arxiv(?:\.org\/(?:abs|pdf)\/|\s*:\s*))\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/i);
		return m ? [m[1].toLowerCase()] : [];
	},

	normalizePMID(v) {
		const m = String(v || "").match(/PMID:\s*(\d+)/i);
		return m ? [m[1]] : [];
	},

	// Host + path + query (minus tracking params). Bare domains are ignored: too
	// many unrelated items share a site's front page.
	normalizeURL(v) {
		let u;
		try { u = new URL(String(v || "").trim()); } catch (e) { return []; }
		if (!/^https?:$/.test(u.protocol)) return [];
		const host = u.hostname.toLowerCase().replace(/^www\./, "");
		if (host === "doi.org" || host === "dx.doi.org") return []; // DOI rule covers these
		const params = [...u.searchParams].filter(([k]) => !/^(utm_|fbclid|gclid)/i.test(k));
		params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const query = params.map(([k, val]) => k + "=" + val).join("&");
		const path = u.pathname.replace(/\/+$/, "");
		if (!path && !query) return [];
		return [host + path + (query ? "?" + query : "")];
	},

	// ---- reading an item --------------------------------------------------

	field(item, name) {
		try {
			return item.getField(name) || "";
		}
		catch (e) {
			return ""; // field not valid for this item type
		}
	},

	candidateKeys(item, type) {
		const keys = new Set();
		for (const src of type.sources) {
			for (const f of src.fields) {
				const v = LinkDup.field(item, f);
				if (v) for (const k of type.keys(v)) keys.add(k);
			}
		}
		return keys;
	},

	titleKey(item) {
		const t = LinkDup.normText(LinkDup.field(item, "title"));
		return t.length >= 8 ? t : "";
	},

	firstCreator(item) {
		const c = item.getCreators()[0];
		return c ? LinkDup.normText(c.lastName || c.name || "") : "";
	},

	year(item) {
		const m = LinkDup.field(item, "date").match(/\b(1[5-9]\d\d|20\d\d)\b/);
		return m ? m[1] : "";
	},

	// ---- finding matches --------------------------------------------------

	// One SQL query per (identifier type, source) for the whole batch.
	async fetchValues(libraryID, fieldNames, like, includeDeleted) {
		const fieldIDs = [];
		for (const n of fieldNames) {
			const id = Zotero.ItemFields.getID(n);
			if (id) fieldIDs.push(Number(id));
			// title also lives under type-specific mapped fields (caseName, ...)
			if (n === "title") {
				for (const m of Zotero.ItemFields.getTypeFieldsFromBase("title") || []) fieldIDs.push(Number(m));
			}
		}
		if (!fieldIDs.length) return [];
		const skipTypes = ["attachment", "note", "annotation"]
			.map(n => Zotero.ItemTypes.getID(n)).filter(Boolean).map(Number);
		let sql = "SELECT itemID, value FROM items "
			+ "JOIN itemData USING (itemID) JOIN itemDataValues USING (valueID) "
			+ "WHERE libraryID = ? AND fieldID IN (" + fieldIDs.join(",") + ")";
		const params = [libraryID];
		if (skipTypes.length) sql += " AND itemTypeID NOT IN (" + skipTypes.join(",") + ")";
		if (!includeDeleted) sql += " AND itemID NOT IN (SELECT itemID FROM deletedItems)";
		if (like) {
			sql += " AND value LIKE ?";
			params.push(like);
		}
		return Zotero.DB.queryAsync(sql, params);
	},

	async buildIndex(libraryID, type, includeDeleted) {
		const index = new Map();
		for (const src of type.sources) {
			const rows = await LinkDup.fetchValues(libraryID, src.fields, src.like, includeDeleted);
			for (const row of rows) {
				for (const k of type.keys(row.value)) {
					if (!index.has(k)) index.set(k, new Set());
					index.get(k).add(row.itemID);
				}
			}
		}
		return index;
	},

	async buildTitleIndex(libraryID, includeDeleted) {
		const index = new Map();
		const rows = await LinkDup.fetchValues(libraryID, ["title"], null, includeDeleted);
		for (const row of rows) {
			const k = LinkDup.normText(row.value);
			if (k.length < 8) continue;
			if (!index.has(k)) index.set(k, new Set());
			index.get(k).add(row.itemID);
		}
		return index;
	},

	compatible(a, b) {
		return a.itemTypeID === b.itemTypeID || !!LinkDup.pref("allowCrossType");
	},

	// Pick the best existing item among `ids` for `item`: same library, compatible
	// type, optional extra check; live items first, then the oldest dateAdded.
	async choose(item, ids, loaded, verify) {
		const wanted = [...ids].filter(id => !loaded.has(id));
		if (wanted.length) {
			const objs = await Zotero.Items.getAsync(wanted);
			await Zotero.Items.loadDataTypes(objs);
			for (const o of objs) loaded.set(o.id, o);
		}
		const skipTrashed = LinkDup.pref("trashedExisting") !== "restore";
		const ok = [...ids].map(id => loaded.get(id)).filter(e => e
			&& e.id !== item.id
			&& e.libraryID === item.libraryID
			&& e.isRegularItem()
			&& !(e.deleted && skipTrashed)
			&& LinkDup.compatible(item, e)
			&& (!verify || verify(e)));
		ok.sort((a, b) => (Number(!!a.deleted) - Number(!!b.deleted))
			|| (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : 0)
			|| a.id - b.id);
		return ok[0] || null;
	},

	// items: new regular items of ONE library. Returns Map(item.id -> {existing, reason}).
	async findMatches(libraryID, items) {
		const found = new Map();
		const batchIDs = new Set(items.map(i => i.id));
		const includeDeleted = LinkDup.pref("trashedExisting") === "restore";
		const loaded = new Map();
		const without = set => new Set([...set].filter(id => !batchIDs.has(id)));

		for (const type of LinkDup.IDTYPES) {
			const wanting = items.filter(i => !found.has(i.id))
				.map(i => ({ item: i, keys: LinkDup.candidateKeys(i, type) }))
				.filter(c => c.keys.size);
			if (!wanting.length) continue;
			const index = await LinkDup.buildIndex(libraryID, type, includeDeleted);
			for (const { item, keys } of wanting) {
				const ids = new Set();
				for (const k of keys) for (const id of without(index.get(k) || [])) ids.add(id);
				if (!ids.size) continue;
				const existing = await LinkDup.choose(item, ids, loaded);
				if (existing) found.set(item.id, { existing, reason: type.name });
			}
		}

		if (LinkDup.pref("strictness") === "identifiers+title") {
			const wanting = items.filter(i => !found.has(i.id) && LinkDup.titleKey(i));
			if (wanting.length) {
				const index = await LinkDup.buildTitleIndex(libraryID, includeDeleted);
				for (const item of wanting) {
					const ids = without(index.get(LinkDup.titleKey(item)) || []);
					if (!ids.size) continue;
					const creator = LinkDup.firstCreator(item);
					const year = LinkDup.year(item);
					// title alone is not enough: creator and/or year must agree too
					if (!creator && !year) continue;
					const existing = await LinkDup.choose(item, ids, loaded, e =>
						LinkDup.firstCreator(e) === creator && LinkDup.year(e) === year);
					if (existing) found.set(item.id, { existing, reason: "title+creator+year" });
				}
			}
		}
		return found;
	},

	// ---- applying ---------------------------------------------------------

	async processBatch(ids) {
		const objs = (await Zotero.Items.getAsync(ids)).filter(Boolean);
		await Zotero.Items.loadDataTypes(objs);
		const byLibrary = new Map();
		for (const item of objs) {
			if (!item.isRegularItem() || item.deleted || item.isFeedItem || item.synced) continue;
			if (LinkDup.ownIDs.has(item.id)) continue;
			const lib = Zotero.Libraries.get(item.libraryID);
			if (!lib || !lib.editable) continue;
			if (!byLibrary.has(item.libraryID)) byLibrary.set(item.libraryID, []);
			byLibrary.get(item.libraryID).push(item);
		}

		const plans = [];
		for (const [libraryID, items] of byLibrary) {
			const matches = await LinkDup.findMatches(libraryID, items);
			for (const item of items) {
				const m = matches.get(item.id);
				if (!m) continue;
				if (!item.getCollections().length && LinkDup.pref("noCollectionAction") === "keep") continue;
				plans.push({ item, existing: m.existing, reason: m.reason });
			}
		}
		Zotero.debug("[linkdup] checked " + objs.length + " new item(s), " + plans.length + " duplicate(s)");
		if (!plans.length) return [];

		let disposal = LinkDup.pref("newCopyAction");
		if (disposal === "ask") {
			disposal = LinkDup.askDisposal(plans.length);
			if (disposal === "keep") return [];
		}

		const records = [];
		for (const plan of plans) {
			try {
				records.push(await LinkDup.link(plan, disposal));
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		if (records.length) {
			LinkDup.lastBatch = records;
			LinkDup.notify(records);
		}
		return records;
	},

	askDisposal(count) {
		const p = Services.prompt;
		const flags = p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_0
			+ p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_1
			+ p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_2;
		const choice = p.confirmEx(Zotero.getMainWindow(), "Link instead of duplicate",
			count + " item(s) you just added already exist in your library.\n\n"
			+ "The existing item will be added to the collection instead. What should happen to the new copy?",
			flags, "Move to Trash", "Keep both", "Delete permanently", null, {});
		return ["trash", "keep", "delete"][choice] || "keep";
	},

	hasEqualNote(existing, noteHTML) {
		return existing.getNotes().some(id => Zotero.Items.get(id).getNote() === noteHTML);
	},

	// Move one child (attachment/note) of the replaced copy onto the existing item,
	// unless the existing item already has an equivalent one.
	async adoptChild(child, existing, rec) {
		if (child.isNote()) {
			if (LinkDup.hasEqualNote(existing, child.getNote())) return false;
		}
		else {
			const type = child.attachmentContentType;
			const same = existing.getAttachments().some(id =>
				type && Zotero.Items.get(id).attachmentContentType === type);
			if (same) return false;
		}
		const oldParent = child.parentID;
		child.parentID = existing.id;
		await child.save();
		LinkDup.ownIDs.add(child.id);
		rec.movedChildren.push({ id: child.id, oldParent });
		return true;
	},

	async link({ item, existing, reason }, disposal) {
		const rec = {
			newID: item.id,
			existingID: existing.id,
			reason,
			disposal,
			restoredExisting: false,
			collections: item.getCollections(),
			addedCollections: [],
			addedTags: [],
			movedChildren: [],
			addedRelated: [],
		};
		const merge = !!LinkDup.pref("mergeChildren");

		await Zotero.DB.executeTransaction(async () => {
			if (existing.deleted) {
				existing.deleted = false;
				rec.restoredExisting = true;
			}
			for (const colID of rec.collections) {
				if (!existing.inCollection(colID)) {
					existing.addToCollection(colID);
					rec.addedCollections.push(colID);
				}
			}
			if (merge) {
				for (const t of item.getTags()) {
					if (!existing.hasTag(t.tag)) {
						existing.addTag(t.tag, t.type);
						rec.addedTags.push(t.tag);
					}
				}
			}
			await existing.save();

			if (merge) {
				for (const id of [...item.getNotes(), ...item.getAttachments()]) {
					await LinkDup.adoptChild(Zotero.Items.get(id), existing, rec);
				}
				for (const key of item.relatedItems || []) {
					const rel = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
					if (!rel || rel.id === existing.id || existing.relatedItems.includes(rel.key)) continue;
					existing.addRelatedItem(rel);
					rel.addRelatedItem(existing);
					await rel.save();
					await existing.save();
					rec.addedRelated.push(rel.id);
				}
			}

			if (disposal === "delete") {
				await item.erase();
			}
			else {
				item.deleted = true;
				await item.save();
			}
		});

		LinkDup.ownIDs.add(item.id);
		LinkDup.ownIDs.add(existing.id);
		if (disposal !== "delete") LinkDup.replaced.set(item.id, { record: rec, time: Date.now() });
		Zotero.debug("[linkdup] item " + item.id + " -> existing " + existing.id + " via " + reason
			+ "; collections added: " + rec.addedCollections.length);
		return rec;
	},

	// Attachments/notes that the connector saves after the item itself.
	async adoptLate(ids) {
		for (const id of ids) {
			try {
				const child = Zotero.Items.get(id);
				if (!child) continue;
				const entry = LinkDup.replaced.get(child.parentItemID);
				if (!entry) continue;
				const existing = Zotero.Items.get(entry.record.existingID);
				if (!existing || !LinkDup.pref("mergeChildren")) continue;
				await Zotero.DB.executeTransaction(async () => {
					await LinkDup.adoptChild(child, existing, entry.record);
				});
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	// ---- undo -------------------------------------------------------------

	async undo(records) {
		await Zotero.DB.executeTransaction(async () => {
			for (const rec of records) {
				if (rec.disposal === "delete") continue; // permanently gone
				const item = Zotero.Items.get(rec.newID);
				const existing = Zotero.Items.get(rec.existingID);
				if (item) {
					item.deleted = false;
					await item.save();
				}
				if (!existing) continue;
				for (const m of rec.movedChildren) {
					const child = Zotero.Items.get(m.id);
					if (child) {
						child.parentID = m.oldParent;
						await child.save();
					}
				}
				for (const relID of rec.addedRelated) {
					const rel = Zotero.Items.get(relID);
					if (rel) {
						existing.removeRelatedItem(rel);
						rel.removeRelatedItem(existing);
						await rel.save();
					}
				}
				for (const colID of rec.addedCollections) existing.removeFromCollection(colID);
				for (const tag of rec.addedTags) existing.removeTag(tag);
				if (rec.restoredExisting) existing.deleted = true;
				await existing.save();
				LinkDup.replaced.delete(rec.newID);
			}
		});
		Zotero.debug("[linkdup] undone " + records.length + " link(s)");
	},

	// ---- notification -----------------------------------------------------

	collectionName(id) {
		const c = Zotero.Collections.get(id);
		return c ? c.name : "";
	},

	message(records) {
		if (records.length === 1) {
			const r = records[0];
			if (r.addedCollections.length) {
				const names = r.addedCollections.map(id => '"' + LinkDup.collectionName(id) + '"').join(", ");
				return "Already in your library, linked to collection " + names + " instead of creating a duplicate.";
			}
			if (r.collections.length) {
				const names = r.collections.map(id => '"' + LinkDup.collectionName(id) + '"').join(", ");
				return "Already in collection " + names + ". The new copy was removed.";
			}
			return "Already in your library. The new copy was removed.";
		}
		const linked = records.filter(r => r.addedCollections.length).length;
		return records.length + " items were already in your library: " + linked
			+ " linked to the existing item, " + (records.length - linked) + " already in the collection.";
	},

	notify(records) {
		if (!LinkDup.pref("notify")) return;
		const undoable = records.filter(r => r.disposal !== "delete");
		LinkDup.ui.toast(LinkDup.message(records), undoable.length
			? () => LinkDup.undo(undoable).catch(e => Zotero.logError(e))
			: null);
	},

	ui: {
		timer: null,
		box: null,

		toast(message, onUndo) {
			const win = Zotero.getMainWindow();
			if (!win) return;
			LinkDup.ui.dismiss();
			const doc = win.document;
			const NS = "http://www.w3.org/1999/xhtml";
			const make = (tag, css, text) => {
				const el = doc.createElementNS(NS, tag);
				el.style.cssText = css;
				if (text) el.textContent = text;
				return el;
			};
			const box = make("div", "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:400px;"
				+ "padding:10px 14px;background:#323232;color:#fff;border-radius:6px;font:13px sans-serif;"
				+ "display:flex;gap:12px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.4);");
			box.append(make("span", "flex:1;", message));
			const button = (label, fn) => {
				const b = make("button", "cursor:pointer;", label);
				b.addEventListener("click", fn);
				return b;
			};
			if (onUndo) {
				box.append(button("Undo", () => {
					LinkDup.ui.dismiss();
					onUndo();
				}));
			}
			box.append(button("×", () => LinkDup.ui.dismiss()));
			doc.documentElement.append(box);
			LinkDup.ui.box = box;
			LinkDup.ui.timer = win.setTimeout(() => LinkDup.ui.dismiss(), 15000);
		},

		dismiss() {
			const win = Zotero.getMainWindow && Zotero.getMainWindow();
			if (LinkDup.ui.timer && win) win.clearTimeout(LinkDup.ui.timer);
			LinkDup.ui.timer = null;
			if (LinkDup.ui.box) LinkDup.ui.box.remove();
			LinkDup.ui.box = null;
		},
	},
};
