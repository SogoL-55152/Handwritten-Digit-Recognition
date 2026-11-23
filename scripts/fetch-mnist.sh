#!/usr/bin/env bash
# 下载官方 MNIST IDX 文件到 model-service/data/MNIST/raw（一次性准备，不入库）。
# 用法：bash scripts/fetch-mnist.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
TARGET="$ROOT/model-service/data/MNIST/raw"
BASE="${HDR_MNIST_BASE:-https://ossci-datasets.s3.amazonaws.com/mnist}"
mkdir -p "$TARGET"

for name in train-images-idx3-ubyte train-labels-idx1-ubyte t10k-images-idx3-ubyte t10k-labels-idx1-ubyte; do
  dest="$TARGET/$name"
  if [[ -f "$dest" ]]; then
    echo "已存在：$name"
    continue
  fi
  echo "下载 $name ..."
  curl -fL --retry 3 -o "$dest.gz" "$BASE/$name.gz"
  gzip -d "$dest.gz"
done

echo "完成：$TARGET"
