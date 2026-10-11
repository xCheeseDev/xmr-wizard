/* XMR Multisig Wizard — ceremony state machine.
 *
 * How it works:
 *  - The page never performs cryptography and never sees private keys.
 *  - It only validates and shuffles the PUBLIC coordination strings that
 *    monero-wallet-cli prints (MultisigV1..., exported multisig info).
 *  - Ceremony progress is kept in memory + localStorage (your browser only).
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
function save() {
  try { localStorage.setItem("xmr-wizard", JSON.stringify(state)); } catch (_) {}
}
function load() {
  try {
    const raw = localStorage.getItem("xmr-wizard");
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (_) {}
}
function resetAll() {
  try { localStorage.removeItem("xmr-wizard"); } catch (_) {}
  location.reload();
}

/* ---------- validators ----------
 * These are deliberately conservative heuristics. The exact byte lengths of
 * CLI outputs can vary between Monero releases, so we check shape, not size:
 * correct prefix + hex body + sane minimum length. Tighten these against real
 * `monero-wallet-cli` output during testing (see README). */
function isHex(s) { return /^[0-9a-fA-F]+$/.test(s); }

function validatePrepareString(s) {
  s = s.trim();
  if (!s) return "Paste the output of prepare_multisig first.";
  if (!s.startsWith("MultisigV1")) return 'Should start with "MultisigV1". Did you run prepare_multisig?';
  const body = s.slice("MultisigV1".length);
  if (!isHex(body)) return "After the MultisigV1 prefix the output should be hex characters only.";
  if (body.length < 64) return "That looks too short for a real prepare_multisig output.";
  return null; // valid
}

function validateExportedInfo(s) {
  s = s.trim();
  if (!s) return "Paste the output of export_multisig_info first.";
  // Some versions print bare hex; accept it as long as it looks like hex of sane length.
  const compact = s.replace(/\s+/g, "");
  if (!isHex(compact)) return "Expected hex output from export_multisig_info.";
  if (compact.length < 64) return "That looks too short for real exported multisig info.";
  return null;
}

/* ---------- QR adapter ----------
 * Plug a QR renderer in here later (e.g. a small vendored qrcode library).
 * Same pattern as the camera-feed adapter in the TTG project: the page works
 * without it, and one function swap enables it. */
function renderQR(_text, _slotEl) {
  // TODO: render QR code of the coordination string into _slotEl.
}

/* ---------- UI helpers ---------- */
function show(step) {
  state.step = step;
  save();
  for (const s of STEPS) {
    document.getElementById("step-" + s).hidden = s !== step;
  }
  renderProgress();
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
  save();
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
  document.querySelectorAll("button.back").forEach((btn) => {
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

function spendExit() {
  setTab("setup");
  document.querySelectorAll(".spend-panel").forEach((p) => { p.hidden = true; });
  document.getElementById("spend-progress").hidden = true;
  document.getElementById("faq-setup").hidden = false;
  document.getElementById("faq-spend").hidden = true;
  document.getElementById("progress").hidden = false;
  show(state.step || "setup");
}

function spendRenderCounter() {
  document.getElementById("spend-count").textContent = spend.signed;
  document.getElementById("spend-need").textContent = spend.threshold;
}

function wireSpend() {
  document.querySelectorAll(".mode-tab").forEach((t) => {
    t.addEventListener("click", () => {
      if (t.dataset.mode === "spend") spendShow("intro");
      else spendExit();
    });
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
    spendRenderCounter();
    spendShow("sign");
  });

  document.getElementById("btn-signer-signed").addEventListener("click", () => {
    spend.signed += 1;
    if (spend.signed >= spend.threshold) spendShow("broadcast");
    else spendRenderCounter();
  });

  document.getElementById("btn-broadcast-done").addEventListener("click", () => spendShow("done"));
  document.getElementById("btn-spend-again").addEventListener("click", () => spendShow("intro"));

  document.querySelectorAll("button.back[data-spend-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.spendBack;
      if (t === "wizard") spendExit();
      else spendShow(t);
    });
  });
}

/* ---------- init ---------- */
load();
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
