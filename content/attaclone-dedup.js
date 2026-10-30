/* eslint-disable no-undef */
// Core logic for Attaclone-dedup.

Zotero.AttacloneDedup = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  _stopping: false,
  prefBranch: "extensions.attaclone-dedup.",
  // Track injected DOM nodes per window for clean removal.
  _addedElements: new WeakMap(),
  _scanWarnings: [],

  // ---- lifecycle ----------------------------------------------------------

  async init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._stopping = false;
    this._setDefaultPrefs();
    this._registerPrefPane();
    this.initialized = true;
    this._log("Initialized");
  },

  shutdown() {
    this._stopping = true;
    this.initialized = false;
  },

  _log(msg) {
    Zotero.debug("Attaclone-dedup: " + msg);
  },

  _setDefaultPrefs() {
    const defaults = {
      dryRun: true,
      keepStrategy: "oldest", // oldest | newest
    };
    for (const [key, val] of Object.entries(defaults)) {
      const full = this.prefBranch + key;
      if (Zotero.Prefs.get(full, true) === undefined) {
        Zotero.Prefs.set(full, val, true);
      }
    }
  },

  getPref(key) {
    return Zotero.Prefs.get(this.prefBranch + key, true);
  },

  _registerPrefPane() {
    try {
      Zotero.PreferencePanes.register({
        pluginID: this.id,
        src: this.rootURI + "content/preferences.xhtml",
        label: "Attaclone-dedup",
        image: this.rootURI + "content/icons/icon.png",
      });
    } catch (e) {
      this._log("Pref pane registration failed: " + e);
    }
  },

  _str(name) {
    try {
      return Zotero
        .getMainWindow()
        .document.getElementById("attaclone-dedup-strings")
        ?.getString(name) || name;
    } catch (e) {
      return name;
    }
  },

  // ---- detection ----------------------------------------------------------

  // Hashing failures are not evidence of equality. Never group by name/size.
  async _attachmentKey(attachment) {
    const path = await attachment.getFilePathAsync();
    if (!path) throw new Error("Attachment file is missing");
    const before = await IOUtils.stat(path);
    if (before.type !== "regular" || before.size <= 0) {
      throw new Error("Attachment is not a nonempty regular file");
    }
    const hash = await IOUtils.computeHexDigest(path, "sha256");
    const after = await IOUtils.stat(path);
    if (!/^[a-f0-9]{64}$/i.test(hash) || before.size !== after.size
        || before.lastModified !== after.lastModified) {
      throw new Error("Attachment changed while hashing or hash was invalid");
    }
    return { key: "sha256:" + hash.toLowerCase(), path, size: after.size,
      lastModified: after.lastModified };
  },

  async _attachmentMeta(attachment) {
    if (!attachment || attachment.deleted || !attachment.isFileAttachment()) {
      throw new Error("Attachment is unavailable or deleted");
    }
    await attachment.loadAllData();
    if (!/^[A-Z0-9]{8}$/.test(attachment.key || "")) throw new Error("Attachment identity is unavailable");
    // A main-file digest cannot prove equality of a multi-file HTML snapshot.
    if (!attachment.isPDFAttachment()) throw new Error("Only PDF attachments are supported");
    // Retargeting links in other records needs a separate reviewed migration.
    // Preserve both outgoing and incoming relations and links in live/trashed notes.
    const relations = attachment.getRelations();
    if (Object.values(relations).some((values) => values.length)
        || (await Zotero.Relations.getByObject("item", Zotero.URI.getItemURI(attachment))).length) {
      throw new Error("Attachment has related/linked records; keep it for manual review");
    }
    if (await Zotero.DB.valueQueryAsync(
      "SELECT itemNotes.itemID FROM itemNotes JOIN items USING (itemID) "
        + "WHERE items.libraryID=? AND itemNotes.note LIKE ? LIMIT 1",
      [attachment.libraryID, "%" + attachment.key + "%"])) {
      throw new Error("A note references this attachment; keep it for manual review");
    }
    // Include trashed annotations: recoverable work also prevents automatic
    // resolution. Failed inspection aborts this attachment.
    const annotations = attachment.getAnnotations(true);
    if (annotations.some((a) => a.annotationIsExternal)) {
      throw new Error("External annotations cannot be transferred safely");
    }
    if (annotations.some((a) => a.hasChanged())) {
      throw new Error("An annotation has pending edits; save or discard them and scan again");
    }
    const tags = attachment.getTags();
    const note = attachment.getNote();
    const file = await this._attachmentKey(attachment);
    return {
      id: attachment.id, libraryID: attachment.libraryID, parentID: attachment.parentID,
      ...file,
      filename: attachment.attachmentFilename || attachment.getDisplayTitle(),
      contentType: attachment.attachmentContentType || "",
      dateAdded: attachment.dateAdded, dateModified: attachment.dateModified,
      annotationCount: annotations.length,
      annotationIDs: annotations.map((a) => a.id).sort((a, b) => a - b),
      annotationState: annotations.map((a) => [a.id, a.dateModified, a.deleted]).sort((a, b) => a[0] - b[0]),
      tagCount: tags.length, tags: tags.map((t) => t.tag).sort(),
      note, hasNote: !!note.trim(), linkMode: attachment.attachmentLinkMode,
    };
  },

  async _findDuplicateGroups(item) {
    if (!item || item.deleted || !item.isRegularItem()) return [];
    await item.loadAllData();
    const byKey = new Map();
    for (const id of item.getAttachments()) {
      const attachment = Zotero.Items.get(id);
      if (!attachment || !attachment.isFileAttachment()) continue;
      try {
        const meta = await this._attachmentMeta(attachment);
        if (meta.parentID !== item.id || meta.libraryID !== item.libraryID) {
          throw new Error("Attachment parent/library changed");
        }
        if (!byKey.has(meta.key)) byKey.set(meta.key, []);
        byKey.get(meta.key).push(meta);
      } catch (error) {
        this._scanWarnings.push(`Attachment ${id}: ${error.message || error}`);
      }
    }
    return [...byKey.entries()].filter(([, members]) => members.length > 1)
      .map(([key, members]) => ({ key, members }));
  },

  _canAutoResolve(group) {
    return /^sha256:[a-f0-9]{64}$/.test(group.key) && group.members.length > 1
      && group.members.every((m) => m.key === group.key && m.annotationCount === 0
        && !m.hasNote && m.tagCount === 0);
  },

  _pickKeeper(members) {
    const sorted = [...members].sort((a, b) => {
      const difference = Date.parse(a.dateAdded) - Date.parse(b.dateAdded);
      return (Number.isFinite(difference) && difference) || a.id - b.id;
    });
    return this.getPref("keepStrategy") === "newest" ? sorted.at(-1) : sorted[0];
  },

  _assertEditable(item) {
    if (this._stopping) throw new Error("Plugin is shutting down; the operation was cancelled");
    if (this._recoveryRequired) throw new Error("Recovery failed; restart Zotero before another duplicate operation");
    const library = Zotero.Libraries.get(item.libraryID);
    if (item.deleted || !item.isEditable() || !library?.editable || !library.filesEditable) {
      throw new Error("Library/attachment is read-only, unavailable, or deleted");
    }
    if (item.hasChanged()) throw new Error("Item has pending edits; save or discard them and scan again");
  },

  _assertApplyAllowed() {
    if (this._stopping || this.getPref("dryRun") !== false) {
      throw new Error("Operation cancelled because the plugin stopped or dry run was enabled");
    }
  },

  async _revalidate(item, group) {
    this._assertEditable(item);
    for (const previous of group.members) {
      const attachment = Zotero.Items.get(previous.id);
      if (!attachment) throw new Error("Attachment was removed after the scan");
      this._assertEditable(attachment);
      const current = await this._attachmentMeta(attachment);
      for (const field of ["libraryID", "parentID", "key", "path", "size", "lastModified",
        "dateModified", "note", "linkMode", "contentType"]) {
        if (current[field] !== previous[field]) throw new Error(`Attachment ${previous.id} changed: ${field}`);
      }
      if (JSON.stringify(current.annotationIDs) !== JSON.stringify(previous.annotationIDs)
          || JSON.stringify(current.annotationState) !== JSON.stringify(previous.annotationState)
          || JSON.stringify(current.tags) !== JSON.stringify(previous.tags)) {
        throw new Error(`Attachment ${previous.id} gained or lost annotations/tags`);
      }
      if (current.parentID !== item.id || current.libraryID !== item.libraryID || current.key !== group.key) {
        throw new Error("Attachment content/parent/library does not match the reviewed group");
      }
    }
    this._assertEditable(item);
  },

  async _resolveGroup(item, group, { keepIDs, deleteIDs, mergeAnnotations = false }) {
    const dryRun = this._runDryRun ?? (this.getPref("dryRun") !== false);
    const members = new Set(group.members.map((m) => m.id));
    const all = [...keepIDs, ...deleteIDs];
    if (!keepIDs.length || new Set(all).size !== all.length || all.length !== members.size
        || all.some((id) => !members.has(id))) throw new Error("Invalid duplicate selection");
    if (!deleteIDs.length) return { changed: 0, planned: 0 };
    if (mergeAnnotations && keepIDs.length !== 1) throw new Error("Annotation transfer requires exactly one keeper");
    if (!/^sha256:[a-f0-9]{64}$/.test(group.key)) throw new Error("Content equality is not verified");
    await this._revalidate(item, group);
    if (dryRun) {
      this._log(`[DRY RUN] Would move ${deleteIDs.length} attachment(s) to Trash`);
      return { changed: 0, planned: deleteIDs.length };
    }
    try {
      await Zotero.DB.executeTransaction(async () => {
        // Metadata and file equality are checked again at the mutation boundary.
        await this._revalidate(item, group);
        this._assertApplyAllowed();
        const keeper = Zotero.Items.get(keepIDs[0]);
        for (const id of deleteIDs) {
          this._assertApplyAllowed();
          const attachment = Zotero.Items.get(id);
          if (mergeAnnotations) {
            // Native transfer preserves annotation identities. Referencing notes
            // and relations were excluded above, so no link rewriting is needed.
            // Any failure rejects the transaction before sources can be trashed.
            await Zotero.Items.moveChildItems(attachment, keeper, { includeTrashed: true });
            this._assertApplyAllowed();
          }
          attachment.deleted = true;
          await attachment.save();
          this._assertApplyAllowed();
        }
      });
    } catch (error) {
      // Rollback restores the database; reload objects whose in-memory state may
      // have changed before a save failed. Preserve the original failure.
      const affectedIDs = new Set(group.members.flatMap((previous) => [previous.id, ...previous.annotationIDs]));
      let reloadFailed = false;
      for (const id of affectedIDs) {
        const affected = Zotero.Items.get(id);
        if (affected) {
          try { await affected.reload(undefined, true); } catch (reloadError) {
            reloadFailed = true;
            Zotero.logError(reloadError);
          }
        }
      }
      if (reloadFailed) {
        this._recoveryRequired = true;
        throw new Error("Database transaction failed and cached items could not be reloaded; restart Zotero before continuing");
      }
      throw error;
    }
    return { changed: deleteIDs.length, planned: 0 };
  },

  async processItems(items, win) {
    if (this._running) throw new Error("A duplicate scan is already running");
    if (this._stopping) throw new Error("Plugin is shutting down");
    this._running = true;
    this._runDryRun = this.getPref("dryRun") !== false;
    this._scanWarnings = [];
    const summary = { itemsScanned: 0, duplicatesFound: 0, autoResolved: 0,
      manualResolved: 0, planned: 0, manualQueued: 0, failed: 0 };
    try {
      const manualQueue = [];
      for (const item of items) {
        if (this._stopping) break;
        if (!item || item.deleted || !item.isRegularItem()) continue;
        summary.itemsScanned++;
        try {
          const groups = await this._findDuplicateGroups(item);
          for (const group of groups) {
            summary.duplicatesFound += group.members.length - 1;
            if (this._canAutoResolve(group)) {
              const keeper = this._pickKeeper(group.members);
              const result = await this._resolveGroup(item, group, {
                keepIDs: [keeper.id], deleteIDs: group.members.filter((m) => m.id !== keeper.id).map((m) => m.id),
              });
              summary.autoResolved += result.changed;
              summary.planned += result.planned;
            } else {
              summary.manualQueued++;
              manualQueue.push({ item, group });
            }
          }
        } catch (error) {
          summary.failed++;
          this._scanWarnings.push(`Item ${item.id}: ${error.message || error}`);
        }
      }
      for (const { item, group } of manualQueue) {
        if (this._stopping) break;
        try {
          const result = await this._openManualDialog(win, item, group);
          summary.manualResolved += result.changed;
          summary.planned += result.planned;
        } catch (error) {
          summary.failed++;
          this._scanWarnings.push(`Item ${item.id}: ${error.message || error}`);
        }
      }
      summary.warnings = this._scanWarnings.length;
      if (!this._stopping) this._showSummary(win, summary);
      return summary;
    } finally {
      this._running = false;
      delete this._runDryRun;
    }
  },

  async _openManualDialog(win, item, group) {
    const params = { itemTitle: item.getDisplayTitle(), members: group.members,
      dryRun: this._runDryRun ?? (this.getPref("dryRun") !== false), result: null };
    win.openDialog("chrome://attaclone-dedup/content/manualResolve.xhtml",
      "attaclone-dedup-manual", "chrome,modal,centerscreen,resizable=yes", params);
    if (!params.result || params.result.skip) return { changed: 0, planned: 0 };
    return this._resolveGroup(item, group, params.result);
  },

  _showSummary(win, summary) {
    let message = `Items scanned: ${summary.itemsScanned}\n` +
      `Verified duplicate attachments: ${summary.duplicatesFound}\n` +
      `Moved to Trash automatically: ${summary.autoResolved}\n` +
      `Moved to Trash after review: ${summary.manualResolved}\n` +
      `Previewed, unchanged: ${summary.planned}\n` +
      `Manual groups: ${summary.manualQueued}\n` +
      `Failed groups/items: ${summary.failed}\n` +
      `Unreadable/changed items and other warnings: ${summary.warnings}`;
    if (this._runDryRun ?? (this.getPref("dryRun") !== false)) message += "\n\nDRY RUN: no library changes were made.";
    if (this._scanWarnings.length) message += "\n\n" + this._scanWarnings.slice(0, 10).join("\n");
    Services.prompt.alert(win, "Attaclone-dedup", message);
  },

  // ---- entry points -------------------------------------------------------

  async scanSelectedItems(win) {
    const items = win.ZoteroPane.getSelectedItems();
    const regular = items.filter((i) => i.isRegularItem());
    if (!regular.length) {
      Services.prompt.alert(
        win,
        "Attaclone-dedup",
        "No regular items selected."
      );
      return;
    }
    await this.processItems(regular, win);
  },

  async scanCollection(win) {
    const collection = win.ZoteroPane.getSelectedCollection();
    if (!collection) {
      Services.prompt.alert(
        win,
        "Attaclone-dedup",
        "No collection selected."
      );
      return;
    }
    const items = collection
      .getChildItems(false, false)
      .filter((i) => i.isRegularItem());
    await this.processItems(items, win);
  },

  async scanLibrary(win) {
    const ps = Services.prompt;
    const confirmed = ps.confirm(
      win,
      "Attaclone-dedup",
      "Scan the entire library for duplicate attachments? This may take a while for large libraries."
    );
    if (!confirmed) return;

    const libraryID = win.ZoteroPane.getSelectedLibraryID();
    const library = Zotero.Libraries.get(libraryID);
    await library.waitForDataLoad("item");
    const items = (await Zotero.Items.getAll(libraryID, true)).filter((i) => i.isRegularItem());

    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Scanning for duplicate attachments…");
    pw.show();
    try {
      await this.processItems(items, win);
    } finally {
      pw.close();
    }
  },

  async _runUI(operation, win) {
    try { await operation(); }
    catch (error) { Services.prompt.alert(win, "Attaclone-dedup", "Scan stopped: " + (error.message || error)); }
  },

  // ---- UI injection -------------------------------------------------------

  addToWindow(win) {
    if (!win.ZoteroPane || this._addedElements.has(win)) return;
    const doc = win.document;

    // Load the localized string bundle into this window once.
    if (!doc.getElementById("attaclone-dedup-strings")) {
      const stringBundle = doc.createXULElement("stringbundle");
      stringBundle.id = "attaclone-dedup-strings";
      stringBundle.setAttribute(
        "src",
        "chrome://attaclone-dedup/locale/attaclone-dedup.properties"
      );
      doc.documentElement.appendChild(stringBundle);
    }

    const created = [];

    // Item context menu entries.
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (itemMenu) {
      const sep = doc.createXULElement("menuseparator");
      sep.id = "attaclone-dedup-item-sep";
      itemMenu.appendChild(sep);
      created.push(sep);

      const itemEntry = doc.createXULElement("menuitem");
      itemEntry.id = "attaclone-dedup-item-menuitem";
      itemEntry.setAttribute("label", "Check for duplicate attachments");
      itemEntry.addEventListener("command", () => this._runUI(() => this.scanSelectedItems(win), win));
      itemMenu.appendChild(itemEntry);
      created.push(itemEntry);
    }

    // Collection context menu entry.
    const collectionMenu = doc.getElementById("zotero-collectionmenu");
    if (collectionMenu) {
      const colEntry = doc.createXULElement("menuitem");
      colEntry.id = "attaclone-dedup-collection-menuitem";
      colEntry.setAttribute(
        "label",
        "Scan collection for duplicate attachments"
      );
      colEntry.addEventListener("command", () => this._runUI(() => this.scanCollection(win), win));
      collectionMenu.appendChild(colEntry);
      created.push(colEntry);
    }

    // Tools menu entry (full library scan).
    const toolsPopup = doc.getElementById("menu_ToolsPopup");
    if (toolsPopup) {
      const toolsEntry = doc.createXULElement("menuitem");
      toolsEntry.id = "attaclone-dedup-tools-menuitem";
      toolsEntry.setAttribute(
        "label",
        "Scan entire library for duplicate attachments"
      );
      toolsEntry.addEventListener("command", () => this._runUI(() => this.scanLibrary(win), win));
      toolsPopup.appendChild(toolsEntry);
      created.push(toolsEntry);
    }

    this._addedElements.set(win, created);
  },

  removeFromWindow(win) {
    const created = this._addedElements.get(win);
    if (created) {
      for (const el of created) {
        el?.remove();
      }
      this._addedElements.delete(win);
    }
    const bundle = win.document.getElementById(
      "attaclone-dedup-strings"
    );
    bundle?.remove();
  },
};
