const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('startup explicitly supplies IOUtils to the module scope', async () => {
  const IOUtils = { stat() {} };
  const Zotero = { debug() {}, getMainWindows: () => [] };
  let imported = false;
  const context = vm.createContext({ Zotero,
    Components: {
      classes: { '@mozilla.org/addons/addon-manager-startup;1': {
        getService: () => ({ registerChrome: () => ({ destruct() {} }) }),
      } }, interfaces: {},
      utils: { importGlobalProperties(properties) {
        assert.deepEqual(Array.from(properties), ['IOUtils']);
        imported = true; context.IOUtils = IOUtils;
      } },
    },
    Services: { io: { newURI: x => x }, scriptloader: { loadSubScript(uri, scope) {
      assert.equal(scope.IOUtils, IOUtils);
      Zotero.AttacloneDedup = { init: async () => {}, shutdown() {} };
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../bootstrap.js'), 'utf8'), context);
  await context.startup({ id: 'test', version: '1', rootURI: 'file:///synthetic/' });
  assert.equal(imported, true);
  context.shutdown();
  assert.equal(Zotero.AttacloneDedup, undefined);
});

test('manual annotation merging requires exactly one keeper', () => {
  const alerts = [];
  const context = vm.createContext({ window: {}, document: {
    getElementById: () => ({ checked: true }),
  }, ChromeUtils: { importESModule: () => ({ Services: {
    prompt: { alert: (...args) => alerts.push(args) },
  } }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/manualResolve.js'), 'utf8'), context);
  context.DupResolve.params = { members: [{ id: 1 }, { id: 2 }, { id: 3 }], result: null };
  context.DupResolve._collectKeepIDs = () => [1, 2];
  assert.equal(context.DupResolve.onAccept(), false);
  assert.equal(context.DupResolve.params.result, null);
  assert.equal(alerts.length, 1);
});


test('manual dry-run dialog labels its preview and initially keeps every copy', () => {
  const nodes = new Map();
  const node = () => ({ style: {}, children: [], setAttribute() {},
    appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); } });
  for (const id of ['dup-item-title', 'dup-list', 'dup-intro']) nodes.set(id, node());
  const context = vm.createContext({ window: { arguments: [{ dryRun: true,
    members: [{ id: 1 }, { id: 2 }] }] }, document: {
    getElementById: id => nodes.get(id), createXULElement: node,
  }, ChromeUtils: { importESModule: () => ({ Services: {} }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/manualResolve.js'), 'utf8'), context);
  context.DupResolve.onLoad();
  assert.match(nodes.get('dup-intro').textContent, /Dry run.*No attachments or annotations will change/);
  assert.deepEqual(Array.from(context.DupResolve._collectKeepIDs()), [1, 2]);
  assert.equal(nodes.get('dup-list').children.length, 2);
});
