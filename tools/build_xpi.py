"""Build a deterministic XPI from an explicit runtime allowlist, without overwriting archives."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["LICENSE", "manifest.json", "bootstrap.js", "chrome.manifest",
         "content/attaclone-dedup.js", "content/manualResolve.js", "content/manualResolve.xhtml",
         "content/manualResolve.css", "content/preferences.xhtml", "content/icons/icon.png",
         "content/icons/icon@2x.png", "locale/en-US/attaclone-dedup.properties"]


def package_bytes():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(FILES):
            path = ROOT / name
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"Missing or symlinked runtime file: {name}")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return stream.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    version = json.loads((ROOT / "manifest.json").read_text())["version"]
    output = (args.output or ROOT / "dist" / f"attaclone-dedup-{version}.xpi").resolve()
    body = package_bytes()
    if output.exists():
        if output.read_bytes() != body:
            raise SystemExit(f"Refusing to overwrite different archive: {output}; choose a new --output")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".attaclone-", suffix=".partial", dir=output.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temporary, output)
        finally:
            os.unlink(temporary)
    print(f"Built {output}")
    print(f"SHA-256 {hashlib.sha256(body).hexdigest()}")


if __name__ == "__main__":
    main()
