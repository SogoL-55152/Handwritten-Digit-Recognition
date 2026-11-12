"""多位数字：垂直投影切分 + 逐字复用线上模型。

只做"间隔式书写、最多 MAX_DIGITS 位"；连笔/黏连不承诺。
切出的每一段都走与线上完全相同的 28×28 归一化，避免逐字准确率因口径不同而掉点。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from services.inference_manifest import BASELINE
from services.inference_preprocess import foreground_ink

MAX_DIGITS = 4
# 间隙阈值取画布宽度的比例：太小会把笔画间空隙当分隔，太大则漏切。
MIN_GAP_RATIO = 0.02
MIN_WIDTH_RATIO = 0.01


@dataclass(frozen=True)
class Segment:
    left: int
    right: int


def segment_mask(mask: np.ndarray, min_gap_ratio: float = MIN_GAP_RATIO) -> list[Segment]:
    """按列投影切分：连续空列达到阈值即视为一个分隔。"""
    if mask.ndim != 2:
        raise ValueError("mask must be 2D")
    width = int(mask.shape[1])
    filled = mask.any(axis=0)
    min_gap = max(2, int(round(width * min_gap_ratio)))
    segments: list[Segment] = []
    start: int | None = None
    empty = 0
    for x in range(width):
        if filled[x]:
            if start is None:
                start = x
            empty = 0
        elif start is not None:
            empty += 1
            if empty >= min_gap:
                segments.append(Segment(start, x - empty + 1))
                start = None
                empty = 0
    if start is not None:
        segments.append(Segment(start, width))
    min_width = max(2, int(round(width * MIN_WIDTH_RATIO)))
    kept = [item for item in segments if item.right - item.left >= min_width]
    return kept or segments


def normalize_segment(mask: np.ndarray, ink: np.ndarray, segment: Segment) -> np.ndarray | None:
    """与 canvas_input 同口径：裁到墨迹外框 → 长边缩放到 20 → 居中贴到 28×28。"""
    rows = np.nonzero(mask[:, segment.left:segment.right].any(axis=1))[0]
    if rows.size == 0:
        return None
    top, bottom = int(rows.min()), int(rows.max()) + 1
    crop = np.where(mask, ink, 0).astype(np.uint8)[top:bottom, segment.left:segment.right]
    if crop.size == 0:
        return None
    image = Image.fromarray(crop)
    width, height = image.size
    scale = 20 / max(width, height)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    canvas = Image.new("L", (28, 28), 0)
    canvas.paste(image.resize(target, Image.Resampling.LANCZOS),
                 ((28 - target[0]) // 2, (28 - target[1]) // 2))
    values = np.asarray(canvas, dtype=np.float32) / np.float32(255)
    return np.ascontiguousarray(((values - BASELINE.mean) / BASELINE.std)[None, :, :])


def segments_of(gray: np.ndarray) -> tuple[list[Segment], np.ndarray, np.ndarray]:
    """灰度图 → (切分结果, 墨迹图, 二值掩膜)。无法分离前景时抛 ValueError。"""
    ink = foreground_ink(gray)
    if ink is None:
        raise ValueError("BLANK_IMAGE")
    mask = ink > 0
    return segment_mask(mask), ink, mask


def top_guesses(probabilities: list[float]) -> tuple[int, float, float]:
    """返回 (最佳数字, 置信度, 与次优的分差)。"""
    order = np.argsort(np.asarray(probabilities))[::-1]
    best = int(order[0])
    confidence = float(probabilities[best])
    margin = float(probabilities[order[0]] - probabilities[order[1]]) if len(order) > 1 else confidence
    return best, confidence, margin
