// Minimal in-memory model of the Zotero APIs LinkDup uses. The library is mirrored
// into a real SQLite database (node:sqlite) so the plugin's SQL actually executes.
import { DatabaseSync } from "node:sqlite";

export const FIELDS = { title: 1, DOI: 2, ISBN: 3, url: 4, extra: 5, archiveID: 6, date: 7 };
export const TYPES = { journalArticle: 1, book: 2, preprint: 3, attachment: 4, note: 5, annotation: 6, webpage: 7 };
const REGULAR = new Set(["journalArticle", "book", "preprint", "webpage"]);

let clock = 0;
const stamp = () => "2026-01-01 00:" + String(Math.floor(clock / 60)).padStart(2, "0") + ":" + String(clock++ % 60).padStart(2, "0");

export class FakeItem {
	constructor(world, id, itemType, opts = {}) {
		this.world = world;
		this.id = id;
		this.key = "K" + id;
		this.libraryID = opts.libraryID ?? 1;
		this.itemType = itemType;
		this.itemTypeID = TYPES[itemType];
		this.fields = { ...(opts.fields || {}) };
		this.creators = opts.creators || [];
		this.collections = new Set(opts.collections || []);
		this.tags = (opts.tags || []).map(t => ({ tag: t, type: 0 }));
		this.parentID = opts.parentID ?? null;
		this.deleted = !!opts.deleted;
		this.dateAdded = opts.dateAdded || stamp();
		this.synced = !!opts.synced;
		this.isFeedItem = false;
		this.attachmentContentType = opts.contentType || "";
		this.note = opts.note || "";
		this.relatedItems = [...(opts.related || [])];
		this.saves = 0;
	}
	get parentItemID() { return this.parentID; }
	isRegularItem() { return REGULAR.has(this.itemType); }
	isAttachment() { return this.itemType === "attachment"; }
	isNote() { return this.itemType === "note"; }
	getField(n) { return this.fields[n] || ""; }
	getCreators() { return this.creators; }
	getCollections() { return [...this.collections]; }
	inCollection(c) { return this.collections.has(c); }
	addToCollection(c) { this.collections.add(c); }
	removeFromCollection(c) { this.collections.delete(c); }
	getTags() { return this.tags; }
	hasTag(t) { return this.tags.some(x => x.tag === t); }
	addTag(t, type = 0) { if (!this.hasTag(t)) this.tags.push({ tag: t, type }); }
	removeTag(t) { this.tags = this.tags.filter(x => x.tag !== t); }
	getNote() { return this.note; }
	getNotes() { return this.world.children(this.id).filter(c => c.isNote()).map(c => c.id); }
	getAttachments() { return this.world.children(this.id).filter(c => c.isAttachment()).map(c => c.id); }
	addRelatedItem(o) { if (!this.relatedItems.includes(o.key)) this.relatedItems.push(o.key); }
	removeRelatedItem(o) { this.relatedItems = this.relatedItems.filter(k => k !== o.key); }
	async save() { this.saves++; this.world.log.push("save " + this.id); return true; }
	async erase() { this.world.items.delete(this.id); this.world.log.push("erase " + this.id); }
}

export class World {
	constructor() {
		this.items = new Map();
		this.collections = new Map();
		this.nextID = 1;
		this.log = [];
		this.queries = [];
		this.transactions = 0;
		this.editable = true;
	}
	add(itemType, opts = {}) {
		const it = new FakeItem(this, this.nextID++, itemType, opts);
		this.items.set(it.id, it);
		return it;
	}
	collection(name) {
		const id = 100 + this.collections.size;
		this.collections.set(id, { id, name });
		return id;
	}
	children(parentID) { return [...this.items.values()].filter(i => i.parentID === parentID); }

	rebuild() {
		const db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT);
			CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
			CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
			CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);`);
		let v = 1;
		for (const it of this.items.values()) {
			db.prepare("INSERT INTO items VALUES (?,?,?)").run(it.id, it.itemTypeID, it.libraryID);
			if (it.deleted) db.prepare("INSERT INTO deletedItems VALUES (?)").run(it.id);
			for (const [name, value] of Object.entries(it.fields)) {
				db.prepare("INSERT INTO itemDataValues VALUES (?,?)").run(v, value);
				db.prepare("INSERT INTO itemData VALUES (?,?,?)").run(it.id, FIELDS[name], v++);
			}
		}
		return db;
	}

	zotero(prefs = {}) {
		const world = this;
		return {
			Prefs: { get: k => prefs[k] },
			debug() {},
			logError(e) { throw e; },
			getMainWindow: () => ({}),
			Promise: { delay: () => Promise.resolve() },
			ItemFields: { getID: n => FIELDS[n], getTypeFieldsFromBase: () => [] },
			ItemTypes: { getID: n => TYPES[n] },
			Libraries: { get: () => ({ editable: world.editable }) },
			Collections: { get: id => world.collections.get(id) },
			Items: {
				get: id => world.items.get(id),
				getAsync: async ids => (Array.isArray(ids) ? ids : [ids]).map(i => world.items.get(i)).filter(Boolean),
				loadDataTypes: async () => {},
				getByLibraryAndKey: (lib, key) => [...world.items.values()].find(i => i.key === key),
			},
			DB: {
				queryAsync: async (sql, params = []) => {
					world.queries.push(sql);
					const db = world.rebuild();
					return db.prepare(sql).all(...params);
				},
				executeTransaction: async fn => { world.transactions++; return fn(); },
			},
			Notifier: { registerObserver: () => 1, unregisterObserver() {} },
		};
	}
}
