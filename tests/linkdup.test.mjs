import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { World } from "./fake-zotero.mjs";

const SRC = fs.readFileSync(new URL("../plugins/zotero-helper/linkdup.js", import.meta.url), "utf8");
const P = "extensions.plugins4zotero.linkdup.";

function setup(prefs = {}) {
	const world = new World();
	const full = {};
	for (const [k, v] of Object.entries(prefs)) full[P + k] = v;
	const ctx = {
		Zotero: world.zotero(full),
		Services: { prompt: { confirmEx: () => 0, BUTTON_TITLE_IS_STRING: 127, BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536 } },
		URL,
	};
	vm.createContext(ctx);
	vm.runInContext(SRC + ";globalThis.LinkDup=LinkDup;", ctx);
	const L = ctx.LinkDup;
	const toasts = [];
	L.ui = { toast: (message, undo) => toasts.push({ message, undo }), dismiss() {} };
	return { world, L, toasts, ctx };
}

const article = (world, fields, extra = {}) => world.add("journalArticle", { fields, ...extra });

test("DOI match: case and URL prefix are normalized, existing item gets the collection", async () => {
	const { world, L, toasts } = setup();
	const col = world.collection("Thesis");
	const existing = article(world, { title: "A", DOI: "10.1000/ABC.123" });
	const added = article(world, { title: "A (copy)", DOI: "https://doi.org/10.1000/abc.123" }, { collections: [col] });

	const records = await L.processBatch([added.id]);

	assert.equal(records.length, 1);
	assert.ok(existing.inCollection(col), "existing item is now in the target collection");
	assert.equal(added.deleted, true, "new copy is in the Trash");
	assert.equal(records[0].reason, "doi");
	assert.equal(toasts.length, 1);
	assert.match(toasts[0].message, /linked to collection "Thesis"/);
	assert.equal(typeof toasts[0].undo, "function");
});

test("ISBN match: ISBN-10 and ISBN-13 are treated as equal", async () => {
	const { world, L } = setup();
	const col = world.collection("Books");
	const existing = world.add("book", { fields: { title: "Some Book", ISBN: "0-306-40615-2" } });
	const added = world.add("book", { fields: { title: "Some Book", ISBN: "978-0-306-40615-7" }, collections: [col] });

	const [rec] = await L.processBatch([added.id]);

	assert.equal(rec.reason, "isbn");
	assert.ok(existing.inCollection(col));
	assert.equal(added.deleted, true);
});

test("other identifiers: arXiv (URL vs Extra), PMID and URL", async () => {
	const { world, L } = setup({ strictness: "identifiers" });
	const col = world.collection("C");
	const a = world.add("preprint", { fields: { title: "X", extra: "arXiv: 2101.00001 [cs.CL]" } });
	const b = world.add("preprint", { fields: { title: "Y", url: "https://arxiv.org/abs/2101.00001v3" }, collections: [col] });
	assert.equal((await L.processBatch([b.id]))[0].reason, "arxiv");
	assert.ok(a.inCollection(col));

	const c = article(world, { title: "P", extra: "PMID: 31415926" });
	const d = article(world, { title: "Q", extra: "PMID: 31415926" }, { collections: [col] });
	assert.equal((await L.processBatch([d.id]))[0].reason, "pmid");
	assert.ok(c.inCollection(col));

	const e = world.add("webpage", { fields: { title: "W", url: "http://www.example.org/post/1/?utm_source=x" } });
	const f = world.add("webpage", { fields: { title: "Z", url: "https://example.org/post/1" }, collections: [col] });
	assert.equal((await L.processBatch([f.id]))[0].reason, "url");
	assert.ok(e.inCollection(col));
});

test("bare domains are not used as a URL identifier", async () => {
	const { world, L } = setup({ strictness: "identifiers" });
	world.add("webpage", { fields: { title: "Home", url: "https://example.org/" } });
	const n = world.add("webpage", { fields: { title: "Other", url: "https://example.org" }, collections: [world.collection("C")] });
	assert.equal((await L.processBatch([n.id])).length, 0);
});

test("title fallback: normalized title + first creator + year", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	const existing = article(world, { title: "Café Culture: A Study of Naïve Résumés!", date: "2020-05-01" },
		{ creators: [{ lastName: "Müller" }] });
	const added = article(world, { title: "  cafe culture -- a study of naive resumes ", date: "2020" },
		{ creators: [{ lastName: "MULLER" }], collections: [col] });

	const [rec] = await L.processBatch([added.id]);
	assert.equal(rec.reason, "title+creator+year");
	assert.ok(existing.inCollection(col));
});

