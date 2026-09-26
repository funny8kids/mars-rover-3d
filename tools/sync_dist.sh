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

node tools/primitive_census.mjs --check >/tmp/rsb-sync-census.txt 2>&1
CENSUS_RC=$?
node tools/audit_double_sided.mjs --check >/tmp/rsb-sync-ds.txt 2>&1
DS_RC=$?
printf 'CENSUS_RC=%s DS_RC=%s\n' "$CENSUS_RC" "$DS_RC"

if [ "$CENSUS_RC" -ne 0 ] || [ "$DS_RC" -ne 0 ]; then
  echo "dist 未同步 —— 判据见 /tmp/rsb-sync-census.txt 与 /tmp/rsb-sync-ds.txt" >&2
  exit 1
fi

rsync -a --delete index.html src vendor "$DIST"/ || exit 2
rsync -a --delete public/assets/ "$DIST"/assets/ --exclude web || exit 3
echo "dist 已写入 $DIST（源码 $(git rev-parse --short HEAD) 之后含未提交改动）"
