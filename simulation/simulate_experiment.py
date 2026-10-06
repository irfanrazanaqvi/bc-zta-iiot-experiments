#!/usr/bin/env python3
"""
simulate_experiment.py
-----------------------------------------------------------------------------
Analytical / Monte-Carlo performance model for:
"Blockchain-Assisted Zero-Trust Architecture for Secure and Scalable
Industrial Internet of Things (IIoT)"

WHAT THIS IS (and is not)
    A transparent, parameterized *model* of the request path of four access-
    control configurations. Every number in Tables III-IV and Figs. 3-4 of the
    paper is produced by this script from the component costs in PARAMS below.
    The component costs are ASSUMPTIONS (typical orders of magnitude for a
    plant LAN / WAN, ECDSA verification on gateway-class hardware, and an
    IBFT 2.0 block period of 2 s). They are NOT measurements from a deployed
    Hyperledger Besu network. To obtain measured results, run the Hardhat
    contracts on a Besu IBFT 2.0 testbed (see README) and replace PARAMS with
    measured component latencies, or replace the sampling functions with real
    timings (e.g., Hyperledger Caliper).

    The only *measured* quantities are on-chain gas costs, produced by
    scripts/measure_gas.js (output/gas_measurements.json).

Configurations
    B1  Centralized PKI-IAM    : every request is verified against a central
                                 LDAP/IAM service across the plant WAN.
    B2  ABAC (no blockchain)   : local in-memory policy engine; no ledger.
    B3  Blockchain-only (sync) : every authentication/authorization decision is
                                 a synchronous on-chain transaction.
    P   Proposed BC-ZTA        : decisions use edge-cached, Merkle-verified
                                 ledger state; writes (trust updates, audit
                                 anchors) are asynchronous and batched.

Usage
    python3 simulate_experiment.py [--seed 42] [--trials 100000]
Outputs (./output/)
    table3_model_parameters.csv, table4_comlondonon.csv, raw_results.json,
    fig3_latency.png, fig4_scalability.png
"""
import argparse
import csv
import json
import os

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "output")

# ---------------------------------------------------------------------------
# Model parameters (assumptions; see docstring). Times in milliseconds.
# ---------------------------------------------------------------------------
PARAMS = {
    "rtt_lan_ms": 2.0,            # device <-> edge gateway round trip
    "rtt_wan_ms": 40.0,           # plant <-> central IAM / cloud round trip
    "rtt_validator_ms": 5.0,      # validator <-> validator round trip (plant LAN)
    "ecdsa_verify_ms": 3.0,       # signature verification, gateway-class CPU
    "ecdsa_sign_ms": 2.0,         # signature generation at the device/gateway
    "merkle_verify_ms": 0.5,      # depth-20 keccak256 Merkle proof check
    "ldap_lookup_ms": 15.0,       # central directory lookup incl. processing
    "local_lookup_ms": 1.0,       # local identity-store lookup
    "local_policy_eval_ms": 1.0,  # in-memory ABAC evaluation
    "chain_read_ms": 8.0,         # eth_call to a co-located validator/full node
    "cache_hit_ms": 0.2,          # in-memory cache lookup at the gateway
    "cache_hit_ratio": 0.90,      # fraction of decisions served from cache
    "block_period_ms": 2000.0,    # IBFT 2.0 blockperiodseconds = 2
    "ibft_message_rounds": 3,     # pre-prepare / prepare / commit
    "cache_ttl_s": 30.0,          # cached identity/trust state validity
    "trust_update_interval_s": 30.0,
    "quorum": 2,                  # validator votes needed per trust update
    "audit_batch_interval_s": 1.0,  # one Merkle-root anchor per second
    "chain_capacity_tps": 300.0,  # assumed sustainable write capacity (to be measured)
    "request_rate_per_device": 1.0,  # access requests per device per second
    "cpu_sigma": 0.15,            # lognormal sigma, compute costs
    "net_sigma": 0.30,            # lognormal sigma, network costs
}

SCHEMES = ["Centralized PKI-IAM", "ABAC (no BC)", "Blockchain-only (sync)", "Proposed BC-ZTA"]
DEVICE_COUNTS = [10, 25, 50, 100, 150, 200, 250, 300, 400]


