'use strict';

const IS_EXTENSION = typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
const API_CANDIDATES = IS_EXTENSION
  ? ['https://verathos.ai/api/dashboard']
  : ['/api/dashboard', 'https://verathos.ai/api/dashboard'];
const REFRESH_MS = 5 * 60 * 1000;
const TELEGRAM_SETTINGS_LOCAL_KEY = 'verathos-telegram-settings';
const PROBATION_STATE_LOCAL_KEY = 'verathos-watched-probation-state';

// Epoch timing isn't exposed by the API. Anchored against a known reference
// point (next epoch boundary observed at 2026-07-21T05:52:36Z) and projected
// forward using Bittensor's standard tempo (360 blocks × 12s ≈ 72min).
const EPOCH_LENGTH_MS = 72 * 60 * 1000;
const EPOCH_ANCHOR_MS = Date.UTC(2026, 6, 21, 5, 52, 26);

const state = {
  data: null,
  miners: [],
  sortKey: 'score',
  sortDir: 'desc',
  pageSize: Infinity,
  watched: new Set(),
  watchGroups: [],
  activeWatchGroupId: null,
  showWatchedOnly: false,
  telegram: { botToken: '', chatId: '' },
  probationByUid: {},
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------- formatting helpers ----------
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}
function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits) + '%';
}
function fmtMoney(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtTruncated(str, head = 6, tail = 4) {
  if (!str) return '—';
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}
function fmtAgo(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
function fmtDate(unixSec) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

// ---------- epoch countdown ----------
function nextEpochBoundary(now) {
  const epochsSinceAnchor = Math.floor((now - EPOCH_ANCHOR_MS) / EPOCH_LENGTH_MS);
  return EPOCH_ANCHOR_MS + (epochsSinceAnchor + 1) * EPOCH_LENGTH_MS;
}

function tickEpochCountdown() {
  const now = Date.now();
  const remaining = nextEpochBoundary(now) - now;
  $('#epochCountdown').textContent = fmtDuration(remaining);
  $('#epochBarFill').style.width = `${(remaining / EPOCH_LENGTH_MS) * 100}%`;
}

// ---------- fetching ----------
async function fetchDashboard() {
  let lastErr;
  for (const url of API_CANDIDATES) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function loadData({ silent = false } = {}) {
  try {
    const data = await fetchDashboard();
    state.data = data;
    render(data);
    setConnStatus(true);
    hideError();
    $('#lastUpdated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    setConnStatus(false);
    if (!silent) showError(err);
    console.error(err);
  }
}

function setConnStatus(ok) {
  const pill = $('#connStatus');
  pill.classList.remove('ok', 'bad', 'pill-muted');
  pill.classList.add(ok ? 'ok' : 'bad');
  pill.innerHTML = `<span class="dot"></span> ${ok ? 'connected' : 'disconnected'}`;
}

// ---------- miner debug ----------
const MINER_DEBUG_BASE = IS_EXTENSION
  ? 'https://api.verathos.ai/v1/miner-debug'
  : '/api/miner-debug';

const ISSUE_CODE_INFO = {
  healthy: { label: 'Healthy', sev: 'good', desc: 'No obvious issue in the cached window.' },
  new_entry_not_scored: { label: 'Not scored yet', sev: 'info', desc: 'The active endpoint has not closed a scored epoch yet.' },
  local_weight_not_reflected: { label: 'Weight not reflected', sev: 'info', desc: "This validator's positive last weight is not yet reflected by the cached metagraph incentive." },
  chat_unauthorized: { label: 'Chat 401', sev: 'bad', desc: 'The endpoint is reachable but /chat returns 401 to validator canaries.' },
  chat_forbidden: { label: 'Chat 403', sev: 'bad', desc: 'The endpoint is reachable but /chat returns 403 to validator canaries.' },
  chat_not_found: { label: 'Chat 404', sev: 'bad', desc: 'The endpoint is reachable but /chat route is missing.' },
  timeout: { label: 'Timeout', sev: 'warn', desc: 'Recent inference/canary request timed out.' },
  connection_failed: { label: 'Connection failed', sev: 'bad', desc: 'Recent inference/canary request could not connect.' },
  tls_error: { label: 'TLS error', sev: 'bad', desc: 'Recent inference/canary request failed TLS/certificate validation.' },
  on_probation: { label: 'On probation', sev: 'warn', desc: 'One or more endpoint entries are on probation.' },
  capacity_audit_failures: { label: 'Capacity-audit failures', sev: 'warn', desc: 'Recent capacity-audit failures remain in the scoring lookback.' },
  uid_audit_gate_active: { label: 'UID audit gate active', sev: 'bad', desc: 'UID-level capacity-audit floor is active.' },
  recent_endpoint_churn: { label: 'Recent endpoint churn', sev: 'info', desc: 'Recent inactive/stale endpoint entries still affect interpretation.' },
  stale_uid_identity: { label: 'Stale UID identity', sev: 'warn', desc: 'An old EVM address is stale for the current UID owner.' },
  blacklisted: { label: 'Blacklisted', sev: 'bad', desc: 'The current miner address is blacklisted by subnet configuration.' },
  model_gate_active: { label: 'Model gate active', sev: 'warn', desc: 'The executor fails the current model/GPU capacity gate.' },
  proof_failure: { label: 'Proof failure', sev: 'bad', desc: 'A recent synthetic canary proof failed verification.' },
  tee_failure: { label: 'TEE failure', sev: 'bad', desc: 'A recent TEE attestation failed verification.' },
  no_active_endpoint: { label: 'No active endpoint', sev: 'bad', desc: 'No active endpoint is present for this UID.' },
};

function issueInfo(code) {
  return ISSUE_CODE_INFO[code] || { label: code, sev: 'warn', desc: '' };
}
function sevIcon(sev) {
  return { good: '✓', info: 'i', warn: '!', bad: '✕' }[sev] || '•';
}

const debugState = {
  uid: null,
  modelIndex: null,
  windowH: 24,
  kind: 'uid',
  loading: false,
  error: null,
  raw: null,
  payload: null,
};

async function fetchMinerDebugRaw(path) {
  const res = await fetch(MINER_DEBUG_BASE + path, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}
function fetchMinerDebugUid(uid, windowH) {
  return fetchMinerDebugRaw(`/${uid}?window_h=${windowH}`);
}
function fetchMinerDebugEntry(uid, modelIndex, windowH) {
  return fetchMinerDebugRaw(`/${uid}/entries/${modelIndex}?window_h=${windowH}`);
}

function normalizeDebugPayload(raw, kind) {
  const d = raw.data || {};
  const base = {
    epochNumber: raw.epoch_number,
    cacheStaleS: raw.cache_stale_s,
  };
  if (kind === 'uid') {
    return {
      ...base,
      primaryIssue: d.primary_issue,
      identity: d.identity,
      summary: d.summary,
      network: d.network,
      uidGate: d.uid_gate,
      hints: d.hints,
      nextSteps: d.next_steps,
      entries: d.entries || [],
    };
  }
  return {
    ...base,
    primaryIssue: d.uid_primary_issue,
    identity: null,
    summary: d.uid_summary,
    network: d.uid_network,
    uidGate: d.uid_gate,
    hints: d.uid_hints,
    nextSteps: [],
    entries: d.entries || [],
  };
}

function openDebugModal(uid, modelIndex, windowH) {
  debugState.uid = uid;
  debugState.modelIndex = modelIndex ?? null;
  debugState.windowH = windowH || 24;
  $('#debugModalWindowSelect').value = String(debugState.windowH);
  $('#debugModalOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  loadDebugModal();
}

function closeDebugModal() {
  $('#debugModalOverlay').hidden = true;
  document.body.style.overflow = '';
}

async function loadDebugModal() {
  debugState.loading = true;
  debugState.error = null;
  renderDebugModalTitle();
  renderDebugModalBody();
  try {
    const { uid, modelIndex, windowH } = debugState;
    let raw, kind;
    if (modelIndex !== null && modelIndex !== undefined) {
      raw = await fetchMinerDebugEntry(uid, modelIndex, windowH);
      kind = 'entry';
    } else {
      raw = await fetchMinerDebugUid(uid, windowH);
      kind = 'uid';
    }
    debugState.raw = raw;
    debugState.kind = kind;
    debugState.payload = normalizeDebugPayload(raw, kind);
  } catch (err) {
    debugState.error = err;
    debugState.payload = null;
  } finally {
    debugState.loading = false;
    renderDebugModalTitle();
    renderDebugModalBody();
  }
}

function renderDebugModalTitle() {
  const title = $('#debugModalTitle');
  const sub = $('#debugModalSubtitle');
  title.textContent = (debugState.modelIndex !== null && debugState.modelIndex !== undefined)
    ? `UID ${debugState.uid} · Model #${debugState.modelIndex}`
    : `UID ${debugState.uid} · Overview`;
  if (debugState.payload) {
    const g = debugState.payload;
    const parts = [`epoch ${fmtInt(g.epochNumber)}`];
    if (g.cacheStaleS != null) parts.push(`cache ${Math.round(g.cacheStaleS)}s old`);
    sub.textContent = parts.join(' · ');
  } else {
    sub.textContent = '';
  }
}

function debugLoadingNode() {
  const wrap = el('div', 'debug-loading');
  wrap.appendChild(el('div', 'debug-spinner'));
  wrap.appendChild(el('div', null, 'Fetching diagnostics…'));
  return wrap;
}

function debugErrorNode(err) {
  const wrap = el('div', 'debug-error');
  let msg = err.message || String(err);
  if (err.status === 404) msg = `Not found: ${msg}. The UID/model index isn't in the validator's debug cache.`;
  else if (err.status === 503) msg = `Debug cache not ready yet: ${msg}`;
  else if (!err.status) msg = `${msg}. Make sure you're running the included proxy: python3 server.py`;
  wrap.textContent = msg;
  return wrap;
}

function issueBannerNode(code) {
  const info = issueInfo(code || 'healthy');
  const wrap = el('div', `debug-issue-banner sev-${info.sev}`);
  wrap.appendChild(el('span', 'sev-icon', sevIcon(info.sev)));
  const text = el('div', 'sev-text');
  text.appendChild(el('div', null, info.label));
  if (info.desc) text.appendChild(el('div', 'sev-sub', info.desc));
  wrap.appendChild(text);
  return wrap;
}

function issueChipNode(code) {
  const info = issueInfo(code);
  const chip = el('span', `issue-chip sev-${info.sev}`, info.label);
  if (info.desc) chip.title = info.desc;
  return chip;
}

function kvCard(title, rows) {
  const card = el('div', 'debug-card');
  card.appendChild(el('h4', null, title));
  rows.forEach(([label, value]) => {
    const row = el('div', 'debug-kv');
    row.appendChild(el('span', null, label));
    row.appendChild(el('b', null, value === null || value === undefined ? '—' : String(value)));
    card.appendChild(row);
  });
  return card;
}

function summaryGridNode(summary, network) {
  const grid = el('div', 'debug-grid');
  summary = summary || {};
  network = network || {};
  grid.appendChild(kvCard('Summary', [
    ['Active entries', fmtInt(summary.active_entries)],
    ['Recent entries', fmtInt(summary.recent_entries)],
    ['Inactive recent', fmtInt(summary.inactive_recent_entries)],
    ['On probation', fmtInt(summary.entries_on_probation)],
    ['Best score', summary.best_score != null ? summary.best_score.toFixed(4) : '—'],
    ['Latest scored epoch', fmtInt(summary.latest_scored_epoch)],
  ]));
  grid.appendChild(kvCard('Network (this validator)', [
    ['Last weight set', network.last_validator_weight != null ? network.last_validator_weight.toFixed(6) : '—'],
    ['Metagraph incentive', network.metagraph_incentive != null ? network.metagraph_incentive.toFixed(6) : '—'],
    ['Metagraph emission', network.metagraph_emission != null ? network.metagraph_emission.toFixed(6) : '—'],
    ['Metagraph trust', network.metagraph_trust != null ? network.metagraph_trust.toFixed(6) : '—'],
    ['Metagraph consensus', network.metagraph_consensus != null ? network.metagraph_consensus.toFixed(6) : '—'],
    ['Metagraph block', fmtInt(network.metagraph_block)],
  ]));
  return grid;
}

function identityCardNode(identity) {
  return kvCard('Identity', [
    ['Hotkey', fmtTruncated(identity.hotkey_ss58, 8, 6)],
    ['EVM address', fmtTruncated(identity.evm_address, 8, 6)],
    ['Generation', fmtInt(identity.generation)],
    ['Identity start epoch', fmtInt(identity.identity_start_epoch)],
  ]);
}

function uidGateNode(gate) {
  gate = gate || {};
  const wrap = el('div');
  wrap.appendChild(el('div', 'debug-section-title', 'UID Capacity-Audit Gate'));
  const grid = el('div', 'debug-grid');
  const th = gate.thresholds || {};
  grid.appendChild(kvCard('Gate status', [
    ['Active', gate.active ? 'Yes' : 'No'],
    ['Enabled', gate.enabled ? 'Yes' : 'No'],
    ['Convicted / entries', `${fmtInt(gate.convicted_entries)} / ${fmtInt(gate.entry_count)}`],
    ['Quorum', fmtInt(gate.quorum)],
    ['Since epoch', fmtInt(gate.since_epoch)],
    ['Next clear epoch', gate.next_possible_clear_epoch != null ? fmtInt(gate.next_possible_clear_epoch) : '—'],
    ['Est. hours remaining', gate.estimated_hours_remaining_if_clean ? gate.estimated_hours_remaining_if_clean.toFixed(1) + 'h' : '—'],
  ]));
  grid.appendChild(kvCard('Thresholds', [
    ['Invalid proof misses', fmtInt(th.invalid_proof_misses)],
    ['Hard proof misses', fmtInt(th.hard_proof_misses)],
    ['Timing misses', fmtInt(th.timing_misses)],
    ['Timing-only allowed', th.timing_only_allowed ? 'Yes' : 'No'],
    ['UID min entries', fmtInt(th.uid_min_entries)],
    ['UID fraction', th.uid_fraction != null ? fmtPct(th.uid_fraction * 100) : '—'],
    ['UID max entries', fmtInt(th.uid_max_entries)],
  ]));
  wrap.appendChild(grid);

  if (gate.convicted && gate.convicted.length) {
    const tableWrap = el('div', 'table-wrap debug-table-wrap');
    const table = el('table', 'data-table');
    const thead = el('thead');
    const htr = el('tr');
    ['Model idx', 'Reasons', 'Next clear epoch', 'Epochs left', 'Est. hours'].forEach((h) => htr.appendChild(el('th', null, h)));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    gate.convicted.forEach((c) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', c.model_index));
      tr.appendChild(el('td', null, (c.active_reasons || []).join(', ') || '—'));
      tr.appendChild(el('td', null, c.next_possible_clear_epoch != null ? fmtInt(c.next_possible_clear_epoch) : '—'));
      tr.appendChild(el('td', null, fmtInt(c.epochs_remaining_if_clean)));
      tr.appendChild(el('td', null, c.estimated_hours_remaining_if_clean != null ? c.estimated_hours_remaining_if_clean.toFixed(1) + 'h' : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
  }
  return wrap;
}

function entriesListNode(entries) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'debug-section-title', `Entries (${entries.length})`));
  const tableWrap = el('div', 'table-wrap debug-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const htr = el('tr');
  ['Model idx', 'Model', 'GPU', 'Score', 'Active', 'Issue', ''].forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  entries.forEach((entry) => {
    const tr = el('tr');
    tr.appendChild(el('td', 'mono', entry.model_index));
    const modelTd = el('td');
    modelTd.appendChild(el('span', 'cell-main', (entry.model_id || '—').split('/').pop()));
    modelTd.title = entry.model_id || '';
    tr.appendChild(modelTd);
    tr.appendChild(el('td', null, entry.gpu_name || '—'));
    tr.appendChild(el('td', null, entry.score != null ? entry.score.toFixed(3) : '—'));
    const activeTd = el('td');
    activeTd.appendChild(el('span', `health-dot ${entry.active ? 'up' : 'down'}`));
    tr.appendChild(activeTd);
    const issueTd = el('td');
    const codes = entry.issue_codes && entry.issue_codes.length ? entry.issue_codes : ['healthy'];
    codes.forEach((c) => issueTd.appendChild(issueChipNode(c)));
    tr.appendChild(issueTd);
    const actionTd = el('td');
    const btn = el('button', 'debug-btn', 'Details →');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      debugState.modelIndex = entry.model_index;
      loadDebugModal();
    });
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  return wrap;
}

function backToOverviewButtonNode() {
  const btn = el('button', 'btn btn-ghost debug-back-btn', '← Back to UID overview');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    debugState.modelIndex = null;
    loadDebugModal();
  });
  return btn;
}

function capacityAuditNode(ca) {
  if (!ca) return el('div');
  const wrap = el('div');
  wrap.appendChild(el('div', 'debug-section-title', 'Capacity Audit'));

  const gs = ca.gate_status || {};
  const grid = el('div', 'debug-grid');
  grid.appendChild(kvCard('Audit totals', [
    ['Total', fmtInt(ca.total)],
    ['Timing pass / excused / miss', `${fmtInt(ca.timing_pass)} / ${fmtInt(ca.timing_excused)} / ${fmtInt(ca.timing_miss)}`],
    ['Hard proof miss', fmtInt(ca.hard_proof_miss)],
    ['No-show', fmtInt(ca.no_show)],
    ['Pending', fmtInt(ca.pending)],
  ]));
  grid.appendChild(kvCard('Gate status', [
    ['Active', gs.active ? 'Yes' : 'No'],
    ['Since epoch', fmtInt(gs.since_epoch)],
    ['Next clear epoch', gs.next_possible_clear_epoch != null ? fmtInt(gs.next_possible_clear_epoch) : '—'],
    ['Epochs left', fmtInt(gs.epochs_remaining_if_clean)],
    ['Est. hours remaining', gs.estimated_hours_remaining_if_clean != null ? gs.estimated_hours_remaining_if_clean.toFixed(1) + 'h' : '—'],
    ['Reasons', (gs.active_reasons || []).join(', ') || '—'],
  ]));
  wrap.appendChild(grid);

  if (ca.failure_reasons && Object.keys(ca.failure_reasons).length) {
    const chipsWrap = el('div', 'debug-issue-chips');
    Object.entries(ca.failure_reasons).forEach(([reason, count]) => {
      chipsWrap.appendChild(el('span', 'issue-chip sev-warn', `${reason} ×${count}`));
    });
    wrap.appendChild(chipsWrap);
  }

  if (ca.recent_failures && ca.recent_failures.length) {
    const tableWrap = el('div', 'table-wrap debug-table-wrap');
    const table = el('table', 'data-table');
    const thead = el('thead');
    const htr = el('tr');
    ['Epoch', 'Verdict', 'Timing', 'Proof', 'Reason'].forEach((h) => htr.appendChild(el('th', null, h)));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    ca.recent_failures.forEach((f) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', f.epoch));
      tr.appendChild(el('td', null, f.verdict || '—'));
      tr.appendChild(el('td', null, f.timing_status || '—'));
      tr.appendChild(el('td', null, f.proof_status || '—'));
      tr.appendChild(el('td', null, f.failure_reason || '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
  }
  return wrap;
}

function entryDeepDiveNode(entry) {
  const wrap = el('div');

  const header = el('div', 'debug-entry-header');
  header.appendChild(el('div', 'cell-main', entry.model_id || '—'));
  header.appendChild(el('div', 'cell-sub mono', entry.endpoint || ''));
  const chipsRow = el('div', 'debug-entry-chips');
  chipsRow.appendChild(badge(entry.active ? 'active' : 'inactive', entry.active ? 'green' : 'gray'));
  if (entry.stale) chipsRow.appendChild(badge('stale', 'amber'));
  if (entry.blacklisted) chipsRow.appendChild(badge('blacklisted', 'red'));
  if (entry.model_gate && entry.model_gate.active) chipsRow.appendChild(badge('model gate active', 'red'));
  header.appendChild(chipsRow);
  wrap.appendChild(header);

  const codes = entry.issue_codes && entry.issue_codes.length ? entry.issue_codes : ['healthy'];
  const chipsWrap = el('div', 'debug-issue-chips');
  codes.forEach((c) => chipsWrap.appendChild(issueChipNode(c)));
  wrap.appendChild(chipsWrap);

  const probation = entry.probation || {};
  const canary = entry.canary || {};
  const receipts = entry.receipts || {};
  const lastScore = entry.last_score || {};

  const grid = el('div', 'debug-grid');
  grid.appendChild(kvCard('Score', [
    ['Score', entry.score != null ? entry.score.toFixed(4) : '—'],
    ['EMA score', entry.ema_score != null ? entry.ema_score.toFixed(4) : '—'],
    ['Total / scored epochs', `${fmtInt(entry.total_epochs)} / ${fmtInt(entry.scored_epochs)}`],
    ['First seen epoch', fmtInt(entry.first_seen_epoch)],
    ['Last seen epoch', fmtInt(entry.last_seen_epoch)],
  ]));
  grid.appendChild(kvCard('Probation', [
    ['Active', probation.active ? 'Yes' : 'No'],
    ['Entered epoch', probation.entered_epoch != null ? fmtInt(probation.entered_epoch) : '—'],
    ['Consecutive passes', fmtInt(probation.consecutive_passes)],
    ['Required passes', fmtInt(probation.required_passes)],
    ['Remaining if clean', fmtInt(probation.passes_remaining_if_clean)],
  ]));
  grid.appendChild(kvCard('Canary checks', [
    ['Total / OK', `${fmtInt(canary.total)} / ${fmtInt(canary.ok)}`],
    ['Errors', fmtInt(canary.errors)],
    ['Proof req / verified / fail', `${fmtInt(canary.proof_requested)} / ${fmtInt(canary.proof_verified)} / ${fmtInt(canary.proof_failures)}`],
    ['TEE req / verified / fail', `${fmtInt(canary.tee_requested)} / ${fmtInt(canary.tee_verified)} / ${fmtInt(canary.tee_failures)}`],
    ['Last status', canary.last_status || '—'],
    ['Last error kind', canary.last_error_kind || '—'],
  ]));
  grid.appendChild(kvCard('Receipts', [
    ['Receipts', fmtInt(receipts.receipts)],
    ['Canary receipts', fmtInt(receipts.canary_receipts)],
    ['Own receipts', fmtInt(receipts.own_receipts)],
    ['Proof req / verified', `${fmtInt(receipts.proof_requested)} / ${fmtInt(receipts.proof_verified)}`],
    ['Avg tok/s', receipts.avg_tok_s != null ? receipts.avg_tok_s.toFixed(1) : '—'],
  ]));
  grid.appendChild(kvCard('Last closed epoch', [
    ['Epoch', fmtInt(lastScore.last_scored_epoch)],
    ['Epoch score', lastScore.epoch_score != null ? lastScore.epoch_score.toFixed(4) : '—'],
    ['EMA score', lastScore.ema_score != null ? lastScore.ema_score.toFixed(4) : '—'],
    ['Own / all / expected receipts', `${fmtInt(lastScore.own_receipts)} / ${fmtInt(lastScore.all_receipts)} / ${fmtInt(lastScore.expected_receipts)}`],
    ['Proof tests / fail', `${fmtInt(lastScore.proof_tests)} / ${fmtInt(lastScore.proof_failures)}`],
    ['TEE tests / fail / verified', `${fmtInt(lastScore.tee_tests)} / ${fmtInt(lastScore.tee_failures)} / ${lastScore.tee_verified ? 'Yes' : 'No'}`],
  ]));
  wrap.appendChild(grid);

  wrap.appendChild(capacityAuditNode(entry.capacity_audit));

  if (entry.next_steps && entry.next_steps.length) wrap.appendChild(nextStepsNode(entry.next_steps));

  return wrap;
}

function hintsNode(hints) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'debug-section-title', 'Hints'));
  const ul = el('ul', 'debug-list');
  hints.forEach((h) => {
    const li = el('li', null, typeof h === 'string' ? h : h.message);
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  return wrap;
}

function nextStepsNode(steps) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'debug-section-title', 'Recommended next steps'));
  const ul = el('ul', 'debug-list');
  steps.forEach((s) => ul.appendChild(el('li', null, s)));
  wrap.appendChild(ul);
  return wrap;
}

function rawJsonNode(raw) {
  const details = el('details', 'debug-raw');
  details.appendChild(el('summary', null, 'Raw JSON response'));
  const pre = el('pre', null, JSON.stringify(raw, null, 2));
  details.appendChild(pre);
  return details;
}

function renderDebugModalBody() {
  const body = $('#debugModalBody');
  body.innerHTML = '';

  if (debugState.loading && !debugState.payload) {
    body.appendChild(debugLoadingNode());
    return;
  }
  if (debugState.error) {
    body.appendChild(debugErrorNode(debugState.error));
    return;
  }
  if (!debugState.payload) return;

  const g = debugState.payload;

  body.appendChild(issueBannerNode(g.primaryIssue));

  if (g.identity) body.appendChild(identityCardNode(g.identity));

  body.appendChild(summaryGridNode(g.summary, g.network));

  if (debugState.kind === 'entry' && g.entries.length) {
    body.appendChild(backToOverviewButtonNode());
    body.appendChild(entryDeepDiveNode(g.entries[0]));
  } else if (g.entries.length) {
    body.appendChild(entriesListNode(g.entries));
  }

  body.appendChild(uidGateNode(g.uidGate));

  if (g.hints && g.hints.length) body.appendChild(hintsNode(g.hints));
  if (g.nextSteps && g.nextSteps.length) body.appendChild(nextStepsNode(g.nextSteps));

  body.appendChild(rawJsonNode(debugState.raw));
}

function showError(err) {
  const banner = $('#errorBanner');
  banner.hidden = false;
  banner.innerHTML = `Could not load <code>/api/dashboard</code> (${err.message || err}). If you opened this file
    directly or via a plain static server, the browser's CORS policy blocks cross-origin requests to
    <code>verathos.ai</code>. Run the included proxy instead: <code>python3 server.py</code>, then open
    <code>http://localhost:8000</code>.`;
}
function hideError() { $('#errorBanner').hidden = true; }

// ---------- named watch groups (persisted per-browser, not shared across devices) ----------
const WATCHLIST_LOCAL_KEY = 'verathos-watched-uids';
const WATCHGROUPS_LOCAL_KEY = 'verathos-watched-groups-v2';
let editingWatchGroupId = null;

function makeWatchGroupId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function activeWatchGroup() {
  return state.watchGroups.find((group) => group.id === state.activeWatchGroupId) || null;
}

function setWatchedOnly(enabled) {
  state.showWatchedOnly = enabled;
  $('#watchedToggle')?.classList.toggle('active', enabled);
}

function watchedGroupScore(group) {
  if (!state.miners.length || !group?.uids?.length) return null;
  const uids = new Set(group.uids);
  return state.miners.reduce((total, miner) => {
    if (!uids.has(miner.uid) || typeof miner.score !== 'number' || Number.isNaN(miner.score)) return total;
    return total + miner.score;
  }, 0);
}

function watchGroupLabel(group) {
  const base = `${group.name} (${group.uids.length})`;
  const score = watchedGroupScore(group);
  return score === null ? base : `${base} - ${score.toFixed(1)}`;
}

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHGROUPS_LOCAL_KEY) || 'null');
    if (saved?.groups?.length) {
      state.watchGroups = saved.groups
        .filter((group) => group && typeof group.name === 'string' && Array.isArray(group.uids))
        .map((group) => ({
          id: String(group.id || makeWatchGroupId()),
          name: group.name.trim() || 'Unnamed group',
          uids: [...new Set(group.uids.filter((uid) => Number.isInteger(uid) && uid >= 0))],
        }));
      state.activeWatchGroupId = state.watchGroups.some((group) => group.id === saved.activeGroupId)
        ? saved.activeGroupId
        : state.watchGroups[0]?.id;
    }
  } catch (err) {
    console.warn('Could not read saved watched groups:', err);
  }

  if (!state.watchGroups.length) {
    let legacyUids = [];
    try {
      const legacy = JSON.parse(localStorage.getItem(WATCHLIST_LOCAL_KEY) || '[]');
      if (Array.isArray(legacy)) legacyUids = legacy.filter((uid) => Number.isInteger(uid) && uid >= 0);
    } catch (err) {
      console.warn('Could not migrate the old watchlist:', err);
    }
    const initialGroup = { id: makeWatchGroupId(), name: 'My watched miners', uids: [...new Set(legacyUids)] };
    state.watchGroups = [initialGroup];
    state.activeWatchGroupId = initialGroup.id;
  }

  state.watched = new Set(activeWatchGroup()?.uids || []);
  renderWatchGroupSelect();
  updateWatchedCount();
  saveWatchlist();
}

