#!/usr/bin/env python3
"""Closed-form model of revocation delay, stale service and Merkle proof size, compared with the measured runs.
Calibrates ONE parameter (eps, propagation + read latency) from the event-driven mean, then predicts the others.
Usage: analytic_model.py <aggregate_e2e.json> <aggregate_robust.json> <audit_verify.json> <raw_results.json> <out.json>"""
import json, sys, math
e2e, rob, av, raw, out = sys.argv[1:6]
E2 = json.load(open(e2e))["E2"]; R = json.load(open(rob)); A = json.load(open(av)); G = json.load(open(raw))["gas_per_record"]
B, tau, k = 2.0, 10.0, 2                      # Besu block period (s), cache TTL (s), stale factor
ev, tt = E2["bczta-events"], E2["bczta-ttl"]
eps = ev["mean_ms"] / 1000 - B / 2            # calibrated from events mean:  E[D_ev] = B/2 + eps
res = {"inputs": {"block_period_s": B, "ttl_s": tau, "k": k, "eps_s_calibrated": eps}, "revocation": {}, "failclosed": {}, "proof": []}
pred = {"events_mean_s": B / 2 + eps, "events_max_s": B + eps, "ttl_mean_s": B / 2 + tau / 2 + eps, "ttl_max_s": B + tau + eps}
meas = {"events_mean_s": ev["mean_ms"] / 1000, "events_max_s": ev["max_ms"] / 1000, "ttl_mean_s": tt["mean_ms"] / 1000, "ttl_max_s": tt["max_ms"] / 1000}
for kx in pred: res["revocation"][kx] = {"predicted": pred[kx], "measured": meas[kx], "rel_err": (meas[kx] - pred[kx]) / pred[kx], "calibrated": kx == "events_mean_s"}
p3 = R["P3"]["bczta"]; s = p3["summary"]
res["failclosed"] = {"bound_k_tau_s": k * tau, "measured_granted_after_2ttl": s["granted_after_2ttl"], "measured_last_grant_within_bound": all(x == 0 for x in s["granted_after_2ttl"]),
                     "measured_first_denial_s_after_cut": s["seconds_until_denials"]}
push = R["P2"]["push"]["mean_ms"] / 1000
res["ledger_premium_over_push"] = {"expected_s": B / 2, "worst_case_s": B, "measured_events_minus_push_s": ev["mean_ms"] / 1000 - push, "push_mean_s": push}
for r in A["A"] + A["B"]:
    n = r.get("batch", r.get("devices")); res["proof"].append({"leaves": n, "predicted_bytes": 32 * math.ceil(math.log2(n)), "measured_bytes": r["proof_bytes"]})
res["proof_exact_match"] = all(x["predicted_bytes"] == x["measured_bytes"] for x in res["proof"])
ga, ge = G["anchorBatch_per_record_at_1000"] * 1000, G["logEvent_per_record"]
res["gas"] = {"anchor_tx_gas": ga, "log_event_gas_per_record": ge, "break_even_batch": ga / ge}
json.dump(res, open(out, "w"), indent=1); print(json.dumps(res, indent=1))
