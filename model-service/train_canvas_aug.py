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
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import gzip
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import time
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


def apply_augments(image_l, rng, aug):
    """在渲染结果上追加可配置增强；aug 为 0..1 的强度，None 表示不额外增强。

    渲染结果是 numpy 灰度图，增强全程用 PIL 完成，出口统一转回 numpy，
    保证 canvas_input 收到的始终是 ndarray。
    """
    if not aug:
        return image_l
    from PIL import Image, ImageFilter
    out = image_l if isinstance(image_l, Image.Image) else Image.fromarray(image_l)
    rotate = float(aug.get("rotate", 0) or 0)
    if rotate > 0:
        angle = float(rng.uniform(-20, 20)) * min(1.0, rotate)
        if abs(angle) > 0.5:
            out = out.rotate(angle, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=0)
    scale = float(aug.get("scale", 0) or 0)
    if scale > 0:
        factor = 1 + float(rng.uniform(-0.2, 0.2)) * min(1.0, scale)
        width, height = out.size
        resized = out.resize((max(8, int(width * factor)), max(8, int(height * factor))),
                             Image.Resampling.LANCZOS)
        canvas = Image.new("L", (width, height), 0)
        canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
        out = canvas
    brightness = float(aug.get("brightness", 0) or 0)
    if brightness > 0:
        factor = 1 + float(rng.uniform(-0.4, 0.4)) * min(1.0, brightness)
        values = np.asarray(out).astype(np.float32) * factor
        out = Image.fromarray(np.clip(values, 0, 255).astype(np.uint8))
    blur = float(aug.get("blur", 0) or 0)
    if blur > 0 and rng.random() < min(1.0, blur):
        out = out.filter(ImageFilter.GaussianBlur(radius=float(rng.uniform(0.5, 2.5)) * min(1.0, blur)))
    mosaic = float(aug.get("mosaic", 0) or 0)
    if mosaic > 0 and rng.random() < min(1.0, mosaic):
        width, height = out.size
        block = max(2, int(min(width, height) * float(rng.uniform(0.06, 0.30)) * min(1.0, mosaic)))
        small = out.resize((max(1, width // block), max(1, height // block)), Image.Resampling.NEAREST)
        out = small.resize((width, height), Image.Resampling.NEAREST)
    return np.asarray(out)
    return out


def build_inputs(images: np.ndarray, rng, photo_ratio: float, aug=None, on_progress=None) -> tuple[np.ndarray, int]:
    """渲染并走线上同一套 canvas_input；返回输入张量与无法对齐的样本数。

    多线程渲染（PIL 滤镜会释放 GIL）；每个样本用 spawn 出的独立随机流，
    同种子下结果仍然可复现。on_progress(0–100) 按块回调。
    """
    rows = np.zeros((len(images), 1, 28, 28), dtype=np.float32)
    if len(images) == 0:
        if on_progress is not None:
            on_progress(100)
        return rows, 0
    workers = int(os.getenv("TRAINING_PREP_THREADS", "4"))
    workers = max(1, min(8, workers, len(images)))
    children = rng.spawn(workers)

    def render_one(pair):
        index, child_rng = pair
        render = photo_style if child_rng.random() < photo_ratio else canvas_style
        try:
            return index, canvas_input(apply_augments(render(images[index], child_rng), child_rng, aug))
        except InvalidImage:
            return index, None

    skipped = 0
    chunk = max(1, (len(images) + 19) // 20)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for start in range(0, len(images), chunk):
            end = min(len(images), start + chunk)
            indices = range(start, end)
            for index, result in pool.map(render_one, ((i, children[i % workers]) for i in indices)):
                if result is None:
                    skipped += 1
                else:
                    rows[index, 0] = result
            if on_progress is not None:
                on_progress(int(round(end * 100.0 / len(images))))
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


def _confusion_and_errors(model, torch, inputs: np.ndarray, labels: np.ndarray, max_errors: int = 20):
    """跑一遍评估集：返回混淆矩阵、置信度最高的错误样本、以及错误总数。"""
    model.eval()
    confusion = [[0] * 10 for _ in range(10)]
    errors: list[dict] = []
    with torch.inference_mode():
        for start in range(0, len(inputs), 512):
            batch = torch.from_numpy(inputs[start:start + 512])
            probabilities = torch.softmax(model(batch), dim=1)
            confidence, predicted = probabilities.max(dim=1)
            for offset, (truth, guess, score) in enumerate(
                    zip(labels[start:start + 512], predicted.numpy(), confidence.numpy())):
                true_label, guessed = int(truth), int(guess)
                if not (0 <= true_label < 10 and 0 <= guessed < 10):
                    continue
                confusion[true_label][guessed] += 1
                if true_label != guessed:
                    errors.append({"index": start + offset, "truth": true_label,
                                   "predicted": guessed, "confidence": round(float(score), 4)})
    # 置信度最高的错误最值得回溯：模型"很确定但错了"，通常指向标签噪声或分布偏移
    errors.sort(key=lambda item: item["confidence"], reverse=True)
    return confusion, errors[:max_errors], len(errors)


def _write_error_sheet(inputs: np.ndarray, errors: list[dict], path: Path,
                       thumb: int = 56, columns: int = 6) -> None:
    """把错误样本拼成一张 PNG 联络表，方便人工回看（不参与接口返回）。"""
    if not errors:
        return
    rows = (len(errors) + columns - 1) // columns
    gap = 6
    width = columns * thumb + (columns + 1) * gap
    height = rows * thumb + (rows + 1) * gap
    sheet = Image.new("L", (width, height), 255)
    for position, error in enumerate(errors):
        index = int(error["index"])
        if not (0 <= index < len(inputs)):
            continue
        pixels = np.asarray(inputs[index]).reshape(28, 28)
        pixels = (np.clip(pixels, 0.0, 1.0) * 255).astype(np.uint8)
        tile = Image.fromarray(pixels, mode="L").resize((thumb, thumb), Image.NEAREST)
        column, row = position % columns, position // columns
        sheet.paste(tile, (gap + column * (thumb + gap), gap + row * (thumb + gap)))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(path)


def detailed_metrics(model, torch, inputs: np.ndarray, labels: np.ndarray,
                     domain: str = "canvas_simulated", output_dir: Path | None = None,
                     max_errors: int = 20) -> dict:
    """单个评估域的完整指标：混淆矩阵 + 每类 P/R/F1 + 宏/加权平均 + 错误样本回溯。

    行=真实标签、列=预测标签。某类的 precision/recall 在分母为 0 时为 None（不是 0），
    避免"这个类根本没出现过"被误读成"这个类全错"。
    """
    confusion, errors, error_total = _confusion_and_errors(model, torch, inputs, labels, max_errors)

    per_class = []
    macro_precision: list[float] = []
    macro_recall: list[float] = []
    macro_f1: list[float] = []
    weighted_f1_sum = 0.0
    support_total = 0
    correct_total = 0
    for label in range(10):
        support = sum(confusion[label])                      # 真实是该类的样本数
        predicted = sum(row[label] for row in confusion)      # 被判成该类的样本数
        correct = confusion[label][label]
        precision = round(correct / predicted, 4) if predicted else None
        recall = round(correct / support, 4) if support else None
        if precision is None or recall is None:
            f1 = None
        elif precision + recall == 0:
            f1 = 0.0
        else:
            f1 = round(2 * precision * recall / (precision + recall), 4)
        per_class.append({"label": label, "support": support, "predicted": predicted,
                          "correct": correct, "precision": precision, "recall": recall, "f1": f1,
                          "accuracy": round(correct / support, 4) if support else None})
        support_total += support
        correct_total += correct
        if support or predicted:
            if precision is not None:
                macro_precision.append(precision)
            if recall is not None:
                macro_recall.append(recall)
            if f1 is not None:
                macro_f1.append(f1)
        if support and f1 is not None:
            weighted_f1_sum += f1 * support

    def average(values: list[float]):
        return round(sum(values) / len(values), 4) if values else None

    measured = [item for item in per_class if item["support"] > 0]
    worst = sorted(measured, key=lambda item: (item["f1"] if item["f1"] is not None else 1.0))[:3]

    report = {
        "domain": domain,
        "total": support_total,
        "correct": correct_total,
        "accuracy": round(correct_total / support_total, 4) if support_total else None,
        "perClass": per_class,
        "macro": {"precision": average(macro_precision), "recall": average(macro_recall),
                  "f1": average(macro_f1), "classes": len(macro_f1)},
        "weighted": {"f1": round(weighted_f1_sum / support_total, 4) if support_total else None},
        "confusion": confusion,
        "worst": [{"label": item["label"], "f1": item["f1"], "recall": item["recall"],
                   "precision": item["precision"], "support": item["support"]} for item in worst],
        "errorCount": error_total,
        "errors": errors,
    }
    if output_dir is not None and errors:
        sheet = Path(output_dir) / f"errors-{domain}.png"
        try:
            _write_error_sheet(inputs, errors, sheet)
            report["errorSheet"] = sheet.name
        except OSError:
            report["errorSheet"] = None
    return report


def accuracy(model, torch, inputs: np.ndarray, labels: np.ndarray) -> float:
    model.eval()
    correct = 0
    with torch.inference_mode():
        for start in range(0, len(inputs), 512):
            batch = torch.from_numpy(inputs[start:start + 512])
            correct += int((model(batch).argmax(dim=1).numpy() == labels[start:start + 512]).sum())
    return round(correct / len(labels), 4)


def load_extra_inputs(directory: Path, on_progress=None):
    """读取数据集版本导出的 PNG（文件名形如 7_123.png），返回 (图像, 标签)。多线程加载。"""
    from PIL import Image

    from services.inference_preprocess import canvas_input

    paths = sorted(directory.glob("*.png"))
    valid = []
    for path in paths:
        label = path.name.split("_")[0]
        if label.isdigit() and len(label) == 1:
            valid.append(path)
    if not valid:
        if on_progress is not None:
            on_progress(100)
        return np.empty((0, 28, 28), dtype=np.float32), np.empty((0,), dtype=np.int64)

    def load_one(path):
        try:
            normalized = canvas_input(np.asarray(Image.open(path).convert("L")))
            return int(path.name.split("_")[0]), normalized[0]
        except Exception:
            return None

    workers = max(1, min(8, int(os.getenv("TRAINING_PREP_THREADS", "4")), len(valid)))
    inputs, labels = [], []
    chunk = max(1, (len(valid) + 19) // 20)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for start in range(0, len(valid), chunk):
            for loaded in pool.map(load_one, valid[start:start + chunk]):
                if loaded is None:
                    continue
                label, normalized = loaded
                labels.append(label)
                inputs.append(normalized)
            if on_progress is not None:
                on_progress(int(round(min(len(valid), start + chunk) * 100.0 / len(valid))))
    if not inputs:
        return np.empty((0, 28, 28), dtype=np.float32), np.empty((0,), dtype=np.int64)
    return np.stack(inputs).astype(np.float32)[:, None, :, :], np.asarray(labels, dtype=np.int64)


LAYER_NAMES = ("conv1", "conv2", "fc1", "fc2")


def _layer_module(model, name: str):
    """按块取模块：features[0]=conv1, features[3]=conv2, classifier[1]=fc1, classifier[4]=fc2。"""
    if name == "conv1":
        return model.features[0]
    if name == "conv2":
        return model.features[3]
    if name == "fc1":
        return model.classifier[1]
    if name == "fc2":
        return model.classifier[4]
    raise ValueError(f"未知层名：{name}")


def apply_trainable(model, trainable_layers):
    """按层设置 requires_grad；trainable_layers=None 表示全部可训练。"""
    if trainable_layers is None:
        return list(LAYER_NAMES)
    unknown = [name for name in trainable_layers if name not in LAYER_NAMES]
    if unknown:
        raise ValueError(f"未知层名：{','.join(unknown)}")
    if "fc2" not in trainable_layers:
        raise ValueError("fc2（最后一层）必须可训练，否则训练没有意义")
    for name in LAYER_NAMES:
        flag = name in trainable_layers
        for parameter in _layer_module(model, name).parameters():
            parameter.requires_grad = flag
    if not any(parameter.requires_grad for parameter in model.parameters()):
        raise ValueError("没有可训练参数，请至少保留 fc2")
    return [name for name in LAYER_NAMES if name in trainable_layers]


def _input_cache_key(config: CanvasAugConfig, data_dir: Path, emnist_zip: Path | None,
                     extra_dir: Path | None, aug: "dict | None") -> str:
    """渲染输入缓存键：配置 + 数据文件身份。同配置同数据再次训练直接复用渲染结果。"""
    payload = {"seed": config.seed, "samples": config.samples,
               "photo_ratio": config.photo_ratio, "aug": aug or {}}
    for name in ("train-images-idx3-ubyte", "train-labels-idx1-ubyte"):
        stat = (data_dir / name).stat()
        payload[f"{name}:size"] = stat.st_size
        payload[f"{name}:mtime"] = stat.st_mtime_ns
    if emnist_zip is not None:
        stat = emnist_zip.stat()
        payload["emnist:size"] = stat.st_size
    if extra_dir is not None:
        manifest = Path(extra_dir) / "manifest.json"
        if manifest.is_file():
            payload["extra:sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def _prepare_inputs(config: CanvasAugConfig, data_dir: Path, rng, emnist_zip: Path | None,
                    extra_dir: Path | None, aug: "dict | None", on_prepare) -> tuple[np.ndarray, np.ndarray, int, int]:
    """渲染训练输入（带缓存与进度）；返回 (train_inputs, train_labels, extra_count, skipped)。"""
    cache_dir = Path(os.getenv("TRAINING_INPUT_CACHE",
                               str(Path(__file__).resolve().parent / "data" / "input-cache")))
    cache_key = _input_cache_key(config, data_dir, emnist_zip, extra_dir, aug)
    cache_path = cache_dir / f"{cache_key}.npz"

    mnist_count = config.samples if emnist_zip is None else config.samples // 2
    extra_count = 0

    if cache_path.is_file():
        with np.load(cache_path) as data:
            train_inputs = data["train_inputs"]
            train_labels = data["train_labels"]
        if on_prepare is not None:
            on_prepare(100)
        print(json.dumps({"inputCache": "hit", "samples": int(len(train_inputs))}), flush=True)
        return train_inputs, train_labels, extra_count, 0

    mnist_train = read_idx(data_dir / "train-images-idx3-ubyte", mnist_count)
    mnist_labels = read_labels(data_dir / "train-labels-idx1-ubyte", mnist_count)
    if emnist_zip is not None:
        extra_images, extra_labels = read_emnist_digits(emnist_zip, "train", config.samples - mnist_count)
        train_images = np.concatenate([mnist_train, extra_images])
        train_labels = np.concatenate([mnist_labels, extra_labels])
    else:
        train_images, train_labels = mnist_train, mnist_labels

    train_inputs, skipped = build_inputs(train_images, rng, config.photo_ratio, aug, on_progress=on_prepare)
    if extra_dir is not None:
        # 数据集版本里的样本已是真实画板/照片，接近线上输入，不再叠加照片模拟
        extra_inputs, extra_labels = load_extra_inputs(Path(extra_dir), on_progress=on_prepare)
        if len(extra_inputs):
            train_inputs = np.concatenate([train_inputs, extra_inputs])
            train_labels = np.concatenate([train_labels, extra_labels])
            extra_count = int(len(extra_inputs))
    if not cache_path.parent.exists():
        cache_path.parent.mkdir(parents=True)
    temporary = cache_path.with_suffix(".tmp.npz")
    np.savez_compressed(temporary, train_inputs=train_inputs, train_labels=train_labels)
    temporary.replace(cache_path)
    # 缓存只留最近 2 份，避免占满磁盘
    entries = sorted(cache_path.parent.glob("*.npz"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for stale in entries[2:]:
        try:
            stale.unlink()
        except OSError:
            pass
    return train_inputs, train_labels, extra_count, skipped


def run(config: CanvasAugConfig, data_dir: Path, output_dir: Path, init: Path | None,
        threads: int | None = None, emnist_zip: Path | None = None,
        on_epoch: "callable | None" = None, extra_dir: Path | None = None,
        early_stop: bool = False, patience: int = 3,
        trainable_layers: "list[str] | None" = None, aug: "dict | None" = None,
        on_prepare: "callable | None" = None) -> dict:
    """on_epoch(metrics) 在每轮评估后被调用，用于把实时指标推给上层；回调异常不影响训练。
    on_prepare(0–100) 在渲染/加载训练输入时回调，用于上报准备进度。"""
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

    train_inputs, train_labels, extra_count, skipped = _prepare_inputs(
        config, data_dir, rng, emnist_zip, extra_dir, aug, on_prepare)

    test_images = read_idx(data_dir / "t10k-images-idx3-ubyte", 1000)
    test_labels = read_labels(data_dir / "t10k-labels-idx1-ubyte", 1000)
    emnist_test = None
    if emnist_zip is not None:
        emnist_test = read_emnist_digits(emnist_zip, "test", 1000)
    canvas_test, _ = build_inputs(test_images, np.random.default_rng(config.seed + 1), 0.0)
    photo_test, _ = build_inputs(test_images, np.random.default_rng(config.seed + 2), 1.0)
    raw_test = raw_inputs(test_images)

    model = DigitCNN()
    if init is not None:
        if not init.is_file():
            raise ValueError("--init must be an existing checkpoint file")
        start_model, _ = load_checkpoint(init.open("rb"), device="cpu")
        model.load_state_dict(start_model.state_dict())
    active_layers = apply_trainable(model, trainable_layers)
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    print(json.dumps({"trainableLayers": active_layers, "trainableParams": trainable_params,
                      "totalParams": total_params}), flush=True)
    before = {"raw_mnist_1000": accuracy(model, torch, raw_test, test_labels),
              "canvas_simulated_1000": accuracy(model, torch, canvas_test, test_labels),
              "photo_simulated_1000": accuracy(model, torch, photo_test, test_labels)}

    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=config.learning_rate)
    loss_fn = torch.nn.CrossEntropyLoss()
    labels = torch.from_numpy(train_labels.astype(np.int64))
    history = []
    step_series = []
    early_stopped = False
    stalls = 0
    last_grad_norm = 0.0
    best_epoch, best_score = None, -1.0
    for epoch in range(config.epochs):
        epoch_started = time.perf_counter()
        model.train()
        order = torch.randperm(len(train_inputs))
        total, seen = 0.0, 0
        for start in range(0, len(order), config.batch):
            index = order[start:start + config.batch]
            optimizer.zero_grad()
            loss = loss_fn(model(torch.from_numpy(train_inputs[index.numpy()])), labels[index])
            loss.backward()
            with torch.no_grad():
                squared = sum(float(parameter.grad.norm(2)) ** 2
                              for parameter in model.parameters() if parameter.grad is not None)
                last_grad_norm = squared ** 0.5
            optimizer.step()
            total += float(loss) * len(index)
            seen += len(index)
            if len(step_series) < 500 and seen % max(config.batch, 640) < config.batch:
                step_series.append({"step": seen, "epoch": epoch + 1,
                                    "loss": round(float(loss), 5),
                                    "lr": float(optimizer.param_groups[0]["lr"])})
        elapsed = max(0.001, time.perf_counter() - epoch_started)
        # 训练集准确率取一小段（最多 1000 个）算，避免每轮额外跑全量
        train_probe = min(1000, len(train_inputs))
        metrics = {"epoch": epoch + 1, "loss": round(total / seen, 5),
                   "durationMs": int(round(elapsed * 1000)),
                   "lr": float(optimizer.param_groups[0]["lr"]),
                   "gradNorm": round(last_grad_norm, 4),
                   "tps": round(seen / elapsed, 1),
                   "trainAcc": accuracy(model, torch, train_inputs[:train_probe], train_labels[:train_probe]),
                   "raw_mnist": accuracy(model, torch, raw_test, test_labels),
                   "canvas_simulated": accuracy(model, torch, canvas_test, test_labels),
                   "photo_simulated": accuracy(model, torch, photo_test, test_labels)}
        if emnist_test is not None:
            emnist_inputs, _ = build_inputs(emnist_test[0], np.random.default_rng(config.seed + 3), 0.0)
            metrics["emnist_canvas_simulated_1000"] = accuracy(model, torch, emnist_inputs, emnist_test[1])
        if metrics["canvas_simulated"] > best_score:
            best_score = metrics["canvas_simulated"]
            best_epoch = metrics["epoch"]
            stalls = 0
        else:
            stalls += 1
        history.append(metrics)
        if early_stop and stalls >= patience:
            early_stopped = True
            print(json.dumps({"earlyStop": True, "epoch": metrics["epoch"], "bestEpoch": best_epoch}), flush=True)
            break
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
    # 三个评估域都出完整报告（混淆矩阵 + 每类 P/R/F1 + 错误样本），不再只算画板域
    detailed = {}
    for domain, domain_inputs in (("raw_mnist", raw_test),
                                  ("canvas_simulated", canvas_test),
                                  ("photo_simulated", photo_test)):
        detailed[domain] = detailed_metrics(model, torch, domain_inputs, test_labels, domain, output_dir)
    after = {"raw_mnist_1000": detailed["raw_mnist"]["accuracy"],
             "canvas_simulated_1000": detailed["canvas_simulated"]["accuracy"],
             "photo_simulated_1000": detailed["photo_simulated"]["accuracy"]}
    metrics = {
        "recipe": "production canvas_input geometry + canvas & photo augmentation",
        "config": {"epochs": config.epochs, "samples": config.samples, "batch": config.batch,
                   "earlyStop": early_stop, "patience": patience,
                   "learning_rate": config.learning_rate, "seed": config.seed,
                   "photo_ratio": config.photo_ratio,
                   "augment": aug or {},
                   "emnist": str(emnist_zip) if emnist_zip else None,
                   "initialized_from": str(init) if init else None},
        "samples_rendered": int(len(train_inputs) - skipped),
        "samples_unusable": int(skipped),
        "extra_samples": extra_count,
        "bestEpoch": best_epoch,
        "earlyStopped": early_stopped,
        "trainableLayers": active_layers,
        "trainableParams": trainable_params,
        "totalParams": total_params,
        "stepSeries": step_series,
        "before": before,
        "after": after,
        "detailed": detailed,
        # 兼容旧前端/旧记录：detailed_canvas 仍指向画板域
        "detailed_canvas": detailed["canvas_simulated"],
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