function saveWatchlist() {
  const group = activeWatchGroup();
  if (group) group.uids = [...state.watched].sort((a, b) => a - b);
  localStorage.setItem(WATCHGROUPS_LOCAL_KEY, JSON.stringify({
    version: 2,
    activeGroupId: state.activeWatchGroupId,
    groups: state.watchGroups,
  }));
}

function renderWatchGroupSelect() {
  const select = $('#watchGroupSelect');
  if (!select) return;
  select.innerHTML = '';
  state.watchGroups.forEach((group) => {
    const option = el('option');
    option.value = group.id;
    option.textContent = watchGroupLabel(group);
    select.appendChild(option);
  });
  select.value = state.activeWatchGroupId || '';
}

function selectWatchGroup(groupId) {
  const group = state.watchGroups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  state.activeWatchGroupId = group.id;
  state.watched = new Set(group.uids);
  $('#uidFilter').value = '';
  setWatchedOnly(true);
  updateWatchedCount();
  saveWatchlist();
  renderMinersTable();
}

function parseWatchGroupUids(value) {
  const tokens = value.trim() ? value.trim().split(/[\s,]+/) : [];
  const invalid = tokens.filter((token) => !/^\d+$/.test(token));
  if (invalid.length) throw new Error(`Invalid UID${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
  return [...new Set(tokens.map(Number))].sort((a, b) => a - b);
}

function createWatchGroup(name, uids) {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Enter a group or user name.');
  if (state.watchGroups.some((group) => group.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('A watched group with this name already exists.');
  }
  const group = { id: makeWatchGroupId(), name: normalizedName, uids };
  state.watchGroups.push(group);
  state.activeWatchGroupId = group.id;
  state.watched = new Set(uids);
  $('#uidFilter').value = '';
  setWatchedOnly(true);
  renderWatchGroupSelect();
  updateWatchedCount();
  saveWatchlist();
  renderMinersTable();
}

function updateWatchGroup(groupId, name, uids) {
  const group = state.watchGroups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error('The watched group no longer exists.');

  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Enter a group or user name.');
  if (state.watchGroups.some((candidate) => (
    candidate.id !== groupId && candidate.name.toLowerCase() === normalizedName.toLowerCase()
  ))) {
    throw new Error('A watched group with this name already exists.');
  }

  group.name = normalizedName;
  group.uids = uids;
  state.watched = new Set(uids);
  renderWatchGroupSelect();
  updateWatchedCount();
  saveWatchlist();
  renderMinersTable();
}

function deleteActiveWatchGroup() {
  const groupIndex = state.watchGroups.findIndex((group) => group.id === state.activeWatchGroupId);
  if (groupIndex < 0) return;

  const group = state.watchGroups[groupIndex];
  const uidLabel = `${group.uids.length} watched UID${group.uids.length === 1 ? '' : 's'}`;
  if (!window.confirm(`Delete "${group.name}" and its ${uidLabel}? This cannot be undone.`)) return;

  state.watchGroups.splice(groupIndex, 1);
  if (!state.watchGroups.length) {
    state.watchGroups.push({
      id: makeWatchGroupId(),
      name: 'My watched miners',
      uids: [],
    });
  }

  const nextGroup = state.watchGroups[Math.min(groupIndex, state.watchGroups.length - 1)];
  state.activeWatchGroupId = nextGroup.id;
  state.watched = new Set(nextGroup.uids);
  $('#uidFilter').value = '';
  setWatchedOnly(true);
  renderWatchGroupSelect();
  updateWatchedCount();
  saveWatchlist();
  renderMinersTable();
}

function toggleWatch(uid) {
  if (state.watched.has(uid)) state.watched.delete(uid);
  else state.watched.add(uid);
  updateWatchedCount();
  saveWatchlist();
  renderWatchGroupSelect();
  renderMinersTable();
}

function updateWatchedCount() {
  $('#watchedCount').textContent = state.watched.size;
}

function openWatchGroupModal(group = null) {
  editingWatchGroupId = group?.id || null;
  $('#watchGroupForm').reset();
  $('#watchGroupError').hidden = true;
  $('#watchGroupModalTitle').textContent = group ? 'Edit watched group' : 'New watched group';
  $('#watchGroupModalSubtitle').textContent = group
    ? 'Update the group name and its watched miner UIDs.'
    : 'Save a named set of miner UIDs in this browser.';
  $('#watchGroupSubmit').textContent = group ? 'Save changes' : 'Create group';
  if (group) {
    $('#watchGroupName').value = group.name;
    $('#watchGroupUids').value = group.uids.join(', ');
  }
  $('#watchGroupModalOverlay').hidden = false;
  requestAnimationFrame(() => $('#watchGroupName').focus());
}

function openEditWatchGroupModal() {
  const group = activeWatchGroup();
  if (group) openWatchGroupModal(group);
}

function closeWatchGroupModal() {
  $('#watchGroupModalOverlay').hidden = true;
  editingWatchGroupId = null;
}

// ---------- Telegram probation alerts ----------
async function loadTelegramSettings() {
  try {
    const saved = IS_EXTENSION && chrome.storage?.local
      ? (await chrome.storage.local.get(TELEGRAM_SETTINGS_LOCAL_KEY))[TELEGRAM_SETTINGS_LOCAL_KEY]
      : JSON.parse(localStorage.getItem(TELEGRAM_SETTINGS_LOCAL_KEY) || 'null');
    if (saved && typeof saved.botToken === 'string' && typeof saved.chatId === 'string') {
      state.telegram = { botToken: saved.botToken, chatId: saved.chatId };
    }
  } catch (err) {
    console.warn('Could not read Telegram settings:', err);
  }
  updateTelegramSettingsIndicator();
}

async function saveTelegramSettings(settings) {
  state.telegram = settings;
  if (IS_EXTENSION && chrome.storage?.local) {
    await chrome.storage.local.set({ [TELEGRAM_SETTINGS_LOCAL_KEY]: settings });
  } else {
    localStorage.setItem(TELEGRAM_SETTINGS_LOCAL_KEY, JSON.stringify(settings));
  }
  updateTelegramSettingsIndicator();
}

function loadProbationState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROBATION_STATE_LOCAL_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) state.probationByUid = saved;
  } catch (err) {
    console.warn('Could not read saved probation state:', err);
    state.probationByUid = {};
  }
}

function saveProbationState() {
  localStorage.setItem(PROBATION_STATE_LOCAL_KEY, JSON.stringify(state.probationByUid));
}

function updateTelegramSettingsIndicator() {
  const configured = Boolean(state.telegram.botToken && state.telegram.chatId);
  const button = $('#settingsBtn');
  button.classList.toggle('configured', configured);
  button.title = configured ? 'Telegram alerts connected' : 'Telegram alert settings';
}

function openSettingsModal() {
  $('#telegramBotToken').value = state.telegram.botToken;
  $('#telegramChatId').value = state.telegram.chatId;
  const status = $('#telegramConnectionStatus');
  status.hidden = true;
  status.className = 'connection-status';
  $('#settingsModalOverlay').hidden = false;
  requestAnimationFrame(() => $('#telegramBotToken').focus());
}

function closeSettingsModal() {
  $('#settingsModalOverlay').hidden = true;
}

function validateTelegramSettings(botToken, chatId) {
  const token = botToken.trim();
  const chat = chatId.trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Enter a valid Telegram bot token from @BotFather.');
  }
  if (!chat || /\s/.test(chat)) throw new Error('Enter a valid Telegram chat ID or @channel username.');
  return { botToken: token, chatId: chat };
}

async function sendTelegramMessage(text, settings = state.telegram) {
  if (!settings.botToken || !settings.chatId) throw new Error('Telegram alerts are not configured.');

  const url = IS_EXTENSION
    ? `https://api.telegram.org/bot${settings.botToken}/sendMessage`
    : '/api/telegram/send-message';
  const body = IS_EXTENSION
    ? { chat_id: settings.chatId, text }
    : { bot_token: settings.botToken, chat_id: settings.chatId, text };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error(`Telegram returned HTTP ${response.status}.`);
  }
  if (!response.ok || result.ok === false) {
    throw new Error(result.description || result.error || `Telegram returned HTTP ${response.status}.`);
  }
  return result;
}

