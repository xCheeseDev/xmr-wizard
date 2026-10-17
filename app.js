/* XMR Multisig Wizard — ceremony state machine.
 *
 * How it works:
 *  - The page never performs cryptography and never sees private keys.
 *  - It only validates and shuffles the PUBLIC coordination strings that
 *    monero-wallet-cli prints (MultisigV1..., exported multisig info).
 *  - Ceremony progress is kept in memory only — every visit starts fresh.
 *    Only the spend history is kept in localStorage (your browser only).
 *    Nothing is sent anywhere.
 *
 * The ceremony, mapped to CLI commands:
 *   setup -> prepare_multisig -> share strings -> make_multisig M strings...
 *         -> (export_multisig_info -> share -> import_multisig_info)... until ready
 */

const STEPS = ["setup", "prepare", "share", "make", "rounds", "done"];
const STEP_TITLES = {
  setup: "Configure",
  prepare: "Prepare",
  share: "Share",
  make: "Build wallet",
  rounds: "Sync info",
  done: "Done",
};

const state = {
  step: "setup",
  threshold: 2,      // M: signatures required
  participants: 3,   // N: total signers
  me: 1,             // my participant number (1..N)
  myPrepareString: "",
  peerPrepareStrings: [],
  round: 1,
};

/* ---------- persistence (local only) ---------- */
/* No ceremony persistence by design: every visit starts at step 1.
 * (Old sessions may have a stale "xmr-wizard" key; init clears it.) */
function resetAll() {
  try { localStorage.removeItem("xmr-wizard"); } catch (_) {}
  location.reload();
}

/* ---------- validators ----------
 * Shape checks against real `monero-wallet-cli` output: correct prefix,
 * single unbroken line, hex body, and a minimum length well below what the
 * CLI actually prints (real outputs are several hundred hex chars). */
function isHex(s) { return /^[0-9a-fA-F]+$/.test(s); }

function validatePrepareString(s) {
  s = s.trim();
  if (!s) return "Paste the output of prepare_multisig first.";
  if (/\s/.test(s)) return "The output should be one unbroken string — remove any spaces or line breaks.";
  if (!s.startsWith("MultisigV1")) return 'Should start with "MultisigV1". Did you run prepare_multisig?';
  const body = s.slice("MultisigV1".length);
  if (!isHex(body)) return "After the MultisigV1 prefix the output should be hex characters only.";
  if (body.length < 128) return "That looks too short for a real prepare_multisig output (" + body.length + " hex chars; expected 128+).";
  return null; // valid
}

function validateExportedInfo(s) {
  s = s.trim();
  if (!s) return "Paste the output of export_multisig_info first.";
  let compact = s.replace(/\s+/g, "");
  // Real exports start with the MultisigV1 magic like prepare strings do.
  if (compact.startsWith("MultisigV1")) compact = compact.slice("MultisigV1".length);
  if (!isHex(compact)) return "Expected hex output from export_multisig_info (optionally starting with MultisigV1).";
  if (compact.length < 128) return "That looks too short for real exported multisig info (" + compact.length + " hex chars; expected 128+).";
  return null;
}

/* ---------- QR codes (vendored qrcode-generator, MIT) ----------
 * Renders the coordination string as a scannable QR for phone-to-phone
 * sharing. Falls back to a hint if the library failed to load. */
function renderQR(text, slotEl) {
  if (!slotEl) return;
  slotEl.innerHTML = "";
  try {
    if (typeof qrcode === "undefined") throw new Error("qr lib missing");
    const qr = qrcode(0, "M"); // auto version, medium error correction
    qr.addData(text);
    qr.make();
    slotEl.innerHTML = qr.createSvgTag({ scalable: true });
  } catch (_) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "QR unavailable — copy the string above instead.";
    slotEl.appendChild(p);
  }
}

