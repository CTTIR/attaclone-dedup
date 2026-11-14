"""Zotero 10 install contract and no unannounced update releases."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class UpdateManifestTests(unittest.TestCase):
    def test_required_update_url_resolves_to_committed_empty_manifest(self):
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        settings = manifest["applications"]["zotero"]
        self.assertEqual(settings["update_url"], 'https://raw.githubusercontent.com/CTTIR/attaclone-dedup/main/updates.json')
        updates = json.loads((ROOT / "updates.json").read_text())
        self.assertEqual(updates, {"addons": {settings["id"]: {"updates": []}}})

if __name__ == "__main__":
    unittest.main()
