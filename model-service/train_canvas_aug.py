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
from concurrent.futures import ThreadPoolExecutor
import threading
from io import BytesIO
import hashlib
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
        if not 1 <= self.epochs <= 100:
            raise ValueError("epochs must be within 1..100")
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
    """在渲染结果上追加可配置增强；aug 为 0..1 的强度，None 表示不额外增强。"""
    if not aug:
        return image_l
    from PIL import Image, ImageFilter
    out = image_l
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
    return out


def _to_pil(image):
    """photo_style 返回 ndarray，canvas_style 返回 PIL；统一成 PIL 再叠加增强。"""
    if isinstance(image, np.ndarray):
        return Image.fromarray(np.clip(image, 0, 255).astype(np.uint8))
    return image


def _render_chunk(args):
    images, seed, photo_ratio, aug = args
    rng = np.random.default_rng(seed)
    rows = np.zeros((len(images), 1, 28, 28), dtype=np.float32)
    skipped = 0
    for index, image in enumerate(images):
        render = photo_style if rng.random() < photo_ratio else canvas_style
        try:
            rendered = _to_pil(render(image, rng))
            rows[index, 0] = canvas_input(np.asarray(apply_augments(rendered, rng, aug)))
        except InvalidImage:
            skipped += 1
    return rows, skipped


