"""SVHN → 数据集导入：按 digitStruct 的框裁单字，过"单段校验"后批量导入。

为什么需要它：train.tar.gz 里每张图是 1–6 位数的门牌照片，直接导进"单字数据集"是错的。
这里按框裁出每个数字，并保证裁图里只有一段前景（防邻居污染），再按标签分批调导入接口。

用法（在 model-service/ 下执行）：

    # 只看能裁出多少、跳过多少，不写库
    python -I tools/svhn_import.py --archive D:/noname/train.tar.gz \
        --labels D:/Temp/hdr-svhn/train/digitStruct.mat --per-label 50 --dry-run

    # 真导入：自动建数据集
    python -I tools/svhn_import.py --archive D:/noname/train.tar.gz \
        --labels D:/Temp/hdr-svhn/train/digitStruct.mat --per-label 500 \
        --dataset-name "SVHN-单字-5000"

    # 也可以读已解压的目录
    python -I tools/svhn_import.py --images D:/Temp/hdr-svhn/train \
        --labels D:/Temp/hdr-svhn/train/digitStruct.mat --per-label 500 --dataset-id 6
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
import time
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.multidigit import segments_of  # noqa: E402
from tools.svhn_eval import read_labels  # noqa: E402


def crop_box(array: np.ndarray, box, padding: float):
    left, top, right, bottom = box
    pad_x = max(0, int(round((right - left) * padding)))
    pad_y = max(0, int(round((bottom - top) * padding)))
    crop = array[max(0, top - pad_y):min(array.shape[0], bottom + pad_y),
                 max(0, left - pad_x):min(array.shape[1], right + pad_x)]
    return crop if crop.size else None


def segment_count(crop: np.ndarray) -> int:
    try:
        segments, _, _ = segments_of(crop)
        return len(segments)
    except ValueError:
        return 0


def digit_crop(array: np.ndarray, box, padding: float = 0.08):
    """返回 (png_bytes, reason)。reason 为 None 表示通过单段校验。"""
    for attempt in (padding, 0.0):
        crop = crop_box(array, box, attempt)
        if crop is None:
            return None, 'empty'
        if crop.shape[0] < 8 or crop.shape[1] < 8:
            return None, 'tooSmall'
        if segment_count(crop) == 1:
            buffer = io.BytesIO()
            Image.fromarray(crop).save(buffer, format='PNG')
            return buffer.getvalue(), None
    return None, 'multiSegment'


def png_of_crop(array: np.ndarray, box, padding: float = 0.08):
    return digit_crop(array, box, padding)


def iter_images(archive: Path | None, images: Path | None):
    """按文件名产出 (name, ndarray)。archive 用 tar 流式读，不解压到磁盘。"""
    if images is not None:
        for path in sorted(images.glob('*.png')):
            yield path.name, np.asarray(Image.open(path).convert('L'))
        return
    with tarfile.open(archive) as tar:
        members = {member.name.rsplit('/', 1)[-1]: member for member in tar.getmembers()
                   if member.isfile() and member.name.endswith('.png')}
        for name in sorted(members):
            handle = tar.extractfile(members[name])
            if handle is None:
                continue
            yield name, np.asarray(Image.open(io.BytesIO(handle.read())).convert('L'))


def collect_digits(labels: dict[str, dict], archive: Path | None, images: Path | None,
                   per_label: int, padding: float):
    """收集到每类 per_label 个为止；返回 ({label: [(name, png)]}, 统计)。"""
    buckets: dict[int, list[tuple[str, bytes]]] = {digit: [] for digit in range(10)}
    stats = Counter()
    wanted = min(per_label, max(len(item['boxes']) for item in labels.values()))
    started = time.perf_counter()
    for index, (name, array) in enumerate(iter_images(archive, images), start=1):
        item = labels.get(name)
        if item is None:
            continue
        for box, digit in zip(item['boxes'], [int(ch) for ch in item['text']]):
            if len(buckets[digit]) >= per_label:
                continue
            png, reason = digit_crop(array, box, padding)
            stats['seen'] += 1
            if png is None:
                stats[reason] += 1
                continue
            buckets[digit].append((f'{digit}-{len(buckets[digit]):06d}', png))
            stats['kept'] += 1
        if index % 2000 == 0:
            print(f'  扫描 {index} 张图，已收集 {stats["kept"]} 个单字', flush=True)
        if all(len(buckets[digit]) >= per_label for digit in range(10)):
            break
    stats['seconds'] = round(time.perf_counter() - started, 1)
    return buckets, stats


def login(api: str, username: str, password: str):
    import requests
    response = requests.post(f'{api}/api/v2/auth/login', json={'username': username, 'password': password}, timeout=30)
    response.raise_for_status()
    data = response.json()['data']
    return data['token'], data['defaultWorkspaceId']


def ensure_dataset(api: str, token: str, workspace: int, dataset_id: int | None, name: str | None):
    import requests
    headers = {'Authorization': f'Bearer {token}'}
    if dataset_id:
        return dataset_id
    created = requests.post(f'{api}/api/v2/workspaces/{workspace}/datasets', headers=headers,
                            json={'name': name or 'SVHN-单字', 'description': '按 digitStruct 框裁的 SVHN 单字'}, timeout=30)
    created.raise_for_status()
    return int(created.json()['data']['id'])


def upload(api: str, token: str, workspace: int, dataset_id: int, label: int, items, batch: int):
    import requests
    headers = {'Authorization': f'Bearer {token}'}
    imported = duplicates = failed = 0
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        files = [('files', (f'{name}.png', png, 'image/png')) for name, png in chunk]
        response = requests.post(f'{api}/api/v2/workspaces/{workspace}/datasets/{dataset_id}/import',
                                 headers=headers, data={'label': str(label)}, files=files, timeout=180)
        if response.status_code != 200:
            failed += len(chunk)
            print(f'  标签 {label} 导入失败：{response.status_code} {response.text[:120]}', flush=True)
            continue
        data = response.json()['data']
        imported += data['imported']
        duplicates += data['duplicates']
        failed += data['failed']
    return imported, duplicates, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--archive', type=Path, help='train.tar.gz')
    source.add_argument('--images', type=Path, help='已解压的图片目录')
    parser.add_argument('--labels', type=Path, required=True, help='digitStruct.mat')
    parser.add_argument('--per-label', type=int, default=200)
    parser.add_argument('--batch', type=int, default=20, help='每批上传张数（默认 20，避开 6MB 请求上限）')
    parser.add_argument('--padding', type=float, default=0.08)
    parser.add_argument('--api', default='http://127.0.0.1:8080')
    parser.add_argument('--username', default='admin')
    parser.add_argument('--password', default='HdrAdmin2026!')
    parser.add_argument('--dataset-id', type=int, default=None)
    parser.add_argument('--dataset-name', default=None)
    parser.add_argument('--dry-run', action='store_true', help='只裁剪与校验，不写库')
    parser.add_argument('--limit-images', type=int, default=None)
    args = parser.parse_args()

    labels = read_labels(args.labels)
    if args.limit_images:
        labels = dict(list(labels.items())[: args.limit_images])
    print(f'标签文件 {len(labels)} 张图，目标每类 {args.per_label} 个', flush=True)

    buckets, stats = collect_digits(labels, args.archive, args.images, args.per_label, args.padding)
    total = sum(len(items) for items in buckets.values())
    print(f'裁出 {total} 个单字（扫描 {stats["seen"]} 个框）：'
          f'多段跳过 {stats["multiSegment"]}、空白 {stats["blank"]}、过小 {stats["tooSmall"]}，'
          f'耗时 {stats["seconds"]}s', flush=True)
    for digit in range(10):
        print(f'  标签 {digit}: {len(buckets[digit])} 个', flush=True)

    if args.dry_run:
        print(json.dumps({'dryRun': True, 'total': total, 'stats': dict(stats)}, ensure_ascii=False))
        return 0

    token, workspace = login(args.api, args.username, args.password)
    dataset_id = ensure_dataset(args.api, token, workspace, args.dataset_id, args.dataset_name)
    print(f'目标数据集 {dataset_id}（工作空间 {workspace}）', flush=True)

    imported = duplicates = failed = 0
    started = time.perf_counter()
    for digit in range(10):
        part = upload(args.api, token, workspace, dataset_id, digit, buckets[digit], args.batch)
        imported += part[0]
        duplicates += part[1]
        failed += part[2]
        print(f'  标签 {digit}: 成功 {part[0]} · 重复 {part[1]} · 失败 {part[2]}', flush=True)

    summary = {'dataset': dataset_id, 'workspace': workspace, 'total': total,
               'imported': imported, 'duplicates': duplicates, 'failed': failed,
               'skipped': {key: stats[key] for key in ('multiSegment', 'blank', 'tooSmall')},
               'seconds': round(time.perf_counter() - started, 1)}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
