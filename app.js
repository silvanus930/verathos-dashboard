'use strict';

const API_CANDIDATES = ['/api/dashboard', 'https://verathos.ai/api/dashboard'];
const REFRESH_MS = 5 * 60 * 1000;

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
  showWatchedOnly: false,
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

function showError(err) {
  const banner = $('#errorBanner');
  banner.hidden = false;
  banner.innerHTML = `Could not load <code>/api/dashboard</code> (${err.message || err}). If you opened this file
    directly or via a plain static server, the browser's CORS policy blocks cross-origin requests to
    <code>verathos.ai</code>. Run the included proxy instead: <code>python3 server.py</code>, then open
    <code>http://localhost:8000</code>.`;
}
function hideError() { $('#errorBanner').hidden = true; }

// ---------- watchlist (persisted per-browser in localStorage, not shared across devices) ----------
const WATCHLIST_LOCAL_KEY = 'verathos-watched-uids';

function loadWatchlist() {
  const raw = localStorage.getItem(WATCHLIST_LOCAL_KEY);
  state.watched = new Set(raw ? JSON.parse(raw) : []);
  updateWatchedCount();
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_LOCAL_KEY, JSON.stringify([...state.watched]));
}

function toggleWatch(uid) {
  if (state.watched.has(uid)) state.watched.delete(uid);
  else state.watched.add(uid);
  updateWatchedCount();
  saveWatchlist();
  renderMinersTable();
}

function updateWatchedCount() {
  $('#watchedCount').textContent = state.watched.size;
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
      const hay = `${m.model_id} ${m.gpu_name} ${m.endpoint}`.toLowerCase();
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
  renderMinersTable();
}

// ---------- events ----------
function initEvents() {
  $('#refreshBtn').addEventListener('click', () => loadData());
  $('#themeBtn').addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('verathos-theme', isDark ? 'dark' : 'light');
  });

  $('#watchedToggle').addEventListener('click', () => {
    state.showWatchedOnly = !state.showWatchedOnly;
    $('#watchedToggle').classList.toggle('active', state.showWatchedOnly);
    renderMinersTable();
  });

  $('#minerSearch').addEventListener('input', () => renderMinersTable());
  $('#uidFilter').addEventListener('change', () => renderMinersTable());
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
}

async function init() {
  initEvents();
  loadWatchlist();
  tickEpochCountdown();
  setInterval(tickEpochCountdown, 1000);
  await loadData();
  setInterval(() => loadData({ silent: true }), REFRESH_MS);
}

init();