/* ---------- UI helpers ---------- */
function show(step) {
  state.step = step;
  for (const s of STEPS) {
    document.getElementById("step-" + s).hidden = s !== step;
  }
  renderProgress();
  if (step === "done") renderVerifyInputs();
  // Re-draw the QR whenever the share step shows (covers page reloads
  // restoring a mid-ceremony step, where the click handler never fires).
  if (step === "share" && state.myPrepareString)
    renderQR(state.myPrepareString, document.getElementById("qr-slot"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderProgress() {
  const nav = document.getElementById("progress");
  nav.innerHTML = "";
  const idx = STEPS.indexOf(state.step);
  STEPS.forEach((s, i) => {
    const dot = document.createElement("span");
    dot.className = "pstep" + (i < idx ? " done" : "") + (i === idx ? " current" : "");
    dot.textContent = (i + 1) + ". " + STEP_TITLES[s];
    nav.appendChild(dot);
  });
}

function fieldError(id, msg) {
  const el = document.getElementById(id);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

function wireCopyButtons(root = document) {
  root.querySelectorAll("button.copy").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const text = btn.dataset.copy
        || btn.closest(".command, .share-box")?.querySelector("code")?.textContent
        || "";
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = old), 1200);
      });
    });
  });
}

/* ---------- step: setup ---------- */
document.getElementById("btn-start").addEventListener("click", () => {
  const m = parseInt(document.getElementById("cfg-threshold").value, 10);
  const n = parseInt(document.getElementById("cfg-participants").value, 10);
  const me = parseInt(document.getElementById("cfg-me").value, 10);
  if (!(m >= 1 && m <= n)) return fieldError("setup-error", "Threshold M must be between 1 and N.");
  if (!(n >= 2)) return fieldError("setup-error", "Need at least 2 participants.");
  if (!(me >= 1 && me <= n)) return fieldError("setup-error", "Your number must be between 1 and N.");
  fieldError("setup-error", null);
  state.threshold = m; state.participants = n; state.me = me;
  show("prepare");
});

/* Shareable ceremony link: encodes M-of-N in the URL hash, e.g. #c=2-3.
 * Anyone opening the link gets the same numbers pre-filled. Stateless. */
document.getElementById("btn-ceremony-link").addEventListener("click", () => {
  const m = parseInt(document.getElementById("cfg-threshold").value, 10);
  const n = parseInt(document.getElementById("cfg-participants").value, 10);
  if (!(m >= 1 && m <= n) || !(n >= 2)) {
    fieldError("setup-error", "Set a valid M-of-N first (1 \u2264 M \u2264 N, N \u2265 2).");
    return;
  }
  fieldError("setup-error", null);
  const url = location.origin + location.pathname + "#c=" + m + "-" + n;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById("btn-ceremony-link");
    const old = btn.textContent;
    btn.textContent = "Link copied";
    setTimeout(() => (btn.textContent = old), 1200);
  });
});

function applyCeremonyLink() {
  const m = /^#c=(\d+)-(\d+)$/.exec(location.hash || "");
  if (!m) return;
  const lm = parseInt(m[1], 10), ln = parseInt(m[2], 10);
  if (!(lm >= 1 && ln >= 2 && lm <= ln)) return;
  state.threshold = lm;
  state.participants = ln;
  state.step = "setup"; // fresh ceremony from a link starts at the beginning
  document.getElementById("cfg-threshold").value = lm;
  document.getElementById("cfg-participants").value = ln;
  const note = document.getElementById("ceremony-link-note");
  note.textContent = "Loaded ceremony " + lm + "-of-" + ln + " from link — confirm your participant number and start.";
  note.hidden = false;
}

/* ---------- step: prepare ---------- */
document.getElementById("btn-prepare-next").addEventListener("click", () => {
  const v = document.getElementById("prepare-output").value;
  const err = validatePrepareString(v);
  if (err) return fieldError("prepare-error", err);
  fieldError("prepare-error", null);
  state.myPrepareString = v.trim();
  document.getElementById("my-string").textContent = state.myPrepareString;
  renderQR(state.myPrepareString, document.getElementById("qr-slot"));
  show("share");
});
document.getElementById("btn-share-next").addEventListener("click", () => show("make"));

/* ---------- step: make_multisig ---------- */
function buildPeerInputs(containerId, count, prefix) {
  const box = document.getElementById(containerId);
  box.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const label = document.createElement("label");
    label.textContent = "Participant string " + (i + 1) + ": ";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.id = prefix + i;
    ta.placeholder = "MultisigV1...";
    label.appendChild(ta);
    box.appendChild(label);
  }
}
buildPeerInputs("peer-strings", state.participants - 1, "peer-");

