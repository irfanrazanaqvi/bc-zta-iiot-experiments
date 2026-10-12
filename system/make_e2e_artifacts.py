"""Aggregate the end-to-end runs (run1..runN) and the E5 fault run, and draw Figs. 3-6 for the paper.
usage: python3 system/make_e2e_artifacts.py benchmark/results/gcp-2026-10-11 system/output"""
import json, sys, os, glob, statistics as st
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
RUN_IDS = sorted(int(os.path.basename(d)[3:]) for d in glob.glob(os.path.join(src, "run[0-9]*")) if os.path.isfile(os.path.join(d, "e2e_results.json")))
runs = [json.load(open(os.path.join(src, f"run{r}", "e2e_results.json"))) for r in RUN_IDS]
FAULT = os.path.join(src, "fault", "fault_results.json")
fault = json.load(open(FAULT)) if os.path.isfile(FAULT) else None
sd = lambda v: st.stdev(v) if len(v) > 1 else 0.0
mean = lambda v: sum(v) / len(v)
SYS = ["central", "abac", "bczta", "bcsync"]
LABEL = {"central": "Central PKI-IAM", "abac": "ABAC (no BC)", "bczta": "Proposed BC-ZTA", "bcsync": "Blockchain-only (sync)"}
counts = runs[0]["meta"]["counts"]
agg = {"runs": len(runs), "counts": counts, "duration_s": runs[0]["meta"]["duration_s"], "warmup_s": runs[0]["meta"]["warmup_s"],
       "wan_rtt_ms": runs[0]["meta"]["wan_rtt_ms"], "deployment": runs[0]["meta"].get("deployment", "single-host"),
       "netem_wan_ms": runs[0]["meta"].get("netem_wan_ms"), "netem_validator_ms": runs[0]["meta"].get("netem_validator_ms"), "E1": {}, "E2": {}, "E3": {}, "E4": {}}
for s in SYS:
    agg["E1"][s] = []
    for i, n in enumerate(counts):
        rs = [r["E1"][s][i] for r in runs]
        meas = sum(x["measured"] for x in rs); ok = sum(x["ok"] for x in rs)
        row = {"devices": n, "mean_ms": mean([x["mean_ms"] for x in rs]), "mean_ms_sd": sd([x["mean_ms"] for x in rs]),
               "p95_ms": mean([x["p95_ms"] for x in rs]), "p99_ms": mean([x["p99_ms"] for x in rs]),
               "goodput_rps": mean([x["goodput_rps"] for x in rs]), "goodput_sd": sd([x["goodput_rps"] for x in rs]),
               "success_ratio": ok / meas, "late": sum(x.get("late", 0) for x in rs), "failed_or_timeout": sum(x["failed_or_timeout"] for x in rs),
               "cpu_cores": mean([x["pep"]["cpu_cores_avg"] for x in rs]),
               "cache_hit_ratio": (mean([x["pep"]["cache_hit_ratio"] for x in rs]) if rs[0]["pep"]["cache_hit_ratio"] is not None else None),
               "onchain_tx_per_s": mean([(x["pep"]["tx_confirmed"] + x["pep"]["anchors_sent"]) / (agg["duration_s"] + agg["warmup_s"]) for x in rs])}
        agg["E1"][s].append(row)
for v in runs[0]["E2"]:
    sm = [x for r in runs for x in r["E2"][v]["samples_ms"]]
    agg["E2"][v] = {"n": len(sm), "mean_ms": mean(sm), "p95_ms": float(np.percentile(sm, 95)), "max_ms": max(sm), "ttl_s": runs[0]["E2"][v]["ttl_s"]}
for k in runs[0]["E3"]:
    if k == "revoked_device":
        agg["E3"][k] = {"accepted_before_revocation": [r["E3"][k]["accepted_before_revocation"] for r in runs],
                        "accepted_after_tx_confirmed": [r["E3"][k]["accepted_after_tx_confirmed"] for r in runs],
                        "first_denial_after_confirmation_ms": [r["E3"][k]["first_denial_after_confirmation_ms"] for r in runs]}
    else:
        agg["E3"][k] = {"attempts": sum(r["E3"][k]["attempts"] for r in runs), "allowed": sum(r["E3"][k]["allowed"] for r in runs), "denied": sum(r["E3"][k]["denied"] for r in runs)}
for k in runs[0]["E4"]:
    rs = [r["E4"][k] for r in runs]
    agg["E4"][k] = {"mean_ms_per_run": [x["mean_ms"] for x in rs], "p95_ms_per_run": [x["p95_ms"] for x in rs],
                    "success_ratio_per_run": [x["ok"] / x["measured"] for x in rs], "reasons": [x["reasons"] for x in rs],
                    "flood": [x.get("flood") for x in rs]}