test("title fallback is rejected when year or author differ, or when strictness is identifiers-only", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	article(world, { title: "Deep Learning for Graphs", date: "2020" }, { creators: [{ lastName: "Smith" }] });
	const diffYear = article(world, { title: "Deep Learning for Graphs", date: "2021" }, { creators: [{ lastName: "Smith" }], collections: [col] });
	const diffAuthor = article(world, { title: "Deep Learning for Graphs", date: "2020" }, { creators: [{ lastName: "Jones" }], collections: [col] });
	const titleOnly = article(world, { title: "Deep Learning for Graphs" }, { collections: [col] });
	assert.equal((await L.processBatch([diffYear.id, diffAuthor.id, titleOnly.id])).length, 0);

	const strict = setup({ strictness: "identifiers" });
	article(strict.world, { title: "Deep Learning for Graphs", date: "2020" }, { creators: [{ lastName: "Smith" }] });
	const same = article(strict.world, { title: "Deep Learning for Graphs", date: "2020" }, { creators: [{ lastName: "Smith" }], collections: [strict.world.collection("C")] });
	assert.equal((await strict.L.processBatch([same.id])).length, 0);
	assert.equal(same.deleted, false);
});

test("no match: the new item is left completely alone", async () => {
	const { world, L, toasts } = setup();
	const col = world.collection("C");
	article(world, { title: "Something else", DOI: "10.1000/other" });
	const added = article(world, { title: "Brand new", DOI: "10.1000/new" }, { collections: [col] });
	assert.equal((await L.processBatch([added.id])).length, 0);
	assert.equal(added.deleted, false);
	assert.equal(toasts.length, 0);
});

test("already in the collection: no membership change, new copy removed, notice shown", async () => {
	const { world, L, toasts } = setup();
	const col = world.collection("Thesis");
	const existing = article(world, { DOI: "10.1000/x" }, { collections: [col] });
	const added = article(world, { DOI: "10.1000/x" }, { collections: [col] });

	const [rec] = await L.processBatch([added.id]);

	assert.equal(rec.addedCollections.length, 0);
	assert.equal(existing.getCollections().join(), String(col));
	assert.equal(added.deleted, true);
	assert.match(toasts[0].message, /Already in collection "Thesis"/);
});

test("existing item in the Trash: skipped by default, restored and used when configured", async () => {
	const skip = setup();
	const col1 = skip.world.collection("C");
	const trashed = article(skip.world, { DOI: "10.1000/t" }, { deleted: true });
	const added1 = article(skip.world, { DOI: "10.1000/t" }, { collections: [col1] });
	assert.equal((await skip.L.processBatch([added1.id])).length, 0);
	assert.equal(trashed.deleted, true);
	assert.equal(added1.deleted, false, "new item kept because nothing live matched");

	const restore = setup({ trashedExisting: "restore" });
	const col2 = restore.world.collection("C");
	const trashed2 = article(restore.world, { DOI: "10.1000/t" }, { deleted: true });
	const added2 = article(restore.world, { DOI: "10.1000/t" }, { collections: [col2] });
	const [rec] = await restore.L.processBatch([added2.id]);
	assert.equal(rec.restoredExisting, true);
	assert.equal(trashed2.deleted, false);
	assert.ok(trashed2.inCollection(col2));
	assert.equal(added2.deleted, true);

	// Undo puts the Trash back as it was
	await restore.L.undo([rec]);
	assert.equal(trashed2.deleted, true);
	assert.equal(added2.deleted, false);
});

test("multiple matches: the oldest (lowest dateAdded) wins; live items beat trashed ones", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	const newer = article(world, { DOI: "10.1000/m" }, { dateAdded: "2026-01-02 00:00:00" });
	const oldest = article(world, { DOI: "10.1000/m" }, { dateAdded: "2025-01-01 00:00:00" });
	const added = article(world, { DOI: "10.1000/m" }, { collections: [col] });
	const [rec] = await L.processBatch([added.id]);
	assert.equal(rec.existingID, oldest.id);
	assert.ok(!newer.inCollection(col));
});

test("different item types are not linked by default, but can be via the setting", async () => {
	const off = setup();
	article(off.world, { DOI: "10.1000/p" });
	const pre = off.world.add("preprint", { fields: { DOI: "10.1000/p" }, collections: [off.world.collection("C")] });
	assert.equal((await off.L.processBatch([pre.id])).length, 0);

	const on = setup({ allowCrossType: true });
	const j = article(on.world, { DOI: "10.1000/p" });
	const pre2 = on.world.add("preprint", { fields: { DOI: "10.1000/p" }, collections: [on.world.collection("C")] });
	assert.equal((await on.L.processBatch([pre2.id])).length, 1);
	assert.ok(j.getCollections().length === 1);
});

