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


module.exports = { fixture };