def build_inputs(images: np.ndarray, rng, photo_ratio: float, aug=None, workers: int = 1,
                 seed: int | None = None, progress=None) -> tuple[np.ndarray, int]:
    """渲染并走线上同一套 canvas_input；返回输入张量与无法对齐的样本数。

    workers > 1 时按块并行（PIL 渲染主要释放 GIL）；progress(done, total) 用于上报进度。
    """
    total = len(images)
    if total == 0:
        return np.zeros((0, 1, 28, 28), dtype=np.float32), 0
    workers = max(1, int(workers or 1))
    if workers == 1:
        rows, skipped = _render_chunk((images, rng, photo_ratio, aug))
        if progress:
            progress(total, total)
        return rows, skipped

    if seed is None:
        seed = int(rng.integers(0, 2**31 - 1))
    chunk = max(1, (total + workers * 8 - 1) // (workers * 8))
    jobs = []
    for index, start in enumerate(range(0, total, chunk)):
        jobs.append((images[start:start + chunk], seed + index * 101, photo_ratio, aug))
    rows = np.zeros((total, 1, 28, 28), dtype=np.float32)
    skipped = 0
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for start, (part, part_skipped) in zip(range(0, total, chunk), pool.map(_render_chunk, jobs)):
            rows[start:start + len(part)] = part
            skipped += part_skipped
            done += len(part)
            if progress:
                progress(done, total)
    return rows, skipped


class StreamingRenderer:
    """后台线程按块渲染，训练循环按需等待；首轮渲染与训练重叠。

    每个样本用独立随机种子（seed + index），因此等待顺序不影响结果，也便于部分命中。
    渲染完成后把整份张量写入缓存，后续任务直接命中。
    """

    def __init__(self, images, seed, photo_ratio, aug, cache_file: Path, progress, workers: int):
        self.images = images
        self.n = len(images)
        self.inputs = np.zeros((self.n, 1, 28, 28), dtype=np.float32)
        self.done = np.zeros(self.n, dtype=bool)
        self.skipped = 0
        self.cache_file = Path(cache_file)
        self._progress = progress
        self._condition = threading.Condition()
        self._thread = None

        cached = _load_cached(self.cache_file)
        if cached is not None:
            array, lost = cached
            if len(array) == self.n:
                self.inputs[:] = array
                self.done[:] = True
                self.skipped = lost
                if self._progress:
                    self._progress(self.n, self.n)
                return

        self.seed = seed
        self.photo_ratio = photo_ratio
        self.aug = aug
        self.workers = workers

    def start(self, order):
        """按训练顺序（通常是第一轮 shuffle 后的下标）启动后台渲染。"""
        if self._thread is not None or bool(self.done.all()):
            if self._progress:
                self._progress(self.n, self.n)
            return
        order = np.asarray(order, dtype=np.int64)
        order = order[order < self.n]
        chunk = max(1, min(1024, (self.n + self.workers * 8 - 1) // (self.workers * 8)))
        if not len(order):
            if self._progress:
                self._progress(self.n, self.n)
            return
        jobs = [(order[start:start + chunk], self.seed + start * 17)
                for start in range(0, len(order), chunk)]
        self._thread = threading.Thread(target=self._run, args=(jobs,), daemon=True)
        self._thread.start()

    def _run(self, jobs):
        done_total = 0
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = []
            for indices, rng_seed in jobs:
                futures.append((indices, pool.submit(_render_indices, self.images, indices,
                                                     rng_seed, self.photo_ratio, self.aug)))
            for indices, future in futures:
                array, lost = future.result()
                with self._condition:
                    self.inputs[indices] = array
                    self.done[indices] = True
                    self.skipped += lost
                    done_total += len(indices)
                    self._condition.notify_all()
                if self._progress:
                    self._progress(done_total, self.n)

    def wait(self, indices):
        """阻塞到给定下标全部渲染完成（只处理本次渲染范围内的下标）。"""
        if self._thread is None or not len(indices):
            return
        target = np.asarray(indices)
        target = target[target < self.n]
        if not len(target):
            return
        with self._condition:
            while not bool(self.done[target].all()):
                self._condition.wait(timeout=0.5)

    def finish(self) -> int:
        if self._thread is not None:
            self._thread.join()
        if not self.cache_file.exists():
            _save_cached(self.cache_file, self.inputs, self.skipped)
        return self.skipped


def _render_indices(images, indices, seed, photo_ratio, aug):
    rng = np.random.default_rng(seed)
    rows = np.zeros((len(indices), 1, 28, 28), dtype=np.float32)
    skipped = 0
    for offset, index in enumerate(indices):
        render = photo_style if rng.random() < photo_ratio else canvas_style
        try:
            rendered = _to_pil(render(images[index], rng))
            rows[offset, 0] = canvas_input(np.asarray(apply_augments(rendered, rng, aug)))
        except InvalidImage:
            skipped += 1
    return rows, skipped


def _render_cache_root(fallback: Path) -> Path:
    override = os.environ.get("HDR_RENDER_CACHE_DIR")
    if override:
        return Path(override)
    return Path(fallback) / "render-cache"


def _render_key(parts: dict) -> str:
    text = json.dumps(parts, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _load_cached(path: Path):
    if not path.is_file():
        return None
    try:
        with np.load(path) as data:
            result = data["inputs"], int(data["skipped"][0])
        # 命中即刷新访问时间，供 LRU 清理判断“最近使用”
        try:
            os.utime(path, None)
        except OSError:
            pass
        return result
    except Exception:
        return None


def _cache_files(root: Path):
    if not root.is_dir():
        return []
    return [item for item in root.glob("*.npz") if item.is_file()]


def _prune_render_cache(root: Path) -> None:
    """缓存清理：总大小超过 HDR_RENDER_CACHE_MAX_MB（默认 1024）时按最久未用删除。

    HDR_RENDER_CACHE_TTL_DAYS > 0 时再按时间兜底（默认关闭）。
    只删缓存，不影响数据集、样本与已训练模型。
    """
    try:
        files = _cache_files(root)
        if not files:
            return
        ttl_days = float(os.environ.get("HDR_RENDER_CACHE_TTL_DAYS", "0") or 0)
        now = time.time()
        expired = []
        if ttl_days > 0:
            expired = [item for item in files if now - item.stat().st_mtime > ttl_days * 86400]
        for item in expired:
            try:
                item.unlink()
            except OSError:
                pass
        if expired:
            files = [item for item in files if item.exists()]
        max_mb = float(os.environ.get("HDR_RENDER_CACHE_MAX_MB", "1024") or 1024)
        if max_mb <= 0 or not files:
            return
        sizes = {item: item.stat().st_size for item in files}
        total = sum(sizes.values())
        limit = max_mb * 1024 * 1024
        if total <= limit:
            return
        target = limit * 0.8
        for item in sorted(files, key=lambda entry: entry.stat().st_mtime):
            if total <= target:
                break
            try:
                size = sizes.get(item, item.stat().st_size)
                item.unlink()
                total -= size
            except OSError:
                pass
    except Exception:
        pass


def _save_cached(path: Path, inputs: np.ndarray, skipped: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, inputs=inputs, skipped=np.array([skipped], dtype=np.int64))
        _prune_render_cache(path.parent)
    except Exception:
        pass



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


def load_extra_inputs(directory: Path):
    """读取数据集版本导出的 PNG（文件名形如 7_123.png），返回 (图像, 标签)。"""
    from PIL import Image

    from services.inference_preprocess import canvas_input

    inputs, labels = [], []
    for path in sorted(directory.glob("*.png")):
        label = path.name.split("_")[0]
        if not label.isdigit() or len(label) != 1:
            continue
        try:
            normalized = canvas_input(np.asarray(Image.open(path).convert("L")))
        except Exception:
            continue
        inputs.append(normalized[0])
        labels.append(int(label))
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


def run(config: CanvasAugConfig, data_dir: Path, output_dir: Path, init: Path | None,
        threads: int | None = None, emnist_zip: Path | None = None,
        on_epoch: "callable | None" = None, extra_dir: Path | None = None,
        early_stop: bool = False, patience: int = 3,
        trainable_layers: "list[str] | None" = None, aug: "dict | None" = None,
        on_progress: "callable | None" = None) -> dict:
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

    workers = int(os.environ.get("HDR_RENDER_WORKERS", "0") or 0) or min(4, os.cpu_count() or 1)
    cache_base = Path(extra_dir).parent if extra_dir else data_dir
    cache_root = _render_cache_root(cache_base)

    def report(stage, done, total):
        if on_progress is None or not total:
            return
        try:
            on_progress(stage, done, total)
        except Exception:
            pass

    def render_cached(kind, images, seed, photo_ratio, aug_value, cache_name, base_seed):
        key = _render_key({"kind": kind, "n": int(len(images)), "seed": int(seed),
                           "photo": float(photo_ratio), "aug": aug_value})
        cache_file = cache_root / f"{cache_name}_{key}.npz"
        cached = _load_cached(cache_file)
        if cached is not None:
            report(kind, 1, 1)
            return cached
        rendered, lost = build_inputs(images, np.random.default_rng(base_seed), photo_ratio,
                                      aug=aug_value, workers=workers, seed=seed,
                                      progress=lambda done, total: report(kind, done, total))
        _save_cached(cache_file, rendered, lost)
        return rendered, lost

    train_key = _render_key({"kind": "train", "n": int(len(train_images)), "seed": int(config.seed),
                             "photo": float(config.photo_ratio), "aug": aug, "scheme": "stream-v2"})
    renderer = StreamingRenderer(train_images, config.seed, config.photo_ratio, aug,
                                 cache_root / f"train_{train_key}.npz",
                                 lambda done, total: report("train", done, total), workers)
    train_inputs = renderer.inputs
    skipped = 0
    extra_count = 0
    if extra_dir is not None:
        # 数据集版本里的样本已是真实画板/照片，接近线上输入，不再叠加照片模拟
        extra_inputs, extra_labels = load_extra_inputs(Path(extra_dir))
        if len(extra_inputs):
            train_inputs = np.concatenate([train_inputs, extra_inputs])
            train_labels = np.concatenate([train_labels, extra_labels])
            extra_count = int(len(extra_inputs))
    canvas_test, _ = render_cached("test-canvas", test_images, config.seed + 1, 0.0, None,
                                   "test_canvas", config.seed + 1)
    photo_test, _ = render_cached("test-photo", test_images, config.seed + 2, 1.0, None,
                                  "test_photo", config.seed + 2)
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
        if epoch == 0:
            renderer.start(order.numpy())
        total, seen = 0.0, 0
        for start in range(0, len(order), config.batch):
            index = order[start:start + config.batch]
            renderer.wait(index.numpy())
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
        renderer.wait(np.arange(train_probe))
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

    skipped = renderer.finish()
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
