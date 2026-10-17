/* XMR Wizard — node hub (merged from xmr-niblet).
 *
 * Browser-side latency probing for Monero public nodes.
 *
 * Why the <img> trick: this page is served over HTTPS, and browsers block
 * fetch()/XHR to http:// node RPC ports as mixed content. monerod also
 * doesn't send CORS headers by default. An <img> pointed at the RPC port
 * fails to load (monerod returns an error page, not an image) — but the
 * time from request to failure IS the real network round trip.
 *
 * Speed alone can't prove a node is healthy (a refused connection fails
 * fast, which looks like a great ping). That's why status.json exists:
 * an hourly GitHub Actions job calls get_info on every clearnet node and
 * records height/version, so dead or stale nodes are marked offline even
 * when the browser probe can't tell.
 *
 * The hub runs a fresh test every time you enter the Node Map or Node
 * List tab — see nodeEnter().
 */
const NODES_URL = 'nodes.json';
const STATUS_URL = 'status.json';
const PROBES_PER_NODE = 3;
const PROBE_TIMEOUT_MS = 6000;
const BEHIND_BLOCKS = 5; // node is "behind" if this many blocks under the network max

const nodeState = {
  nodes: [],
  results: new Map(), // "host:port" -> { samples: [], ms: number|null, state: 'idle'|'testing'|'done' }
  health: new Map(),  // "host:port" -> { state: 'synced'|'behind'|'offline'|'unknown', height, version, nettype }
  healthAt: null,
  testing: false,
  filter: 'all',
  hideOffline: true,
  activeTab: 'list',
  selectedKey: null, // host:port picked in the dropdown
  map: null,
  markers: null,
};

const $ = (id) => document.getElementById(id);
const nodeKey = (n) => `${n.host}:${n.port}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function loadNodes() {
  try {
    const res = await fetch(NODES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    nodeState.nodes = await res.json();
    for (const n of nodeState.nodes) nodeState.results.set(nodeKey(n), { samples: [], ms: null, state: 'idle' });
    $('status').textContent = `${nodeState.nodes.length} nodes loaded. Open the Node Map or Node List tab to test your connection — fresh ping every time.`;
  } catch (e) {
    $('status').textContent = `Could not load nodes.json (${e.message}). Serve this folder over HTTP or deploy it — file:// blocks the request.`;
    nodeState.nodes = [];
  }
  renderNodes();
  if (document.body.dataset.standaloneNodes) nodeEnter('map');
}

