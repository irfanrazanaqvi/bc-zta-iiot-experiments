#!/usr/bin/env python3
"""Aggregates repeated runs of benchmark/run_benchmark.js into one JSON (means over runs).
Usage: python3 benchmark/aggregate_results.py benchmark/results/ci-2026-10-06"""
import json, os, sys, statistics as st

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results", "ci-2026-10-06")
runs = [json.load(open(os.path.join(d, f"run{i}", "measured_results.json"))) for i in (1, 2, 3)]
m = lambda xs: sum(xs) / len(xs)
sd = lambda xs: st.stdev(xs) if len(xs) > 1 else 0.0

agg = {"runs": len(runs), "dates": [r["meta"]["date"] for r in runs], "workers": runs[0]["meta"]["workers"], "duration_s": runs[0]["meta"]["duration_s"]}
agg["S1_write_confirmation_phase_locked"] = {k: {"mean_ms": m([r["S1_write_confirmation"][k]["mean_ms"] for r in runs]),
                                                  "p95_ms": m([r["S1_write_confirmation"][k]["p95_ms"] for r in runs])} for k in runs[0]["S1_write_confirmation"]}
rk = list(runs[0]["S2_read_latency"])[0]
agg["S2_read_latency"] = {"mean_ms": m([r["S2_read_latency"][rk]["mean_ms"] for r in runs]), "mean_sd": sd([r["S2_read_latency"][rk]["mean_ms"] for r in runs]),
                          "p95_ms": m([r["S2_read_latency"][rk]["p95_ms"] for r in runs])}
agg["S3_per_event_logging"] = []
for i, row in enumerate(runs[0]["S3_per_event_logging"]):
    rows = [r["S3_per_event_logging"][i] for r in runs]
    lat = [x["mean_ms"] for x in rows if x["mean_ms"] is not None]
    p95 = [x["p95_ms"] for x in rows if x["p95_ms"] is not None]
    agg["S3_per_event_logging"].append({
        "offered_tps": row["offered_tps"], "committed_tps": m([x["committed_tps"] for x in rows]), "committed_tps_sd": sd([x["committed_tps"] for x in rows]),
        "mean_ms": m(lat) if lat else None, "mean_ms_sd": sd(lat), "p95_ms": m(p95) if p95 else None,
        "confirmed_fraction": m([x["confirmed"] / x["submitted"] for x in rows]), "failed_per_run": [x["failed"] for x in rows]})
agg["S4_batch_anchoring"] = {"mean_ms": m([r["S4_batch_anchoring"]["mean_ms"] for r in runs]), "p95_ms": m([r["S4_batch_anchoring"]["p95_ms"] for r in runs]),
                             "confirmed": [r["S4_batch_anchoring"]["confirmed"] for r in runs]}
agg["S5_revocation_visibility_phase_locked"] = {"mean_ms": m([r["S5_revocation_visibility"]["mean_ms"] for r in runs]),
                                                "p95_ms": m([r["S5_revocation_visibility"]["p95_ms"] for r in runs])}
json.dump(agg, open(os.path.join(d, "aggregate.json"), "w"), indent=2)
print(json.dumps(agg, indent=1)[:3000])
