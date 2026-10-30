"""Verify a candidate XPI against current source and the runtime allowlist."""
import argparse
import json
from pathlib import Path
import zipfile

from build_xpi import FILES, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.archive) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(FILES):
            raise SystemExit("Unexpected, duplicate, or missing package files")
        for name in names:
            if archive.read(name) != (ROOT / name).read_bytes():
                raise SystemExit(f"Package/source mismatch: {name}")
        metadata = json.loads(archive.read("manifest.json"))
        print(f"Verified {metadata['name']} {metadata['version']}: {len(names)} source-matching runtime files")


if __name__ == "__main__":
    main()
