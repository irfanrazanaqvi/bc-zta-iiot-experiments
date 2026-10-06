"""Fig. 1 - three-tier BC-ZTA architecture, drawn at IEEE single-column width (3.4 in), text >= 8 pt.
Usage: python3 fig1_architecture.py [outdir]"""
import sys, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
fig, ax = plt.subplots(figsize=(3.4, 4.3))
ax.set_xlim(0, 10); ax.set_ylim(0, 12.7); ax.axis("off")
FS = 8

def box(x, y, w, h, text, fc, ec):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.12", lw=0.9, ec=ec, fc="white"))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=FS, color="#0b2545", linespacing=0.95)

def tier(y0, h, title, fc, ec, rows):
    ax.add_patch(FancyBboxPatch((0.1, y0), 9.8, h, boxstyle="round,pad=0.02,rounding_size=0.15", lw=1.3, ec=ec, fc=fc))
    ax.text(0.35, y0 + h - 0.45, title, ha="left", va="center", fontsize=FS, weight="bold", color="#0b2545")
    top = y0 + h - 0.8
    bh = 1.3
    for r, labels in enumerate(rows):
        y = top - (r + 1) * bh - r * 0.25
        k = len(labels); gap = 0.2; w = (9.3 - gap * (k - 1)) / k
        for i, lab in enumerate(labels):
            box(0.35 + i * (w + gap), y, w, bh, lab, fc, ec)

tier(8.65, 3.95, "Layer III: Permissioned blockchain (Besu, IBFT 2.0)", "#eaeefb", "#3949ab",
     [["Identity\nRegistry", "Trust\nReputation", "Access\nControl"],
      ["Audit Log\n(Merkle anchor)", "IBFT 2.0\nvalidators"]])
tier(4.35, 3.95, "Layer II: Zero-trust layer (edge)", "#eaf7ea", "#2e7d32",
     [["PEP", "PDP /\nABAC", "Trust\nengine"],
      ["State cache\n(Merkle-verified)", "Micro-\nsegmentation"]])
tier(0.1, 3.95, "Layer I: IIoT devices", "#fdf3e7", "#b5651d",
     [["PLC /\nactuator", "Sensor", "Edge\ngateway"],
      ["Fog / MEC\nnode", "SDN\nswitch"]])
for xi in (2.0, 5.0, 8.0):
    for (y1, y2) in ((4.05, 4.35), (8.3, 8.65)):
        ax.add_patch(FancyArrowPatch((xi, y1), (xi, y2), arrowstyle="<|-|>", mutation_scale=7, color="#333333", lw=0.8))
plt.subplots_adjust(left=0.01, right=0.99, top=0.995, bottom=0.005)
plt.savefig(os.path.join(out, "fig1_architecture.png"), dpi=600)
