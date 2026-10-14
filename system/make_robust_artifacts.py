#!/usr/bin/env python3
"""Aggregates robust_r*/robust_results.json (run_robust.js) into aggregate_robust.json and two figures (fig9_failclosed.png, fig10_scaling.png).
usage: make_robust_artifacts.py <dir containing robust_r*/robust_results.json> <output dir>"""
import json, sys, glob, os, statistics as st
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
runs = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(src, "robust_r*/robust_results.json")))]
def ms(a):
    a = [x for x in a if x is not None]
    return (st.mean(a), st.stdev(a) if len(a) > 1 else 0.0) if a else (None, None)
agg = {"n_runs": len(runs)}

# P1 latency
P1 = {}
for m in ("push", "bczta-q2", "bczta"):
    rows = {}
    for r in runs:
        for e in r.get("P1", {}).get(m, []): rows.setdefault(e["devices"], []).append(e)
    P1[m] = {str(n): {"mean_ms": ms([e["mean_ms"] for e in v]), "p95_ms": ms([e["p95_ms"] for e in v]), "goodput": ms([e["goodput_rps"] for e in v]), "fail": sum(e["failed_or_timeout"] for e in v), "reps": len(v),
                     "quorum_mismatch": sum(e["pep"].get("quorum_mismatch", 0) for e in v)} for n, v in sorted(rows.items())}
agg["P1"] = P1
# P2 revocation
P2 = {}
for r in runs:
    for k, v in r.get("P2", {}).items(): P2.setdefault(k, []).extend(v["samples_ms"])
agg["P2"] = {k: {"n": len(v), "mean_ms": st.mean(v), "p95_ms": sorted(v)[max(0, int(0.95 * len(v)) - 1)], "max_ms": max(v), "min_ms": min(v)} for k, v in P2.items() if v}
# P3 fail-closed
P3 = {}
for lab in ("bczta", "push"):
    rs = [r["P3"][lab] for r in runs if lab in r.get("P3", {})]
    if not rs: continue
    L = min(len(x["series"]) for x in rs)
    frac = [st.mean([(x["series"][k]["ok"] / x["series"][k]["n"]) if x["series"][k]["n"] else 0 for x in rs]) for k in range(L)]
    keys = ["granted_before", "granted_cut_0_to_ttl", "granted_ttl_to_2ttl", "granted_after_2ttl", "granted_after_restore", "seconds_until_denials", "seconds_to_recover"]
    P3[lab] = {"reps": len(rs), "source": rs[0]["source"], "cut_at_s": rs[0]["cut_at_s"], "restore_at_s": rs[0]["restore_at_s"], "ttl_s": rs[0]["ttl_s"], "stale_bound_s": rs[0]["stale_bound_s"],
               "granted_series": frac, "summary": {k: [x["summary"][k] for x in rs] for k in keys},
               "stale_served": [x["pep"]["stale_served"] for x in rs if x.get("pep")], "unavailable": [x["pep"]["unavailable"] for x in rs if x.get("pep")]}
agg["P3"] = P3
# P4 consensus halt
agg["P4"] = [{k: r["P4"].get(k) for k in ("halt_at_s", "halt_s", "revoke_submitted_at_s", "decisions_granted", "revocation_enforced_after_submit_ms", "revocation_enforced_after_restart_ms", "blocks", "halt_error", "restart_error")} for r in runs if "P4" in r]
# P5 scaling
P5 = {}
for r in runs:
    for k, rows in r.get("P5", {}).items():
        for e in rows: P5.setdefault(k, {}).setdefault(e["offered_rps"], []).append(e)
agg["P5"] = {k: {str(o): {"goodput": ms([e["goodput_rps"] for e in v]), "p95_ms": ms([e["p95_ms"] for e in v]), "mean_ms": ms([e["mean_ms"] for e in v]), "fail": sum(e["failed_or_timeout"] for e in v),
                          "late": sum(e["late"] for e in v), "cpu": ms([e["pep"]["cpu_cores_total"] for e in v]), "reps": len(v)} for o, v in sorted(d.items())} for k, d in sorted(P5.items(), key=lambda x: int(x[0]))}
json.dump(agg, open(os.path.join(out, "aggregate_robust.json"), "w"), indent=1)

plt.rcParams.update({"font.size": 8, "axes.grid": True, "grid.alpha": .3})
COL = {"bczta": "#2e7d32", "push": "#c0504d"}
NAME = {"bczta": "BC-ZTA (ledger unreachable)", "push": "central + push (directory stopped)"}
if P3:
    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    for lab, e in P3.items(): ax.plot(range(len(e["granted_series"])), [100 * x for x in e["granted_series"]], label=NAME[lab], color=COL[lab], lw=1.2)
    e0 = next(iter(P3.values())); ax.axvspan(e0["cut_at_s"], e0["restore_at_s"], color="grey", alpha=.15, label="state source lost")
    ax.axvline(e0["cut_at_s"] + e0["ttl_s"], color="k", ls=":", lw=.7); ax.axvline(e0["cut_at_s"] + e0["stale_bound_s"], color="k", ls=":", lw=.7)
    ax.set_xlabel("time (s)"); ax.set_ylabel("requests granted (%)"); ax.set_ylim(-3, 103); ax.legend(fontsize=5.5, loc="lower left"); fig.tight_layout(); fig.savefig(os.path.join(out, "fig9_failclosed.png"), dpi=200); plt.close(fig)
if agg["P5"]:
    fig, ax = plt.subplots(1, 2, figsize=(7, 2.6))
    cm = plt.get_cmap("Greens")
    for i, (k, d) in enumerate(agg["P5"].items()):
        offs = sorted(d, key=float); c = cm(0.35 + 0.6 * i / max(1, len(agg["P5"]) - 1))
        ax[0].errorbar([float(o) for o in offs], [d[o]["goodput"][0] for o in offs], yerr=[d[o]["goodput"][1] for o in offs], marker="o", ms=3, color=c, label=f"{k} PEP")
        ax[1].errorbar([float(o) for o in offs], [d[o]["p95_ms"][0] for o in offs], yerr=[d[o]["p95_ms"][1] for o in offs], marker="o", ms=3, color=c, label=f"{k} PEP")
    mx = max(float(o) for d in agg["P5"].values() for o in d); ax[0].plot([0, mx], [0, mx], "k:", lw=.8, label="offered")
    ax[0].set_xlabel("offered rate (req/s)"); ax[0].set_ylabel("goodput (req/s)"); ax[0].legend(fontsize=6)
    ax[1].set_yscale("log"); ax[1].set_xlabel("offered rate (req/s)"); ax[1].set_ylabel("p95 latency (ms)"); ax[1].legend(fontsize=6)
    fig.tight_layout(); fig.savefig(os.path.join(out, "fig10_scaling.png"), dpi=200); plt.close(fig)
print("wrote", out, "runs:", len(runs))