test("never links across libraries", async () => {
	const { world, L } = setup();
	article(world, { DOI: "10.1000/l" }, { libraryID: 2 });
	const added = article(world, { DOI: "10.1000/l" }, { libraryID: 1, collections: [world.collection("C")] });
	assert.equal((await L.processBatch([added.id])).length, 0);
});

test("merging: tags, notes, attachments and related items move; existing fields untouched", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	const related = article(world, { title: "Related paper", DOI: "10.1000/rel" });
	const existing = article(world, { title: "Keep me", DOI: "10.1000/g" }, { tags: ["old"] });
	world.add("attachment", { parentID: existing.id, contentType: "text/html" });
	const added = article(world, { title: "Different title", DOI: "10.1000/g" },
		{ collections: [col], tags: ["old", "new"], related: [related.key] });
	const note = world.add("note", { parentID: added.id, note: "<p>my note</p>" });
	const pdf = world.add("attachment", { parentID: added.id, contentType: "application/pdf" });

	const [rec] = await L.processBatch([added.id]);

	assert.equal(existing.getField("title"), "Keep me");
	assert.equal(existing.tags.map(t => t.tag).sort().join(), "new,old");
	assert.equal(note.parentID, existing.id);
	assert.equal(pdf.parentID, existing.id);
	assert.ok(existing.relatedItems.includes(related.key) && related.relatedItems.includes(existing.key));
	assert.equal(rec.movedChildren.length, 2);
});

test("an equivalent attachment/note already on the existing item is not duplicated", async () => {
	const { world, L } = setup();
	const existing = article(world, { DOI: "10.1000/d" });
	world.add("attachment", { parentID: existing.id, contentType: "application/pdf" });
	world.add("note", { parentID: existing.id, note: "<p>same</p>" });
	const added = article(world, { DOI: "10.1000/d" }, { collections: [world.collection("C")] });
	const pdf2 = world.add("attachment", { parentID: added.id, contentType: "application/pdf" });
	const note2 = world.add("note", { parentID: added.id, note: "<p>same</p>" });
	await L.processBatch([added.id]);
	assert.equal(pdf2.parentID, added.id);
	assert.equal(note2.parentID, added.id);
});

test("mergeChildren off: nothing is copied", async () => {
	const { world, L } = setup({ mergeChildren: false });
	const existing = article(world, { DOI: "10.1000/n" });
	const added = article(world, { DOI: "10.1000/n" }, { collections: [world.collection("C")], tags: ["t"] });
	const note = world.add("note", { parentID: added.id, note: "x" });
	await L.processBatch([added.id]);
	assert.equal(existing.tags.length, 0);
	assert.equal(note.parentID, added.id);
});

test("attachments saved after the item (connector) are moved to the existing item", async () => {
	const { world, L } = setup();
	const existing = article(world, { DOI: "10.1000/c" });
	const added = article(world, { DOI: "10.1000/c" }, { collections: [world.collection("C")] });
	await L.processBatch([added.id]);

	const late = world.add("attachment", { parentID: added.id, contentType: "application/pdf" });
	L.onNotify("add", "item", [late.id]);
	await L.flush();
	assert.equal(late.parentID, existing.id);
});

test("new copy handling: delete permanently, and ask", async () => {
	const del = setup({ newCopyAction: "delete" });
	const e1 = article(del.world, { DOI: "10.1000/z" });
	const a1 = article(del.world, { DOI: "10.1000/z" }, { collections: [del.world.collection("C")] });
	await del.L.processBatch([a1.id]);
	assert.ok(!del.world.items.has(a1.id), "erased");
	assert.equal(del.toasts[0].undo, null, "no Undo after a permanent delete");
	assert.ok(e1.getCollections().length === 1);

	const ask = setup({ newCopyAction: "ask" });
	article(ask.world, { DOI: "10.1000/z" });
	const a2 = article(ask.world, { DOI: "10.1000/z" }, { collections: [ask.world.collection("C")] });
	ask.ctx.Services.prompt.confirmEx = () => 1; // "Keep both"
	assert.equal((await ask.L.processBatch([a2.id])).length, 0);
	assert.equal(a2.deleted, false);
	ask.ctx.Services.prompt.confirmEx = () => 0; // "Move to Trash"
	assert.equal((await ask.L.processBatch([a2.id])).length, 1);
	assert.equal(a2.deleted, true);
});

test("added to My Library with no collection: trashed by default, left alone when configured", async () => {
	const t = setup();
	article(t.world, { DOI: "10.1000/u" });
	const a = article(t.world, { DOI: "10.1000/u" });
	await t.L.processBatch([a.id]);
	assert.equal(a.deleted, true);

	const k = setup({ noCollectionAction: "keep" });
	article(k.world, { DOI: "10.1000/u" });
	const b = article(k.world, { DOI: "10.1000/u" });
	assert.equal((await k.L.processBatch([b.id])).length, 0);
	assert.equal(b.deleted, false);
});

