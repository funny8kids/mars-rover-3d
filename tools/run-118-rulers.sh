#!/bin/bash
# Three shipping rulers re-run on the #118 bytes, serially against the one Chrome on :9333.
cd /home/dominic-jamil/GIthub_Code/mars-rover-3d
U="http://127.0.0.1:8080/qa_boot.html?auto=std"
L=tools/logs
echo "CHAIN_START $(date -u +%FT%TZ)"
echo "SRC_MD5_START $(find src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12)"
node tools/cdp-clip-sweep.mjs "$U" 9333 > $L/clip-sweep-118.log 2>&1; echo "CLIP_RC=$?"
node tools/cdp-tour-audit.mjs "$U" 9333 300 10 > $L/tour-a4-118.log 2>&1; echo "TOUR_RC=$?"
node tools/cdp-type-click.mjs "http://127.0.0.1:8080/qa_boot.html" 9333 > $L/click-walk-118.log 2>&1; echo "CLICK_RC=$?"
echo "SRC_MD5_END $(find src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12)"
node tools/boulder-spire-probe.mjs > $L/boulder-spire-2026-09-29-final.log 2>&1; echo "SPIRE_RC=$?"
echo "CHAIN_DONE $(date -u +%FT%TZ)"