def lognorm(rng, mean, sigma, size):
    """Multiplicative lognormal noise with the given mean."""
    return mean * rng.lognormal(-0.5 * sigma ** 2, sigma, size)


def finality_ms(rng, size, p=PARAMS):
    """Time for a transaction to be included and final under IBFT 2.0:
    uniform wait for the next block + message rounds among validators."""
    wait = rng.uniform(0.0, p["block_period_ms"], size)
    rounds = lognorm(rng, p["ibft_message_rounds"] * p["rtt_validator_ms"], p["net_sigma"], size)
    return wait + rounds


def queue_wait_ms(offered_tps, p=PARAMS):
    """M/M/1 mean waiting time at the ledger; None if saturated."""
    mu = p["chain_capacity_tps"]
    rho = offered_tps / mu
    if rho >= 1.0:
        return None
    return 1000.0 * rho / (mu * (1.0 - rho))


def simulate_latency(rng, trials, n_devices=100, p=PARAMS):
    """Return per-scheme arrays of authentication and authorization latency (ms)."""
    lan = lambda: lognorm(rng, p["rtt_lan_ms"], p["net_sigma"], trials)
    wan = lambda: lognorm(rng, p["rtt_wan_ms"], p["net_sigma"], trials)
    cpu = lambda m: lognorm(rng, m, p["cpu_sigma"], trials)
    out = {}

    # B1: central PKI-IAM (online directory lookup across the WAN)
    auth = lan() + wan() + cpu(p["ecdsa_verify_ms"]) + cpu(p["ldap_lookup_ms"]) + cpu(p["ecdsa_sign_ms"])
    authz = wan() + cpu(p["ldap_lookup_ms"]) + cpu(p["local_policy_eval_ms"])
    out["Centralized PKI-IAM"] = (auth, authz)

    # B2: local ABAC, no ledger
    auth = lan() + cpu(p["ecdsa_verify_ms"]) + cpu(p["ecdsa_sign_ms"]) + cpu(p["local_lookup_ms"])
    authz = cpu(p["local_policy_eval_ms"]) + cpu(p["local_lookup_ms"])
    out["ABAC (no BC)"] = (auth, authz)

    # B3: every decision is a synchronous on-chain transaction (+ queueing)
    qw = queue_wait_ms(n_devices * p["request_rate_per_device"], p)
    q = np.full(trials, np.nan if qw is None else qw)
    auth = lan() + cpu(p["ecdsa_verify_ms"]) + cpu(p["ecdsa_sign_ms"]) + finality_ms(rng, trials) + q
    authz = finality_ms(rng, trials) + q
    out["Blockchain-only (sync)"] = (auth, authz)

    # P: cached, Merkle-verified ledger state at the edge
    hit = rng.random(trials) < p["cache_hit_ratio"]
    state = np.where(hit, cpu(p["cache_hit_ms"]), cpu(p["chain_read_ms"]))
    auth = lan() + cpu(p["ecdsa_verify_ms"]) + cpu(p["ecdsa_sign_ms"]) + state + cpu(p["merkle_verify_ms"])
    hit2 = rng.random(trials) < p["cache_hit_ratio"]
    trust = np.where(hit2, cpu(p["cache_hit_ms"]), cpu(p["chain_read_ms"]))
    authz = cpu(p["local_policy_eval_ms"]) + trust
    out["Proposed BC-ZTA"] = (auth, authz)
    return out


def onchain_load_tps(scheme, n_devices, p=PARAMS):
    """Steady-state write load on the ledger (tx/s)."""
    if scheme == "Blockchain-only (sync)":
        return n_devices * p["request_rate_per_device"]
    if scheme == "Proposed BC-ZTA":
        trust = n_devices / p["trust_update_interval_s"] * p["quorum"]
        audit = 1.0 / p["audit_batch_interval_s"]
        return trust + audit
    return 0.0


