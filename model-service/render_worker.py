"""独立渲染进程：读取图像数组与下标，渲染后写出 npz。

由 train_canvas_aug._render_with_processes 以子进程方式启动，绕开 Python GIL。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from train_canvas_aug import (apply_augments, _to_pil, canvas_style, photo_style,
                              canvas_input, InvalidImage)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", required=True)
    parser.add_argument("--indices", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--photo-ratio", type=float, default=0.5)
    parser.add_argument("--aug", default="{}")
    args = parser.parse_args()

    images = np.load(args.images, mmap_mode="r")
    indices = json.loads(Path(args.indices).read_text(encoding="utf-8"))
    aug = json.loads(args.aug) if args.aug else None
    if aug is not None and not any(float(value or 0) > 0 for value in aug.values()):
        aug = None

    rng = np.random.default_rng(args.seed)
    rows = np.zeros((len(indices), 1, 28, 28), dtype=np.float32)
    skipped = 0
    for offset, index in enumerate(indices):
        render = photo_style if rng.random() < args.photo_ratio else canvas_style
        try:
            rendered = _to_pil(render(np.asarray(images[index]), rng))
            rows[offset, 0] = canvas_input(np.asarray(apply_augments(rendered, rng, aug)))
        except InvalidImage:
            skipped += 1
    np.savez_compressed(args.out, inputs=rows, skipped=np.array([skipped], dtype=np.int64))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
