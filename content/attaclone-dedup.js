/* eslint-disable no-undef */
// Core logic for Attaclone-dedup.

Zotero.AttacloneDedup = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
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
      dryRun: false,
      keepStrategy: "oldest", // oldest | newest
      moveToTrash: true, // false = permanent erase (discouraged)
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

  // Compute a comparison key for an attachment. Prefers content hash;
  // falls back to filename + filesize when hash is unavailable.
  async _attachmentKey(attachment) {
    try {
      const hash = await attachment.attachmentHash; // md5 of file contents
      if (hash) return "h:" + hash;
    } catch (e) {
      this._log("Hash failed for item " + attachment.id + ": " + e);
    }
    // Fallback
    let name = attachment.attachmentFilename || "";
    let size = 0;
    try {
      const path = await attachment.getFilePathAsync();
      if (path) {
        const info = await IOUtils.stat(path);
        size = info.size || 0;
      }
    } catch (e) {
      this._log("Stat failed for item " + attachment.id + ": " + e);
    }
    return "f:" + name + ":" + size;
  },

  // Returns metadata used to decide whether auto-resolution is safe.
  async _attachmentMeta(attachment) {
    let annotationCount = 0;
    try {
      if (attachment.isPDFAttachment && attachment.isPDFAttachment()) {
        annotationCount = attachment.getAnnotations
          ? attachment.getAnnotations().length
          : 0;
      }
    } catch (e) {
      annotationCount = 0;
    }
    const tags = attachment.getTags ? attachment.getTags() : [];
    let note = "";
    try {
      note = attachment.getNote ? attachment.getNote() : "";
    } catch (e) {
      note = "";
    }
    let size = 0;
    let path = "";
    try {
      path = await attachment.getFilePathAsync();
      if (path) {
        const info = await IOUtils.stat(path);
        size = info.size || 0;
      }
    } catch (e) {
      /* linked / missing file */
    }
    return {
      id: attachment.id,
      key: await this._attachmentKey(attachment),
      filename: attachment.attachmentFilename || attachment.getDisplayTitle(),
      contentType: attachment.attachmentContentType || "",
      dateAdded: attachment.dateAdded,
      size,
      path,
      annotationCount,
      tagCount: tags.length,
      tags: tags.map((t) => t.tag),
      hasNote: !!(note && note.trim().length),
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
      metas.push(await this._attachmentMeta(att));
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

  // Decide whether a duplicate group can be auto-resolved safely.
  // Safe = same content key AND at most one member carries unique
  // annotations/notes/tags (the rest are "bare" copies).
  _canAutoResolve(group) {
    const enriched = group.members.filter(
      (m) => m.annotationCount > 0 || m.hasNote || m.tagCount > 0
    );
    // Only auto-resolve when zero members are enriched: pure byte-identical
    // bare copies. Anything with annotations/notes/tags goes to manual.
    return enriched.length === 0;
  },

  _pickKeeper(members) {
    const strategy = this.getPref("keepStrategy");
    const sorted = [...members].sort((a, b) => {
      const da = new Date(a.dateAdded).getTime();
      const db = new Date(b.dateAdded).getTime();
      return da - db;
    });
    return strategy === "newest" ? sorted[sorted.length - 1] : sorted[0];
  },

  async _deleteAttachments(ids) {
    const dryRun = this.getPref("dryRun");
    if (dryRun) {
      this._log("[DRY RUN] Would delete attachment IDs: " + ids.join(", "));
      return;
    }
    const toTrash = this.getPref("moveToTrash");
    for (const id of ids) {
      const att = Zotero.Items.get(id);
      if (!att) continue;
      if (toTrash) {
        att.deleted = true;
        await att.saveTx();
      } else {
        await att.eraseTx();
      }
    }
  },

  // Run detection + auto-resolution across a list of regular items.
  // Items needing manual review are queued and surfaced one dialog at a time.
  async processItems(items, win) {
    const summary = {
      itemsScanned: 0,
      duplicatesFound: 0,
      autoResolved: 0,
      manualQueued: 0,
    };
    const manualQueue = [];

    for (const item of items) {
      if (!item.isRegularItem()) continue;
      summary.itemsScanned++;
      const groups = await this._findDuplicateGroups(item);
      for (const group of groups) {
        summary.duplicatesFound += group.members.length - 1;
        if (this._canAutoResolve(group)) {
          const keeper = this._pickKeeper(group.members);
          const removeIDs = group.members
            .filter((m) => m.id !== keeper.id)
            .map((m) => m.id);
          await this._deleteAttachments(removeIDs);
          summary.autoResolved += removeIDs.length;
          this._log(
            `Auto-resolved item ${item.id}: kept ${keeper.id}, removed ${removeIDs.join(", ")}`
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
    if (mergeAnnotations && keepIDs.length === 1) {
      await this._mergeAnnotations(keepIDs[0], deleteIDs);
    }
    await this._deleteAttachments(deleteIDs);
    this._log(
      `Manual resolve item ${item.id}: kept ${keepIDs.join(",")}, deleted ${deleteIDs.join(",")}`
    );
  },

  // Move annotations from soon-to-be-deleted PDFs onto the kept PDF.
  async _mergeAnnotations(keepID, deleteIDs) {
    const keeper = Zotero.Items.get(keepID);
    if (!keeper || !keeper.isPDFAttachment || !keeper.isPDFAttachment()) return;
    for (const did of deleteIDs) {
      const src = Zotero.Items.get(did);
      if (!src || !src.getAnnotations) continue;
      const annotations = src.getAnnotations();
      for (const ann of annotations) {
        try {
          const newAnn = ann.clone(keeper.libraryID);
          newAnn.parentID = keeper.id;
          await newAnn.saveTx();
        } catch (e) {
          this._log("Annotation merge failed: " + e);
        }
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
      `Auto-resolved: ${s.autoResolved}\n` +
      `Sent to manual review: ${s.manualQueued}` +
      dryNote;
    ps.alert(win, "Attaclone-dedup", msg);
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
    const itemIDs = await Zotero.Items.getAll(libraryID, true);
    const items = Zotero.Items.get(itemIDs).filter((i) =>
      i.isRegularItem()
    );

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
    if (!win.ZoteroPane) return;
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
      itemEntry.addEventListener("command", () => this.scanSelectedItems(win));
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
      colEntry.addEventListener("command", () => this.scanCollection(win));
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
      toolsEntry.addEventListener("command", () => this.scanLibrary(win));
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
