# Gate probe for the plaza flag cloth builder — the acceptance table's control run.
#
# Why this exists: `accept()` in build_flag_cloth.py is a pure function of a sweep table, and the
# shipped sweep reaches only one of its branches. It flies one calm arm and hangs the rest, so the
# three named refusals — NEVER_FLEW, NEVER_QUIET, OFF_TARGET — would be code that no real build ever
# walks. A gate nobody has seen refuse is a gate that has not been tested, and the last time this
# ticket shipped a gate on that basis it reported a green sweep over a banner folded against the mast.
#
# bending_damping 0.5 / 5.0 / 20.0 across wind 10 000-90 000 and is where the gusty and over-flown
# arms below come from). The table is 13 cases: 8 for accept() and 5 for the export certification
# below it. Every arm is data this solver produced, except the inert-wind pair, which is written by
# hand because no arm in the sweep is that flat. The rest of the job is moving a threshold on data
# that otherwise passes, which proves the comparison is load-bearing rather than decorative.
#
# Invariants the cases must keep: a refusal case needs at least two rows (a one-row table trips the
# inert-wind bar first and goes green for the wrong reason), and a mutation case needs a pair where
# every other bar is comfortably met, so the refusal is named for the number that moved.
#
# Run: blender --background --python tools/blender/probe_flag_gates.py
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_flag_cloth as B


def row(strength, ang, drift, reach, flap, settled=True):
    """One SWEEP line, in the same units the builder prints: deg, deg, m, deg."""
    return {"strength": strength, "settled": settled, "ang": ang, "ang_drift": drift,
            "reach": reach, "flap": flap, "ripple": 0.083, "freeze": 200,
            "ang_f": ang, "reach_f": reach, "ang_dev": 0.0}


# Measured arms, verbatim from the 2026-09-27 bending_damping probe (damping, wind -> fly-deg,
# one-second angle drift, reach, peak-to-peak flap):
HANG = row(10000.0, 35.74, 6.09, 1.471, 19.30)        #  0.5 — hanging in a fold, below REACH_MIN
GUST = row(90000.0, 8.68, 4.60, 1.916, 45.26)         #  0.5 — flies, but its own mean repeats to 4.6
FLY = row(90000.0, 5.39, 0.65, 2.030, 22.68)          #  5.0 — the arm the builder picks
LEAN = row(30000.0, 10.73, 1.81, 2.000, 16.85)        #  5.0 — calm, flies, 4.3 deg off the target
OVER = row(90000.0, 2.37, 2.27, 2.070, 13.35)         # 20.0 — calm, flown nearly horizontal

cases = []


def expect_refusal(name, rows, want, mods=None):
    """Run accept(rows), optionally with thresholds moved, and require one specific named refusal."""
    saved = {k: getattr(B, k) for k in (mods or {})}
    for k, v in (mods or {}).items():
        setattr(B, k, v)
    try:
        B.accept(rows)
        got = None
    except SystemExit as e:
        got = str(e)
    finally:
        for k, v in saved.items():
            setattr(B, k, v)
    ok = got is not None and got.startswith("FLAG_CLOTH_" + want)
    cases.append((name, ok, (got or "ACCEPTED").split(" —")[0]))


def expect_pick(name, rows, want_strength):
    try:
        best = B.accept(rows)
        ok = best["strength"] == want_strength
        got = "%s @ %.0f" % ("PICKED" if ok else "WRONG", best["strength"])
    except SystemExit as e:
        ok, got = False, str(e).split(" —")[0]
    cases.append((name, ok, got))


# --- polarity controls: each refusal has to be reachable, and by a table that was measured.
# Two rows minimum per case: a one-row table trips the inert-wind bar before it ever reaches the
# gate under test, which is the wrong kind of green for the other three.
expect_refusal("inert-wind", [row(10000.0, 22.0, 1.0, 1.2, 3.0), row(90000.0, 22.05, 1.0, 1.2, 3.0)],
               "WIND_INERT")
