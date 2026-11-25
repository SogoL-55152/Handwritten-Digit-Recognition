#!/usr/bin/env bash
# 清空重来：删除容器与全部数据卷（数据库、训练数据都会没）
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "未检测到 Docker"; exit 1; }
read -r -p "这会删除所有数据（数据库/样本/训练产物），确定吗？输入 yes 继续：" answer
[ "$answer" = "yes" ] || { echo "已取消"; exit 0; }
docker compose down -v
echo "已清空。下次 ./start.sh 会重新初始化数据库和管理员账号。"
