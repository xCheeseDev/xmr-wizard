# XMR Multisig Wizard

A free web wizard that walks you through setting up a Monero multisig wallet, validates each step, coordinates the group, and will never touches your keys.

**Live and functional at [xcheesedev.github.io/xmr-wizard](https://xcheesedev.github.io/xmr-wizard/)** — deployed via GitHub Pages.

## The problem

Monero has supported multisig wallets for years — shared custody, 2-of-3 escrow, DAO treasuries — but almost nobody uses it, because the setup is a CLI obstacle course: `prepare_multisig`, swapping hex strings between participants in the right order, `make_multisig` with the right threshold, then multiple rounds of `export_multisig_info` / `import_multisig_info`. One string pasted wrong and you're debugging blind. The GUI wallet doesn't support multisig at all.

## What this does

This page coordinates the ceremony, participant by participant:

1. **Configure** — agree on M-of-N and who is who, before anyone touches the CLI.
2. **Prepare** — each person runs `prepare_multisig`; the page validates the `MultisigV1...` output.
3. **Share** — the page shows exactly what to send the other participants (copy button; QR renderer plugs in later).
4. **Build** — paste the co-signers' strings, get the exact `make_multisig` command to run.
5. **Sync** — loop `export_multisig_info` / `import_multisig_info` rounds until every wallet reports the setup complete.

## Safety model

Fully stateless. No server, no accounts, no analytics, no network calls. The page never sees or asks for private keys or seed phrases — it only handles the public coordination strings that participants are supposed to share with each other anyway. All cryptography happens in your own `monero-wallet-cli`. Progress is kept in your browser's local storage only, and the reset button wipes it.

## Run it

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Status

Early development. The CLI command mapping in `app.js` follows the documented `monero-wallet-cli` multisig flow, but the validators are conservative heuristics — exact output shapes vary between Monero releases and still need checking against real CLI output. If you've done a Monero multisig setup by hand, that verification is the most valuable contribution right now.

## Contributing

Keep it dependency-free and stateless. Any feature that would require a server, an account, or handling private key material is out of scope by design.
