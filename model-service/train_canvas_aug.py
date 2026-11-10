r"""画板与照片域候选基线训练（可信基线配方）。

两条线同时覆盖：
- 画板：大画布、粗笔画、倾斜、缩放；
- 相册照片：纸面底色、光照渐变、模糊、噪声、JPEG 伪影、低对比。

关键约束：训练输入直接复用线上 `services.inference_preprocess.canvas_input`，
因此"训练看到的图"和"线上看到的图"逐像素同源，不会再出现归一化漂移。

用法（在 model-service/ 下，需 torch 训练环境；输出目录必须是新目录）::

    python -I train_canvas_aug.py --data-dir data/MNIST/raw \
        --emnist-zip D:/Temp/hdr-emnist/gzip.zip \
        --output-dir weights/w2-canvas-aug --epochs 3 --samples 60000 \
        --photo-ratio 0.5 --seed 20261107 --threads 2

不联网（EMNIST 由 --emnist-zip 显式指定的本地压缩包提供）、不覆盖已有输出。
"""
from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
import gzip
from io import BytesIO
import json
from pathlib import Path
import sys
import zipfile

import numpy as np
from PIL import Image, ImageFilter

# -I 不加入脚本目录；只补入受信任的项目源码目录，不加入调用者 cwd/数据目录。
SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from services.inference_manifest import BASELINE
from services.inference_preprocess import InvalidImage, canvas_input

CANVAS_SIZES = (280, 320, 360)
PHOTO_SIZES = (240, 280, 320)


@dataclass(frozen=True)
class CanvasAugConfig:
    epochs: int = 3
    samples: int = 60000
    batch: int = 64
    learning_rate: float = 0.001
    seed: int = 20261107
    photo_ratio: float = 0.5

    def __post_init__(self):
        if not 1 <= self.epochs <= 20:
            raise ValueError("epochs must be within 1..20")
        if not 1000 <= self.samples <= 200000:
            raise ValueError("samples must be within 1000..200000")
        if self.batch not in (32, 64, 128):
            raise ValueError("batch must be 32, 64 or 128")
        if not 0 < self.learning_rate <= 0.1:
            raise ValueError("learning_rate must be within (0, 0.1]")
        if not isinstance(self.seed, int) or not 0 <= self.seed <= 2**32 - 1:
            raise ValueError("seed must be a non-negative 32-bit integer")
        if not 0.0 <= self.photo_ratio <= 1.0:
            raise ValueError("photo_ratio must be within 0..1")


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


def _paper_and_gradient(size: int, rng) -> np.ndarray:
    """纸面底色 + 光照渐变，模拟手机拍摄的相册照片。"""
    level = float(rng.uniform(110, 240))
    grid = np.mgrid[0:size, 0:size].astype(np.float32) / max(size - 1, 1)
    tilt_x = float(rng.uniform(-0.30, 0.30)) * level
    tilt_y = float(rng.uniform(-0.30, 0.30)) * level
    return level + (grid[0] - 0.5) * tilt_y + (grid[1] - 0.5) * tilt_x


def canvas_style(image28: np.ndarray, rng) -> np.ndarray:
    """画板风格：大画布、粗笔画、随机倾斜与缩放，返回灰度数组（黑底白字）。"""
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
    return np.asarray(canvas)


def photo_style(image28: np.ndarray, rng) -> np.ndarray:
    """照片风格：纸面底色/光照渐变/墨迹低对比/模糊/噪声/JPEG 伪影。"""
    size = int(rng.choice(PHOTO_SIZES))
    side = int(size * rng.uniform(0.35, 0.80))
    digit = np.asarray(
        Image.fromarray(image28, mode="L").resize((side, side), Image.Resampling.LANCZOS), dtype=np.float32
    ) / 255.0
    paper = _paper_and_gradient(size, rng)
    canvas = paper.copy()
    top = (size - side) // 2 + int(rng.integers(-8, 9))
    left = (size - side) // 2 + int(rng.integers(-8, 9))
    top = max(0, min(size - side, top))
    left = max(0, min(size - side, left))
    window = canvas[top:top + side, left:left + side]
    ink_ratio = float(rng.uniform(0.15, 0.70))  # 笔迹相对纸面的亮度比
    window[:] = window * (1.0 - digit) + (window * ink_ratio) * digit
    angle = float(rng.uniform(-8, 8))
    if abs(angle) > 0.5:
        canvas = np.asarray(
            Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).rotate(
                angle, resample=Image.Resampling.BICUBIC, fillcolor=int(round(float(np.median(paper))))
            ), dtype=np.float32
        )
    if rng.random() < 0.75:
        radius = float(rng.uniform(0.4, 1.6))
        canvas = np.asarray(
            Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)),
            dtype=np.float32,
        )
    if rng.random() < 0.75:
        canvas = canvas + rng.normal(0.0, float(rng.uniform(0.5, 5.0)), canvas.shape)
    canvas = np.clip(canvas, 0, 255).astype(np.uint8)
    if rng.random() < 0.5:
        buffer = BytesIO()
        Image.fromarray(canvas).save(buffer, format="JPEG", quality=int(rng.integers(40, 86)))
        canvas = np.asarray(Image.open(BytesIO(buffer.getvalue())).convert("L"))
    return canvas


