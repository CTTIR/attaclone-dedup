# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Missing hashes and unreadable annotations/notes no longer authorize automatic
  removal; embedded PDF annotations prevent automatic resolution.
- Dry run prevents annotation writes as well as attachment removals.
- Group changes are revalidated and transactional; failures propagate instead
  of deleting sources after a failed annotation move.
- Library scans consume item objects correctly; bootstrap supplies IOUtils;
  simultaneous scans are refused and menu errors are surfaced.

### Changed

- Removals now use Trash only. The old permanent-erase preference is preserved
  but ignored. New installations default to dry run.
- Annotation merging moves existing internal annotation objects and requires
  one keeper. Package builds are reproducible and write to `dist/`.

Host qualification is required before release.


## [1.0.0] - 2026-05-28

### Added
- Content-hash based detection of duplicate file attachments within Zotero items, with filename + size fallback.
- Automatic resolution of byte-identical bare duplicates (no annotations, notes, or tags).
- Manual-resolve dialog for ambiguous duplicate sets, with an optional annotation-merge step that transfers annotations from discarded PDFs onto the kept PDF.
- Three scan scopes: selected items, current collection, and entire library.
- Preferences pane: dry-run mode, keep-strategy (oldest / newest), move-to-trash vs. permanent erase.
- Localization scaffold (`en-US`).

[Unreleased]: https://github.com/CTTIR/attaclone-dedup/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CTTIR/attaclone-dedup/releases/tag/v1.0.0