document.getElementById("btn-make-cmd").addEventListener("click", () => {
  const strs = [];
  for (let i = 0; i < state.participants - 1; i++) {
    const v = document.getElementById("peer-" + i).value;
    const err = validatePrepareString(v);
    if (err) return fieldError("make-error", "String " + (i + 1) + ": " + err);
    if (v.trim() === state.myPrepareString)
      return fieldError("make-error", "String " + (i + 1) + " matches your own — paste a co-signer's string.");
    strs.push(v.trim());
  }
  fieldError("make-error", null);
  state.peerPrepareStrings = strs;
  const cmd = "make_multisig " + state.threshold + " " + strs.join(" ");
  document.getElementById("make-command").textContent = cmd;
  document.getElementById("make-command-wrap").hidden = false;
  wireCopyButtons();
});
document.getElementById("btn-make-next").addEventListener("click", () => {
  startRound();
  show("rounds");
});

/* ---------- step: export/import rounds ---------- */
function startRound() {
  document.getElementById("round-label").textContent = "(round " + state.round + ")";
  document.getElementById("round-mine").value = "";
  document.getElementById("round-command-wrap").hidden = true;
  fieldError("round-error", null);
  buildPeerInputs("round-peers", state.participants - 1, "rpeer-");
}
document.getElementById("btn-round-cmd").addEventListener("click", () => {
  const mine = document.getElementById("round-mine").value;
  let err = validateExportedInfo(mine);
  if (err) return fieldError("round-error", err);
  const strs = [];
  for (let i = 0; i < state.participants - 1; i++) {
    const v = document.getElementById("rpeer-" + i).value;
    err = validateExportedInfo(v);
    if (err) return fieldError("round-error", "Peer string " + (i + 1) + ": " + err);
    strs.push(v.trim().replace(/\s+/g, ""));
  }
  fieldError("round-error", null);
  document.getElementById("round-command").textContent =
    "import_multisig_info " + strs.join(" ");
  document.getElementById("round-command-wrap").hidden = false;
  wireCopyButtons();
});
document.getElementById("btn-round-yes").addEventListener("click", () => {
  document.getElementById("done-summary").textContent =
    state.threshold + "-of-" + state.participants;
  show("done");
});
document.getElementById("btn-round-no").addEventListener("click", () => {
  state.round += 1;
  startRound();
});
document.getElementById("btn-reset").addEventListener("click", resetAll);

/* ---------- donate ---------- */
const DONATE_ADDRESS = "85JuRjHskBj6sxKunWcsJPev5Ck3Gq8az6swN9eFF1K87frhfnt7EGRAMHm8jvkMAkjKr1mWbmDEu866Hkfeu56hCQ7DaQJ";
function initDonate() {
  document.getElementById("donate-address").textContent = DONATE_ADDRESS;
}

/* Enlarge the donation QR on tap/click for easier scanning. */
function initQrLightbox() {
  var qr = document.getElementById("donate-qr");
  if (!qr) return;
  var trigger = qr.closest(".qr-wrap") || qr;
  var overlay = null;
  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  function open() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "qr-lightbox";
    var img = document.createElement("img");
    img.alt = "Monero donation QR code, enlarged";
    img.src = qr.src;
    var hint = document.createElement("p");
    hint.textContent = "Tap anywhere to close";
    overlay.appendChild(img);
    overlay.appendChild(hint);
    overlay.addEventListener("click", close);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
  }
  trigger.setAttribute("tabindex", "0");
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-label", "Enlarge donation QR code");
  trigger.addEventListener("click", open);
  trigger.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
}

/* Back buttons carry data-back="<step>" and return to the previous stage. */
function wireBackButtons() {
  // Spend-panel back buttons carry data-spend-back and are wired separately
  // in wireSpend(); grabbing them here would call show(undefined).
  document.querySelectorAll("button.back:not([data-spend-back])").forEach((btn) => {
    btn.addEventListener("click", () => show(btn.dataset.back));
  });
}