def build_inputs(images: np.ndarray, rng, photo_ratio: float) -> tuple[np.ndarray, int]:
    """渲染并走线上同一套 canvas_input；返回输入张量与无法对齐的样本数。"""
    rows = np.zeros((len(images), 1, 28, 28), dtype=np.float32)
    skipped = 0
    for index, image in enumerate(images):
        render = photo_style if rng.random() < photo_ratio else canvas_style
        try:
            rows[index, 0] = canvas_input(render(image, rng))
        except InvalidImage:
            skipped += 1
    return rows, skipped


def raw_inputs(images: np.ndarray) -> np.ndarray:
    values = images.astype(np.float32) / 255
    return ((values - BASELINE.mean) / BASELINE.std)[:, None, :, :]


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


def read_emnist_digits(archive: Path, split: str, limit: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """读取 NIST EMNIST digits 压缩包；图像按官方约定做行列转置。"""
    inside = f"gzip/emnist-digits-{split}"
    with zipfile.ZipFile(archive) as bundle:
        images = np.frombuffer(gzip.decompress(bundle.read(inside + "-images-idx3-ubyte.gz")), dtype=np.uint8)
        labels = np.frombuffer(gzip.decompress(bundle.read(inside + "-labels-idx1-ubyte.gz")), dtype=np.uint8)
    count = int.from_bytes(images[4:8].tobytes(), "big")
    grayscale = images[16:16 + count * 784].reshape(count, 28, 28)
    # EMNIST 以转置方式存储；转置回来才是正常字向（已用样例目视核对）。
    grayscale = np.transpose(grayscale, (0, 2, 1))
    return grayscale[:limit], labels[8:][:limit]


def accuracy(model, torch, inputs: np.ndarray, labels: np.ndarray) -> float:
    model.eval()
    correct = 0
    with torch.inference_mode():
        for start in range(0, len(inputs), 512):
            batch = torch.from_numpy(inputs[start:start + 512])
            correct += int((model(batch).argmax(dim=1).numpy() == labels[start:start + 512]).sum())
    return round(correct / len(labels), 4)


def run(config: CanvasAugConfig, data_dir: Path, output_dir: Path, init: Path | None,
        threads: int | None = None, emnist_zip: Path | None = None,
        on_epoch: "callable | None" = None) -> dict:
    """on_epoch(metrics) 在每轮评估后被调用，用于把实时指标推给上层；回调异常不影响训练。"""
    import torch
    from models.cnn import ARCHITECTURE, DigitCNN
    from services.mnist_training import load_checkpoint

    if output_dir.exists():
        raise ValueError("--output-dir must be a NEW directory; existing outputs are refused")
    if not (data_dir / "train-images-idx3-ubyte").is_file():
        raise ValueError("--data-dir must contain official MNIST IDX files")
    if emnist_zip is not None and not emnist_zip.is_file():
        raise ValueError("--emnist-zip must be an existing local archive")
    if threads:
        torch.set_num_threads(threads)
    rng = np.random.default_rng(config.seed)
    torch.manual_seed(config.seed)

    mnist_count = config.samples if emnist_zip is None else config.samples // 2
    mnist_train = read_idx(data_dir / "train-images-idx3-ubyte", mnist_count)
    mnist_labels = read_labels(data_dir / "train-labels-idx1-ubyte", mnist_count)
    if emnist_zip is not None:
        extra_images, extra_labels = read_emnist_digits(emnist_zip, "train", config.samples - mnist_count)
        train_images = np.concatenate([mnist_train, extra_images])
        train_labels = np.concatenate([mnist_labels, extra_labels])
    else:
        train_images, train_labels = mnist_train, mnist_labels

    test_images = read_idx(data_dir / "t10k-images-idx3-ubyte", 1000)
    test_labels = read_labels(data_dir / "t10k-labels-idx1-ubyte", 1000)
    emnist_test = None
    if emnist_zip is not None:
        emnist_test = read_emnist_digits(emnist_zip, "test", 1000)

    train_inputs, skipped = build_inputs(train_images, rng, config.photo_ratio)
    canvas_test, _ = build_inputs(test_images, np.random.default_rng(config.seed + 1), 0.0)
    photo_test, _ = build_inputs(test_images, np.random.default_rng(config.seed + 2), 1.0)
    raw_test = raw_inputs(test_images)

    model = DigitCNN()
    if init is not None:
        if not init.is_file():
            raise ValueError("--init must be an existing checkpoint file")
        start_model, _ = load_checkpoint(init.open("rb"), device="cpu")
        model.load_state_dict(start_model.state_dict())
    before = {"raw_mnist_1000": accuracy(model, torch, raw_test, test_labels),
              "canvas_simulated_1000": accuracy(model, torch, canvas_test, test_labels),
              "photo_simulated_1000": accuracy(model, torch, photo_test, test_labels)}

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
        metrics = {"epoch": epoch + 1, "loss": round(total / seen, 5),
                   "raw_mnist": accuracy(model, torch, raw_test, test_labels),
                   "canvas_simulated": accuracy(model, torch, canvas_test, test_labels),
                   "photo_simulated": accuracy(model, torch, photo_test, test_labels)}
        if emnist_test is not None:
            emnist_inputs, _ = build_inputs(emnist_test[0], np.random.default_rng(config.seed + 3), 0.0)
            metrics["emnist_canvas_simulated_1000"] = accuracy(model, torch, emnist_inputs, emnist_test[1])
        history.append(metrics)
        print(json.dumps(metrics), flush=True)
        if on_epoch is not None:
            try:
                on_epoch(dict(metrics))
            except Exception:  # noqa: BLE001 - 上报失败不能中断训练
                pass

    output_dir.mkdir(parents=True)
    torch.save({
        "format_version": 1,
        "architecture": ARCHITECTURE,
        "config": {"source": "train_canvas_aug", "epochs": config.epochs, "samples": config.samples,
                   "batch": config.batch, "learning_rate": config.learning_rate, "seed": config.seed,
                   "photo_ratio": config.photo_ratio,
                   "emnist": str(emnist_zip) if emnist_zip else None,
                   "init": str(init) if init else None},
        "epoch": config.epochs,
        "checkpoint_selection": "final_epoch",
        "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
    }, output_dir / "checkpoint.pt")
    metrics = {
        "recipe": "production canvas_input geometry + canvas & photo augmentation",
        "config": {"epochs": config.epochs, "samples": config.samples, "batch": config.batch,
                   "learning_rate": config.learning_rate, "seed": config.seed,
                   "photo_ratio": config.photo_ratio,
                   "emnist": str(emnist_zip) if emnist_zip else None,
                   "initialized_from": str(init) if init else None},
        "samples_rendered": int(len(train_inputs) - skipped),
        "samples_unusable": int(skipped),
        "before": before,
        "after": {"raw_mnist_1000": accuracy(model, torch, raw_test, test_labels),
                  "canvas_simulated_1000": accuracy(model, torch, canvas_test, test_labels),
                  "photo_simulated_1000": accuracy(model, torch, photo_test, test_labels)},
        "history": history,
        "limitations": [
            "canvas/photo simulated sets share the generator family with training; they are optimistic.",
            "MNIST test is in-distribution only and says nothing about real board or album accuracy.",
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
    parser.add_argument("--emnist-zip", type=Path, help="Local NIST EMNIST gzip.zip (official digits split)")
    parser.add_argument("--init", type=Path, help="Existing checkpoint to fine-tune from")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--samples", type=int, default=60000)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=20261107)
    parser.add_argument("--photo-ratio", type=float, default=0.5)
    parser.add_argument("--threads", type=int)
    args = parser.parse_args(argv)
    config = CanvasAugConfig(epochs=args.epochs, samples=args.samples, batch=args.batch,
                             learning_rate=args.learning_rate, seed=args.seed, photo_ratio=args.photo_ratio)
    metrics = run(config, args.data_dir, args.output_dir, args.init, args.threads, args.emnist_zip)
    print(json.dumps({"output": str(args.output_dir), "metrics": metrics["after"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
