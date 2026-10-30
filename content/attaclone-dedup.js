/* eslint-disable no-undef */
// Core logic for Attaclone-dedup.

Zotero.AttacloneDedup = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  _processing: false,
  _activePrefs: null,
  _unverifiedAttachments: 0,
  prefBranch: "extensions.attaclone-dedup.",
  // Track injected DOM nodes per window for clean removal.
  _addedElements: new WeakMap(),

  // ---- lifecycle ----------------------------------------------------------

  async init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._setDefaultPrefs();
    this._registerPrefPane();
    this.initialized = true;
    this._log("Initialized");
  },

  shutdown() {
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
    const value = this._activePrefs ? this._activePrefs[key] : Zotero.Prefs.get(this.prefBranch + key, true);
    if (key === "dryRun") return value !== false;
    if (key === "keepStrategy") return value === "newest" ? "newest" : "oldest";
    return value;
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

  // Only a content hash can identify a duplicate candidate. A filename and
  // size cannot establish identity when the file cannot be read.
  async _attachmentKey(attachment) {
    try {
      const hash = await attachment.attachmentHash;
      return typeof hash === "string" && /^[0-9a-f]{32}$/i.test(hash)
        ? "h:" + hash.toLowerCase() : null;
    } catch (e) {
      this._log("Hash unavailable for attachment " + attachment.id);
      return null;
    }
  },

  async _attachmentMeta(attachment) {
    let safetyKnown = true;
    let annotationCount = null;
    let tags = [];
    let hasNote = false;
    let embeddedAnnotations = false;
    let size = 0;
    let path = "";
    try { annotationCount = attachment.getAnnotations(true).length; }
    catch (e) { safetyKnown = false; }
    try { tags = attachment.getTags(); }
    catch (e) { safetyKnown = false; }
    try { hasNote = !!attachment.getNote().trim(); }
    catch (e) { safetyKnown = false; }
    try { embeddedAnnotations = await attachment.hasEmbeddedAnnotations(); }
    catch (e) { safetyKnown = false; }
    try {
      path = await attachment.getFilePathAsync();
      if (!path) throw new Error("File unavailable");
      const info = await IOUtils.stat(path);
      if (info.type !== "regular" || !Number.isFinite(info.size)) throw new Error("File unavailable");
      size = info.size;
    } catch (e) { safetyKnown = false; }
    return {
      id: attachment.id,
      key: await this._attachmentKey(attachment),
      filename: attachment.attachmentFilename || attachment.getDisplayTitle(),
      contentType: attachment.attachmentContentType || "",
      dateAdded: attachment.dateAdded, size, path, annotationCount,
      tagCount: tags.length, tags: tags.map(t => t.tag), hasNote,
      embeddedAnnotations, safetyKnown,
      linkMode: attachment.attachmentLinkMode,
    };
  },

  // Group an item's child attachments by comparison key. Returns array of
  // groups where each group has 2+ members (i.e. duplicate sets).
  async _findDuplicateGroups(item) {
    if (!item || !item.isRegularItem()) return [];
    const attachmentIDs = item.getAttachments();
    if (!attachmentIDs || attachmentIDs.length < 2) return [];

    const metas = [];
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      if (!att || !att.isFileAttachment()) continue;
      // Skip linked-URL attachments with no file.
      if (att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        continue;
      }
      const meta = await this._attachmentMeta(att);
      if (!meta.key) { this._unverifiedAttachments++; continue; }
      metas.push(meta);
    }

    const byKey = new Map();
    for (const m of metas) {
      if (!byKey.has(m.key)) byKey.set(m.key, []);
      byKey.get(m.key).push(m);
    }

    const groups = [];
    for (const [key, members] of byKey.entries()) {
      if (members.length >= 2) groups.push({ key, members });
    }
    return groups;
  },

  // ---- resolution ---------------------------------------------------------

  _canAutoResolve(group) {
    if (!group.key || !group.key.startsWith("h:") || group.members.length < 2) return false;
    const first = group.members[0];
    return group.members.every(m => m.key === group.key && m.safetyKnown &&
      m.annotationCount === 0 && !m.embeddedAnnotations && !m.hasNote && m.tagCount === 0 &&
      m.linkMode === first.linkMode && m.contentType === first.contentType && m.size === first.size);
  },

  _pickKeeper(members) {
    const time = m => Date.parse(String(m.dateAdded).replace(" ", "T") + "Z");
    if (!members.length || members.some(m => !Number.isFinite(time(m)))) {
      throw new Error("Cannot select a keeper with missing or invalid dates.");
    }
    const sorted = [...members].sort((a, b) => time(a) - time(b) || a.id - b.id);
    return this.getPref("keepStrategy") === "newest" ? sorted[sorted.length - 1] : sorted[0];
  },

  async _deleteAttachments(ids) {
    if (this.getPref("dryRun")) return;
    Zotero.DB.requireTransaction();
    for (const id of ids) {
      const attachment = Zotero.Items.get(id);
      if (!attachment || !attachment.isFileAttachment()) throw new Error("Attachment is unavailable.");
      // Erase removes files before a database rollback could restore them.
      // Keep removals reversible; legacy moveToTrash=false is no longer used.
      attachment.deleted = true;
      await attachment.save();
    }
  },

  async _resolveGroup(win, item, group, keepIDs, deleteIDs, mergeAnnotations = false, automatic = false) {
    const reviewed = new Set(group.members.map(m => m.id));
    const selected = [...keepIDs, ...deleteIDs];
    if (!keepIDs.length || selected.length !== reviewed.size ||
        new Set(selected).size !== selected.length || selected.some(id => !reviewed.has(id))) {
      throw new Error("Selection does not match the reviewed duplicate group.");
    }
    if (mergeAnnotations && keepIDs.length !== 1) throw new Error("Keep exactly one PDF to merge annotations.");
    if (!deleteIDs.length) return 0;
    if (this.getPref("dryRun")) {
      this._log("[DRY RUN] Would resolve " + deleteIDs.length + " duplicate attachment(s).");
      return 0;
    }

    await Zotero.DB.executeTransaction(async () => {
      const current = [];
      for (const old of group.members) {
        const attachment = Zotero.Items.get(old.id);
        if (!attachment || attachment.deleted || !attachment.isFileAttachment() ||
            attachment.parentItemID !== item.id || attachment.libraryID !== item.libraryID) {
          throw new Error("An attachment changed since the scan. Scan again before applying changes.");
        }
        const meta = await this._attachmentMeta(attachment);
        if (!meta.key || meta.key !== group.key || !meta.safetyKnown ||
            meta.annotationCount !== old.annotationCount || meta.hasNote !== old.hasNote ||
            JSON.stringify(meta.tags) !== JSON.stringify(old.tags) ||
            meta.embeddedAnnotations !== old.embeddedAnnotations || meta.size !== old.size ||
            meta.linkMode !== old.linkMode || meta.contentType !== old.contentType) {
          throw new Error("Attachment content or metadata changed, or could not be verified. Scan again.");
        }
        current.push(meta);
      }
      if (automatic && !this._canAutoResolve({ key: group.key, members: current })) {
        throw new Error("This group is no longer safe for automatic resolution.");
      }
      if (mergeAnnotations) await this._mergeAnnotations(keepIDs[0], deleteIDs);
      await this._deleteAttachments(deleteIDs);
    });
    return deleteIDs.length;
  },

  // Run detection + auto-resolution across a list of regular items.
  // Items needing manual review are queued and surfaced one dialog at a time.
  async processItems(items, win) {
    if (this._processing) throw new Error("An attachment scan is already in progress.");
    this._processing = true;
    try {
      this._activePrefs = Object.fromEntries(["dryRun", "keepStrategy"].map(
        key => [key, Zotero.Prefs.get(this.prefBranch + key, true)]));
      this._unverifiedAttachments = 0;
      return await this._processItems(items, win);
    } finally {
      this._processing = false;
      this._activePrefs = null;
    }
  },

  async _processItems(items, win) {
    const summary = {
      itemsScanned: 0,
      duplicatesFound: 0,
      autoResolved: 0,
      autoPlanned: 0,
      manualQueued: 0,
    };
    const manualQueue = [];

    for (const item of items) {
      if (!item || item.deleted || !item.isRegularItem()) continue;
      summary.itemsScanned++;
      const groups = await this._findDuplicateGroups(item);
      for (const group of groups) {
        summary.duplicatesFound += group.members.length - 1;
        if (this._canAutoResolve(group)) {
          const keeper = this._pickKeeper(group.members);
          const removeIDs = group.members
            .filter((m) => m.id !== keeper.id)
            .map((m) => m.id);
          summary.autoPlanned += removeIDs.length;
          const resolved = await this._resolveGroup(win, item, group, [keeper.id], removeIDs, false, true);
          summary.autoResolved += resolved;
          this._log(
            `Item ${item.id}: ${resolved} duplicate attachment(s) removed`
          );
        } else {
          summary.manualQueued++;
          manualQueue.push({ item, group });
        }
      }
    }

    // Handle manual cases sequentially.
    for (const entry of manualQueue) {
      await this._openManualDialog(win, entry.item, entry.group);
    }

    summary.unverifiedAttachments = this._unverifiedAttachments;
    this._showSummary(win, summary);
    return summary;
  },

  // ---- manual dialog ------------------------------------------------------

  async _openManualDialog(win, item, group) {
    const params = {
      itemTitle: item.getDisplayTitle(),
      members: group.members,
      result: null, // filled by dialog: { keepIDs: [], deleteIDs: [], skip: bool, mergeAnnotations: bool }
      DupMgr: this,
    };
    win.openDialog(
      "chrome://attaclone-dedup/content/manualResolve.xhtml",
      "attaclone-dedup-manual",
      "chrome,modal,centerscreen,resizable=yes",
      params
    );
    if (!params.result || params.result.skip) {
      this._log("Manual dialog skipped for item " + item.id);
      return;
    }
    const { deleteIDs, keepIDs, mergeAnnotations } = params.result;
    const removed = await this._resolveGroup(win, item, group, keepIDs, deleteIDs, mergeAnnotations);
    this._log("Manual resolution removed " + removed + " attachment(s).");
  },

  // Move existing annotation objects so their identity and links are preserved.
  async _mergeAnnotations(keepID, deleteIDs) {
    if (this.getPref("dryRun")) return;
    Zotero.DB.requireTransaction();
    const keeper = Zotero.Items.get(keepID);
    if (!keeper || !keeper.isPDFAttachment()) throw new Error("Annotation merging requires a PDF keeper.");
    for (const id of deleteIDs) {
      const source = Zotero.Items.get(id);
      if (!source || !source.isPDFAttachment()) throw new Error("Annotation merging requires PDF sources.");
      for (const annotation of source.getAnnotations(true)) {
        if (annotation.annotationIsExternal) {
          throw new Error("Embedded annotations cannot be moved. Keep the original PDF.");
        }
        annotation.parentItemID = keeper.id;
        await annotation.save();
      }
    }
  },

  // ---- summary ------------------------------------------------------------

  _showSummary(win, s) {
    const ps = Services.prompt;
    const dryNote = this.getPref("dryRun")
      ? "\n\n(DRY RUN — no changes were made.)"
      : "";
    const msg =
      `Items scanned: ${s.itemsScanned}\n` +
      `Duplicate attachments found: ${s.duplicatesFound}\n` +
      `Auto-resolution candidates: ${s.autoPlanned}\n` +
      `Auto-resolved: ${s.autoResolved}\n` +
      `Attachments without a readable hash: ${s.unverifiedAttachments}\n` +
      `Sent to manual review: ${s.manualQueued}` +
      dryNote;
    ps.alert(win, "Attaclone-dedup", msg);
  },

  async _runFromMenu(win, operation) {
    try { await operation(); }
    catch (error) {
      this._log("Scan stopped: " + error);
      Services.prompt.alert(win, "Attaclone-dedup", "Scan stopped: " + error.message +
        "\nThe scan did not finish. Review any groups already completed.");
    }
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
    const items = (await Zotero.Items.getAll(libraryID, true, false)).filter(i => i.isRegularItem());

    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("Scanning for duplicate attachments…");
    pw.show();
    try {
      await this.processItems(items, win);
    } finally {
      pw.close();
    }
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
      itemEntry.addEventListener("command", () => this._runFromMenu(win, () => this.scanSelectedItems(win)));
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
      colEntry.addEventListener("command", () => this._runFromMenu(win, () => this.scanCollection(win)));
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
      toolsEntry.addEventListener("command", () => this._runFromMenu(win, () => this.scanLibrary(win)));
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