def revocation_delay(rng, trials, p=PARAMS):
    """Time (s) from a revocation decision until enforcement at the PEP."""
    fin = finality_ms(rng, trials) / 1000.0
    ttl_wait = rng.uniform(0.0, p["cache_ttl_s"], trials)  # remaining cache validity
    chain_read = p["chain_read_ms"] / 1000.0
    worst_fin = p["block_period_ms"] / 1000.0 + 0.1
    return {
        "Centralized PKI-IAM": {"mean_s": 0.0, "worst_s": 0.0, "note": "online lookup; effective on next request"},
        "ABAC (no BC)": {"mean_s": 0.0, "worst_s": 0.0, "note": "local store updated directly"},
        "Blockchain-only (sync)": {"mean_s": float(np.mean(fin)), "worst_s": worst_fin, "note": "next block"},
        "Proposed BC-ZTA (TTL expiry)": {"mean_s": float(np.mean(fin + ttl_wait)),
                                         "worst_s": worst_fin + p["cache_ttl_s"],
                                         "note": "block finality + remaining cache TTL"},
        "Proposed BC-ZTA (event-driven)": {"mean_s": float(np.mean(fin) + chain_read),
                                           "worst_s": worst_fin + chain_read,
                                           "note": "gateway subscribes to DIDRevoked events"},
    }


def storage_footprint():
    """Derived from the Solidity storage layout (32-byte slots)."""
    return {
        "DIDRecord_bytes": 3 * 32,           # bytes32 | uint8+bool packed | uint256
        "AuditEntry_bytes": 5 * 32 + 32,     # five slots + array-length/index slot
        "AuditAnchor_bytes": 4 * 32 + 32,    # root | count | timestamp | reporter + index slot
    }


