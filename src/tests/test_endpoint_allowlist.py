import json
from pathlib import Path
import unittest
from urllib.parse import urlsplit

import server


class TestOwnedEndpointAllowlist(unittest.TestCase):
    def test_allowlist_contains_only_exact_https_origins(self):
        path = Path(__file__).parents[2] / "owned-endpoints.json"
        endpoints = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(endpoints), 15)
        self.assertEqual(len(set(endpoints)), 15)
        for endpoint in endpoints:
            parsed = urlsplit(endpoint)
            self.assertEqual(parsed.scheme, "https")
            self.assertTrue(parsed.netloc)
            self.assertIn(parsed.scheme + "://" + parsed.netloc, server.OWNED_ENDPOINTS)

    def test_unlisted_endpoint_is_rejected_by_allowlist(self):
        self.assertNotIn("https://example.com", server.OWNED_ENDPOINTS)


if __name__ == "__main__":
    unittest.main()
