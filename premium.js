/* XMR Wizard — Premium section (DORMANT SCAFFOLD).
 *
 * Ceremony Rooms + Payment Proof live here, in their own section, separate
 * from the free site. Nothing on this page runs until PREMIUM_ENABLED is
 * flipped to true AND a backend exists at PREMIUM_API_BASE. While dormant:
 *  - the page shows only the "coming soon" placeholder
 *  - no feature code initializes, no network calls happen
 *  - premium.html is not linked from anywhere on the free site
 *
 * To activate (after the site moves off GitHub Pages):
 *  1. Set PREMIUM_ENABLED = true and PREMIUM_API_BASE to the backend URL.
 *  2. Implement the backend endpoints marked TODO below.
 *  3. Link premium.html from the free site (e.g. a "Premium" tab).
 *
 * Privacy rules the backend must follow:
 *  - Never accept or store private keys, mnemonics, or spend keys.
 *  - Rooms hold only public coordination strings (the same strings users
 *    already share with co-signers), encrypted at rest, deleted when done.
 *  - Payment Proof takes a txid + tx key + recipient address, verifies them
 *    against a node, and returns a receipt. It never learns who paid.
 */

const PREMIUM_ENABLED = false;
const PREMIUM_API_BASE = ''; // TODO: e.g. 'https://api.example.com'

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function setStatus(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg;
}

/* Backend call. Throws while dormant.
 * Real implementation: fetch(PREMIUM_API_BASE + path, { method: 'POST', ... }) */
async function premiumApi(path, body) {
  throw new Error('Premium backend not connected (dormant scaffold).');
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

/* ---------- tabs ---------- */
function showPremiumTab(tab) {
  const rooms = tab === 'rooms';
  $('roomsPanel').hidden = !rooms;
  $('proofPanel').hidden = rooms;
  document.querySelectorAll('.premium-tab').forEach((b) =>
    b.classList.toggle('active', b.getAttribute('data-premium-tab') === tab));
}

/* ---------- Ceremony Rooms ---------- */
async function createRoom() {
  const m = parseInt($('roomM').value, 10);
  const n = parseInt($('roomN').value, 10);
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || n < m) {
    setStatus('roomStatus', 'Need whole numbers with 1 ≤ M ≤ N.');
    return;
  }
  setStatus('roomStatus', 'Creating room…');
  try {
    // TODO(backend): POST /rooms { m, n } -> { code, payment: { address, amount } }
    const res = await premiumApi('/rooms', { m, n });
    $('roomPayAddr').textContent = res.payment.address;
    $('roomPayAmount').textContent = res.payment.amount;
    $('roomCodeNew').textContent = res.code;
    $('roomPay').hidden = false;
    setStatus('roomStatus', 'Room created. Pay the address above to open it.');
  } catch (e) {
    setStatus('roomStatus', e.message);
  }
}

async function joinRoom() {
  const code = $('roomCode').value.trim();
  if (!code) {
    setStatus('roomStatus', 'Enter a room code first.');
    return;
  }
  setStatus('roomStatus', 'Joining room…');
  try {
    // TODO(backend): GET /rooms/:code -> { code, participants: [{ name, done }], turn }
    const res = await premiumApi(`/rooms/${encodeURIComponent(code)}`, null);
    $('roomCodeOut').textContent = res.code;
    $('roomParticipants').innerHTML = (res.participants || [])
      .map((p) => `<div>${esc(p.name)} — ${p.done ? 'done' : 'waiting'}</div>`).join('');
    $('roomTurn').textContent = res.turn || '';
    $('roomView').hidden = false;
    setStatus('roomStatus', `Joined room ${res.code}.`);
  } catch (e) {
    setStatus('roomStatus', e.message);
  }
}

async function submitRoomString() {
  const code = $('roomCodeOut').textContent;
  const str = $('roomPaste').value.trim();
  if (!str) {
    setStatus('roomPasteStatus', 'Paste a coordination string first.');
    return;
  }
  setStatus('roomPasteStatus', 'Checking…');
  try {
    // TODO(backend): POST /rooms/:code/strings { string } -> { ok, detail, turn }
    const res = await premiumApi(`/rooms/${encodeURIComponent(code)}/strings`, { string: str });
    setStatus('roomPasteStatus', res.ok
      ? `Accepted. ${res.detail || ''}`
      : `Rejected. ${res.detail || ''}`);
    if (res.turn) $('roomTurn').textContent = res.turn;
  } catch (e) {
    setStatus('roomPasteStatus', e.message);
  }
}

/* ---------- Payment Proof ---------- */
async function verifyPayment() {
  const txid = $('proofTxid').value.trim();
  const txKey = $('proofTxKey').value.trim();
  const address = $('proofAddress').value.trim();
  if (!txid || !txKey || !address) {
    setStatus('proofStatus', 'Fill in all three fields.');
    return;
  }
  setStatus('proofStatus', 'Verifying…');
  try {
    // TODO(backend): POST /proof { txid, txKey, address }
    //   -> { found, amount, confirmations, height }
    const res = await premiumApi('/proof', { txid, txKey, address });
    $('proofResult').innerHTML = res.found
      ? `<p>Payment found: <strong>${esc(res.amount)}</strong> XMR, ${esc(res.confirmations)} confirmations.</p>`
      : '<p>No matching payment found.</p>';
    setStatus('proofStatus', res.found ? 'Payment confirmed.' : 'No matching payment found.');
  } catch (e) {
    setStatus('proofStatus', e.message);
  }
}

function initPremium() {
  document.querySelectorAll('.premium-tab').forEach((b) =>
    b.addEventListener('click', () => showPremiumTab(b.getAttribute('data-premium-tab'))));
  $('createRoomBtn').addEventListener('click', createRoom);
  $('joinRoomBtn').addEventListener('click', joinRoom);
  $('roomValidateBtn').addEventListener('click', submitRoomString);
  $('verifyProofBtn').addEventListener('click', verifyPayment);
  $('roomPayCopy').addEventListener('click', (e) =>
    copyText($('roomPayAddr').textContent, e.currentTarget));
}

if (!PREMIUM_ENABLED) {
  $('premiumComingSoon').hidden = false;
  $('premiumApp').hidden = true;
} else {
  $('premiumComingSoon').hidden = true;
  $('premiumApp').hidden = false;
  initPremium();
}
