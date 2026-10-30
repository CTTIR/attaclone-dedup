# Contributing to Attaclone-dedup

Thanks for considering a contribution. This project is small and easy to hack on.

## Reporting bugs

Open an issue with:

- Your Zotero version (Help → About Zotero) and operating system.
- The plugin version (Tools → Plugins).
- Steps to reproduce, expected behavior, actual behavior.
- Relevant lines from the Zotero debug log (Help → Debug Output Logging). Lines from Attaclone-dedup are prefixed `Attaclone-dedup: `.

## Suggesting features

Open an issue describing the use case. Keep the scope tight — the plugin deliberately handles one job (attachment dedup within an item).

## Development

The plugin is a bootstrapped Zotero 10.0.x extension; the deterministic XPI builder packages only runtime files.

```bash
# Run safety checks and build without overwriting existing archives
node --test tests/*.test.js
python3 tools/build_xpi.py
python3 tools/check_xpi.py dist/attaclone-dedup-1.0.1.xpi
```

To load an unpacked plugin in Zotero, point a file named `attaclone-dedup@r-heller.github.io` (no extension) at the source folder and drop it into Zotero's `extensions/` profile directory. See the [Zotero plugin development docs](https://www.zotero.org/support/dev/client_coding/plugin_development) for details.

### Code style

- Match the surrounding style: 2-space indent, double quotes, semicolons.
- Keep logic in `content/attaclone-dedup.js`; UI in `content/manualResolve.{xhtml,js,css}`; preferences in `content/preferences.xhtml`.
- Localizable strings go in `locale/en-US/attaclone-dedup.properties`.

## Pull requests

1. Fork and create a topic branch.
2. Make focused changes — one concern per PR.
3. Test against a real Zotero 10.0.x installation with a non-trivial library before opening the PR.
4. Update `CHANGELOG.md` under the `Unreleased` heading.
