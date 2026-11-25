#!/usr/bin/env bash
# 停止服务（保留数据）
set -euo pipefail
cd "$(dirname "$0")"
if command -v docker >/dev/null 2>&1; then
  docker compose down
  echo "已停止（数据保留在 Docker volume 中）"
else
  echo "未检测到 Docker；本机模式请执行 scripts/start-all.ps1 对应的 stop-all.ps1"
  exit 1
fi
