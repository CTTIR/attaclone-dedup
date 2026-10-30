# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 1.0.1 safety revision (2026-10-30)
- Target Zotero 10.0.x; update library-scan API usage and remove the unavailable update feed.
- Verify SHA-256 equality only; missing/unreadable/empty files are never inferred duplicates.
- Default new installations to dry run and remove permanent erase support.
- Guard metadata, permissions, pending edits and content at the mutation boundary.
- Transfer annotations with native identity-preserving operations and trash in one transaction.
- Restrict matching to PDFs; preserve related/referenced attachments and external annotations.
- Reload annotation caches after rollback and block further changes if cache recovery fails.
- Make dry run write-free, keep manual copies by default, report failures accurately, and serialize scans.
- Keep preview mode fixed for the scan; cancel pending writes on shutdown or enabling dry run.
- Add synthetic regression tests, deterministic package construction/verification, and safety CI.
- Document Workbench handoff and distinguish historical archive citation from this unpublished revision.

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
