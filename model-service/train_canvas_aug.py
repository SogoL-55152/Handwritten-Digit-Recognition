r"""画板域候选基线训练脚本（W2.1 可信基线）。

背景：W1 基线只在 MNIST 原图上训练，真实画板笔迹上 top-1 明显下降，
且线上"裁剪墨迹外接框→缩放 20px"的几何归一化与训练分布不一致
（见 docs/画板识别失败诊断-20261107.md）。

本脚本用与线上一致的几何归一化生成训练输入，并叠加画板风格增广：
随机画布尺寸、笔画加粗、随机倾斜、随机缩放。默认从既有权重初始化微调。

用法（在 model-service/ 下，需 torch 训练环境）::

    python -I train_canvas_aug.py --init weights/w1-full/checkpoint.pt \
        --output-dir weights/w2-canvas-aug --epochs 3 --samples 48000 --seed 20261107

不联网、不下载数据、不覆盖已有输出目录。仅使用 --data-dir 下的官方 IDX 文件。
"""
from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

# -I 不加入脚本目录；只补入受信任的项目源码目录，不加入调用者 cwd/数据目录。
SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

BASELINE_MEAN = 0.1307
BASELINE_STD = 0.3081
CANVAS_SIZES = (280, 320, 360)


@dataclass(frozen=True)
class CanvasAugConfig:
    epochs: int = 3
    samples: int = 48000
    batch: int = 64
    learning_rate: float = 0.001
    seed: int = 20261107

    def __post_init__(self):
        if not 1 <= self.epochs <= 20:
            raise ValueError("epochs must be within 1..20")
        if not 1000 <= self.samples <= 60000:
            raise ValueError("samples must be within 1000..60000")
        if self.batch not in (32, 64, 128):
            raise ValueError("batch must be 32, 64 or 128")
        if not 0 < self.learning_rate <= 0.1:
            raise ValueError("learning_rate must be within (0, 0.1]")
        if not isinstance(self.seed, int) or not 0 <= self.seed <= 2**32 - 1:
            raise ValueError("seed must be a non-negative 32-bit integer")