def load_gas():
    path = os.path.join(OUT_DIR, "gas_measurements.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)["gas_used"]
    return None


def run(seed=42, trials=100000):
    os.makedirs(OUT_DIR, exist_ok=True)
    rng = np.random.default_rng(seed)
    res = {"seed": seed, "trials": trials, "params": PARAMS}

    # --- latency at reference scale (100 devices) -------------------------
    lat = simulate_latency(rng, trials, n_devices=100)
    res["latency_100_devices"] = {}
    for s in SCHEMES:
        a, z = lat[s]
        res["latency_100_devices"][s] = {
            "auth_mean_ms": float(np.mean(a)), "auth_p95_ms": float(np.percentile(a, 95)),
            "authz_mean_ms": float(np.mean(z)), "authz_p95_ms": float(np.percentile(z, 95)),
        }

    # --- scalability sweep ------------------------------------------------
    sweep = {"devices": DEVICE_COUNTS}
    for s in ["Blockchain-only (sync)", "Proposed BC-ZTA"]:
        loads, authz_mean, saturated = [], [], []
        for n in DEVICE_COUNTS:
            load = onchain_load_tps(s, n)
            loads.append(round(load, 2))
            sat = queue_wait_ms(load) is None
            saturated.append(bool(sat))
            if sat:
                authz_mean.append(None)
            else:
                z = simulate_latency(rng, max(trials // 4, 20000), n_devices=n)[s][1]
                authz_mean.append(float(np.mean(z)))
        sweep[s] = {"onchain_load_tps": loads, "authz_mean_ms": authz_mean, "saturated": saturated}
    res["scalability"] = sweep
    res["ledger_capacity_tps"] = PARAMS["chain_capacity_tps"]
    first_sat = next((n for n, sflag in zip(DEVICE_COUNTS, sweep["Blockchain-only (sync)"]["saturated"]) if sflag), None)
    res["blockchain_only_saturation_devices"] = first_sat
    res["blockchain_only_saturation_analytic"] = PARAMS["chain_capacity_tps"] / PARAMS["request_rate_per_device"]

    res["revocation_delay"] = revocation_delay(rng, trials)
    res["storage"] = storage_footprint()
    # per-day audit growth at 400 devices if every access is logged individually
    ev_per_day = 400 * PARAMS["request_rate_per_device"] * 86400
    res["audit_growth_400_devices"] = {
        "events_per_day": ev_per_day,
        "per_event_logging_MB_per_day": ev_per_day * res["storage"]["AuditEntry_bytes"] / 1e6,
        "batch_anchoring_MB_per_day": 86400 / PARAMS["audit_batch_interval_s"] * res["storage"]["AuditAnchor_bytes"] / 1e6,
    }
    res["sensitivity"] = sensitivity(seed)
    gas = load_gas()
    if gas:
        res["gas_used"] = gas
        n = 1000
        res["gas_per_record"] = {
            "logEvent_per_record": gas.get("AuditLog.logEvent"),
            "anchorBatch_per_record_at_1000": gas.get("AuditLog.anchorBatch", 0) / n,
        }

    with open(os.path.join(OUT_DIR, "raw_results.json"), "w") as f:
        json.dump(res, f, indent=2)
    write_tables(res)
    plot_fig3(res)
    plot_fig4(res)
    plot_fig5(res)
    print(json.dumps({k: res[k] for k in ["latency_100_devices", "blockchain_only_saturation_devices",
                                           "revocation_delay", "audit_growth_400_devices"]}, indent=2))


def write_tables(res):
    with open(os.path.join(OUT_DIR, "table3_model_parameters.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Parameter", "Value"])
        for k, v in res["params"].items():
            w.writerow([k, v])
        w.writerow(["seed", res["seed"]])
        w.writerow(["trials", res["trials"]])
    lat = res["latency_100_devices"]
    with open(os.path.join(OUT_DIR, "table4_comlondonon.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Metric"] + SCHEMES)
        w.writerow(["Mean authentication latency (ms)"] + [f'{lat[s]["auth_mean_ms"]:.1f}' for s in SCHEMES])
        w.writerow(["P95 authentication latency (ms)"] + [f'{lat[s]["auth_p95_ms"]:.1f}' for s in SCHEMES])
        w.writerow(["Mean authorization latency (ms)"] + [f'{lat[s]["authz_mean_ms"]:.1f}' for s in SCHEMES])
        w.writerow(["P95 authorization latency (ms)"] + [f'{lat[s]["authz_p95_ms"]:.1f}' for s in SCHEMES])


def _style():
    plt.rcParams.update({"font.size": 8, "axes.titlesize": 8, "axes.labelsize": 8,
                         "xtick.labelsize": 7.5, "ytick.labelsize": 7.5, "legend.fontsize": 7.5,
                         "font.family": "DejaVu Sans"})


COLORS = {"Centralized PKI-IAM": "#7a7a7a", "ABAC (no BC)": "#c76b1e",
          "Blockchain-only (sync)": "#a8322d", "Proposed BC-ZTA": "#1f5f8b"}


def sensitivity(seed=42, trials=60000):
    """One-at-a-time sensitivity of BC-ZTA to the two assumptions that matter most."""
    rng = np.random.default_rng(seed + 1)
    out = {"cache_hit_ratio": [], "cache_ttl_s": []}
    for h in [0.50, 0.70, 0.80, 0.90, 0.95, 0.99]:
        p = dict(PARAMS); p["cache_hit_ratio"] = h
        z = simulate_latency(rng, trials, 100, p)["Proposed BC-ZTA"][1]
        out["cache_hit_ratio"].append({"hit": h, "authz_mean_ms": float(np.mean(z)), "authz_p95_ms": float(np.percentile(z, 95))})
    for ttl in [5, 10, 30, 60, 120, 300]:
        p = dict(PARAMS); p["cache_ttl_s"] = ttl
        r = revocation_delay(rng, trials, p)
        out["cache_ttl_s"].append({"ttl": ttl, "ttl_mean_s": r["Proposed BC-ZTA (TTL expiry)"]["mean_s"],
                                   "ttl_worst_s": r["Proposed BC-ZTA (TTL expiry)"]["worst_s"],
                                   "event_mean_s": r["Proposed BC-ZTA (event-driven)"]["mean_s"],
                                   "reads_per_s_400dev": 400 / ttl})
    return out


def plot_fig5(res):
    _style()
    s = res["sensitivity"]
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(3.4, 2.5))
    h = [d["hit"] * 100 for d in s["cache_hit_ratio"]]
    a1.plot(h, [d["authz_mean_ms"] for d in s["cache_hit_ratio"]], "-o", ms=3, lw=1.3, color="#1f5f8b", label="mean")
    a1.plot(h, [d["authz_p95_ms"] for d in s["cache_hit_ratio"]], "-s", ms=3, lw=1.3, color="#c76b1e", label="P95")
    a1.set_xlabel("(a) Cache hit ratio (%)"); a1.set_ylabel("Authz. latency (ms)")
    a1.legend(frameon=False, loc="center right")
    t = [d["ttl"] for d in s["cache_ttl_s"]]
    a2.plot(t, [d["ttl_mean_s"] for d in s["cache_ttl_s"]], "-o", ms=3, lw=1.3, color="#a8322d", label="TTL mean")
    a2.plot(t, [d["ttl_worst_s"] for d in s["cache_ttl_s"]], "--s", ms=3, lw=1.3, color="#7a7a7a", label="TTL worst")
    a2.plot(t, [d["event_mean_s"] for d in s["cache_ttl_s"]], "-^", ms=3, lw=1.3, color="#1f5f8b", label="event")
    a2.set_xscale("log"); a2.set_yscale("log")
    a2.set_xlabel("(b) Cache TTL (s)"); a2.set_ylabel("Revocation delay (s)")
    a2.legend(frameon=False, loc="upper left", fontsize=7)
    for a in (a1, a2):
        for s_ in ("top", "right"):
            a.spines[s_].set_visible(False)
    plt.tight_layout()
    plt.savefig(os.path.join(OUT_DIR, "fig5_sensitivity.png"), dpi=600)
    plt.close()


def plot_fig3(res):
    _style()
    lat = res["latency_100_devices"]
    labels = ["PKI-\nIAM", "ABAC\n(no BC)", "BC-only\n(sync)", "BC-\nZTA"]
    auth = [lat[s]["auth_mean_ms"] for s in SCHEMES]
    authz = [lat[s]["authz_mean_ms"] for s in SCHEMES]
    x = np.arange(len(SCHEMES)); w = 0.38
    fig, ax = plt.subplots(figsize=(3.4, 2.7))
    b1 = ax.bar(x - w / 2, auth, w, label="Authentication", color="#2e5f8a")
    b2 = ax.bar(x + w / 2, authz, w, label="Authorization", color="#c76b1e")
    ax.set_yscale("log")
    ax.set_ylim(1, 40000)
    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.set_ylabel("Mean latency (ms, log scale)")
    ax.legend(frameon=False, loc="upper left")
    for bars in (b1, b2):
        ax.bar_label(bars, labels=[f"{b.get_height():.1f}" if b.get_height() < 100 else f"{b.get_height():.0f}" for b in bars],
                     fontsize=7.5, padding=2, rotation=90)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    plt.tight_layout()
    plt.savefig(os.path.join(OUT_DIR, "fig3_latency.png"), dpi=600)
    plt.close()


def plot_fig4(res):
    _style()
    sw = res["scalability"]
    n = sw["devices"]
    cap = res["ledger_capacity_tps"]
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(3.4, 4.0), sharex=True)
    for s, c, m in (("Blockchain-only (sync)", COLORS["Blockchain-only (sync)"], "s"),
                    ("Proposed BC-ZTA", COLORS["Proposed BC-ZTA"], "o")):
        a1.plot(n, sw[s]["onchain_load_tps"], "-" + m, color=c, ms=3, lw=1.3, label=s)
        xs = [d for d, v in zip(n, sw[s]["authz_mean_ms"]) if v is not None]
        ys = [v for v in sw[s]["authz_mean_ms"] if v is not None]
        a2.plot(xs, ys, "-" + m, color=c, ms=3, lw=1.3, label=s)
    a1.axhline(cap, color="#444444", ls="--", lw=0.9)
    a1.text(n[0], cap * 1.04, f"assumed ledger capacity ({cap:.0f} tx/s)", fontsize=7.5, va="bottom")
    a1.set_ylabel("On-chain write load (tx/s)")
    a1.set_ylim(0, cap * 1.75)
    a1.legend(frameon=False, loc="upper left")
    sat = res["blockchain_only_saturation_devices"]
    if sat:
        a2.axvline(sat, color="#a8322d", ls=":", lw=0.9)
        a2.text(sat - 6, 3, "BC-only\nsaturates", fontsize=7.5, color="#a8322d", ha="right")
    a2.set_yscale("log")
    a2.set_ylabel("Mean authorization\nlatency (ms, log)")
    a2.set_xlabel("Number of IIoT devices (1 request/s each)")
    for a in (a1, a2):
        for s_ in ("top", "right"):
            a.spines[s_].set_visible(False)
    plt.tight_layout()
    plt.savefig(os.path.join(OUT_DIR, "fig4_scalability.png"), dpi=600)
    plt.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--trials", type=int, default=100000)
    a = ap.parse_args()
    run(seed=a.seed, trials=a.trials)