test("Undo restores the new item and removes only the memberships/tags it added", async () => {
	const { world, L, toasts } = setup();
	const colNew = world.collection("New");
	const colOld = world.collection("Old");
	const existing = article(world, { DOI: "10.1000/undo" }, { collections: [colOld], tags: ["keep"] });
	const added = article(world, { DOI: "10.1000/undo" }, { collections: [colNew], tags: ["extra"] });
	const note = world.add("note", { parentID: added.id, note: "n" });

	await L.processBatch([added.id]);
	assert.ok(existing.inCollection(colNew));
	await toasts[0].undo();

	assert.equal(added.deleted, false);
	assert.equal(existing.getCollections().join(), String(colOld));
	assert.equal(existing.tags.map(t => t.tag).join(), "keep");
	assert.equal(note.parentID, added.id);
});

test("ignored: attachments, notes, synced items, read-only libraries, disabled feature", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	article(world, { DOI: "10.1000/i" });
	const att = world.add("attachment", { fields: { DOI: "10.1000/i" } });
	const note = world.add("note", { fields: { DOI: "10.1000/i" } });
	L.onNotify("add", "item", [att.id, note.id]);
	assert.equal(L.pending.size, 0, "standalone attachments/notes never enter the queue");

	const synced = article(world, { DOI: "10.1000/i" }, { collections: [col], synced: true });
	assert.equal((await L.processBatch([synced.id])).length, 0);

	world.editable = false;
	const ro = article(world, { DOI: "10.1000/i" }, { collections: [col] });
	assert.equal((await L.processBatch([ro.id])).length, 0);

	const off = setup({ enabled: false });
	const x = article(off.world, { DOI: "10.1000/i" });
	off.L.onNotify("add", "item", [x.id]);
	assert.equal(off.L.pending.size, 0);
});

test("re-entrancy: items the plugin itself touched never trigger it again; dragging an existing item into a collection is not 'new'", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	const existing = article(world, { DOI: "10.1000/r" });
	const added = article(world, { DOI: "10.1000/r" }, { collections: [col] });
	await L.processBatch([added.id]);

	L.onNotify("add", "item", [added.id, existing.id]); // events caused by our own saves
	assert.equal(L.pending.size, 0);

	const pre = article(world, { DOI: "10.1000/r" }); // pre-existing duplicate pair
	L.onNotify("add", "collection-item", [col + "-" + pre.id]); // user drags it into a collection
	assert.equal(L.pending.size, 0, "collection-item events alone never queue an item");
});

test("the observer path batches events and processes after the settle delay", async () => {
	const { world, L } = setup();
	const col = world.collection("C");
	const existing = article(world, { DOI: "10.1000/o" });
	const added = article(world, { DOI: "10.1000/o" }, { collections: [col] });
	L.onNotify("add", "item", [added.id]);
	L.onNotify("add", "collection-item", [col + "-" + added.id]);
	await new Promise(r => setTimeout(r, 20));
	assert.equal(added.deleted, true);
	assert.ok(existing.inCollection(col));
});

test("bulk import: 300 new items cost a constant number of queries, and only the real duplicates are linked", async () => {
	const { world, L } = setup();
	const col = world.collection("Import");
	for (let i = 0; i < 300; i++) article(world, { title: "Existing paper number " + i, DOI: "10.5000/" + i });
	const ids = [];
	for (let i = 0; i < 300; i++) {
		// every third one is a duplicate of an existing item
		const doi = i % 3 === 0 ? "10.5000/" + i : "10.9000/new" + i;
		ids.push(article(world, { title: "Imported " + i, DOI: doi }, { collections: [col] }).id);
	}
	world.queries.length = 0;

	const records = await L.processBatch(ids);

	assert.equal(records.length, 100);
	assert.ok(world.queries.length <= 8, "queries: " + world.queries.length);
	assert.equal(world.transactions, 100, "one transaction per linked item");
	assert.equal([...world.items.values()].filter(i => i.deleted).length, 100);
});

test("normalizers", () => {
	const { L } = setup();
	assert.equal(L.normalizeDOI("doi:10.1000/XYZ.5.").join(), "10.1000/xyz.5");
	assert.equal(L.normalizeISBNs("ISBN 0-306-40615-2, 978-0-306-40615-7").join(), "9780306406157");
	assert.equal(L.normalizeISBNs("0-306-40615-3").length, 0, "bad checksum rejected");
	assert.equal(L.normalizeArxiv("https://arxiv.org/pdf/hep-th/9901001v2").join(), "hep-th/9901001");
});
