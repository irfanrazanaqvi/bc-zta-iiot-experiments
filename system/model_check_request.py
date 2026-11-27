#!/usr/bin/env python3
"""Bounded explicit-state model check of the BC-ZTA request protocol (perfect-crypto abstraction).

Sound only for the stated bounds; it is not a ProVerif/Tamarin proof. The attacker owns the network: it sees every
message, may deliver any seen message to any gateway at any later tick, and may inject messages whose signature does
not verify. Signatures are unforgeable tokens. Safety properties checked exhaustively:
  P1  no device-signed request is accepted more than once (across all gateways)  [replay]
  P2  no message with an invalid signature is accepted                           [forgery / tamper]
Variants: nonce cache per gateway or shared; gateway id inside the signed fields (GATEWAY_BIND) or not.
A second check enumerates the cache automaton for revocation delay and the fail-closed bound k*TTL.
Usage: model_check_request.py <out.json>
"""
import json, sys, itertools
DELTA, T, GWS, FRESH = 2, 7, ("g0", "g1"), 2

def accepts(msg, g, now, caches, scope, bind):
    n, t, gw, valid = msg
    if not valid or abs(now - t) > DELTA: return False
    if bind and gw != g: return False
    key = None if scope == "shared" else g
    return n not in caches.get(key, ())

def check(scope, bind):
    # state: (now, fresh_used, seen, caches, acc) ; caches: tuple of (key, frozenset(nonces)); acc: tuple of (n, count) for valid msgs
    init = (0, 0, frozenset(), (), (), 0)
    stack, seen_states, trace_of = [init], {init}, {init: ()}
    viol = {"P1": None, "P2": None}
    while stack:
        s = stack.pop(); now, fu, seen, caches, acc, inval = s
        cd = {k: set(v) for k, v in caches}; ad = dict(acc)
        succ = []
        if now < T: succ.append((("tick",), (now + 1, fu, seen, caches, acc, inval)))
        acts = []
        if fu < FRESH:
            for g in GWS:
                m = (fu, now, g if bind else None, True)
                acts.append((("device-send", m, g), m, g, True))
        for m in seen:
            for g in GWS:
                acts.append((("replay", m, g), m, g, False))
            n, t, gw, valid = m
            if valid:  # attacker alters a signed field -> signature no longer verifies
                for g in GWS:
                    acts.append((("tamper+deliver", (n, now, gw, False), g), (n, now, gw, False), g, False))
        for lab, m, g, fresh in acts:
            seen2 = seen | {m}
            cd2 = {k: set(v) for k, v in cd.items()}; ad2 = dict(ad); inv2 = inval
            if accepts(m, g, now, cd2, scope, bind):
                key = None if scope == "shared" else g
                cd2.setdefault(key, set()).add(m[0])
                if m[3]: ad2[m[0]] = ad2.get(m[0], 0) + 1
                else: inv2 += 1
            ns = (now, fu + (1 if fresh else 0), seen2, tuple(sorted((k, frozenset(v)) for k, v in cd2.items() if True)), tuple(sorted(ad2.items())), inv2)
            succ.append((lab, ns))
        for lab, ns in succ:
            if ns in seen_states: continue
            seen_states.add(ns); trace_of[ns] = trace_of[s] + (lab,); stack.append(ns)
            if any(c > 1 for _, c in ns[4]) and viol["P1"] is None: viol["P1"] = [str(x) for x in trace_of[ns]]
            if ns[5] > 0 and viol["P2"] is None: viol["P2"] = [str(x) for x in trace_of[ns]]
    return {"states": len(seen_states), "P1_replay_safe": viol["P1"] is None, "P2_forgery_safe": viol["P2"] is None,
            "P1_counterexample": viol["P1"]}

def cache_automaton(tau=10, k=2, eps=3, horizon=60):
    """Enumerate cache-refresh phases and event delays (integer seconds). Revocation final at r; gateway polls every tau
    from phase phi; read latency <= eps; DIDRevoked event, when delivered, arrives after d <= eps (or is lost)."""
    worst_events = worst_lost = 0
    for r in range(0, tau):
        for phi in range(tau):
            for d in range(eps + 1):                       # event delivered
                worst_events = max(worst_events, d)
            polls = [p for p in range(phi, horizon, tau) if p >= r]
            worst_lost = max(worst_lost, polls[0] - r + eps)   # event lost: next poll after r, plus read latency
    # fail-closed: ledger unreachable from c. The entry was last read at l <= c (refresh is lazy, on request, so l can be
    # older than tau); the rule serves it only while now <= l + k*tau, hence the last grant is at most c + k*tau.
    last_grant = max(l + k * tau - c for c in range(tau) for l in range(c - k * tau + 1, c + 1))
    return {"tau": tau, "k": k, "eps": eps, "max_delay_event_delivered": worst_events,
            "max_delay_event_lost_poll_only": worst_lost, "poll_only_bound_tau_plus_eps": tau + eps,
            "poll_only_within_bound": worst_lost <= tau + eps,
            "failclosed_last_grant_after_cut_s": last_grant, "failclosed_bound_k_tau": k * tau,
            "failclosed_within_bound": last_grant <= k * tau}

if __name__ == "__main__":
    out = {"params": {"delta_ticks": DELTA, "horizon_ticks": T, "gateways": len(GWS), "fresh_requests": FRESH,
                      "attacker": "Dolev-Yao-style network control, perfect crypto; not ProVerif"}, "variants": {}}
    for scope in ("local", "shared"):
        for bind in (False, True):
            out["variants"][f"nonce_{scope}__gateway_bind_{'on' if bind else 'off'}"] = check(scope, bind)
    out["cache_automaton"] = cache_automaton()
    print(json.dumps(out, indent=1)[:3000])
    if len(sys.argv) > 1: json.dump(out, open(sys.argv[1], "w"), indent=1)
