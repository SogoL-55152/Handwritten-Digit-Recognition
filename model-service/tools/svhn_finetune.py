"""用 SVHN 训练集微调单字模型，并给出前后对比。

做法：
1. 按 digitStruct.mat 的框把每个数字单独裁出来（这是最干净的口径，不受检测误差影响）；
2. 用与线上完全相同的 canvas_input 归一化；
3. 混入一部分 MNIST 手写画板样本，避免只学印刷体把画板能力带偏；
4. 在 SVHN 测试集的数字裁图上评估前后逐位准确率，并在 MNIST 上确认没有退化；
5. 产物写到 weights/w4-svhn-ft/checkpoint.pt，并打印 registry 需要的信息。

用法（在 model-service/ 下）：

    python -I tools/svhn_finetune.py --epochs 1 --digits 40000
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from models.cnn import ARCHITECTURE, DigitCNN  # noqa: E402
from services.inference_preprocess import InvalidImage, canvas_input  # noqa: E402
from services.multidigit import segments_of  # noqa: E402
from tools.svhn_eval import read_labels  # noqa: E402
from train_canvas_aug import read_idx, read_labels as read_idx_labels  # noqa: E402


def registry_entry(version: str):
    registry = json.loads((ROOT / "weights" / "registry.json").read_text(encoding="utf-8"))
    return next((item for item in registry["models"] if item["version"] == version), None)


def load_model(checkpoint_path: Path):
    import torch

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if checkpoint.get("format_version") != 1 or checkpoint.get("architecture") != ARCHITECTURE:
        raise SystemExit("基础 checkpoint 与当前架构不匹配")
    model = DigitCNN()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    return model


def _crop(array, box, padding: float):
    left, top, right, bottom = box
    pad_x = max(0, int(round((right - left) * padding)))
    pad_y = max(0, int(round((bottom - top) * padding)))
    crop = array[max(0, top - pad_y):min(array.shape[0], bottom + pad_y),
                 max(0, left - pad_x):min(array.shape[1], right + pad_x)]
    return crop if crop.size else None


def _segments(crop) -> int:
    """裁图里前景有几段；切分失败（全黑/全白）返回 0。"""
    try:
        segments, _, _ = segments_of(crop)
        return len(segments)
    except ValueError:
        return 0


def crop_digits(labels: dict[str, dict], images: Path, limit: int, padding: float = 0.08):
    """按框裁单字；裁完必须只剩一段前景，否则缩边距重裁，再不行就跳过。

    返回 (samples, stats)：samples 是 [(normalized 28×28, label)]，stats 记录跳过原因。
    """
    samples = []
    stats = {"seen": 0, "kept": 0, "multiSegment": 0, "blank": 0}
    for name, item in labels.items():
        path = images / name
        if not path.is_file():
            continue
        try:
            array = np.asarray(Image.open(path).convert("L"))
        except OSError:
            continue
        for box, digit in zip(item["boxes"], [int(ch) for ch in item["text"]]):
            stats["seen"] += 1
            crop = _crop(array, box, padding)
            if crop is None:
                stats["blank"] += 1
                continue
            # 关键校验：加了边距后如果出现第二段，说明把邻居裁进来了
            if _segments(crop) != 1:
                crop = _crop(array, box, 0.0)
                if crop is None or _segments(crop) != 1:
                    stats["multiSegment"] += 1
                    continue
            try:
                normalized = canvas_input(crop)
            except InvalidImage:
                stats["blank"] += 1
                continue
            samples.append((normalized[0], digit))
            stats["kept"] += 1
            if len(samples) >= limit:
                return samples, stats
    return samples, stats


def mnist_samples(data_dir: Path, count: int, seed: int):
    """取一部分 MNIST 作混训，形状与线上画板输入一致（加轻微增广）。"""
    train_images = read_idx(data_dir / "train-images-idx3-ubyte", count)
    train_labels = read_idx_labels(data_dir / "train-labels-idx1-ubyte", count)
    from train_canvas_aug import build_inputs
    inputs, _ = build_inputs(train_images, np.random.default_rng(seed), 0.5)
    return [(inputs[index][0], int(train_labels[index])) for index in range(len(inputs))]


def to_tensors(samples):
    import torch

    stacked = torch.stack([torch.from_numpy(np.ascontiguousarray(item[0], dtype=np.float32)) for item in samples])
    images = stacked.unsqueeze(1) if stacked.dim() == 3 else stacked
    labels = torch.tensor([item[1] for item in samples], dtype=torch.long)
    return images, labels


def evaluate_digits(model, samples, batch=512):
    import torch

    correct = 0
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(samples), batch):
            chunk = samples[start:start + batch]
            images, labels = to_tensors(chunk)
            predicted = model(images).argmax(dim=1)
            correct += int((predicted == labels).sum())
    return correct / len(samples) if samples else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--train-images", type=Path, default=Path("D:/Temp/hdr-svhn/train"))
    parser.add_argument("--train-labels", type=Path, default=Path("D:/Temp/hdr-svhn/train/digitStruct.mat"))
    parser.add_argument("--test-images", type=Path, default=Path("D:/Temp/hdr-scene/test"))
    parser.add_argument("--test-labels", type=Path, default=Path("D:/Temp/hdr-svhn/test/digitStruct.mat"))
    parser.add_argument("--base-version", default="w4-task-8-a1")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--digits", type=int, default=40000)
    parser.add_argument("--mnist", type=int, default=10000)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20261118)
    parser.add_argument("--eval-digits", type=int, default=4000)
    args = parser.parse_args()

    import torch

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    entry = registry_entry(args.base_version)
    if entry is None:
        raise SystemExit(f"基础版本 {args.base_version} 不在注册表里")
    checkpoint = ROOT / "weights" / entry["artifact"]
    print(f"基础模型 {args.base_version} → {checkpoint}", flush=True)

    train_labels = read_labels(args.train_labels)
    print(f"训练图 {len(train_labels)} 张，目标单字 {args.digits} 个", flush=True)
    started = time.perf_counter()
    train_digits, train_stats = crop_digits(train_labels, args.train_images, args.digits)
    print(f"裁出单字 {len(train_digits)} 个（{time.perf_counter() - started:.1f}s），"
          f"跳过多段 {train_stats['multiSegment']} 个、空白 {train_stats['blank']} 个", flush=True)

    test_labels = read_labels(args.test_labels)
    test_digits, test_stats = crop_digits(test_labels, args.test_images, args.eval_digits, padding=0.02)
    print(f"测试单字 {len(test_digits)} 个（多段跳过 {test_stats['multiSegment']}）", flush=True)

    model = load_model(checkpoint)
    before_svhn = evaluate_digits(model, test_digits)
    data_dir = Path(__import__("os").getenv("TRAINING_DATA_DIR", ROOT / "data" / "MNIST" / "raw"))
    mnist = mnist_samples(data_dir, args.mnist, args.seed)
    mnist_eval = mnist_samples(data_dir, 2000, args.seed + 1)
    before_mnist = evaluate_digits(model, mnist_eval)
    print(f"微调前：SVHN 单字 {before_svhn:.4f} ｜ MNIST {before_mnist:.4f}", flush=True)

    samples = train_digits + mnist
    random.shuffle(samples)
    images, labels = to_tensors(samples)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    loss_fn = torch.nn.CrossEntropyLoss()
    model.train()
    for epoch in range(args.epochs):
        order = torch.randperm(len(labels))
        total, seen = 0.0, 0
        epoch_started = time.perf_counter()
        for start in range(0, len(order), args.batch):
            index = order[start:start + args.batch]
            optimizer.zero_grad()
            loss = loss_fn(model(images[index]), labels[index])
            loss.backward()
            optimizer.step()
            total += float(loss) * len(index)
            seen += len(index)
        print(f"epoch {epoch + 1}: loss {total / seen:.4f}（{time.perf_counter() - epoch_started:.1f}s）", flush=True)

    after_svhn = evaluate_digits(model, test_digits)
    after_mnist = evaluate_digits(model, mnist_eval)
    print(f"微调后：SVHN 单字 {after_svhn:.4f} ｜ MNIST {after_mnist:.4f}", flush=True)

    output = ROOT / "weights" / "w4-svhn-ft"
    output.mkdir(parents=True, exist_ok=True)
    target = output / "checkpoint.pt"
    torch.save({"format_version": 1, "architecture": ARCHITECTURE, "checkpoint_selection": "final_epoch",
                "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()}},
               target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    size = target.stat().st_size
    print(json.dumps({"artifact": "w4-svhn-ft/checkpoint.pt", "sha256": digest, "sizeBytes": size,
                      "before": {"svhn": round(before_svhn, 4), "mnist": round(before_mnist, 4)},
                      "after": {"svhn": round(after_svhn, 4), "mnist": round(after_mnist, 4)}},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
