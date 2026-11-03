# Maintenance audit — 30 October 2026

> Historical record for audit commit `50ef8b47`. Its 9.x target, MD5-era
> implementation details, package version and test counts are superseded by the
> newer Zotero 10 PDF/SHA-256 safety revision and the
> [3 November integration record](integration-2026-11-03.md). This record is
> retained as evidence of the earlier audit, not as current release guidance.

## Purpose and acceptance criteria

Find duplicate file attachments within each bibliographic item, preserve user
annotations and metadata, and make uncertain matches reviewable. No automatic
removal may depend on filename similarity, missing metadata or a failed hash.
Dry run must perform no writes. A failed group must remain recoverable.

Baseline: `9618e8ff771ae71905aa95f587a893fc331bd2a2`. The original checkout was
clean. GitHub had no open issues or published releases at the audit. Successful
existing CI runs rendered documentation, not plugin behavior. The local host is
Zotero 10.0.5; the manifest permits 7–9, so host qualification remains pending.

## Findings and repairs

| Finding and evidence | Impact | Priority | Repair |
| --- | --- | --- | --- |
| `_attachmentKey()` fell back to filename and size, including size zero after errors. `_canAutoResolve()` ignored the key type. | Different unreadable files could be removed automatically. | Release blocker | Require a readable content hash. Count and skip unhashed attachments. Recheck hash and metadata before applying a group. |
| Metadata exceptions were replaced with empty annotations or notes; embedded PDF annotations were not checked. | An unknown state could authorize removal. | Release blocker | Track verification state; unknown or enriched records cannot be automatically removed. |
| `_openManualDialog()` merged annotations before `_deleteAttachments()` checked dry run. | A dry run could write to the library. | Release blocker | Guard every write path and test the manual-dialog route. |
| `_mergeAnnotations()` swallowed copy failures before source removal; individual saves used separate transactions. | Failed copying or a later deletion could leave a partial operation. | Release blocker | Move original internal annotation objects; require one PDF keeper; revalidate selections and apply one transaction per group. Propagate failures. |
| Native permanent erase removes files inside `_eraseData()` before the transaction finishes. | A database rollback cannot restore physical files. | Release blocker | Remove permanent erase from this plugin; always use Trash. Preserve but ignore the stored legacy preference. |
| `getAll()` returns objects unless `asIDs` is requested, but the code passed them to `Items.get()`. | Full-library scans could fail. | High | Consume returned objects directly. |
| Module scope omitted IOUtils; scan promises had no menu error handler. | File checks failed silently or UI operations rejected without a useful result. | High | Import/pass IOUtils explicitly, show errors, and prevent concurrent scans. |
| Packaging used the working directory and removed an existing root archive before building. | Wrong-directory builds and loss of previous packages were possible. | Medium | Anchor paths to the script, build atomically into `dist/`, verify archive entries and include the MIT licence. |
| Documentation contained missing screenshots, unsupported compatibility claims and a missing update-feed URL. | First use did not match the available package. | Medium | Align installation/compatibility guidance, remove nonexistent screenshots and update URL, document manual updates and release gates. |

## Strategy and tradeoffs

M1 prevents unsafe mutation and establishes failure-path regressions. M2 aligns
package construction, user instructions and CI with the actual behavior. M3
qualifies the completed candidate in supported Zotero hosts before release.

Trash-only behavior is an intentional migration: callers with the old erase
preference still get reversible removals. Their stored preference is unchanged.
Existing explicit dry-run settings are retained; only fresh or undefined
settings default to dry run. Each group is atomic; an interrupted full-library
scan may have earlier completed groups. Restoring a source PDF from Trash does
not reverse a completed annotation move; the annotation remains on its keeper.

Unknown data reduces automatic cleanup, deliberately. A missing hash never
becomes a filename-based candidate. MD5 is Zotero's existing file-hash API;
automatic resolution additionally checks file size, type, link mode and
annotation/note/tag state. Large-library timing, progress cancellation and
qualification of Zotero 10 are deferred until host integration is established.

## Local verification and first use

The regression suite exercises the actual source in synthetic host contexts,
including startup scope and manual-dialog validation. It does not emulate the
complete Zotero application or prove actual SQLite/filesystem rollback. The
packaging tests compare repeated archive hashes and every embedded source entry,
and reject attempts to overwrite source or historical archives.

Prerequisites: Node.js 24 and Python 3.9+; no npm dependencies.

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 _repack.py
```

Candidate: `dist/attaclone-dedup-1.0.0-dev.xpi`. The 22 Node regressions and 3
Python packaging tests pass locally. JavaScript syntax and actionlint checks
also pass. Hosted CI has not run on the maintenance branch.
The Node tests were also executed with the documented Node 24 prerequisite
(24.22.1). The original 13-case safety suite failed 12 cases on the baseline.
Quarto 1.10.19 rendered all three documentation pages from a clean temporary
copy; all 68 local asset references across those pages resolve.

## Outstanding release gates

1. In a disposable supported Zotero profile with sync disabled, verify startup,
   menu injection/removal, preferences, and all three scan scopes.
2. Use synthetic PDFs with distinct contents but identical names/sizes,
   internal/external annotations, tags, notes, missing files and linked files.
   Verify dry run changes nothing and uncertain states never auto-remove data.
3. Exercise manual merging, cancel/skip, stale records and injected save
   failures. Inspect the real database and files; verify group rollback and
   subsequent retry. Confirm annotation identities and PDF content remain intact.
4. Test Trash restoration and record realistic scan duration/UI responsiveness.
5. Reconcile the manifest's 1.0.0 with the historical citation's 0.1.0 and verify
   DOI registration before choosing a release version. Existing provenance is
   retained; no release date or registered DOI is invented here.
6. Build/review the final package, then publish with authorization. No release,
   deployment or submission was performed during this maintenance pass.

## Primary interfaces checked

- [Zotero JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)
- [Preference binding](https://www.zotero.org/support/dev/zotero_7_for_developers#preference_tags_and_preference_binding)
- [getAll in Zotero 9.0.6](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/data/items.js)
- [Attachment hashing, annotations and physical erasure](https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/data/item.js)
- [Privileged global imports](https://github.com/mozilla/gecko-dev/blob/master/js/xpconnect/idl/xpccomponents.idl)
