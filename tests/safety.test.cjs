const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../content/attaclone-dedup.js'), 'utf8');

function setup(preferences = {}) {
  const prefs = { dryRun: false, moveToTrash: true, keepStrategy: 'oldest', ...preferences };
  const records = new Map(); const calls = { writes: 0, dialogs: 0, transactions: 0, alerts: [] };
  let transaction = false;
  const parent = { id: 10, libraryID: 1, isRegularItem: () => true,
    getAttachments: () => [...records.values()].filter(x => x.parentItemID === 10 && !x.deleted).map(x => x.id),
    getDisplayTitle: () => 'Synthetic parent' };
  records.set(10, parent);
  function attachment(id, overrides = {}) {
    const value = { id, parentItemID: 10, libraryID: 1, deleted: false,
      attachmentHash: 'a'.repeat(32), attachmentFilename: 'same.pdf',
      attachmentContentType: 'application/pdf', attachmentLinkMode: 0,
      dateAdded: `2026-01-0${id} 00:00:00`,
      isRegularItem: () => false, isFileAttachment: () => true, isPDFAttachment: () => true,
      getFilePathAsync: async () => `/synthetic/${id}.pdf`, getAnnotations: () => [],
      hasEmbeddedAnnotations: async () => false, getTags: () => [], getNote: () => '',
      getDisplayTitle: () => 'Attachment',
      async save() { assert.ok(transaction); calls.writes++; if (this.failSave) throw new Error('save failed'); },
      async saveTx() { calls.writes++; if (this.failSave) throw new Error('save failed'); },
      async erase() { assert.ok(transaction); calls.writes++; this.erased = true; },
      async eraseTx() { calls.writes++; this.erased = true; },
      ...overrides };
    records.set(id, value); return value;
  }
  const Zotero = { debug() {},
    Prefs: { get(name) { return prefs[name.split('.').at(-1)]; }, set(name,value) { prefs[name.split('.').at(-1)] = value; } },
    Attachments: { LINK_MODE_LINKED_URL: 3 },
    Items: {
      get(ids) {
        if (Array.isArray(ids)) return ids.map(id => { assert.equal(typeof id, 'number'); return records.get(id); });
        return records.get(ids);
      },
      getAll: async () => [parent],
    },
    DB: {
      requireTransaction() { assert.ok(transaction); },
      async executeTransaction(fn) {
        calls.transactions++;
        const snapshot = new Map([...records].map(([id, x]) => [id, { parentItemID: x.parentItemID, deleted: x.deleted, erased: x.erased }]));
        transaction = true;
        try { return await fn(); }
        catch (e) { for (const [id,s] of snapshot) Object.assign(records.get(id),s); throw e; }
        finally { transaction = false; }
      },
    },
    ProgressWindow: class { changeHeadline() {} show() {} close() {} },
  };
  const Services = { prompt: { confirm: () => true, alert: (win,title,message) => calls.alerts.push(message) } };
  const IOUtils = { stat: async () => ({ size: 100, type: 'regular' }) };
  const context = vm.createContext({ Zotero, Services, IOUtils });
  vm.runInContext(source, context);
  const app = Zotero.AttacloneDedup;
  const win = { ZoteroPane: { getSelectedLibraryID: () => 1 }, openDialog(url,name,features,params) {
    calls.dialogs++; params.result = calls.result || { skip: true };
  } };
  return { app, attachment, parent, records, prefs, calls, win, Zotero, IOUtils };
}

test('missing hashes cannot authorize automatic removal', async () => {
  const h = setup(); h.attachment(1, { attachmentHash: null }); h.attachment(2, { attachmentHash: null });
  await h.app.processItems([h.parent], h.win);
  assert.equal(h.calls.writes, 0);
});

test('same filename and size are not identity evidence after a hash error', async () => {
  const h = setup();
  for (const id of [1,2]) {
    const a = h.attachment(id); Object.defineProperty(a, 'attachmentHash', { get() { throw new Error('hash unavailable'); } });
  }
  await h.app.processItems([h.parent], h.win);
  assert.equal(h.calls.writes, 0);
});

for (const fault of ['annotations', 'embedded', 'note', 'stat']) {
  test(`unknown ${fault} state cannot be classified as bare`, async () => {
    const h = setup(); const a = h.attachment(1); h.attachment(2);
    if (fault === 'annotations') a.getAnnotations = () => { throw new Error('unavailable'); };
    if (fault === 'embedded') a.hasEmbeddedAnnotations = async () => { throw new Error('unavailable'); };
    if (fault === 'note') a.getNote = () => { throw new Error('unavailable'); };
    if (fault === 'stat') h.IOUtils.stat = async () => { throw new Error('unavailable'); };
    await h.app.processItems([h.parent], h.win);
    assert.equal(h.calls.writes, 0);
  });
}

test('embedded PDF annotations always require review', async () => {
  const h = setup(); h.attachment(1, { hasEmbeddedAnnotations: async () => true }); h.attachment(2);
  await h.app.processItems([h.parent], h.win);
  assert.equal(h.calls.writes, 0); assert.equal(h.calls.dialogs, 1);
});

test('known identical bare copies are resolved and the oldest keeper survives', async () => {
  const h = setup(); const first = h.attachment(1); const second = h.attachment(2);
  const summary = await h.app.processItems([h.parent], h.win);
  assert.equal(first.deleted, false); assert.equal(second.deleted, true);
  assert.equal(summary.autoResolved, 1);
});

