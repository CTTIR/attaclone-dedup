/* eslint-disable no-undef */
// Logic for the manual duplicate-resolution dialog.

const { Services } = ChromeUtils.importESModule(
  "resource://gre/modules/Services.sys.mjs"
);

var DupResolve = {
  params: null,

  onLoad() {
    this.params = window.arguments[0];
    const doc = document;

    doc.getElementById("dup-item-title").textContent =
      "Item: " + (this.params.itemTitle || "(untitled)");

    const list = doc.getElementById("dup-list");
    const members = this.params.members;

    // Default keeper: oldest by dateAdded.
    const sorted = [...members].sort(
      (a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)
    );
    const defaultKeepID = sorted[0].id;

    for (const m of members) {
      const row = doc.createXULElement("vbox");
      row.className = "dup-row";
      row.style.border = "1px solid #ccc";
      row.style.borderRadius = "6px";
      row.style.padding = "8px";
      row.style.marginBottom = "8px";

      const header = doc.createXULElement("hbox");
      header.align = "center";

      const keepCheck = doc.createXULElement("checkbox");
      keepCheck.setAttribute("label", "Keep");
      keepCheck.id = "keep-" + m.id;
      keepCheck.checked = m.id === defaultKeepID;
      header.appendChild(keepCheck);

      const name = doc.createXULElement("description");
      name.style.fontWeight = "bold";
      name.style.marginLeft = "8px";
      name.textContent = m.filename || "(no filename)";
      header.appendChild(name);

      row.appendChild(header);

      const detail = doc.createXULElement("description");
      detail.style.color = "#555";
      detail.style.fontSize = "0.9em";
      const sizeKB = m.size ? (m.size / 1024).toFixed(1) + " KB" : "unknown size";
      const annText =
        m.annotationCount > 0 ? `, ${m.annotationCount} annotation(s)` : "";
      const tagText = m.tagCount > 0 ? `, tags: ${m.tags.join(", ")}` : "";
      const noteText = m.hasNote ? ", has note" : "";
      detail.textContent =
        `${m.contentType || "unknown type"} · ${sizeKB} · ` +
        `added ${new Date(m.dateAdded).toLocaleString()}` +
        annText +
        tagText +
        noteText;
      row.appendChild(detail);

      if (m.path) {
        const pathDesc = doc.createXULElement("description");
        pathDesc.style.color = "#999";
        pathDesc.style.fontSize = "0.8em";
        pathDesc.textContent = m.path;
        row.appendChild(pathDesc);
      }

      list.appendChild(row);
    }
  },

  _collectKeepIDs() {
    const keep = [];
    for (const m of this.params.members) {
      const cb = document.getElementById("keep-" + m.id);
      if (cb && cb.checked) keep.push(m.id);
    }
    return keep;
  },

  onAccept() {
    const keepIDs = this._collectKeepIDs();
    if (keepIDs.length === 0) {
      Services.prompt.alert(
        window,
        "Attaclone-dedup",
        "You must keep at least one attachment. Use 'Skip this item' to make no changes."
      );
      return false; // block dialog close
    }
    const deleteIDs = this.params.members
      .map((m) => m.id)
      .filter((id) => !keepIDs.includes(id));

    const merge = document.getElementById("dup-merge-annotations").checked;

    this.params.result = {
      skip: false,
      keepIDs,
      deleteIDs,
      mergeAnnotations: merge,
    };
    return true;
  },

  onCancel() {
    this.params.result = { skip: true };
    return true;
  },
};
