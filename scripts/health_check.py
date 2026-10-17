#!/usr/bin/env python3
"""Hourly health check for xmr-niblet.

Calls get_info on every clearnet node in nodes.json and writes status.json
with block height, version, and reachability. Onion/I2P nodes are skipped:
GitHub runners can't reach them without Tor/I2P.

Run locally: python3 scripts/health_check.py
Requires only the standard library.
"""

import json
import time
import urllib.request
from datetime import datetime, timezone

TIMEOUT_S = 10

REPO_ROOT = __file__.rsplit("/", 2)[0]
NODES_PATH = f"{REPO_ROOT}/nodes.json"
STATUS_PATH = f"{REPO_ROOT}/status.json"


def check_node(host, port, tls=False):
    payload = json.dumps({"jsonrpc": "2.0", "id": "0", "method": "get_info"}).encode()
    # TLS nodes are checked over HTTPS first; fall back to plain HTTP for
    # nodes that serve both (like corny.cc) or have a broken cert.
    schemes = ["https", "http"] if tls else ["http"]
    t0 = time.time()
    last_error = None
    for scheme in schemes:
        url = f"{scheme}://{host}:{port}/json_rpc"
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                body = json.loads(res.read().decode())
            break
        except Exception as e:
            last_error = e
            continue
    else:
        return {
            "ok": False,
            "error": f"{type(last_error).__name__}: {last_error}"[:120],
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
    try:
        ms = int((time.time() - t0) * 1000)
        result = body.get("result", {})
        return {
            "ok": True,
            "height": result.get("height"),
            "version": result.get("version"),
            "nettype": result.get("nettype"),
            "response_ms": ms,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}"[:120],
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }


def main():
    with open(NODES_PATH) as f:
        nodes = json.load(f)

    status = {"generated_at": datetime.now(timezone.utc).isoformat(), "nodes": {}}
    for n in nodes:
        if n.get("network") != "clearnet":
            continue  # runners can't reach onion/i2p
        key = f"{n['host']}:{n['port']}"
        status["nodes"][key] = check_node(n["host"], n["port"], n.get("tls", False))
        ok = status["nodes"][key]["ok"]
        print(f"{'OK  ' if ok else 'DOWN'} {key}")

    with open(STATUS_PATH, "w") as f:
        json.dump(status, f, indent=1)
        f.write("\n")
    print(f"Wrote {STATUS_PATH}")


if __name__ == "__main__":
    main()