function allWatchedUids() {
  return new Set(state.watchGroups.flatMap((group) => group.uids));
}

function watchedGroupNamesForUid(uid) {
  return state.watchGroups.filter((group) => group.uids.includes(uid)).map((group) => group.name);
}

function checkForNewProbations() {
  const watchedUids = allWatchedUids();
  const currentByUid = new Map();
  const minerByUid = new Map();

  state.miners.forEach((miner) => {
    if (!watchedUids.has(miner.uid)) return;
    currentByUid.set(miner.uid, Boolean(currentByUid.get(miner.uid) || miner.on_probation));
    if (!minerByUid.has(miner.uid)) minerByUid.set(miner.uid, miner);
  });

  const nextState = {};
  const newProbations = [];
  watchedUids.forEach((uid) => {
    const key = String(uid);
    if (!currentByUid.has(uid)) {
      if (Object.hasOwn(state.probationByUid, key)) nextState[key] = state.probationByUid[key];
      return;
    }
    const isOnProbation = currentByUid.get(uid);
    const hadPreviousState = Object.hasOwn(state.probationByUid, key);
    if (hadPreviousState && state.probationByUid[key] === false && isOnProbation) {
      newProbations.push({ uid, miner: minerByUid.get(uid), groups: watchedGroupNamesForUid(uid) });
    }
    nextState[key] = isOnProbation;
  });

  state.probationByUid = nextState;
  saveProbationState();
  if (newProbations.length && state.telegram.botToken && state.telegram.chatId) {
    notifyNewProbations(newProbations);
  }
}

