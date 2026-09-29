#!/usr/bin/env bash
# 把当前源码同步进 dist/，并在写之前先跑两道源码闸 —— 红线落在真正执行写入的这条命令上。
#
# 为什么要闸在同步这一步：本仓库没有 CI、没有 pre-commit/pre-push 钩子（.git/hooks 里只有
# post-checkout 和 post-commit，且钩子不进仓库、换台机器就不存在），dist/ 是唯一会被发出去的
# 产物。判据若只印在自己的 stdout 上，就得有人「记得去看」；判据与写入放进同一条命令，红就停，
# 就没有可跳过的中间状态。
#
# 两道闸：
#   node tools/primitive_census.mjs --check     每个手绘图元要么带着 RETAINED 理由，要么挂着票
#   node tools/audit_double_sided.mjs --check   assets.js 的 SHEETS 表还对着库里的真实拓扑
#
# 用法：bash tools/sync_dist.sh
# 只验闸不写产物：RSB_DIST=/tmp/some-dir bash tools/sync_dist.sh
set -u

cd "$(dirname "$0")/.." || exit 1
DIST="${RSB_DIST:-dist}"

python3 tools/glb-orphan-scan.py --emit-exclude /tmp/rsb-glb-exclude.txt >/tmp/rsb-sync-orphan.txt 2>&1
ORPHAN_RC=$?
node tools/primitive_census.mjs --check >/tmp/rsb-sync-census.txt 2>&1
CENSUS_RC=$?
node tools/audit_double_sided.mjs --check >/tmp/rsb-sync-ds.txt 2>&1
DS_RC=$?
printf 'CENSUS_RC=%s DS_RC=%s ORPHAN_RC=%s\n' "$CENSUS_RC" "$DS_RC" "$ORPHAN_RC"

# rc 0 = library fully wired, rc 4 = some file is unreferenced (it goes in the exclude list).
# Anything else is the scanner refusing to enumerate, and writing dist from a list it never produced
# would silently ship whatever the last run left in /tmp.
if [ "$ORPHAN_RC" -gt 4 ]; then
  echo "dist 未同步 —— 孤儿普查没给清单，判据见 /tmp/rsb-sync-orphan.txt" >&2
  exit 1
fi
if [ "$CENSUS_RC" -ne 0 ] || [ "$DS_RC" -ne 0 ]; then
  echo "dist 未同步 —— 判据见 /tmp/rsb-sync-census.txt 与 /tmp/rsb-sync-ds.txt" >&2
  exit 1
fi

rsync -a --delete index.html src vendor "$DIST"/ || exit 2
# --delete-excluded is load-bearing and easy to get wrong: a plain --exclude hides the file from the
# transfer but also *protects* an already-present copy in dist, so the first run of this rule left all
# 64 dead files in place and still reported 131. The exclude is only a shrink when the destination's
# copy is deleted with it.
rsync -a --delete --delete-excluded public/assets/ "$DIST"/assets/ --exclude web --exclude-from=/tmp/rsb-glb-exclude.txt || exit 3
# The artifact is checked against the page's own request set, so the exclusion cannot take a file the
# rover would ask for: that is a broken site, not a smaller site.
python3 tools/dist-request-check.py --root "$DIST" || exit 4
python3 tools/glb-orphan-scan.py --assets "$DIST/assets" >/tmp/rsb-sync-orphan-after.txt 2>&1
AFTER_RC=$?
printf 'ORPHAN_AFTER_RC=%s (%s)\n' "$AFTER_RC" "$(grep -o 'EXCLUDE_EMITTED [0-9]*\|ENUMERATED [^·]*· [^·]*· [^·]*' /tmp/rsb-sync-orphan-after.txt | head -1)"
echo "dist 已写入 $DIST（源码 $(git rev-parse --short HEAD) 之后含未提交改动）"