test('dry run never moves or clones annotations, even from the manual dialog', async () => {
  const h = setup({ dryRun: true }); h.attachment(1);
  const ann = { id: 20, parentItemID: 2, annotationIsExternal: false,
    clone() { return { saveTx: async () => { h.calls.writes++; } }; },
    save: async () => { h.calls.writes++; } };
  h.records.set(20, ann);
  h.attachment(2, { getAnnotations: () => [ann] });
  h.calls.result = { keepIDs: [1], deleteIDs: [2], mergeAnnotations: true };
  const group = (await h.app._findDuplicateGroups(h.parent))[0];
  await h.app._openManualDialog(h.win, h.parent, group);
  assert.equal(h.calls.writes, 0); assert.equal(ann.parentItemID, 2);
});

test('annotation save failure cannot be followed by deletion', async () => {
  const h = setup(); h.attachment(1); const doomed = h.attachment(2);
  const ann = { id: 20, parentItemID: 2, annotationIsExternal: false,
    clone() { return { saveTx: async () => { throw new Error('annotation failed'); } }; },
    save: async () => { throw new Error('annotation failed'); } };
  h.records.set(20, ann); doomed.getAnnotations = () => [ann];
  h.calls.result = { keepIDs: [1], deleteIDs: [2], mergeAnnotations: true };
  const group = (await h.app._findDuplicateGroups(h.parent))[0];
  await assert.rejects(h.app._openManualDialog(h.win, h.parent, group), /annotation failed/);
  assert.equal(doomed.deleted, false); assert.equal(ann.parentItemID, 2);
});

test('deletion failures roll back the whole group', async () => {
  const h = setup(); h.attachment(1); const a = h.attachment(2); const b = h.attachment(3, { failSave: true });
  await assert.rejects(h.app.processItems([h.parent], h.win), /save failed/);
  assert.equal(a.deleted, false); assert.equal(b.deleted, false);
});

test('manual selections cannot delete attachments outside the reviewed group', async () => {
  const h = setup(); h.attachment(1, { getTags: () => [{ tag: 'review' }] }); h.attachment(2); const other = h.attachment(3, { parentItemID: 99 });
  h.calls.result = { keepIDs: [1], deleteIDs: [2,3], mergeAnnotations: false };
  const group = (await h.app._findDuplicateGroups(h.parent))[0];
  await assert.rejects(h.app._openManualDialog(h.win, h.parent, group));
  assert.equal(other.deleted, false);
});

test('library scanning consumes the item objects returned by getAll', async () => {
  const h = setup({ dryRun: true }); h.attachment(1); h.attachment(2);
  await h.app.scanLibrary(h.win);
  assert.equal(h.calls.writes, 0);
});

test('legacy permanent-erase preference now uses reversible Trash', async () => {
  const h = setup({ moveToTrash: false }); h.attachment(1); const old = h.attachment(2);
  await h.app.processItems([h.parent], h.win);
  assert.equal(old.deleted, true); assert.equal(old.erased, undefined);
  assert.equal(h.prefs.moveToTrash, false);
});

test('stale hashes and metadata are rejected at application time', async () => {
  const h = setup(); h.attachment(1, { getTags: () => [{ tag: 'review' }] }); const a = h.attachment(2);
  const group = (await h.app._findDuplicateGroups(h.parent))[0];
  a.attachmentHash = 'b'.repeat(32);
  h.calls.result = { keepIDs: [1], deleteIDs: [2] };
  await assert.rejects(h.app._openManualDialog(h.win,h.parent,group), /changed/);
  assert.equal(a.deleted, false);
});

test('dry-run summary reports candidates without claiming they were removed', async () => {
  const h = setup({ dryRun: true }); h.attachment(1); h.attachment(2);
  const summary = await h.app.processItems([h.parent], h.win);
  assert.equal(summary.autoPlanned, 1); assert.equal(summary.autoResolved, 0);
});

test('simultaneous scans are refused and the lock is released afterwards', async () => {
  const h = setup({ dryRun: true }); h.attachment(1); h.attachment(2);
  const running = h.app.processItems([h.parent],h.win);
  await assert.rejects(h.app.processItems([h.parent],h.win), /already in progress/);
  await running;
  await h.app.processItems([h.parent],h.win);
});

test('successful annotation merging preserves annotation identity', async () => {
  const h = setup(); h.attachment(1); const old = h.attachment(2);
  const annotation = { id: 20, parentItemID: 2, annotationIsExternal: false, save: async () => { h.calls.writes++; } };
  h.records.set(20, annotation); old.getAnnotations = () => [annotation];
  h.calls.result = { keepIDs: [1], deleteIDs: [2], mergeAnnotations: true };
  const group = (await h.app._findDuplicateGroups(h.parent))[0];
  await h.app._openManualDialog(h.win,h.parent,group);
  assert.equal(h.records.get(20),annotation);
  assert.equal(annotation.parentItemID, 1);
  assert.equal(old.deleted, true);
});

test('uninitialized preferences default to a non-mutating scan', async () => {
  const h = setup({ dryRun: undefined }); h.attachment(1); h.attachment(2);
  await h.app.processItems([h.parent],h.win);
  assert.equal(h.calls.writes, 0);
});

test('preference failures release the scan lock without writing', async () => {
  const h = setup(); h.Zotero.Prefs.get = () => { throw new Error('preferences unavailable'); };
  await assert.rejects(h.app.processItems([h.parent],h.win), /preferences unavailable/);
  assert.equal(h.app._processing,false); assert.equal(h.calls.writes,0);
});
