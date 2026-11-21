#!/usr/bin/env bash
# 下载并安装基线模型权重（Linux / macOS）。
# 权重不进 git，通过 GitHub Release 分发；默认只装生效基线一个模型。
#
# 用法：
#   bash scripts/fetch-weights.sh
#   bash scripts/fetch-weights.sh --zip dist/hdr-weights-baseline-v1.zip
#   HDR_WEIGHTS_URL=... bash scripts/fetch-weights.sh
set -euo pipefail

URL="${HDR_WEIGHTS_URL:-https://github.com/SogoL-55152/Handwritten-Digit-Recognition/releases/download/weights-v1/hdr-weights-baseline-v1.zip}"
ZIP=""
TARGET=""
FORCE_REGISTRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --zip) ZIP="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --force-registry) FORCE_REGISTRY=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-$ROOT/model-service/weights}"
TMP=""
cleanup() { if [[ -n "$TMP" && -f "$TMP" ]]; then rm -f "$TMP"; fi; }
trap cleanup EXIT

if [[ -z "$ZIP" ]]; then
  TMP="$(mktemp /tmp/hdr-weights-XXXXXX.zip)"
  echo "下载权重：$URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TMP" "$URL"
  else
    wget -q -O "$TMP" "$URL"
  fi
  ZIP="$TMP"
fi

[[ -f "$ZIP" ]] || { echo "找不到权重包：$ZIP" >&2; exit 1; }
mkdir -p "$TARGET"

# 选一个真正能跑的 python：Windows 上 python3 常是应用商店占位符
PYTHON_BIN="${HDR_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3 python python.exe; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import sys" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON_BIN" ]]; then
  echo "找不到可用的 python，请用 HDR_PYTHON 指定解释器（如 HDR_PYTHON=/usr/bin/python3）" >&2
  exit 1
fi

MANIFEST="$(unzip -p "$ZIP" MANIFEST.json)"
[[ -n "$MANIFEST" ]] || { echo "权重包缺少 MANIFEST.json" >&2; exit 1; }

"$PYTHON_BIN" - "$ZIP" "$TARGET" "$FORCE_REGISTRY" <<'PY'
import hashlib
import json
import pathlib
import sys
import zipfile

archive_path, target = sys.argv[1], pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive_path) as archive:
    manifest = json.loads(archive.read('MANIFEST.json').decode('utf-8'))
    for item in manifest['files']:
        destination = target / item['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(archive.read(item['path']))
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if digest != item['sha256']:
            raise SystemExit(f"校验失败：{item['path']}")
        print(f"已安装 {item['path']}（{item['sizeBytes']/1024/1024:.2f} MB，sha256 校验通过）")

    registry = target / 'registry.json'
    if registry.exists() and sys.argv[3] != '1':
        print('已存在 registry.json，跳过（需要覆盖：--force-registry）')
    else:
        registry.write_bytes(archive.read('registry.json'))
        print(f"已写入 registry.json（只含生效基线 {manifest['activeModel']['version']}）")

print(f"完成：生效模型 {manifest['activeModel']['modelId']} / {manifest['activeModel']['version']}")
PY
