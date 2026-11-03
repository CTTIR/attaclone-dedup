import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build", ROOT / "tools" / "build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PackageTest(unittest.TestCase):
    def test_reproducible_source_and_licence(self):
        with tempfile.TemporaryDirectory() as directory:
            first = builder.build(Path(directory) / "first.xpi")
            second = builder.build(Path(directory) / "second.xpi")
            self.assertEqual(hashlib.sha256(first.read_bytes()).digest(),
                             hashlib.sha256(second.read_bytes()).digest())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(set(archive.namelist()), set(builder.FILES) | {"LICENSE"})
                for name in builder.FILES:
                    self.assertEqual(archive.read(name), (builder.SOURCE / name).read_bytes())
                self.assertEqual(archive.read("LICENSE"), (ROOT / "LICENSE").read_bytes())
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["applications"]["zotero"]["id"], "attaclone-dedup@r-heller.github.io")

    def test_historical_archives_cannot_be_overwritten(self):
        with self.assertRaises(ValueError):
            builder.build(ROOT / "attaclone-dedup-1.0.0.xpi")

    def test_source_files_cannot_be_overwritten(self):
        for target in [builder.SOURCE / "bootstrap.js", builder.SOURCE / "candidate.xpi"]:
            with self.assertRaises(ValueError):
                builder.build(target)

    def test_compatibility_builder_preserves_different_existing_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "old.xpi"
            target.write_bytes(b"prior artifact")
            with self.assertRaises(SystemExit):
                builder.build(target)
            self.assertEqual(target.read_bytes(), b"prior artifact")

    def test_symlink_destination_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original.xpi"
            original.write_bytes(b"prior artifact")
            target = Path(directory) / "link.xpi"
            target.symlink_to(original)
            with self.assertRaises(ValueError):
                builder.build(target)
            self.assertEqual(original.read_bytes(), b"prior artifact")


if __name__ == "__main__":
    unittest.main()
