# Attaclone-dedup

A Zotero plugin that detects and manages duplicate file attachments within Zotero items.

Large Zotero libraries accumulate duplicate PDFs attached to the same parent item — usually because the same file was imported through multiple routes (browser connector, manual drop, snapshot). Attaclone-dedup compares attachments by content hash, automatically removes byte-identical *bare* copies (no annotations, notes, or tags), and queues the ambiguous cases for a manual review dialog so you never lose annotation work without confirming.

## Features

- **Content-hash matching** — duplicates are identified by MD5 of file contents, with filename + size as a fallback when the hash is unavailable.
- **Safe auto-resolution** — only byte-identical copies with no annotations, notes, or tags are removed without asking.
- **Manual review dialog** — when at least one duplicate carries annotations, notes, or tags, you choose which to keep and optionally **merge annotations** from the discarded PDFs onto the keeper.
- **Three scan scopes** —
  - *Item* context menu → "Check for duplicate attachments"
  - *Collection* context menu → "Scan collection for duplicate attachments"
  - *Tools* menu → "Scan entire library for duplicate attachments"
- **Configurable** — keep oldest vs. newest, move to trash vs. permanent erase, dry-run mode. Configure under *Edit → Settings → Attaclone-dedup*.

## Compatibility

Zotero 7 and later (`strict_min_version` 6.999, `strict_max_version` 9.\*).

## Installation

1. Download `attaclone-dedup-<version>.xpi` from the [Releases page](https://github.com/CTTIR/attaclone-dedup/releases).
2. In Zotero, open **Tools → Plugins**.
3. Click the gear icon → **Install Plugin From File…**, then select the downloaded `.xpi`.
4. Restart Zotero if prompted.

## Usage

1. Select one or more items in your library, or open a collection.
2. Right-click and choose **Check for duplicate attachments** (item menu) or **Scan collection for duplicate attachments** (collection menu). For a full library sweep, use **Tools → Scan entire library for duplicate attachments**.
3. Byte-identical bare duplicates are removed automatically (subject to your *keep* preference and dry-run setting).
4. Anything ambiguous opens the manual-resolve dialog: choose which attachments to keep, optionally tick *merge annotations*, and confirm.
5. A summary dialog reports how many items were scanned, duplicates found, auto-resolved, and sent to manual review.

### Recommended first run

Enable **Dry run** in preferences before your first full-library scan. Attaclone-dedup will log what it *would* delete without touching the library.

## Documentation

A full walkthrough vignette is published at <https://cttir.github.io/attaclone-dedup/>.

## How to cite this plugin

If Attaclone-dedup contributes to your research workflow, please cite it.

**BibTeX**

```bibtex
@software{heller_attaclone_dedup_2026,
  author  = {Heller, Raban},
  title   = {{Attaclone-dedup}: A Zotero plugin for detecting and managing duplicate file attachments},
  year    = {2026},
  version = {1.0.0},
  url     = {https://github.com/CTTIR/attaclone-dedup}
}
```

**APA**

> Heller, R. (2026). *Attaclone-dedup: A Zotero plugin for detecting and managing duplicate file attachments* (Version 1.0.0) [Computer software]. https://github.com/CTTIR/attaclone-dedup

> [!NOTE]
> A DOI has not been minted yet. To create one, archive a release on [Zenodo](https://zenodo.org/account/settings/github/) — enable the repository, cut a GitHub release, and Zenodo will issue a DOI automatically. Add the resulting `doi: 10.5281/zenodo.XXXXXXX` line to `CITATION.cff` and the `doi = {…}` field to the BibTeX block above.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests welcome on the [issue tracker](https://github.com/CTTIR/attaclone-dedup/issues).

## License

Released under the [MIT License](LICENSE).
