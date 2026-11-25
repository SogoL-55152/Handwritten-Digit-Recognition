#!/usr/bin/env bash
# 一键启动：clone 后执行 ./start.sh（macOS / Linux / Git Bash）
set -euo pipefail

cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$1"; }
ok() { printf '    %s\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-40
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-40
  fi
}

# ---------------------------------------------------------------- 依赖
command -v docker >/dev/null 2>&1 || fail "未检测到 Docker。请安装 Docker Desktop（Windows/macOS）或 Docker Engine（Linux）后重试。"

# ---------------------------------------------------------------- .env
step "准备配置 .env"
if [ ! -f .env ]; then
  cat > .env <<EOF
# 由 start.sh 自动生成；请勿提交到 git
MYSQL_ROOT_PASSWORD=$(random_secret)
MYSQL_DATABASE=hdr_w2
DB_PASSWORD=$(random_secret)
V2_JWT_SECRET=$(random_secret)
MODEL_INTERNAL_TOKEN=$(random_secret)
MODEL_WEIGHTS_DIR=$(pwd)/model-service/weights
WEB_PORT=8088
HDR_BOOTSTRAP_ADMIN_USERNAME=admin
HDR_BOOTSTRAP_ADMIN_PASSWORD=$(random_secret | cut -c1-12)
RECOGNITION_MIN_CONFIDENCE=0.90
RECOGNITION_MIN_MARGIN=0.85
W2_MAX_WORKSPACES=3
W2_RECOGNITION_PER_MINUTE=60
W2_GLOBAL_RECOGNITION_PER_MINUTE=240
W2_MAX_MEMBERS=5
W2_DAILY_RECOGNITION_LIMIT=1000
W2_REGISTER_PER_IP=5
W2_REGISTER_WINDOW_SECONDS=900
EOF
  ok "已生成 .env（随机密码与密钥）"
else
  ok "已存在 .env，复用现有配置"
fi

# ---------------------------------------------------------------- 权重
step "检查基线权重"
if [ ! -f model-service/weights/registry.json ]; then
  warn "未找到权重，开始下载…"
  if [ -f scripts/fetch-weights.sh ]; then
    bash scripts/fetch-weights.sh || fail "权重下载失败，请手动执行 scripts/fetch-weights.sh"
  else
    fail "缺少 scripts/fetch-weights.sh，无法下载权重"
  fi
else
  ok "权重已就绪"
fi

# ---------------------------------------------------------------- 启动
step "启动 Docker Compose（首次会构建镜像，约 2~4 分钟）"
if [ "${1:-}" = "--skip-build" ]; then
  docker compose up -d
else
  docker compose up -d --build
fi

web_port="$(grep -E '^WEB_PORT=' .env | cut -d= -f2 | tr -d '\r')"
url="http://127.0.0.1:${web_port:-8088}"

step "等待服务就绪（$url）"
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "$url" 2>/dev/null; then ready=1; break; fi
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  docker compose logs --tail=40 || true
  fail "服务在 6 分钟内未就绪，请把上面的日志发给维护者。"
fi

admin_user="$(grep -E '^HDR_BOOTSTRAP_ADMIN_USERNAME=' .env | cut -d= -f2)"
admin_pass="$(grep -E '^HDR_BOOTSTRAP_ADMIN_PASSWORD=' .env | cut -d= -f2)"

printf '\n\033[32m启动完成：%s\033[0m\n' "$url"
printf '管理员账号：%s\n管理员密码：%s\n' "$admin_user" "$admin_pass"
printf '停止：./stop.sh（数据保留）  清空重来：./reset.sh\n'

if command -v open >/dev/null 2>&1; then open "$url"; fi
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi
