const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers.cjs");

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