if fault:
    agg["E5"] = {"duration_s": fault["meta"]["duration_s"], "revoke_at_s": fault["meta"]["revoke_at_s"], "mean_ms": fault["load"]["mean_ms"], "p95_ms": fault["load"]["p95_ms"],
                "measured": fault["load"]["measured"], "ok": fault["load"]["ok"], "denied": fault["load"]["denied"], "failed_or_timeout": fault["load"]["failed_or_timeout"],
                "late": fault["load"].get("late", 0), "revocation_during_fault_ms": fault["revocation_during_fault_ms"], "pep": fault["pep"]}
json.dump(agg, open(os.path.join(out, "aggregate_e2e.json"), "w"), indent=2)

plt.rcParams.update({"font.size": 7.5, "axes.spines.top": False, "axes.spines.right": False, "axes.linewidth": 0.7, "legend.frameon": False, "font.family": "DejaVu Sans"})
COL = {"central": "#8a6d1d", "abac": "#5b7f3a", "bczta": "#1f5f8b", "bcsync": "#a8322d"}
MK = {"central": "^", "abac": "s", "bczta": "o", "bcsync": "D"}
W = 3.4

fig, ax = plt.subplots(figsize=(W, 3.0))
for s in SYS:
    y = np.array([r["mean_ms"] for r in agg["E1"][s]]); e = np.array([r["mean_ms_sd"] for r in agg["E1"][s]])
    ax.errorbar(counts, y, yerr=e, marker=MK[s], color=COL[s], ms=3, lw=1.2, capsize=1.5, label=LABEL[s])
ax.set_yscale("log"); ax.set_xlabel("Number of devices (1 request/s each)"); ax.set_ylabel("Mean end-to-end latency (ms)")
ax.set_xticks(counts); ax.set_ylim(2, 6e4); ax.legend(fontsize=6.3, loc="upper center", bbox_to_anchor=(0.5, -0.22), ncol=2)
fig.tight_layout(); fig.savefig(os.path.join(out, "fig3_latency.png"), dpi=600); plt.close(fig)

fig, (a1, a2) = plt.subplots(2, 1, figsize=(W, 3.2), sharex=True)
for s in SYS:
    a1.plot(counts, [r["goodput_rps"] for r in agg["E1"][s]], marker=MK[s], color=COL[s], ms=3, lw=1.2, label=LABEL[s])
    a2.plot(counts, [r["onchain_tx_per_s"] for r in agg["E1"][s]], marker=MK[s], color=COL[s], ms=3, lw=1.2)
a1.plot(counts, counts, ":", color="#555", lw=0.8)
a1.set_ylabel("Goodput (accepted req/s)"); a1.legend(fontsize=6.0, loc="upper left", labelspacing=0.25)
a2.set_ylabel("On-chain writes (tx/s)"); a2.set_xlabel("Number of devices (1 request/s each)"); a2.set_xticks(counts)
fig.tight_layout(); fig.savefig(os.path.join(out, "fig4_scalability.png"), dpi=600); plt.close(fig)

fig, ax = plt.subplots(figsize=(W, 2.5))
order = ["central", "abac", "bcsync", "bczta-events", "bczta-ttl"]
nm = {"central": "Central\nPKI-IAM", "abac": "ABAC\n(no BC)", "bcsync": "BC-only\n(sync)", "bczta-events": "BC-ZTA\nevents", "bczta-ttl": "BC-ZTA\nTTL 10 s"}
cl = [COL["central"], COL["abac"], COL["bcsync"], COL["bczta"], "#7fa6c4"]
m = [agg["E2"][v]["mean_ms"] / 1000 for v in order]; mx = [agg["E2"][v]["max_ms"] / 1000 for v in order]
ax.bar(range(5), m, color=cl, width=0.62)
ax.scatter(range(5), mx, marker="_", s=140, color="k", zorder=3, label="worst case observed")
ax.set_yscale("log"); ax.set_xticks(range(5)); ax.set_xticklabels([nm[v] for v in order], fontsize=6.5)
ax.set_ylabel("Revocation enforcement\ndelay (s, mean)"); ax.legend(fontsize=6.5, loc="upper left")
fig.tight_layout(); fig.savefig(os.path.join(out, "fig5_revocation.png"), dpi=600); plt.close(fig)
print(json.dumps({"E2": agg["E2"], "E4": agg["E4"]}, indent=1)[:1800])
