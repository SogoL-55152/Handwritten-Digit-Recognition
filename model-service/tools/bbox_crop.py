"""把带框标注（digitStruct.mat）的数据集裁成「单字 + 按标签分目录」，供导入器直接使用。

用法：
    python tools/bbox_crop.py --images D:\\data\\train --out D:\\tmp\\crops
    python tools/bbox_crop.py --images D:\\data\\train --labels D:\\data\\train\\digitStruct.mat --dry-run

输出目录结构：<out>/<0-9>/<原文件名>_<序号>.png，导入器按「按类别文件夹」识别。
多段（一张图里还有多个数字没切开）和过小的框会被跳过并计入统计。
"""

import argparse
import io
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.svhn_import import digit_crop, iter_images  # noqa: E402
from tools.svhn_eval import read_labels  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--images', type=Path, required=True, help='图片目录（PNG）')
    parser.add_argument('--labels', type=Path, default=None, help='digitStruct.mat（默认取图片目录下的）')
    parser.add_argument('--out', type=Path, default=None, help='裁剪输出目录')
    parser.add_argument('--padding', type=float, default=0.08)
    parser.add_argument('--dry-run', action='store_true', help='只统计不写文件')
    args = parser.parse_args()

    labels_path = args.labels or (args.images / 'digitStruct.mat')
    if not labels_path.exists():
        print(json.dumps({'error': f'找不到标注文件：{labels_path}'}, ensure_ascii=False))
        return 2
    if not args.dry_run and args.out is None:
        print(json.dumps({'error': '--out 必填（非 dry-run 时）'}, ensure_ascii=False))
        return 2

    labels = read_labels(labels_path)
    stats = Counter()
    per_label = Counter()
    if args.out is not None and not args.dry_run:
        for digit in range(10):
            (args.out / str(digit)).mkdir(parents=True, exist_ok=True)

    for name, array in iter_images(None, args.images):
        item = labels.get(name)
        if not item:
            stats['noLabels'] += 1
            continue
        digits = [int(ch) for ch in item['text']]
        for index, (box, digit) in enumerate(zip(item['boxes'], digits)):
            png, reason = digit_crop(array, box, args.padding)
            if png is None:
                stats[reason or 'skipped'] += 1
                continue
            label = digit % 10
            per_label[str(label)] += 1
            if not args.dry_run:
                (args.out / str(label) / f'{Path(name).stem}_{index}.png').write_bytes(png)
    summary = {
        'format': 'bbox',
        'digits': sum(per_label.values()),
        'perLabel': dict(sorted(per_label.items(), key=lambda row: int(row[0]))),
        'skippedMulti': stats.get('multiSegment', 0),
        'skippedSmall': stats.get('tooSmall', 0),
        'skippedOther': stats.get('empty', 0) + stats.get('noLabels', 0),
        'dryRun': bool(args.dry_run),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
