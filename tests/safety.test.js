const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../content/attaclone-dedup.js"), "utf8");

function fixture({ dryRun = true, annotations = false } = {}) {
  const prefs = { dryRun, keepStrategy: "oldest", moveToTrash: false };
  const files = new Map([["/copy1", Buffer.from("verified example")], ["/copy2", Buffer.from("verified example")]]);
  const records = new Map();
  const annotationRecords = new Map(), databaseAnnotationParents = new Map(), noteLinks = new Set();
  let saves = 0, moves = 0, erases = 0, transactions = 0;
  const parent = {
    id: 10, libraryID: 1, deleted: false, isRegularItem: () => true,
    loadAllData: async () => {}, getAttachments: () => [1, 2],
    isEditable: () => true, hasChanged: () => false, getDisplayTitle: () => "Example",
  };
  for (const id of [1, 2]) {
    records.set(id, {
      id, key: `PDFKEY0${id}`, libraryID: 1, parentID: 10, deleted: false, attachmentFilename: "paper.pdf",
      attachmentContentType: "application/pdf", attachmentLinkMode: 0,
      dateAdded: `2026-01-0${id} 12:00:00`, dateModified: "2026-01-03 12:00:00",
      annotations: id === 2 && annotations ? [{ id: 100, parentID: 2, key: "KEEPKEY1",
        dateModified: "2026-01-01", deleted: false, hasChanged: () => false }] : [],
      loadAllData: async () => {}, isFileAttachment: () => true, isPDFAttachment: () => true, isRegularItem: () => false,
      getRelations: () => ({}),
      getFilePathAsync: async () => `/copy${id}`,
      getAnnotations() { return this.annotations; }, getTags: () => [], getNote: () => "",
      isEditable: () => true, hasChanged: () => false,
      async save() { saves++; if (this.failSave) throw new Error("save failed"); },
      async eraseTx() { erases++; }, async reload() {},
    });
  }
  for (const attachment of records.values()) for (const annotation of attachment.annotations) {
    databaseAnnotationParents.set(annotation.id, annotation.parentID);
    annotation.reloads = 0;
    annotation.reload = async function () { this.reloads++; this.parentID = databaseAnnotationParents.get(this.id); };
    annotationRecords.set(annotation.id, annotation);
  }
  const library = { editable: true, filesEditable: true, waitForDataLoad: async () => {} };
  const Zotero = {
    Prefs: { get: (key) => prefs[key.split(".").pop()], set: (key, value) => { prefs[key.split(".").pop()] = value; } },
    Libraries: { get: () => library },
    URI: { getItemURI: attachment => "https://zotero.org/users/1/items/" + attachment.key },
    Relations: { getByObject: async () => [] },
    Items: {
      get(id) { assert.equal(typeof id, "number", "Items.get requires IDs"); return records.get(id) || annotationRecords.get(id); },
      getAll: async () => [parent],
      async moveChildItems(from, to) {
        moves++;
        if (from.failMove) throw new Error("transfer failed");
        for (const annotation of from.annotations) {
          annotation.parentID = to.id; databaseAnnotationParents.set(annotation.id, to.id); to.annotations.push(annotation);
          if (from.failAfterMove) throw new Error("failure after annotation save");
        }
        from.annotations = [];
      },
    },
    DB: {
      valueQueryAsync: async (_sql, params) => noteLinks.has(params[1]) ? 50 : null,
      async executeTransaction(operation) {
        transactions++;
        const annotationSnapshot = new Map(databaseAnnotationParents);
        const snapshot = [...records.values()].map((r) => ({ id: r.id, deleted: r.deleted,
          annotations: [...r.annotations] }));
        try { return await operation(); }
        catch (error) {
          for (const s of snapshot) Object.assign(records.get(s.id), s);
          for (const [id, parent] of annotationSnapshot) databaseAnnotationParents.set(id, parent);
          throw error;
        }
      },
    },
    ProgressWindow: class { changeHeadline() {} show() {} close() {} },
    debug() {}, logError() {},
  };
  const IOUtils = {
    async stat(filename) {
      if (!files.has(filename)) throw new Error("file missing");
      return { type: "regular", size: files.get(filename).length, lastModified: 1 };
    },
    async computeHexDigest(filename, algorithm) { return crypto.createHash(algorithm).update(files.get(filename)).digest("hex"); },
  };
  const prompts = [];
  const Services = { prompt: { alert: (_win, _title, message) => prompts.push(message), confirm: () => true } };
  const context = vm.createContext({ Zotero, IOUtils, Services, console });
  vm.runInContext(source, context);
  const plugin = Zotero.AttacloneDedup;
  plugin._scanWarnings = [];
  const win = {
    ZoteroPane: { getSelectedLibraryID: () => 1 },
    openDialog(_url, _name, _flags, parameters) {
      parameters.result = { keepIDs: [1], deleteIDs: [2], mergeAnnotations: true };
    },
  };
  return { plugin, Zotero, records, annotationRecords, noteLinks, files, parent, library, prefs, IOUtils, win, prompts,
    counts: () => ({ saves, moves, erases, transactions }) };
}