/* ---------- spend flow scaffold ---------- */
const spend = { threshold: 2, signers: 3, signed: 0 };
const SPEND_STEPS = ["intro", "propose", "sign", "broadcast", "done"];
const SPEND_TITLES = { intro: "Setup", propose: "Propose", sign: "Sign", broadcast: "Broadcast", done: "Done" };

function renderSpendProgress(current) {
  const nav = document.getElementById("spend-progress");
  nav.innerHTML = "";
  const idx = SPEND_STEPS.indexOf(current);
  SPEND_STEPS.forEach((s, i) => {
    const dot = document.createElement("span");
    dot.className = "pstep" + (i < idx ? " done" : "") + (i === idx ? " current" : "");
    dot.textContent = (i + 1) + ". " + SPEND_TITLES[s];
    nav.appendChild(dot);
  });
}

function setTab(mode) {
  document.querySelectorAll(".mode-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === mode);
  });
}

function spendShow(name) {
  if (name === "intro") renderSpendHistory();
  setTab("spend");
  for (const s of STEPS) document.getElementById("step-" + s).hidden = true;
  document.getElementById("progress").hidden = true;
  const sp = document.getElementById("spend-progress");
  sp.hidden = false;
  renderSpendProgress(name);
  document.getElementById("faq-setup").hidden = true;
  document.getElementById("faq-spend").hidden = false;
  document.querySelectorAll(".spend-panel").forEach((p) => {
    p.hidden = p.id !== "spend-" + name;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- hub tabs: setup / spend ---------- */
function hubShow(tab) {
  setTab(tab);
  if (tab === "setup") {
    document.querySelectorAll(".spend-panel").forEach((p) => { p.hidden = true; });
    document.getElementById("spend-progress").hidden = true;
    document.getElementById("faq-setup").hidden = false;
    document.getElementById("faq-spend").hidden = true;
    document.getElementById("progress").hidden = false;
    show(state.step || "setup");
    return;
  }
  if (tab === "spend") {
    spendShow("intro");
    return;
  }
}

function spendExit() {
  hubShow("setup");
}

function spendRenderCounter() {
  document.getElementById("spend-count").textContent = spend.signed;
  document.getElementById("spend-need").textContent = spend.threshold;
}

/* ---------- spend history (local only) ---------- */
const SPEND_HISTORY_KEY = "xmr-wizard-spends";
function getSpendHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(SPEND_HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}
function saveSpendHistory(list) {
  try { localStorage.setItem(SPEND_HISTORY_KEY, JSON.stringify(list)); } catch (_) {}
}
function renderSpendHistory() {
  const listEl = document.getElementById("spend-history-list");
  const emptyEl = document.getElementById("spend-history-empty");
  const clearBtn = document.getElementById("btn-clear-history");
  if (!listEl) return;
  const list = getSpendHistory();
  listEl.innerHTML = "";
  const has = list.length > 0;
  emptyEl.hidden = has;
  listEl.hidden = !has;
  clearBtn.hidden = !has;
  list.slice().reverse().forEach((s) => {
    const li = document.createElement("li");
    const amt = document.createElement("b");
    amt.textContent = (s.amount || "\u2014") + " XMR";
    const meta = document.createElement("span");
    const d = new Date(s.t);
    const shortAddr = s.address ? s.address.slice(0, 10) + "\u2026" + s.address.slice(-6) : "no address saved";
    meta.textContent = " \u2192 " + shortAddr + " \u00b7 " + d.toLocaleDateString() + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.appendChild(amt);
    li.appendChild(meta);
    listEl.appendChild(li);
  });
}

function wireSpend() {
  document.querySelectorAll(".mode-tab").forEach((t) => {
    t.addEventListener("click", () => hubShow(t.dataset.mode));
  });

  document.getElementById("btn-spend-start").addEventListener("click", () => {
    const m = parseInt(document.getElementById("spend-threshold").value, 10);
    const n = parseInt(document.getElementById("spend-signers").value, 10);
    const err = document.getElementById("spend-setup-error");
    if (!(m >= 1 && n >= 2 && m <= n)) {
      err.textContent = "Need 1 \u2264 M \u2264 N, with at least 2 signers.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    spend.threshold = m;
    spend.signers = n;
    spend.signed = 1; // proposer signed in step 1
    spendShow("propose");
  });

  document.getElementById("btn-propose-next").addEventListener("click", () => {
    const amount = document.getElementById("spend-amount").value.trim();
    const addr = document.getElementById("spend-address").value.trim();
    const err = document.getElementById("propose-error");
    if (!/^\d+(\.\d{1,12})?$/.test(amount) || parseFloat(amount) <= 0) {
      err.textContent = "Enter the amount in XMR (e.g. 0.5).";
      err.hidden = false;
      return;
    }
    if (addr && !(/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(addr) || /^[1-9A-HJ-NP-Za-km-z]{106}$/.test(addr) || !"48".includes(addr[0]))) {
      err.textContent = "That doesn't look like a Monero address (95/106 characters, starting with 4 or 8). Leave it blank if unsure.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    spend.amount = amount;
    spend.address = addr;
    spendRenderCounter();
    spendShow("sign");
  });

  document.getElementById("btn-signer-signed").addEventListener("click", () => {
    spend.signed += 1;
    if (spend.signed >= spend.threshold) spendShow("broadcast");
    else spendRenderCounter();
  });

  document.getElementById("btn-broadcast-done").addEventListener("click", () => {
    const list = getSpendHistory();
    list.push({ t: Date.now(), amount: spend.amount || "", address: spend.address || "" });
    saveSpendHistory(list.slice(-50)); // keep the last 50 on this device
    spendShow("done");
  });
  document.getElementById("btn-spend-again").addEventListener("click", () => spendShow("intro"));
  document.getElementById("btn-clear-history").addEventListener("click", () => {
    saveSpendHistory([]);
    renderSpendHistory();
  });

  document.querySelectorAll("button.back[data-spend-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.spendBack;
      if (t === "wizard") spendExit();
      else spendShow(t);
    });
  });
}

/* ---------- step: verify addresses ---------- */
const MONERO_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{95}$/;

function renderVerifyInputs() {
  const wrap = document.getElementById("verify-inputs");
  wrap.innerHTML = "";
  const n = state.participants || 2;
  for (let i = 1; i <= n; i++) {
    const label = document.createElement("label");
    label.textContent = "Participant " + i + " address: ";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "verify-addr";
    input.placeholder = "4\u2026 (95 characters)";
    input.autocomplete = "off";
    input.spellcheck = false;
    label.appendChild(input);
    wrap.appendChild(label);
  }
  const res = document.getElementById("verify-result");
  res.hidden = true;
  res.textContent = "";
  res.className = "verify-result";
}

function verifyAddresses() {
  const res = document.getElementById("verify-result");
  const addrs = [...document.querySelectorAll(".verify-addr")].map((el) => el.value.trim());
  res.hidden = false;
  const bad = addrs.findIndex((a) => !(a.length === 95 && a[0] === "4" && MONERO_ADDR_RE.test(a)));
  if (bad !== -1) {
    res.className = "verify-result error";
    res.textContent = "Participant " + (bad + 1) + " doesn't look like a valid Monero address (95 characters, starting with 4).";
    return;
  }
  if (addrs.some((a) => a !== addrs[0])) {
    res.className = "verify-result error";
    res.textContent = "Addresses do NOT match \u2014 at least one participant derived a different wallet. Do not use this wallet. Re-run the ceremony.";
    return;
  }
  res.className = "verify-result ok";
  res.textContent = "All " + addrs.length + " addresses match. Your multisig wallet is verified.";
}

document.getElementById("btn-verify").addEventListener("click", verifyAddresses);

/* ---------- init ---------- */
try { localStorage.removeItem("xmr-wizard"); } catch (_) {} // fresh start every visit
applyCeremonyLink();
// If we reload mid-ceremony, peer input boxes need rebuilding for the saved N.
buildPeerInputs("peer-strings", state.participants - 1, "peer-");
if (state.myPrepareString)
  document.getElementById("my-string").textContent = state.myPrepareString;
wireCopyButtons();
wireBackButtons();
initDonate();
initQrLightbox();
wireSpend();
show(state.step || "setup");
// Deep links: #map / #list now live on the standalone Node Hub page.
if (location.hash === "#map" || location.hash === "#list") {
  location.href = "nodes.html" + location.hash;
}