expect_refusal("never-flew", [HANG, row(30000.0, 31.0, 5.0, 1.35, 12.0, settled=False)], "NEVER_FLEW")
expect_refusal("never-quiet", [HANG, GUST], "NEVER_QUIET")
expect_refusal("off-target", [HANG, OVER], "OFF_TARGET")

# --- false-positive control: the honest sweep must pass, and must pick the calmest closest arm.
expect_pick("picks-the-flying-arm", [HANG, GUST, FLY, LEAN], FLY["strength"])

# --- mutation controls: on a table that passes, each threshold has to still decide the outcome.
# The pair is FLY (5.39 deg, drift 0.65, reach 2.030) with LEAN (10.73 deg, drift 1.81, 2.000 m):
# both calm, both flying, both inside the target bar, so every refusal below is the moved number's.
expect_refusal("mut-reach", [FLY, LEAN], "NEVER_FLEW", {"REACH_MIN": 2.05})
expect_refusal("mut-angstab", [FLY, LEAN], "NEVER_QUIET", {"ANGSTAB_MAX": 0.5})
expect_refusal("mut-tol", [FLY, LEAN], "OFF_TARGET", {"TOL_DEG": 0.5})


# --- the export certification, same two halves: it must let the honest pair through and refuse the
# pair this builder's print once confused (the frozen frame read against its own one-second window).
# FRAME/EXPORT are run 10's two printed readings of the same sheet — before and after the hem and the
# 1.6 mm shell — and they differ by exactly the drift the bars are sized against, so the passing case
# is a measured pair, not a pair invented by copying one number twice. /tmp/flag-cloth-10.log.
def expect_certify(name, cap, out, want, mods=None):
    saved = {k: getattr(B, k) for k in (mods or {})}
    for k, v in (mods or {}).items():
        setattr(B, k, v)
    try:
        B.certify(cap, out)
        got = None if want is None else "PASSED"
        ok = want is None
    except SystemExit as e:
        got = str(e)
        ok = want is not None and got.startswith("FLAG_CLOTH_" + want)
    finally:
        for k, v in saved.items():
            setattr(B, k, v)
    cases.append((name, ok, got or "PASSED"))


FRAME, EXPORT, WINDOW = (6.04, 1.879), (6.02, 1.879), (5.39, 2.030)
expect_certify("export-agrees", FRAME, EXPORT, None)
expect_certify("export-moved", FRAME, WINDOW, "EXPORT_MOVED")
# Each bar gets a mutation that changes only its own field, so a refusal names the number that moved
# rather than whichever of the two comparisons happened to trip.
expect_certify("mut-export-deg", FRAME, (6.02, 1.879), "EXPORT_MOVED", {"EXPORT_TOL_DEG": 0.01})
expect_certify("mut-export-m", FRAME, (6.04, 1.8835), "EXPORT_MOVED", {"EXPORT_TOL_M": 0.002})
expect_certify("mut-export-loose", FRAME, WINDOW, None, {"EXPORT_TOL_DEG": 1.0, "EXPORT_TOL_M": 0.2})

bad = [c for c in cases if not c[1]]
print("GATES  %-18s %-4s %s" % ("case", "ok", "got"))
for name, ok, got in cases:
    print("GATES  %-18s %-4s %s" % (name, "yes" if ok else "NO", got), flush=True)
print("GATES  cases=%d failed=%d  (bars: reach>=%.2f m, drift<=%.2f deg, target=%.2f+/-%.2f deg, "
      "export +/-%.2f deg/%.3f m)"
      % (len(cases), len(bad), B.REACH_MIN, B.ANGSTAB_MAX, B.TARGET_DEG, B.TOL_DEG,
         B.EXPORT_TOL_DEG, B.EXPORT_TOL_M))
if bad:
    print("FLAG_GATES_FAIL " + ", ".join(n for n, _o, _g in bad))
    raise SystemExit(1)
print("FLAG_GATES_DONE")