async function notifyNewProbations(events) {
  const lines = ['⚠️ Verathos probation alert', ''];
  events.forEach(({ uid, miner, groups }, index) => {
    if (index) lines.push('');
    lines.push(`UID ${uid} entered probation.`);
    const hotkey = miner?.ss58_address || miner?.hotkey_ss58 || miner?.hotkey || miner?.address;
    if (hotkey) lines.push(`Hotkey: ${hotkey}`);
    lines.push(`Watched group${groups.length === 1 ? '' : 's'}: ${groups.join(', ')}`);
  });
  lines.push('', `Detected: ${new Date().toLocaleString()}`);

  try {
    await sendTelegramMessage(lines.join('\n').slice(0, 4000));
  } catch (err) {
    console.error('Could not send Telegram probation alert:', err);
    events.forEach(({ uid }) => {
      state.probationByUid[String(uid)] = false;
    });
    saveProbationState();
  }
}

// ---------- render: top stat sections ----------
function statCard(label, value, sub, accent) {
  const card = el('div', 'stat-card' + (accent ? ' accent' : ''));
  card.appendChild(el('div', 'label', label));
  card.appendChild(el('div', 'value', value));
  if (sub) card.appendChild(el('div', 'sub', sub));
  return card;
}

function renderNetworkStats(network, epoch) {
  const wrap = $('#networkStats');
  wrap.innerHTML = '';
  const healthyPct = network.total_miners ? (network.healthy_miners / network.total_miners) * 100 : 0;
  wrap.appendChild(statCard('Total Miners', fmtInt(network.total_miners)));
  wrap.appendChild(statCard('Healthy Miners', fmtInt(network.healthy_miners), `${fmtPct(healthyPct)} of network`, true));
  wrap.appendChild(statCard('Total Models', fmtInt(network.total_models)));
  wrap.appendChild(statCard('Total Validators', fmtInt(network.total_validators)));
  wrap.appendChild(statCard('Organic Requests', fmtCompact(network.organic_requests)));
  wrap.appendChild(statCard('Organic Tokens', fmtCompact(network.organic_tokens)));
}

