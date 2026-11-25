# -*- coding: utf-8 -*-
"""下载并解压 MNIST 原始 IDX 到 model-service/data/MNIST/raw/。

训练链路（train_canvas_aug.py）要求该目录下是**解压后**的四个文件：
    train-images-idx3-ubyte  train-labels-idx1-ubyte
    t10k-images-idx3-ubyte   t10k-labels-idx1-ubyte
仓库不包含 MNIST（体积与许可），所以新环境必须先执行本脚本（或自行准备同名文件）。

用法：
    python scripts/fetch-mnist.py                  # 默认写入 model-service/data/MNIST/raw
    python scripts/fetch-mnist.py --data-dir D:\\mnist-raw
"""
import argparse
import gzip
import hashlib
import sys
import urllib.request
from pathlib import Path

SOURCES = [
    "https://ossci-datasets.s3.amazonaws.com/mnist/",
    "https://storage.googleapis.com/cvdf-datasets/mnist/",
]
FILES = [
    ("train-images-idx3-ubyte.gz", "train-images-idx3-ubyte", 47_040_016),
    ("train-labels-idx1-ubyte.gz", "train-labels-idx1-ubyte", 60_008),
    ("t10k-images-idx3-ubyte.gz", "t10k-images-idx3-ubyte", 7_840_016),
    ("t10k-labels-idx1-ubyte.gz", "t10k-labels-idx1-ubyte", 10_008),
]


def download(url, target):
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = resp.read()
    target.write_bytes(data)
    return data


def main():
    ap = argparse.ArgumentParser()
    default = Path(__file__).resolve().parent.parent / "model-service" / "data" / "MNIST" / "raw"
    ap.add_argument("--data-dir", default=str(default))
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    args = ap.parse_args()

    out = Path(args.data_dir)
    out.mkdir(parents=True, exist_ok=True)
    ok = True
    for gz_name, raw_name, expect_size in FILES:
        raw_path = out / raw_name
        if raw_path.exists() and raw_path.stat().st_size == expect_size and not args.force:
            print(f"已存在 {raw_name}（{expect_size} B）")
            continue
        blob = None
        for base in SOURCES:
            try:
                print(f"下载 {base}{gz_name}")
                blob = download(base + gz_name, out / gz_name)
                break
            except Exception as exc:  # noqa: BLE001
                print(f"  失败：{exc}")
        if blob is None:
            ok = False
            continue
        data = gzip.decompress(blob)
        if len(data) != expect_size:
            print(f"  !! 解压后大小不符：{len(data)} != {expect_size}")
            ok = False
            continue
        raw_path.write_bytes(data)
        print(f"  写入 {raw_name}（{len(data)} B，sha256={hashlib.sha256(data).hexdigest()[:16]}…）")
        (out / gz_name).unlink(missing_ok=True)

    if not ok:
        print("有文件未就绪，训练会失败。", file=sys.stderr)
        return 1
    print(f"MNIST 就绪：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