async function loadHealth() {
  try {
    const res = await fetch(`${STATUS_URL}?x=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    nodeState.healthAt = data.generated_at || null;
    const entries = data.nodes || {};
    const heights = Object.values(entries)
      .filter((e) => e.ok && typeof e.height === 'number')
      .map((e) => e.height);
    const maxHeight = heights.length ? Math.max(...heights) : 0;
    for (const [key, e] of Object.entries(entries)) {
      let hstate = 'unknown';
      if (!e.ok) hstate = 'offline';
      else if (typeof e.height === 'number' && maxHeight && maxHeight - e.height > BEHIND_BLOCKS) hstate = 'behind';
      else if (e.ok) hstate = 'synced';
      nodeState.health.set(key, { state: hstate, height: e.height || null, version: e.version || null, nettype: e.nettype || null });
    }
    const ok = [...nodeState.health.values()].filter((h) => h.state === 'synced').length;
    $('healthInfo').textContent = nodeState.healthAt
      ? `Health data from ${new Date(nodeState.healthAt).toLocaleString()} — ${ok} nodes synced, the rest are behind or offline.`
      : 'Health data loaded.';
  } catch {
    $('healthInfo').textContent = 'No health data yet (the hourly check publishes it as status.json). Speed test still works.';
  }
  renderNodes();
}

function healthOf(node) {
  return nodeState.health.get(nodeKey(node)) || { state: 'unknown', height: null, version: null, nettype: null };
}

function probeOnce(host, port, https) {
  return new Promise((resolve) => {
    const scheme = https ? 'https' : 'http';
    const t0 = performance.now();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? performance.now() - t0 : null);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    const img = new Image();
    // onload or onerror both mean "something answered on that port"
    img.onload = () => done(true);
    img.onerror = () => done(true);
    img.src = `${scheme}://${host}:${port}/wizard-probe?x=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  });
}

async function probeNode(node) {
  const key = nodeKey(node);
  const entry = { samples: [], ms: null, state: 'testing' };
  nodeState.results.set(key, entry);
  renderNodes();
  const https = !!node.tls;
  for (let i = 0; i < PROBES_PER_NODE; i++) {
    const ms = await probeOnce(node.host, node.port, https);
    if (ms !== null) entry.samples.push(ms);
    renderNodes();
  }
  if (entry.samples.length) {
    const s = [...entry.samples].sort((a, b) => a - b);
    entry.ms = Math.round(s[Math.floor(s.length / 2)]);
  }
  entry.state = 'done';
  renderNodes();
}

async function nodeTestAll() {
  if (nodeState.testing || !nodeState.nodes.length) return;
  nodeState.testing = true;
  $('testBtn').disabled = true;
  $('testSpinner').hidden = false;
  $('status').textContent = 'Probing nodes from your connection…';
  await Promise.all(nodeState.nodes.map(probeNode));
  nodeState.testing = false;
  $('testBtn').disabled = false;
  $('testSpinner').hidden = true;
  const ok = [...nodeState.results.values()].filter((r) => r.ms !== null).length;
  $('status').textContent = ok
    ? `Done — ${ok}/${nodeState.nodes.length} nodes responded. Fastest healthy node first; copy the address into your wallet's remote node field.`
    : 'No nodes responded. Check your connection and try again.';
}

async function testCustom() {
  const host = $('customHost').value.trim();
  const port = parseInt($('customPort').value, 10) || 18089;
  if (!host) { $('customResult').textContent = 'Enter a hostname first.'; return; }
  $('customBtn').disabled = true;
  $('customResult').textContent = `Probing ${host}:${port}…`;
  const samples = [];
  for (let i = 0; i < PROBES_PER_NODE; i++) {
    const ms = await probeOnce(host, port, false);
    if (ms !== null) samples.push(ms);
  }
  $('customBtn').disabled = false;
  if (samples.length) {
    const s = [...samples].sort((a, b) => a - b);
    const median = Math.round(s[Math.floor(s.length / 2)]);
    $('customResult').textContent = `${host}:${port} responded in ~${median} ms. (Speed only — a response here doesn't prove the node is synced.)`;
  } else {
    $('customResult').textContent = `${host}:${port} did not respond (timeout).`;
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = old; }, 1200);
}

function filteredNodes() {
  return nodeState.nodes.filter((n) => {
    if (nodeState.filter !== 'all' && n.network !== nodeState.filter) return false;
    if (nodeState.hideOffline && healthOf(n).state === 'offline') return false;
    return true;
  });
}

function pingCell(key) {
  const r = nodeState.results.get(key);
  if (!r || r.state === 'idle') return '<span class="muted">—</span>';
  if (r.state === 'testing') {
    const n = r.samples.length;
    return `<span class="testing"><span class="spinner"></span>${n}/${PROBES_PER_NODE}</span>`;
  }
  if (r.ms === null) return '<span class="timeout">timeout</span>';
  const cls = r.ms < 150 ? 'fast' : r.ms < 400 ? 'mid' : 'slow';
  return `<span class="ping ${cls}">${r.ms} ms</span>`;
}

function healthCell(node) {
  const h = healthOf(node);
  const labels = {
    synced: ['Synced', 'ok'],
    behind: ['Behind', 'warn'],
    offline: ['Offline', 'bad'],
    unknown: ['Unknown', 'muted'],
  };
  const [label, cls] = labels[h.state];
  const title = h.height ? `height ${h.height.toLocaleString()}${h.version ? ` · v${h.version}` : ''}` : label;
  return `<span class="health health-${cls}" title="${esc(title)}">${label}</span>`;
}

function sortedRows() {
  return filteredNodes()
    .map((n) => ({ n, r: nodeState.results.get(nodeKey(n)), h: healthOf(n) }))
    .sort((a, b) => {
      // offline nodes always sink to the bottom, regardless of ping
      const aOff = a.h.state === 'offline' ? 1 : 0;
      const bOff = b.h.state === 'offline' ? 1 : 0;
      if (aOff !== bOff) return aOff - bOff;
      const x = a.r && a.r.ms !== null ? a.r.ms : Infinity;
      const y = b.r && b.r.ms !== null ? b.r.ms : Infinity;
      return x - y;
    });
}

function pingLabel(key) {
  const r = nodeState.results.get(key);
  if (!r || r.state === 'idle') return 'not tested yet';
  if (r.state === 'testing') return `testing… ${r.samples.length}/${PROBES_PER_NODE}`;
  if (r.ms === null) return 'timeout';
  return `${r.ms} ms`;
}

function healthLabel(h) {
  return { synced: 'Synced', behind: 'Behind', offline: 'Offline', unknown: 'Unknown' }[h.state];
}

function renderNodes() {
  const rows = sortedRows();
  const select = $('nodeSelect');
  // keep the user's pick if it's still in the filtered list, else take the top row
  if (!rows.some(({ n }) => nodeKey(n) === nodeState.selectedKey)) {
    nodeState.selectedKey = rows.length ? nodeKey(rows[0].n) : null;
  }
  select.innerHTML = rows.length
    ? rows.map(({ n, h }) => {
        const key = nodeKey(n);
        const label = `${key} — ${pingLabel(key)} · ${healthLabel(h)}`;
        return `<option value="${esc(key)}"${key === nodeState.selectedKey ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('')
    : '<option disabled>No nodes match this filter.</option>';
  renderDetail(rows);
  updateMap();
}

function renderDetail(rows) {
  const box = $('nodeDetail');
  const entry = rows.find(({ n }) => nodeKey(n) === nodeState.selectedKey);
  if (!entry) { box.innerHTML = ''; return; }
  const { n } = entry;
  const key = nodeKey(n);
  const addr = esc(`${n.host}:${n.port}`);
  const netLabel = { clearnet: 'Clearnet', onion: 'Tor', i2p: 'I2P' }[n.network] || n.network;
  const sub = [n.operator, n.region].filter(Boolean).map(esc).join(' · ');
  box.innerHTML = `<div class="node-host big">${esc(n.host)}<span class="node-port">:${esc(n.port)}</span></div>
    ${sub ? `<div class="node-op">${sub}</div>` : ''}
    <div class="detail-badges">${healthCell(n)} ${pingCell(key)} <span class="net net-${esc(n.network)}">${esc(netLabel)}</span></div>
    <button class="mini" data-copy="${addr}" title="Copy host:port">Copy address</button>
    <button class="mini" data-show-map="${key}" title="Show this node on the map">Show on map</button>`;
  box.querySelector('[data-copy]').addEventListener('click', (e) => copyText(e.currentTarget.getAttribute('data-copy'), e.currentTarget));
  const mapBtn = box.querySelector('[data-show-map]');
  if (mapBtn) mapBtn.addEventListener('click', () => {
    nodeState.selectedKey = key;
    if (typeof hubShow === 'function') hubShow('map');
    nodeFocusOnMap(key);
  });
}

/* ---- Map tab ---- */

// Deterministic small offset so nodes that share a city don't stack exactly.
function jitter(key) {
  let h = 0;
  for (const c of key) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const u = (Math.abs(h) % 100) / 100; // 0..0.99
  return (u - 0.5) * 0.3; // +/-0.15 degrees
}

const HEALTH_COLORS = {
  synced: '#4ade80',
  behind: '#facc15',
  offline: '#f87171',
  unknown: '#9a978f',
};
const HEALTH_LABELS = { synced: 'Synced', behind: 'Behind', offline: 'Offline', unknown: 'Unknown' };

function initMap() {
  if (nodeState.map || typeof L === 'undefined') return;
  nodeState.map = L.map('map', { worldCopyJump: true }).setView([25, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(nodeState.map);
  nodeState.markers = L.layerGroup().addTo(nodeState.map);
  nodeState.map.on('popupopen', (e) => {
    const btn = e.popup.getElement().querySelector('[data-copy]');
    if (btn) btn.addEventListener('click', () => copyText(btn.getAttribute('data-copy'), btn));
  });
}

function updateMap() {
  if (nodeState.activeTab !== 'map' || !nodeState.map || !nodeState.markers) return;
  nodeState.markers.clearLayers();
  let shown = 0;
  for (const n of filteredNodes()) {
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue;
    const h = healthOf(n);
    const r = nodeState.results.get(nodeKey(n));
    const ping = r && r.ms !== null ? `${r.ms} ms` : 'not tested yet';
    const key = nodeKey(n);
    const lat = n.lat + jitter(key);
    const lon = n.lon + jitter(key + ':lon');
    const popup = `<div class="map-popup">
      <div class="node-host">${esc(n.host)}<span class="node-port">:${esc(n.port)}</span></div>
      <div class="node-op">${[n.operator, n.region].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="map-popup-row">Health: <strong>${HEALTH_LABELS[h.state]}</strong> · Ping: <strong>${ping}</strong></div>
      <button class="mini" data-copy="${esc(key)}">Copy address</button>
    </div>`;
    L.circleMarker([lat, lon], {
      radius: 7,
      color: '#0e0e10',
      weight: 1.5,
      fillColor: HEALTH_COLORS[h.state],
      fillOpacity: 0.9,
    }).bindPopup(popup).addTo(nodeState.markers);
    shown++;
  }
  const total = nodeState.nodes.length;
  $('mapNote').textContent = `Showing ${shown} of ${total} nodes on the map. ` +
    `Dots are colored by health: green synced, yellow behind, red offline, grey unknown. ` +
    `Nodes without a known location aren't shown. Click a dot for details and a copy button.`;
}


function initNodeFilters() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      nodeState.filter = chip.getAttribute('data-filter');
      renderNodes();
    });
  });
  $('hideOffline').addEventListener('change', (e) => {
    nodeState.hideOffline = e.target.checked;
    renderNodes();
  });
}

