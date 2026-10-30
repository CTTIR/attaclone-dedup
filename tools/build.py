#!/usr/bin/env python3
"""Build a reproducible development XPI without replacing historical archives."""
import argparse
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT
FILES = ("manifest.json", "bootstrap.js", "chrome.manifest",
         "content/attaclone-dedup.js", "content/manualResolve.js",
         "content/manualResolve.xhtml", "content/manualResolve.css",
         "content/preferences.xhtml", "content/icons/icon.png", "content/icons/icon@2x.png",
         "locale/en-US/attaclone-dedup.properties")


def build(destination=None):
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    version = manifest["version"]
    if not isinstance(version, str) or not version or any(c not in "0123456789.-abcdefghijklmnopqrstuvwxyz" for c in version):
        raise ValueError("Invalid version in plugin manifest")
    destination = Path(destination) if destination else ROOT / "dist" / ("attaclone-dedup-" + version + "-dev.xpi")
    if destination.suffix.lower() != ".xpi":
        raise ValueError("Choose an .xpi destination")
    if destination.resolve().parent == ROOT:
        raise ValueError("Build into dist/ or a separate directory; preserve the historical root archives")
    payload = {name: (SOURCE / name).read_bytes() for name in FILES}
    payload["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".xpi", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(temporary_path, "w") as archive:
            for name, contents in sorted(payload.items()):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, contents)
        with zipfile.ZipFile(temporary_path) as archive:
            if archive.testzip() is not None:
                raise ValueError("Archive integrity check failed")
            for name, contents in payload.items():
                if archive.read(name) != contents:
                    raise ValueError("Archive does not match source: " + name)
        temporary_path.replace(destination)
    finally:
        temporary_path.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(build(args.output))
