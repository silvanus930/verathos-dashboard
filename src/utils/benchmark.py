"""Small, bounded OpenAI-compatible inference benchmark."""

import json
import time
import urllib.error
import urllib.request

from ..config.settings import (
    API_URL,
    MAX_DELAY_MS,
    MAX_REQUESTS,
    MAX_TEMPERATURE,
    MAX_TIMEOUT_SECONDS,
    MAX_TOKENS,
    REQUEST_TIMEOUT_SECONDS,
)


def _send_request(model, api_key, prompt, max_tokens, timeout_seconds, temperature):
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }).encode()
    request = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Verathos returned HTTP {error.code}: {detail[:300]}") from error

    elapsed_seconds = time.perf_counter() - started
    usage = body.get("usage") or {}
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    return {
        "latency_seconds": round(elapsed_seconds, 3),
        "output_tokens": output_tokens,
        "effective_tokens_per_second": (
            round(output_tokens / elapsed_seconds, 2) if output_tokens else None
        ),
        "proof_verified": body.get("proof_verified"),
    }


def run_benchmark(
    model,
    api_key,
    prompt,
    request_count=3,
    max_tokens=MAX_TOKENS,
    timeout_seconds=REQUEST_TIMEOUT_SECONDS,
    temperature=0,
    delay_ms=0,
):
    if not model or len(model) > 200:
        raise ValueError("model must contain 1-200 characters")
    if not api_key.startswith("vrt_sk_"):
        raise ValueError("api_key must begin with vrt_sk_")
    if not prompt or len(prompt) > 500:
        raise ValueError("prompt must contain 1-500 characters")
    if not 1 <= request_count <= MAX_REQUESTS:
        raise ValueError(f"request_count must be between 1 and {MAX_REQUESTS}")
    if not 1 <= max_tokens <= MAX_TOKENS:
        raise ValueError(f"max_tokens must be between 1 and {MAX_TOKENS}")
    if not 5 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise ValueError(f"timeout_seconds must be between 5 and {MAX_TIMEOUT_SECONDS}")
    if not 0 <= temperature <= MAX_TEMPERATURE:
        raise ValueError(f"temperature must be between 0 and {MAX_TEMPERATURE}")
    if not 0 <= delay_ms <= MAX_DELAY_MS:
        raise ValueError(f"delay_ms must be between 0 and {MAX_DELAY_MS}")

    runs = []
    failures = []
    for index in range(request_count):
        try:
            runs.append(_send_request(
                model,
                api_key,
                prompt,
                max_tokens,
                timeout_seconds,
                temperature,
            ))
        except Exception as error:
            failures.append(str(error))
        if delay_ms and index < request_count - 1:
            time.sleep(delay_ms / 1000)

    average_latency = (
        sum(run["latency_seconds"] for run in runs) / len(runs) if runs else None
    )
    speeds = [
        run["effective_tokens_per_second"]
        for run in runs
        if run["effective_tokens_per_second"] is not None
    ]
    return {
        "model": model,
        "successful_requests": len(runs),
        "failed_requests": len(failures),
        "average_latency_seconds": round(average_latency, 3) if average_latency else None,
        "average_effective_tokens_per_second": (
            round(sum(speeds) / len(speeds), 2) if speeds else None
        ),
        "runs": runs,
        "errors": failures,
        "note": "Gateway-routed; does not isolate or flood an individual miner instance.",
    }