def production_geometry(ink_image: Image.Image) -> np.ndarray | None:
    """与 services.inference_preprocess 完全一致的几何步骤：crop → 20px → 居中 28。"""
    ink = np.asarray(ink_image)
    ink = np.where(ink >= 32, ink, 0).astype(np.uint8)
    bounds = Image.fromarray(ink).getbbox()
    if bounds is None:
        return None
    foreground = Image.fromarray(ink).crop(bounds)
    width, height = foreground.size
    scale = 20 / max(width, height)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    foreground = foreground.resize(target, Image.Resampling.LANCZOS)
    canvas = Image.new("L", (28, 28), 0)
    canvas.paste(foreground, ((28 - target[0]) // 2, (28 - target[1]) // 2))
    values = np.asarray(canvas, dtype=np.float32) / np.float32(255)
    return (values - BASELINE_MEAN) / BASELINE_STD


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    out = mask
    for _ in range(radius):
        shifted = out.copy()
        shifted[1:, :] |= out[:-1, :]
        shifted[:-1, :] |= out[1:, :]
        shifted[:, 1:] |= out[:, :-1]
        shifted[:, :-1] |= out[:, 1:]
        out = shifted
    return out


def canvas_style(image28: np.ndarray, rng) -> Image.Image:
    """把 MNIST 数字渲染成"画板手写"的样子：更大画布、更粗笔画、随机倾斜/缩放。"""
    canvas_size = int(rng.choice(CANVAS_SIZES))
    side = int(canvas_size * rng.uniform(0.55, 0.95))
    digit = Image.fromarray(image28, mode="L").resize((side, side), Image.Resampling.LANCZOS)
    canvas = Image.new("L", (canvas_size, canvas_size), 0)
    offset = (canvas_size - side) // 2 + int(rng.integers(-6, 7))
    canvas.paste(digit, (offset, offset))
    pixels = _dilate(np.asarray(canvas) > 32, int(rng.integers(0, 4)))
    canvas = Image.fromarray((pixels * 255).astype(np.uint8))
    angle = float(rng.uniform(-12, 12))
    if abs(angle) > 0.5:
        canvas = canvas.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=0)
    return canvas


def build_inputs(images: np.ndarray, rng, augment: bool) -> np.ndarray:
    rows = np.zeros((len(images), 1, 28, 28), dtype=np.float32)
    for index, image in enumerate(images):
        prepared = production_geometry(canvas_style(image, rng) if augment else Image.fromarray(image, mode="L"))
        if prepared is not None:
            rows[index, 0] = prepared
    return rows


def raw_inputs(images: np.ndarray) -> np.ndarray:
    values = images.astype(np.float32) / 255
    return ((values - BASELINE_MEAN) / BASELINE_STD)[:, None, :, :]


def read_idx(path: Path, limit: int | None = None) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    if int.from_bytes(data[0:4], "big") != 2051:
        raise ValueError("expected an IDX image file")
    count = int.from_bytes(data[4:8], "big")
    return data[16:16 + count * 784].reshape(count, 28, 28)[:limit]


def read_labels(path: Path, limit: int | None = None) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    if int.from_bytes(data[0:4], "big") != 2049:
        raise ValueError("expected an IDX label file")
    return data[8:][:limit]


def accuracy(model, torch, inputs: np.ndarray, labels: np.ndarray) -> float:
    model.eval()
    correct = 0
    with torch.inference_mode():
        for start in range(0, len(inputs), 512):
            batch = torch.from_numpy(inputs[start:start + 512])
            correct += int((model(batch).argmax(dim=1).numpy() == labels[start:start + 512]).sum())
    return round(correct / len(labels), 4)


def run(config: CanvasAugConfig, data_dir: Path, output_dir: Path, init: Path | None,
        threads: int | None = None) -> dict:
    import torch
    from models.cnn import ARCHITECTURE, DigitCNN
    from services.mnist_training import load_checkpoint

    if output_dir.exists():
        raise ValueError("--output-dir must be a NEW directory; existing outputs are refused")
    if not (data_dir / "train-images-idx3-ubyte").is_file():
        raise ValueError("--data-dir must contain official MNIST IDX files")
    if threads:
        torch.set_num_threads(threads)
    rng = np.random.default_rng(config.seed)
    torch.manual_seed(config.seed)

    train_images = read_idx(data_dir / "train-images-idx3-ubyte", config.samples)
    train_labels = read_labels(data_dir / "train-labels-idx1-ubyte", config.samples)
    test_images = read_idx(data_dir / "t10k-images-idx3-ubyte", 1000)
    test_labels = read_labels(data_dir / "t10k-labels-idx1-ubyte", 1000)

    train_inputs = build_inputs(train_images, rng, augment=True)
    canvas_test = build_inputs(test_images, np.random.default_rng(config.seed + 1), augment=True)
    raw_test = raw_inputs(test_images)

    model = DigitCNN()
    if init is not None:
        if not init.is_file():
            raise ValueError("--init must be an existing checkpoint file")
        start_model, _ = load_checkpoint(init.open("rb"), device="cpu")
        model.load_state_dict(start_model.state_dict())
    baseline_raw = accuracy(model, torch, raw_test, test_labels)
    baseline_canvas = accuracy(model, torch, canvas_test, test_labels)

    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    loss_fn = torch.nn.CrossEntropyLoss()
    labels = torch.from_numpy(train_labels.astype(np.int64))
    history = []
    for epoch in range(config.epochs):
        model.train()
        order = torch.randperm(len(train_inputs))
        total, seen = 0.0, 0
        for start in range(0, len(order), config.batch):
            index = order[start:start + config.batch]
            optimizer.zero_grad()
            loss = loss_fn(model(torch.from_numpy(train_inputs[index.numpy()])), labels[index])
            loss.backward()
            optimizer.step()
            total += float(loss) * len(index)
            seen += len(index)
        history.append({"epoch": epoch + 1, "loss": round(total / seen, 5),
                        "raw_mnist": accuracy(model, torch, raw_test, test_labels),
                        "canvas_simulated": accuracy(model, torch, canvas_test, test_labels)})
        print(json.dumps(history[-1]), flush=True)

    output_dir.mkdir(parents=True)
    torch.save({
        "format_version": 1,
        "architecture": ARCHITECTURE,
        "config": {"source": "train_canvas_aug", "epochs": config.epochs, "samples": config.samples,
                   "batch": config.batch, "learning_rate": config.learning_rate, "seed": config.seed,
                   "init": str(init) if init else None},
        "epoch": config.epochs,
        "checkpoint_selection": "final_epoch",
        "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
    }, output_dir / "checkpoint.pt")
    metrics = {
        "recipe": "pipeline-consistent geometry + canvas augmentation",
        "config": {"epochs": config.epochs, "samples": config.samples, "batch": config.batch,
                   "learning_rate": config.learning_rate, "seed": config.seed,
                   "initialized_from": str(init) if init else None},
        "before": {"raw_mnist_1000": baseline_raw, "canvas_simulated_1000": baseline_canvas},
        "after": {"raw_mnist_1000": accuracy(model, torch, raw_test, test_labels),
                  "canvas_simulated_1000": accuracy(model, torch, canvas_test, test_labels)},
        "history": history,
        "limitations": [
            "canvas_simulated comes from the same augmentation family as training; it is optimistic.",
            "MNIST test is in-distribution only and says nothing about real board accuracy.",
            "No real user samples were used for training or evaluation.",
        ],
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
                                             encoding="utf-8")
    return metrics


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", type=Path, required=True, help="Directory with official MNIST IDX files")
    parser.add_argument("--output-dir", type=Path, required=True, help="NEW output directory under weights/")
    parser.add_argument("--init", type=Path, help="Existing checkpoint to fine-tune from")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--samples", type=int, default=48000)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=20261107)
    parser.add_argument("--threads", type=int)
    args = parser.parse_args(argv)
    config = CanvasAugConfig(epochs=args.epochs, samples=args.samples, batch=args.batch,
                             learning_rate=args.learning_rate, seed=args.seed)
    metrics = run(config, args.data_dir, args.output_dir, args.init, args.threads)
    print(json.dumps({"output": str(args.output_dir), "metrics": metrics["after"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