function renderUsageStats(u) {
  const wrap = $('#usageStats');
  wrap.innerHTML = '';
  wrap.appendChild(statCard('Total Requests', fmtCompact(u.total_requests), fmtInt(u.total_requests) + ' exact'));
  wrap.appendChild(statCard('Total Input Tokens', fmtCompact(u.total_input_tokens)));
  wrap.appendChild(statCard('Total Output Tokens', fmtCompact(u.total_output_tokens)));
  wrap.appendChild(statCard('Active Users (24h)', fmtInt(u.active_users_24h), null, true));
  wrap.appendChild(statCard('Requests (1h)', fmtCompact(u.requests_1h)));
  wrap.appendChild(statCard('Tokens (1h)', fmtCompact(u.tokens_1h)));
  wrap.appendChild(statCard('Requests (24h)', fmtCompact(u.requests_24h)));
  wrap.appendChild(statCard('Tokens (24h)', fmtCompact(u.tokens_24h)));
}

// ---------- render: models ----------
function renderModels(models, usageModels) {
  const wrap = $('#modelsGrid');
  wrap.innerHTML = '';
  const usageByModel = new Map((usageModels || []).map((m) => [m.model_id, m]));
  const maxDemand = Math.max(1, ...models.map((m) => m.demand_score_bps || 0));

  [...models]
    .sort((a, b) => (b.demand_score_bps || 0) - (a.demand_score_bps || 0))
    .forEach((m) => {
      const usage = usageByModel.get(m.model_id);
      const card = el('div', 'model-card');
      card.appendChild(el('div', 'name', m.name || m.model_id.split('/').pop()));
      card.appendChild(el('div', 'id', m.model_id));

      const demandRow = el('div', 'row');
      demandRow.appendChild(el('span', null, 'Demand score'));
      demandRow.appendChild(el('b', null, fmtPct((m.demand_score_bps || 0) / 100)));
      card.appendChild(demandRow);

      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${((m.demand_score_bps || 0) / maxDemand) * 100}%`;
      track.appendChild(fill);
      card.appendChild(track);

      if (usage) {
        const reqRow = el('div', 'row');
        reqRow.appendChild(el('span', null, 'Requests'));
        reqRow.appendChild(el('b', null, fmtCompact(usage.requests)));
        card.appendChild(reqRow);

        const tokRow = el('div', 'row');
        tokRow.appendChild(el('span', null, 'Tokens (in/out)'));
        tokRow.appendChild(el('b', null, `${fmtCompact(usage.input_tokens)} / ${fmtCompact(usage.output_tokens)}`));
        card.appendChild(tokRow);
      }
      wrap.appendChild(card);
    });
}

// ---------- render: validators ----------
function renderValidators(validators) {
  const tbody = $('#validatorsTable tbody');
  tbody.innerHTML = '';
  [...validators]
    .sort((a, b) => b.stake - a.stake)
    .forEach((v) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', v.uid));
      const addrTd = el('td', 'mono', fmtTruncated(v.address));
      addrTd.title = v.address;
      tr.appendChild(addrTd);
      const ss58Td = el('td', 'mono', fmtTruncated(v.ss58_address, 8, 6));
      ss58Td.title = v.ss58_address;
      tr.appendChild(ss58Td);
      tr.appendChild(el('td', null, fmtInt(v.stake) + ' τ'));
      tr.appendChild(el('td', 'mono', v.proxy_endpoint || '—'));
      const statusTd = el('td');
      statusTd.appendChild(badge(v.active ? 'active' : 'inactive', v.active ? 'green' : 'gray'));
      tr.appendChild(statusTd);
      tr.appendChild(el('td', null, fmtDate(v.registered_at)));
      tbody.appendChild(tr);
    });
}

function badge(text, color) {
  const b = el('span', `badge ${color}`, text);
  return b;
}

// ---------- render: miners ----------
function normalizeMiner(m) {
  return {
    ...m,
    organic_requests: m.organic_stats?.requests ?? 0,
    organic_tokens: m.organic_stats?.tokens ?? 0,
    avg_ttft_ms: m.organic_stats?.avg_ttft_ms ?? null,
    avg_tok_s: m.organic_stats?.avg_tok_s ?? null,
  };
}

function populateModelFilter(miners) {
  const sel = $('#modelFilter');
  const current = sel.value;
  const models = [...new Set(miners.map((m) => m.model_id))].sort();
  sel.innerHTML = '<option value="">All models</option>' +
    models.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id.split('/').pop())}</option>`).join('');
  sel.value = current;
}

function populateUidFilter(miners) {
  const sel = $('#uidFilter');
  const current = sel.value;
  const uids = [...new Set(miners.map((m) => m.uid))]
    .sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  sel.innerHTML = '<option value="">All UIDs</option>' +
    uids.map((uid) => `<option value="${uid}">${uid === null ? 'Unregistered (no UID)' : 'UID ' + uid}</option>`).join('');
  sel.value = current;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function applyMinersFilter() {
  const q = $('#minerSearch').value.trim().toLowerCase();
  const uidFilter = $('#uidFilter').value;
  const modelFilter = $('#modelFilter').value;
  const healthFilter = $('#healthFilter').value;
  const flagFilter = $('#flagFilter').value;

  return state.miners.filter((m) => {
    if (state.showWatchedOnly && !state.watched.has(m.uid)) return false;
    if (uidFilter !== '' && String(m.uid) !== uidFilter) return false;
    if (modelFilter && m.model_id !== modelFilter) return false;
    if (healthFilter === 'healthy' && !m.healthy) return false;
    if (healthFilter === 'unhealthy' && m.healthy) return false;
    if (flagFilter === 'probation' && !m.on_probation) return false;
    if (flagFilter === 'blacklisted' && !m.is_blacklisted) return false;
    if (flagFilter === 'tee' && !m.tee_enabled) return false;
    if (q) {
      const hay = [
        m.ss58_address,
        m.address,
        m.hotkey,
        m.hotkey_ss58,
        m.model_id,
        m.gpu_name,
        m.endpoint,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function makeRowComparator(sortKey, sortDir) {
  return (a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (sortKey === 'healthy') { av = av ? 1 : 0; bv = bv ? 1 : 0; }
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av === undefined || av === null) av = sortDir === 'asc' ? Infinity : -Infinity;
    if (bv === undefined || bv === null) bv = sortDir === 'asc' ? Infinity : -Infinity;
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  };
}

// Groups deployments that belong to the same miner UID so they render as one
// visual block (Miner/UID cells shown once, on the group's first row).
function groupMinerRows(rows, sortKey, sortDir) {
  const groups = [];
  const groupByKey = new Map();

  rows.forEach((m, i) => {
    const key = m.uid === null || m.uid === undefined ? `__none-${i}` : `uid-${m.uid}`;
    let g = groupByKey.get(key);
    if (!g) {
      g = { rows: [] };
      groupByKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(m);
  });

  const cmp = makeRowComparator(sortKey, sortDir);
  groups.forEach((g) => g.rows.sort(cmp));
  groups.sort((a, b) => cmp(a.rows[0], b.rows[0]));

  const flat = [];
  groups.forEach((g) => {
    g.rows.forEach((m, idx) => flat.push({ ...m, __groupStart: idx === 0 }));
  });
  return flat;
}

function renderMinersTable() {
  const filtered = applyMinersFilter();
  const rows = groupMinerRows(filtered, state.sortKey, state.sortDir);
  const shown = Math.min(rows.length, state.pageSize);
  $('#minerCount').textContent = `(${fmtInt(shown)} of ${fmtInt(rows.length)})`;

  const tbody = document.querySelector('#minersTable tbody');
  tbody.innerHTML = '';

  rows.slice(0, state.pageSize).forEach((m) => {
    const tr = el('tr');
    const isWatched = state.watched.has(m.uid);
    if (isWatched) tr.classList.add('watched');
    if (m.__groupStart) tr.classList.add('group-start');

    const watchTd = el('td', 'watch-cell');
    if (m.__groupStart && m.uid !== null && m.uid !== undefined) {
      const starBtn = el('button', 'watch-star' + (isWatched ? ' active' : ''), isWatched ? '★' : '☆');
      starBtn.type = 'button';
      starBtn.title = isWatched ? 'Stop watching this miner' : 'Watch this miner';
      starBtn.addEventListener('click', () => toggleWatch(m.uid));
      watchTd.appendChild(starBtn);
    }
    tr.appendChild(watchTd);

    const minerTd = el('td', 'mono');
    if (m.__groupStart) {
      minerTd.textContent = fmtTruncated(m.ss58_address || m.address);
      minerTd.title = m.ss58_address || m.address || '';
    }
    tr.appendChild(minerTd);

    const uidTd = el('td', 'mono');
    if (m.__groupStart) uidTd.textContent = m.uid ?? '—';
    tr.appendChild(uidTd);

    const modelTd = el('td');
    const modelMain = el('span', 'cell-main', m.model_id.split('/').pop());
    modelTd.appendChild(modelMain);
    modelTd.title = m.model_id;
    const ctxK = m.max_context_len ? Math.round(m.max_context_len / 1000) + 'k' : null;
    modelTd.appendChild(el('span', 'muted', ` ${[m.quant, ctxK].filter(Boolean).join(' ')}`));
    modelTd.appendChild(el('div', 'cell-sub mono', m.endpoint || ''));
    tr.appendChild(modelTd);

    const gpuTd = el('td');
    let gpuName = m.gpu_name || '—';
    if (m.gpu_count > 1) gpuName += ` ×${m.gpu_count}`;
    gpuTd.appendChild(el('span', 'cell-main', gpuName));
    if (m.tee_enabled) gpuTd.appendChild(el('span', 'tee-chip', 'TEE'));
    if (m.vram_gb) gpuTd.appendChild(el('div', 'cell-sub', `${m.vram_gb} GB`));
    tr.appendChild(gpuTd);

    const healthTd = el('td');
    healthTd.appendChild(el('span', `health-dot ${m.healthy ? 'up' : 'down'}`));
    tr.appendChild(healthTd);

    tr.appendChild(el('td', null, m.score != null ? m.score.toFixed(2) : '—'));
    tr.appendChild(el('td', null, m.healthy ? fmtInt(m.organic_requests) : '—'));
    tr.appendChild(el('td', null, m.healthy && m.avg_tok_s != null ? m.avg_tok_s.toFixed(1) : '—'));

    const statusTd = el('td', 'status-col');
    let statusLabel = 'active', statusClass = 'active';
    if (m.is_blacklisted) { statusLabel = 'blacklisted'; statusClass = 'blacklisted'; }
    else if (m.on_probation) { statusLabel = 'probation'; statusClass = 'probation'; }
    statusTd.appendChild(el('span', `status-pill ${statusClass}`, statusLabel));
    tr.appendChild(statusTd);

    const debugTd = el('td', 'debug-col');
    if (m.uid !== null && m.uid !== undefined && m.model_index !== null && m.model_index !== undefined) {
      const debugBtn = el('button', 'debug-btn', 'Debug');
      debugBtn.type = 'button';
      debugBtn.title = `Debug UID ${m.uid} · model #${m.model_index}`;
      debugBtn.addEventListener('click', () => openDebugModal(m.uid, m.model_index, 24));
      debugTd.appendChild(debugBtn);
    }
    tr.appendChild(debugTd);

    tbody.appendChild(tr);
  });

  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll('#minersTable thead th[data-key]').forEach((th) => {
    const base = th.textContent.replace(/ [▲▼]$/, '');
    if (th.dataset.key === state.sortKey) {
      th.textContent = base + (state.sortDir === 'asc' ? ' ▲' : ' ▼');
    } else {
      th.textContent = base;
    }
  });
}

// ---------- top-level render ----------
function render(data) {
  $('#epochPill').textContent = `epoch ${fmtInt(data.epoch_number)}`;
  renderNetworkStats(data.network, data.epoch_number);
  renderUsageStats(data.usage_stats);
  renderModels(data.models, data.usage_stats.models);
  renderValidators(data.validators);

  state.miners = data.miners.map(normalizeMiner);
  populateUidFilter(state.miners);
  populateModelFilter(state.miners);
  renderWatchGroupSelect();
  renderMinersTable();
  checkForNewProbations();
}

// ---------- events ----------
function initEvents() {
  $('#refreshBtn').addEventListener('click', () => loadData());
  $('#settingsBtn').addEventListener('click', openSettingsModal);
  $('#settingsModalClose').addEventListener('click', closeSettingsModal);
  $('#telegramSettingsCancel').addEventListener('click', closeSettingsModal);
  $('#settingsModalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#settingsModalOverlay')) closeSettingsModal();
  });
  $('#telegramSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#telegramConnectionStatus');
    const button = $('#telegramConnectBtn');
    status.hidden = false;
    status.className = 'connection-status';
    status.textContent = 'Connecting and sending the initial message…';
    button.disabled = true;
    try {
      const settings = validateTelegramSettings($('#telegramBotToken').value, $('#telegramChatId').value);
      await sendTelegramMessage(
        '✅ Verathos Dashboard connected.\nProbation alerts are enabled for all watched groups.',
        settings,
      );
      await saveTelegramSettings(settings);
      status.classList.add('success');
      status.textContent = 'Connected. The initial Telegram message was sent successfully.';
    } catch (err) {
      status.classList.add('error');
      status.textContent = err.message || String(err);
    } finally {
      button.disabled = false;
    }
  });
  $('#themeBtn').addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('verathos-theme', isDark ? 'dark' : 'light');
  });

  $('#watchedToggle').addEventListener('click', () => {
    setWatchedOnly(!state.showWatchedOnly);
    renderMinersTable();
  });
  $('#watchGroupSelect').addEventListener('change', (e) => selectWatchGroup(e.target.value));
  $('#newWatchGroupBtn').addEventListener('click', () => openWatchGroupModal());
  $('#editWatchGroupBtn').addEventListener('click', openEditWatchGroupModal);
  $('#deleteWatchGroupBtn').addEventListener('click', deleteActiveWatchGroup);
  $('#watchGroupModalClose').addEventListener('click', closeWatchGroupModal);
  $('#watchGroupCancel').addEventListener('click', closeWatchGroupModal);
  $('#watchGroupModalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#watchGroupModalOverlay')) closeWatchGroupModal();
  });
  $('#watchGroupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const error = $('#watchGroupError');
    try {
      const name = $('#watchGroupName').value;
      const uids = parseWatchGroupUids($('#watchGroupUids').value);
      if (editingWatchGroupId) updateWatchGroup(editingWatchGroupId, name, uids);
      else createWatchGroup(name, uids);
      closeWatchGroupModal();
    } catch (err) {
      error.textContent = err.message || String(err);
      error.hidden = false;
    }
  });

  $('#minerSearch').addEventListener('input', () => renderMinersTable());
  $('#uidFilter').addEventListener('change', (e) => {
    if (e.target.value !== '') setWatchedOnly(false);
    renderMinersTable();
  });
  $('#modelFilter').addEventListener('change', () => renderMinersTable());
  $('#healthFilter').addEventListener('change', () => renderMinersTable());
  $('#flagFilter').addEventListener('change', () => renderMinersTable());

  document.querySelectorAll('#pageSizeTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pageSize = btn.dataset.size === 'all' ? Infinity : parseInt(btn.dataset.size, 10);
      document.querySelectorAll('#pageSizeTabs button').forEach((b) => b.classList.toggle('active', b === btn));
      renderMinersTable();
    });
  });

  document.querySelectorAll('#minersTable thead th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'desc';
      }
      renderMinersTable();
    });
  });

  $('#debugLookupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const uid = parseInt($('#debugUidInput').value, 10);
    if (Number.isNaN(uid)) return;
    const miRaw = $('#debugModelIndexInput').value.trim();
    const modelIndex = miRaw === '' ? null : parseInt(miRaw, 10);
    const windowH = parseInt($('#debugWindowSelect').value, 10);
    openDebugModal(uid, modelIndex, windowH);
  });

  $('#debugModalClose').addEventListener('click', closeDebugModal);
  $('#debugModalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#debugModalOverlay')) closeDebugModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#debugModalOverlay').hidden) closeDebugModal();
    if (e.key === 'Escape' && !$('#watchGroupModalOverlay').hidden) closeWatchGroupModal();
    if (e.key === 'Escape' && !$('#settingsModalOverlay').hidden) closeSettingsModal();
  });
  $('#debugModalRefresh').addEventListener('click', () => loadDebugModal());
  $('#debugModalWindowSelect').addEventListener('change', (e) => {
    debugState.windowH = parseInt(e.target.value, 10);
    loadDebugModal();
  });
}

async function init() {
  initEvents();
  loadWatchlist();
  await loadTelegramSettings();
  loadProbationState();
  tickEpochCountdown();
  setInterval(tickEpochCountdown, 1000);
  await loadData();
  setInterval(() => loadData({ silent: true }), REFRESH_MS);
}

init();
