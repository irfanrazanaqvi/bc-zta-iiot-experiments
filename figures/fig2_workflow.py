"""Fig. 2 - per-request verification workflow, drawn at IEEE single-column width (3.4 in), text >= 8 pt.
Usage: python3 fig2_workflow.py [outdir]"""
import sys, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
fig, ax = plt.subplots(figsize=(3.4, 4.6))
ax.set_xlim(0, 10); ax.set_ylim(0.8, 14.1); ax.axis("off")
FS = 8
steps = [("1", "Device: signed request\n(DID, resource, time, nonce)", "#fdf3e7", "#b5651d"),
         ("2", "PEP: check time window,\nnonce, signature", "#eaf7ea", "#2e7d32"),
         ("3", "PEP: cached DID entry\n+ Merkle proof (chain read on miss)", "#eaf7ea", "#2e7d32"),
         ("4", "PDP: trust score + ABAC policy\n(class range, minimum trust)", "#eaf7ea", "#2e7d32"),
         ("5", "Allow / deny, risk-scored", "#eaf7ea", "#2e7d32"),
         ("6", "PEP: time-limited session;\nleast-privilege access to resource", "#fdf3e7", "#b5651d")]
h, gap, y = 1.7, 0.55, 14.0
ys = []
for n, t, fc, ec in steps:
    y -= h
    ax.add_patch(FancyBboxPatch((0.2, y), 6.3, h, boxstyle="round,pad=0.02,rounding_size=0.15", lw=1.0, ec=ec, fc=fc))
    ax.text(0.55, y + h / 2, n, ha="center", va="center", fontsize=FS, weight="bold", color=ec)
    ax.text(3.65, y + h / 2, t, ha="center", va="center", fontsize=FS, color="#0b2545", linespacing=0.95)
    ys.append(y)
    y -= gap
for a, b in zip(ys[:-1], ys[1:]):
    ax.add_patch(FancyArrowPatch((3.35, a), (3.35, b + h), arrowstyle="-|>", mutation_scale=8, color="#333333", lw=0.9))
# async branch
ax.add_patch(FancyBboxPatch((7.0, 4.6), 2.85, 4.4, boxstyle="round,pad=0.02,rounding_size=0.15", lw=1.0, ec="#3949ab", fc="#eaeefb", ls="--"))
ax.text(8.43, 6.8, "7  Async\nbatched audit\nroot + trust\nvotes to\nblockchain", ha="center", va="center", fontsize=FS, color="#0b2545", linespacing=0.95)
ax.add_patch(FancyArrowPatch((6.5, ys[4] + h / 2), (7.0, 6.9), arrowstyle="-|>", mutation_scale=8, color="#3949ab", lw=0.9, ls="--"))
ax.text(8.43, 3.5, "never on the\nrequest path", ha="center", va="center", fontsize=FS, style="italic", color="#3949ab", linespacing=0.95)
plt.subplots_adjust(left=0.01, right=0.99, top=0.995, bottom=0.005)
plt.savefig(os.path.join(out, "fig2_workflow.png"), dpi=600)