test("failed content hashing never turns same filename/size into duplicates", async () => {
  const f = fixture();
  f.IOUtils.computeHexDigest = async () => { throw new Error("unreadable"); };
  assert.equal((await f.plugin._findDuplicateGroups(f.parent)).length, 0);
  assert.equal(f.plugin._scanWarnings.length, 2);
  assert.equal(f.plugin._canAutoResolve({ key: "f:paper.pdf:16", members: [{}, {}] }), false);
});

test("different same-size bytes never group", async () => {
  const f = fixture();
  f.files.set("/copy2", Buffer.from("different bytes!"));
  assert.equal((await f.plugin._findDuplicateGroups(f.parent)).length, 0);
});

test("dry-run manual annotation transfer writes absolutely nothing", async () => {
  const f = fixture({ annotations: true });
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.planned, 1);
  assert.equal(summary.manualResolved, 0);
  assert.deepEqual(f.counts(), { saves: 0, moves: 0, erases: 0, transactions: 0 });
  assert.equal(f.records.get(2).annotations[0].parentID, 2);
});

test("apply transfers annotation identities and trashes source atomically", async () => {
  const f = fixture({ dryRun: false, annotations: true });
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.manualResolved, 1);
  assert.equal(f.records.get(1).annotations[0].key, "KEEPKEY1");
  assert.equal(f.records.get(1).annotations[0].id, 100);
  assert.equal(f.records.get(2).deleted, true);
  assert.deepEqual(f.counts(), { saves: 1, moves: 1, erases: 0, transactions: 1 });
});

test("transfer failure preserves source and does not trash", async () => {
  const f = fixture({ dryRun: false, annotations: true });
  f.records.get(2).failMove = true;
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.failed, 1);
  assert.equal(f.records.get(2).deleted, false);
  assert.equal(f.records.get(2).annotations[0].key, "KEEPKEY1");
  assert.equal(f.counts().saves, 0);
});

test("save failure rolls back annotation transfer", async () => {
  const f = fixture({ dryRun: false, annotations: true });
  f.records.get(2).failSave = true;
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.failed, 1);
  assert.equal(f.records.get(2).deleted, false);
  assert.equal(f.records.get(2).annotations[0].parentID, 2);
  assert.equal(f.records.get(1).annotations.length, 0);
  assert.equal(f.annotationRecords.get(100).parentID, 2);
  assert.equal(f.annotationRecords.get(100).reloads, 1);
});

test("a failure after an annotation save reloads its cached parent", async () => {
  const f = fixture({ dryRun: false, annotations: true });
  f.records.get(2).failAfterMove = true;
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.failed, 1);
  assert.equal(f.annotationRecords.get(100).parentID, 2);
  assert.equal(f.annotationRecords.get(100).reloads, 1);
  assert.equal(f.records.get(2).deleted, false);
});

test("failed cache recovery prevents later mutations until restart", async () => {
  const f = fixture({ dryRun: false, annotations: true });
  f.records.get(2).failSave = true;
  f.annotationRecords.get(100).reload = async () => { throw new Error("reload failed"); };
  await f.plugin.processItems([f.parent], f.win);
  assert.equal(f.plugin._recoveryRequired, true);
  const before = f.counts().saves;
  await f.plugin.processItems([f.parent], f.win);
  assert.equal(f.counts().saves, before);
});

test("multi-file snapshots, relations, note links and external annotations remain untouched", async () => {
  for (const change of [
    f => { f.records.get(2).isPDFAttachment = () => false; },
    f => { f.records.get(2).getRelations = () => ({ "dc:relation": ["linked-reference"] }); },
    f => { f.Zotero.Relations.getByObject = async () => [{ predicate: "dc:relation" }]; },
    f => { f.noteLinks.add("%PDFKEY02%"); },
    f => { f.records.get(2).annotations = [{ annotationIsExternal: true }]; },
    f => { f.Zotero.DB.valueQueryAsync = async () => { throw new Error("note inspection failed"); }; },
  ]) {
    const f = fixture({ dryRun: false });
    change(f);
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.autoResolved, 0);
    assert.equal(f.counts().saves, 0);
    assert.ok(summary.warnings);
  }
});

