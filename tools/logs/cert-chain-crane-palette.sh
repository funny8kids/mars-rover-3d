# Re-certification chain for the recoloured crane bytes. Three shipping rulers, SEQUENTIALLY,
# one Chrome on :9333, each with its own log and named rc. No src/** edit may happen between the
# first start and the last rc — the voiding window starts at the run, not at its finish.
set -u
cd /home/dominic-jamil/GIthub_Code/mars-rover-3d
L=tools/logs
D=2026-09-29-palette
find src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12 | sed "s/^/SRC_MD5 /"
node tools/cdp-tour-audit.mjs "http://127.0.0.1:8080/qa_boot.html?auto=std" 9333 300 10 > "$L/tour-crane-$D.log" 2>&1
echo "TOUR_RC=$?" | tee -a "$L/tour-crane-$D.log"
node tools/cdp-clip-sweep.mjs "http://127.0.0.1:8080/qa_boot.html?auto=std" 9333 > "$L/clip-crane-$D.log" 2>&1
echo "CLIP_RC=$?" | tee -a "$L/clip-crane-$D.log"
node tools/cdp-type-click.mjs "http://127.0.0.1:8080/qa_boot.html" 9333 > "$L/click-crane-$D.log" 2>&1
echo "CLICK_WALK_RC=$?" | tee -a "$L/click-crane-$D.log"
find src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12 | sed "s/^/SRC_MD5_END /"
echo "CHAIN_DONE"