/* ---------- hub entry: fresh test every time a node tab opens ---------- */
function nodeEnter(tab) {
  nodeState.activeTab = tab;
  if (tab === 'map') {
    if (typeof L === 'undefined') {
      $('mapNote').textContent = 'Map library failed to load (check your connection and reload).';
    } else {
      initMap();
      // the map was hidden, so Leaflet needs a size recalc
      setTimeout(() => { nodeState.map.invalidateSize(); updateMap(); }, 0);
    }
  }
  // Fresh ping every time you enter a node tab.
  nodeTestAll();
}

function nodeFocusOnMap(key) {
  const n = nodeState.nodes.find((x) => nodeKey(x) === key);
  if (!n || typeof n.lat !== 'number' || typeof n.lon !== 'number') return;
  if (!nodeState.map) return;
  nodeState.map.setView([n.lat, n.lon], 6);
}

/* ---------- node hub init (no auto-test here — nodeEnter runs it) ---------- */
$('testBtn').addEventListener('click', nodeTestAll);
$('nodeSelect').addEventListener('change', (e) => { nodeState.selectedKey = e.target.value; renderNodes(); });
$('customBtn').addEventListener('click', testCustom);
$('customHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') testCustom(); });

initNodeFilters();
loadNodes();
loadHealth();
