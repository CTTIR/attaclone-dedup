"""Package reproducibility and preservation without installing a plugin."""
import hashlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from build_xpi import FILES, package_bytes


class PackageTests(unittest.TestCase):
    def test_deterministic_archive_matches_all_runtime_source(self):
        first, second = package_bytes(), package_bytes()
        self.assertEqual(first, second)
        with zipfile.ZipFile(io.BytesIO(first)) as archive:
            self.assertEqual(set(archive.namelist()), set(FILES))
            self.assertEqual(len(archive.namelist()), len(FILES))
            for name in FILES:
                self.assertEqual(archive.read(name), (ROOT / name).read_bytes())

    def test_preexisting_different_archive_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "previous.xpi"
            output.write_bytes(b"previous archive")
            before = hashlib.sha256(output.read_bytes()).hexdigest()
            result = subprocess.run([sys.executable, str(ROOT / "tools/build_xpi.py"), "--output", str(output)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing to overwrite", result.stderr)
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), before)
            self.assertEqual(list(output.parent.iterdir()), [output])

    def test_checker_rejects_added_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "unexpected.xpi"
            output.write_bytes(package_bytes())
            with zipfile.ZipFile(output, "a") as archive:
                archive.writestr("credentials.json", "{}")
            result = subprocess.run([sys.executable, str(ROOT / "tools/check_xpi.py"), str(output)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unexpected", result.stderr)


if __name__ == "__main__":
    unittest.main()
