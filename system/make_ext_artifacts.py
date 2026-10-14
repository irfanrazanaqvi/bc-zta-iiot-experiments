#!/usr/bin/env python3
"""Aggregates the results of run_ext.sh (iam_r*/iam_results.json, flood_<mode>_r*/flood_results.json) into aggregate_ext.json and three figures.
usage: make_ext_artifacts.py <extracted ext_output dir> <output dir>"""
import json, sys, glob, os, statistics as st
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
def load(pat): return [json.load(open(f)) for f in sorted(glob.glob(os.path.join(src, pat)))]
def ms(a): return (st.mean(a), st.stdev(a) if len(a) > 1 else 0.0) if a else (None, None)
iam, agg = load("iam_r*/iam_results.json"), {"n_iam_runs": 0, "n_flood_runs": {}}
agg["n_iam_runs"] = len(iam)

# ---- X1 latency / goodput
LABEL = {"keycloak": "Keycloak", "keycloak-cached": "Keycloak (cached)", "ldap": "OpenLDAP", "ldap-cached": "OpenLDAP (cached)", "bczta": "BC-ZTA"}
E1 = {}
for lab in LABEL:
    rows = {}
    for r in iam:
        for e in r.get("E1", {}).get(lab, []):
            rows.setdefault(e["devices"], []).append(e)
    E1[lab] = {str(n): {"mean_ms": ms([e["mean_ms"] for e in v]), "p95_ms": ms([e["p95_ms"] for e in v]), "goodput": ms([e["goodput_rps"] for e in v]),
                        "fail": sum(e["failed_or_timeout"] for e in v), "reps": len(v), "pep_cpu": ms([e["pep"]["cpu_cores_avg"] for e in v])} for n, v in sorted(rows.items())}
agg["E1"] = E1

# ---- X2 revocation
E2 = {}
for r in iam:
    for k, v in r.get("E2", {}).items(): E2.setdefault(k, []).extend(v["samples_ms"])
agg["E2"] = {k: {"n": len(v), "mean_ms": st.mean(v), "p95_ms": sorted(v)[max(0, int(0.95 * len(v)) - 1)], "max_ms": max(v), "min_ms": min(v)} for k, v in E2.items() if v}

# ---- X3 outage
E6 = {}
for lab in LABEL:
    runs = [r["E6"][lab] for r in iam if lab in r.get("E6", {})]
    if not runs: continue
    L = min(len(x["series"]) for x in runs)
    frac = [st.mean([(x["series"][k]["ok"] / x["series"][k]["n"]) if x["series"][k]["n"] else 0 for x in runs]) for k in range(L)]
    keys = ["ok_fraction_before", "ok_fraction_during_outage", "ok_fraction_late_after", "seconds_until_service_loss", "seconds_to_recover_after_start"]
    E6[lab] = {"reps": len(runs), "stop_at_s": runs[0]["stop_at_s"], "start_at_s": runs[0]["start_at_s"], "svc": runs[0]["svc"], "ok_fraction_series": frac,
               "summary": {k: [x["summary"][k] for x in runs] for k in keys}, "tokens_reissued": any(x.get("tokens_reissued") for x in runs)}
agg["E6"] = E6

# ---- X4 PEP capacity
E7 = {}
for lab in ("keycloak", "ldap", "bczta"):
    rows = {}
    for r in iam:
        for e in r.get("E7", {}).get(lab, []): rows.setdefault(e["offered_rps"], []).append(e)
    E7[lab] = {str(n): {"goodput": ms([e["goodput_rps"] for e in v]), "p95_ms": ms([e["p95_ms"] for e in v]), "fail": sum(e["failed_or_timeout"] for e in v), "late": sum(e["late"] for e in v), "reps": len(v)} for n, v in sorted(rows.items())}
agg["E7"] = E7

# ---- flood sweep
FL, FAILED = {}, {}
for mode in ("bczta", "bcsync"):
    runs = load(f"flood_{mode}_r*/flood_results.json"); agg["n_flood_runs"][mode] = len(runs)
    rows = {}
    for r in runs:
        for e in r["rates"]:
            if e.get("node_failed"): FAILED.setdefault(mode, []).append(e["offered_tps"]); continue
            rows.setdefault(e["offered_tps"], []).append(e)
    FL[mode] = {}
    for rate, v in sorted(rows.items()):
        ok = [e["load"]["ok"] / e["load"]["measured"] for e in v]
        FL[mode][str(rate)] = {"reps": len(v), "accepted_tps": ms([e["flood"]["accepted_tps"] for e in v]),
            "rejected": sum(e["flood"]["rejected"] for e in v), "attempts": sum(e["flood"]["attempts"] for e in v),
            "reasons": {k: sum(e["flood"]["reasons"].get(k, 0) for e in v) for k in {k for e in v for k in e["flood"]["reasons"]}},
            "evicted_after_accept": sum(e["flood"]["evicted_after_accept"] for e in v),
            "committed_tps": ms([e["ledger"]["tps"] for e in v if e.get("ledger") and e["ledger"]["tps"] is not None]),
            "tx_per_block": ms([e["ledger"]["tx_per_block"] for e in v if e.get("ledger")]),
            "mean_ms": ms([e["load"]["mean_ms"] for e in v]), "p95_ms": ms([e["load"]["p95_ms"] for e in v]), "ok_ratio": ms(ok),
            "fail": sum(e["load"]["failed_or_timeout"] for e in v), "drain_s": ms([e["drain_s"] for e in v])}
