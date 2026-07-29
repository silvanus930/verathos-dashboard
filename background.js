'use strict';

const ownedEndpointsPromise = fetch(chrome.runtime.getURL('owned-endpoints.json'))
  .then((response) => {
    if (!response.ok) throw new Error(`Could not load owned endpoint allowlist (${response.status})`);
    return response.json();
  })
  .then((endpoints) => new Set(endpoints.map((endpoint) => new URL(endpoint).origin)));

function isDashboardUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === 'https://verathos.ai' && /^\/dashboard\/?$/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function probeOwnedEndpoint(baseEndpoint, path, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(baseEndpoint + path, {
      method: options.method || 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return {
      reached: true,
      healthy: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      reached: false,
      healthy: false,
      status: null,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error.name === 'AbortError' ? 'timeout' : (error.message || String(error)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runOwnedEndpointTest(message) {
  const ownedEndpoints = await ownedEndpointsPromise;
  const endpoint = new URL(message.endpoint).origin;
  if (!ownedEndpoints.has(endpoint)) throw new Error('Endpoint is not in the owner allowlist.');

  const settings = message.settings || {};
  const path = settings.path === '/' ? '/' : '/health';
  const requests = Number(settings.requests);
  const concurrency = Number(settings.concurrency);
  const timeoutMs = Number(settings.timeoutMs);
  const delayMs = Number(settings.delayMs);
  const payloadBytes = Number(settings.payloadBytes);
  const testCase = String(settings.testCase || 'health_load');
  const allowedTestCases = new Set(['health_load', 'auth_gate', 'body_limit', 'method_rejection', 'full_suite']);
  if (!allowedTestCases.has(testCase)) throw new Error('Unknown endpoint test case.');
  if (!Number.isInteger(requests) || requests < 1 || requests > 25) {
    throw new Error('Requests must be a whole number between 1 and 25.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error('Concurrency must be a whole number between 1 and 5.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 10000) {
    throw new Error('Timeout must be between 2000 and 10000 ms.');
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) {
    throw new Error('Delay must be between 0 and 1000 ms.');
  }
  if (!Number.isInteger(payloadBytes) || payloadBytes < 1024 || payloadBytes > 65536) {
    throw new Error('Body test size must be between 1024 and 65536 bytes.');
  }

  const results = [];
  if (testCase === 'health_load' || testCase === 'full_suite') {
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < requests) {
        nextIndex += 1;
        results.push(await probeOwnedEndpoint(endpoint, path, timeoutMs));
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
  }

  const checks = [];
  async function addCheck(kind, label, checkPath, options, expectedStatuses) {
    const result = await probeOwnedEndpoint(endpoint, checkPath, timeoutMs, options);
    checks.push({
      kind,
      label,
      result,
      passed: result.reached && expectedStatuses.includes(result.status),
    });
  }
  if (testCase === 'auth_gate' || testCase === 'full_suite') {
    await addCheck(
      'auth_gate',
      'Unsigned /chat authentication gate',
      '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'authorization check' }], max_tokens: 1 }),
      },
      [401, 403],
    );
  }
  if (testCase === 'body_limit' || testCase === 'full_suite') {
    await addCheck(
      'body_limit',
      `${payloadBytes}-byte /chat body limit`,
      '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'A'.repeat(payloadBytes) }], max_tokens: 1 }),
      },
      [400, 401, 403, 413, 422, 429],
    );
  }
  if (testCase === 'method_rejection' || testCase === 'full_suite') {
    await addCheck('method_rejection', 'Invalid PUT method', path, { method: 'PUT' }, [400, 405, 501]);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const recovery = await probeOwnedEndpoint(endpoint, path, timeoutMs);
  const latencies = results.filter((result) => result.reached).map((result) => result.latencyMs);
  const statuses = {};
  results.forEach((result) => {
    const key = result.status === null ? (result.error || 'network_error') : String(result.status);
    statuses[key] = (statuses[key] || 0) + 1;
  });
  return {
    endpoint,
    path,
    requests,
    concurrency,
    reached: results.filter((result) => result.reached).length,
    healthy: results.filter((result) => result.healthy).length,
    statuses,
    latency: {
      averageMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maxMs: latencies.length ? Math.max(...latencies) : null,
    },
    testCase,
    checks,
    recovery,
  };
}

async function setTabBadge(tabId, text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

async function enhanceDashboard(tabId, frameId, url) {
  if (frameId !== 0 || !isDashboardUrl(url)) return;

  const target = { tabId, frameIds: [0] };

  try {
    const injection = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      files: ['override-dashboard.js']
    });
    const replaced = Boolean(injection[0] && injection[0].result);

    if (replaced) {
      await chrome.scripting.insertCSS({
        target,
        files: ['style.css']
      });
      await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        files: ['theme-init.js', 'app.js']
      });
    }

    await setTabBadge(tabId, 'ON', '#16803c', 'Verathos Dashboard Plus is active');
  } catch (error) {
    console.error('Could not enhance Verathos dashboard:', error);
    await setTabBadge(tabId, 'ERR', '#b42318', 'Verathos Dashboard Plus failed — inspect extension errors');
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  enhanceDashboard(details.tabId, details.frameId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  enhanceDashboard(details.tabId, details.frameId, details.url);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://verathos.ai/dashboard' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'owned-endpoint-test') return false;
  runOwnedEndpointTest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

// Extension reloads happen after an existing tab's navigation event. Enhance
// any dashboard tabs that are already open so the user does not have to guess
// whether another hard refresh is required.
chrome.tabs.query({ url: ['https://verathos.ai/dashboard', 'https://verathos.ai/dashboard/'] })
  .then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && tab.url) enhanceDashboard(tab.id, 0, tab.url);
    });
  })
  .catch((error) => {
    console.error('Could not scan existing Verathos dashboard tabs:', error);
  });
