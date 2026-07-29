import json
import unittest
from unittest.mock import patch

from src.utils.benchmark import run_benchmark


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps({
            "usage": {"completion_tokens": 24},
            "proof_verified": True,
        }).encode()


class TestBoundedBenchmark(unittest.TestCase):
    @patch("src.utils.benchmark.urllib.request.urlopen", return_value=FakeResponse())
    def test_three_bounded_requests(self, urlopen):
        result = run_benchmark(
            model="test-model",
            api_key="vrt_sk_test_key_123",
            prompt="Test prompt",
            request_count=3,
            max_tokens=32,
        )
        self.assertEqual(result["successful_requests"], 3)
        self.assertEqual(result["failed_requests"], 0)
        self.assertEqual(urlopen.call_count, 3)

    def test_rejects_excessive_request_count(self):
        with self.assertRaises(ValueError):
            run_benchmark(
                model="test-model",
                api_key="vrt_sk_test_key_123",
                prompt="Test prompt",
                request_count=4,
            )

    def test_rejects_out_of_range_settings(self):
        base = {
            "model": "test-model",
            "api_key": "vrt_sk_test_key_123",
            "prompt": "Test prompt",
        }
        invalid_settings = (
            {"max_tokens": 65},
            {"timeout_seconds": 4},
            {"timeout_seconds": 91},
            {"temperature": -0.1},
            {"temperature": 2.1},
            {"delay_ms": -1},
            {"delay_ms": 5001},
        )
        for settings in invalid_settings:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                run_benchmark(**base, **settings)


if __name__ == "__main__":
    unittest.main()