test("a note linked after review invalidates the duplicate selection", async () => {
  const f = fixture({ dryRun: false });
  const [group] = await f.plugin._findDuplicateGroups(f.parent);
  f.noteLinks.add("%PDFKEY02%");
  await assert.rejects(f.plugin._resolveGroup(f.parent, group, { keepIDs: [1], deleteIDs: [2] }), /note references/);
  assert.equal(f.counts().saves, 0);
});

test("inspection errors fail closed for annotations and notes", async () => {
  for (const method of ["getAnnotations", "getNote", "getTags"]) {
    const f = fixture({ dryRun: false });
    f.records.get(2)[method] = () => { throw new Error("inspection failed"); };
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.autoResolved, 0);
    assert.equal(f.counts().saves, 0);
  }
});

test("stale file and metadata changes after review block mutation", async () => {
  for (const change of [
    (f) => f.files.set("/copy2", Buffer.from("changed example!")),
    (f) => { f.records.get(2).getTags = () => [{ tag: "new work" }]; },
    (f) => { f.records.get(2).parentID = 99; },
    (f) => { f.records.get(2).deleted = true; },
  ]) {
    const f = fixture({ dryRun: false });
    const [group] = await f.plugin._findDuplicateGroups(f.parent);
    change(f);
    await assert.rejects(f.plugin._resolveGroup(f.parent, group, { keepIDs: [1], deleteIDs: [2] }));
    assert.equal(f.counts().saves, 0);
  }
});

test("read-only libraries and unsaved edits cannot be mutated", async () => {
  for (const change of [
    (f) => { f.library.editable = false; },
    (f) => { f.library.filesEditable = false; },
    (f) => { f.records.get(2).hasChanged = () => true; },
  ]) {
    const f = fixture({ dryRun: false }); change(f);
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.failed, 1);
    assert.equal(f.counts().saves, 0);
  }
});

test("legacy erase preference is ignored; only trash is supported", async () => {
  const f = fixture({ dryRun: false });
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.autoResolved, 1);
  assert.equal(f.records.get(2).deleted, true);
  assert.equal(f.counts().erases, 0);
});

test("invalid selection cannot remove every copy or an unrelated ID", async () => {
  const f = fixture({ dryRun: false });
  const [group] = await f.plugin._findDuplicateGroups(f.parent);
  for (const selection of [{ keepIDs: [], deleteIDs: [1, 2] }, { keepIDs: [1], deleteIDs: [20] },
    { keepIDs: [1], deleteIDs: [1] }]) {
    await assert.rejects(f.plugin._resolveGroup(f.parent, group, selection));
  }
  assert.equal(f.counts().saves, 0);
});

test("library scan consumes Item objects from current Zotero getAll", async () => {
  const f = fixture();
  await f.plugin.scanLibrary(f.win);
  assert.ok(f.prompts[0].includes("Items scanned: 1"));
});

test("default preferences preserve preview and reentrant scans are refused", async () => {
  const f = fixture();
  delete f.prefs.dryRun;
  f.plugin._setDefaultPrefs();
  assert.equal(f.prefs.dryRun, true);
  f.plugin._running = true;
  await assert.rejects(f.plugin.processItems([f.parent], f.win), /already running/);
});

test("disabling preview during a scan does not turn that preview into writes", async () => {
  const f = fixture();
  const hash = f.IOUtils.computeHexDigest;
  f.IOUtils.computeHexDigest = async (...args) => { f.prefs.dryRun = false; return hash(...args); };
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.planned, 1);
  assert.equal(f.counts().saves, 0);
  assert.match(f.prompts[0], /DRY RUN/);
});

test("shutdown or enabling preview during annotation transfer rolls back before trash", async () => {
  for (const cancel of [f => f.plugin.shutdown(), f => { f.prefs.dryRun = true; }]) {
    const f = fixture({ dryRun: false, annotations: true });
    const move = f.Zotero.Items.moveChildItems;
    f.Zotero.Items.moveChildItems = async (...args) => { await move(...args); cancel(f); };
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.failed, 1);
    assert.equal(f.records.get(2).deleted, false);
    assert.equal(f.annotationRecords.get(100).parentID, 2);
    assert.equal(f.counts().saves, 0);
  }
});
