const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers.cjs');

test('missing or malformed digests never authorize removal', async () => {
  for (const digest of [null, '', 'a'.repeat(32), 'invalid']) {
    const f = fixture({ dryRun: false });
    f.IOUtils.computeHexDigest = async () => digest;
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.duplicatesFound, 0);
    assert.equal(f.counts().saves, 0);
    assert.equal(summary.warnings, 2);
  }
});

test('file inspection failures and changes while hashing fail closed', async () => {
  for (const change of [
    f => { f.IOUtils.stat = async () => { throw Error('stat unavailable'); }; },
    f => { f.IOUtils.stat = async () => ({ type: 'regular', size: 0, lastModified: 1 }); },
    f => { let n = 0; f.IOUtils.stat = async () => ({ type: 'regular', size: 16, lastModified: ++n }); },
  ]) {
    const f = fixture({ dryRun: false });
    change(f);
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.autoResolved, 0);
    assert.equal(f.counts().saves, 0);
    assert.equal(summary.warnings, 2);
  }
});

test('automatic resolution requires matching PDF type and storage mode', async () => {
  for (const change of [
    f => { f.records.get(2).attachmentLinkMode = 2; },
    f => { f.records.get(2).attachmentContentType = ''; },
    f => { for (const id of [1, 2]) f.records.get(id).attachmentLinkMode = undefined; },
  ]) {
    const f = fixture({ dryRun: false });
    change(f);
    const [group] = await f.plugin._findDuplicateGroups(f.parent);
    assert.equal(f.plugin._canAutoResolve(group), false);
    f.win.openDialog = (_url, _name, _flags, params) => { params.result = { skip: true }; };
    const summary = await f.plugin.processItems([f.parent], f.win);
    assert.equal(summary.manualQueued, 1);
    assert.equal(f.counts().saves, 0);
  }
});

test('newest keeper strategy preserves the requested identity and never erases files', async () => {
  const f = fixture({ dryRun: false });
  f.prefs.keepStrategy = 'newest';
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.autoResolved, 1);
  assert.equal(f.records.get(1).deleted, true);
  assert.equal(f.records.get(2).deleted, false);
  assert.equal(f.counts().erases, 0);
  assert.equal(f.prefs.moveToTrash, false);
});

test('simultaneous scans cannot mutate concurrently and release their lock', async () => {
  const f = fixture();
  const running = f.plugin.processItems([f.parent], f.win);
  await assert.rejects(f.plugin.processItems([f.parent], f.win), /already running/);
  await running;
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.planned, 1);
  assert.equal(f.counts().saves, 0);
  assert.equal(f.plugin._running, false);
});

test('preference failures release the scan lock and a later preview can run', async () => {
  const f = fixture();
  const get = f.Zotero.Prefs.get;
  f.Zotero.Prefs.get = () => { throw Error('preferences unavailable'); };
  await assert.rejects(f.plugin.processItems([f.parent], f.win), /preferences unavailable/);
  assert.equal(f.plugin._running, false);
  assert.equal(f.counts().saves, 0);
  f.Zotero.Prefs.get = get;
  assert.equal((await f.plugin.processItems([f.parent], f.win)).planned, 1);
});

test('undefined dry-run preference stays nonmutating without initialization', async () => {
  const f = fixture();
  delete f.prefs.dryRun;
  const summary = await f.plugin.processItems([f.parent], f.win);
  assert.equal(summary.planned, 1);
  assert.equal(summary.autoResolved, 0);
  assert.deepEqual(f.counts(), { saves: 0, moves: 0, erases: 0, transactions: 0 });
});
