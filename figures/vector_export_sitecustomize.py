import matplotlib
matplotlib.use("Agg")
from matplotlib.figure import Figure
_orig = Figure.savefig
def savefig(self, fname, *a, **k):
    _orig(self, fname, *a, **k)
    f = str(fname)
    if f.endswith(".png"):
        base = f[:-4]
        kk = {kk_: v for kk_, v in k.items() if kk_ != "dpi"}
        _orig(self, base + ".pdf", **kk)
        axs = [x for x in self.axes if x.get_visible()]
        if len(axs) == 2:
            self.canvas.draw()
            r = self.canvas.get_renderer()
            for i, ax in enumerate(axs):
                bb = ax.get_tightbbox(r)
                # include legend sitting outside axes
                lg = ax.get_legend()
                if lg is not None: bb = matplotlib.transforms.Bbox.union([bb, lg.get_window_extent(r)])
                bb = bb.transformed(self.dpi_scale_trans.inverted()).padded(0.04)
                _orig(self, base + "_p%d.pdf" % (i + 1), bbox_inches=bb)
Figure.savefig = savefig