agg["FLOOD"] = FL; agg["FLOOD_NODE_FAILED_AT_OFFERED_TPS"] = FAILED
json.dump(agg, open(os.path.join(out, "aggregate_ext.json"), "w"), indent=1)

plt.rcParams.update({"font.size": 8, "axes.grid": True, "grid.alpha": .3})
COL = {"keycloak": "#c0504d", "keycloak-cached": "#e6a09d", "ldap": "#4f81bd", "ldap-cached": "#a3bde0", "bczta": "#2e7d32", "bcsync": "#7b4b9a"}
# fig6: X1 latency
if any(E1[l] for l in E1):
    fig, ax = plt.subplots(1, 2, figsize=(7, 2.6))
    ns = sorted({int(n) for l in E1 for n in E1[l]}); w = 0.16
    for j, lab in enumerate(LABEL):
        for a, key in zip(ax, ("mean_ms", "p95_ms")):
            a.bar([i + (j - 2) * w for i in range(len(ns))], [E1[lab].get(str(n), {}).get(key, (0, 0))[0] or 0 for n in ns], w, label=LABEL[lab], color=COL[lab])
    for a, t in zip(ax, ("mean latency (ms)", "p95 latency (ms)")): a.set_xticks(range(len(ns))); a.set_xticklabels(ns); a.set_xlabel("devices"); a.set_ylabel(t)
    ax[0].legend(fontsize=6); fig.tight_layout(); fig.savefig(os.path.join(out, "fig6_iam_latency.png"), dpi=200); plt.close(fig)
# fig7: X3 outage timeline
if E6:
    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    for lab, e in E6.items(): ax.plot(range(len(e["ok_fraction_series"])), [100 * x for x in e["ok_fraction_series"]], label=LABEL[lab], color=COL[lab], lw=1.2)
    e0 = next(iter(E6.values())); ax.axvspan(e0["stop_at_s"], e0["start_at_s"], color="grey", alpha=.15, label="central service stopped")
    ax.set_xlabel("time (s)"); ax.set_ylabel("requests granted (%)"); ax.set_ylim(-3, 103); ax.legend(fontsize=5.5, loc="lower right"); fig.tight_layout(); fig.savefig(os.path.join(out, "fig7_iam_outage.png"), dpi=200); plt.close(fig)
# fig8: flood
if any(FL[m] for m in FL):
    fig, ax = plt.subplots(1, 2, figsize=(7, 2.6))
    for m in FL:
        if not FL[m]: continue
        rs = sorted(FL[m], key=float)
        ax[0].errorbar([float(r) for r in rs], [FL[m][r]["committed_tps"][0] or 0 for r in rs], yerr=[FL[m][r]["committed_tps"][1] or 0 for r in rs], marker="o", ms=3, label=f"ledger committed ({m} run)", color=COL[m])
        ax[1].errorbar([float(r) for r in rs], [FL[m][r]["p95_ms"][0] or 0 for r in rs], yerr=[FL[m][r]["p95_ms"][1] or 0 for r in rs], marker="o", ms=3, label={"bczta": "BC-ZTA", "bcsync": "synchronous ledger"}[m], color=COL[m])
    mx = max(float(r) for m in FL for r in FL[m]) if any(FL.values()) else 1
    ax[0].plot([0, mx], [0, mx], "k:", lw=.8, label="offered"); ax[0].set_xlabel("offered flood rate (tx/s)"); ax[0].set_ylabel("committed (tx/s)"); ax[0].legend(fontsize=6)
    ax[1].set_yscale("log"); ax[1].set_xlabel("offered flood rate (tx/s)"); ax[1].set_ylabel("access p95 latency (ms)"); ax[1].legend(fontsize=6)
    fig.tight_layout(); fig.savefig(os.path.join(out, "fig8_flood.png"), dpi=200); plt.close(fig)
print("wrote", out, "| iam runs:", agg["n_iam_runs"], "flood runs:", agg["n_flood_runs"])
