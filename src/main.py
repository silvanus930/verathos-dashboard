"""Bounded Verathos model benchmark.

This intentionally uses normal authenticated inference requests. It does not
send raw packets or connect directly to miner endpoints, which require
validator signatures.
"""

from argparse import ArgumentParser
import json

from .config.settings import (
    DEFAULT_PROMPT,
    MAX_DELAY_MS,
    MAX_REQUESTS,
    MAX_TEMPERATURE,
    MAX_TIMEOUT_SECONDS,
    MAX_TOKENS,
)
from .utils.benchmark import run_benchmark


def main():
    parser = ArgumentParser(description="Run a bounded Verathos model inference check")
    parser.add_argument("--model", required=True, help="Verathos model ID")
    parser.add_argument("--api-key", required=True, help="Verathos API key (vrt_sk_...)")
    parser.add_argument(
        "--requests",
        type=int,
        default=3,
        choices=range(1, MAX_REQUESTS + 1),
        metavar=f"1-{MAX_REQUESTS}",
    )
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=MAX_TOKENS,
        choices=range(1, MAX_TOKENS + 1),
        metavar=f"1-{MAX_TOKENS}",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=MAX_TIMEOUT_SECONDS,
        choices=range(5, MAX_TIMEOUT_SECONDS + 1),
        metavar=f"5-{MAX_TIMEOUT_SECONDS}",
        help="Seconds per request",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0,
        help=f"Sampling temperature (0-{MAX_TEMPERATURE})",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=0,
        help=f"Delay between requests (0-{MAX_DELAY_MS} ms)",
    )
    args = parser.parse_args()

    result = run_benchmark(
        model=args.model,
        api_key=args.api_key,
        prompt=args.prompt,
        request_count=args.requests,
        max_tokens=args.max_tokens,
        timeout_seconds=args.timeout,
        temperature=args.temperature,
        delay_ms=args.delay_ms,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
