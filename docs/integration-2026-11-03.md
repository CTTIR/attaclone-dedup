# Maintenance integration — 3 November 2026

This record reconciles the earlier audit branch (`50ef8b47`) with the newer
Zotero 10 safety revision already on `main` (`0c06451d`). Both histories are
preserved. The candidate remains version 1.0.1 for Zotero 10.0.x; publishing
source does not publish a plugin release or qualify a live Zotero profile.

## Preserved safety behavior

Only nonempty PDFs with verified SHA-256 equality are candidates. File identity,
metadata, editability, pending changes and references are checked before applying
a selection. Native annotation moves and Trash operations share a transaction;
failed operations reload affected caches, and failed cache recovery blocks
further changes. Permanent erase remains unavailable. Manual review initially
keeps every copy, and preview mode performs no writes. Shutdown and enabling
dry run cancel pending writes. Historical archives and the current branding
remain unchanged.

## Integrated changes

- Import IOUtils explicitly into the bootstrap module scope.
- Keep automatic resolution conservative: known matching storage modes and
  explicit PDF content types are required; other verified groups need review.
- Release the scan lock if preference loading fails, so a later scan can recover.
- Clearly label the manual dialog when it is a dry-run preview.
- Preserve the canonical deterministic builder and its exclusive publication
  step. Reject source/historical-root and symlink destinations. Both older
  builder entry points delegate to the same implementation.
- Run the combined behavior and package tests in one workflow, with pinned
  action revisions and Node 24.

The earlier audit's MD5-era tests are adapted to the current API rather than
restoring its superseded implementation. All 19 upstream safety tests remain;
supplemental tests cover digest failures, changing files, conservative eligibility,
keeper identity, overlapping scans, preference failure recovery and lifecycle/UI
behavior.

## Validation and remaining qualification

The merged candidate passes 29 Node tests and 8 Python package tests. JavaScript
syntax, workflow validation, deterministic package construction and byte-level
package verification pass. Validation uses synthetic Zotero API fixtures;
no personal library is accessed or changed.

Live Zotero 10.0.x install/restart, actual UI and annotation transfer/rollback
checks in a disposable profile remain required before a plugin release. Neither
this merge nor the historical mock-based audit establishes those host results.
