"""图片导入的照片增强：光照归一化 → Otsu 二值化 → 形态学闭运算 + 加粗。

目标是把"灰纸、阴影、纸纹"的照片变成**白底黑字**的干净输入，并把笔画按比例加粗，
让模型看到的东西更接近它训练时的画板笔迹。画板路径不走这里。
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

# 加粗幅度上限（像素，按图片短边比例缩放），避免把 1 和 7 的拐角糊成一片
MAX_THICKEN_PX = 4


def _otsu_threshold(values: np.ndarray) -> int:
    """经典 Otsu：在 0–255 灰度直方图上找类间方差最大的阈值。"""
    histogram, _ = np.histogram(values, bins=256, range=(0, 256))
    total = float(histogram.sum())
    if total <= 0:
        return 128
    cumulative = np.cumsum(histogram).astype(np.float64)
    weighted = np.cumsum(histogram * np.arange(256)).astype(np.float64)
    best_threshold, best_variance = 128, -1.0
    for threshold in range(1, 256):
        weight_background = cumulative[threshold - 1]
        weight_foreground = total - weight_background
        if weight_background <= 0 or weight_foreground <= 0:
            continue
        mean_background = weighted[threshold - 1] / weight_background
        mean_foreground = (weighted[-1] - weighted[threshold - 1]) / weight_foreground
        variance = weight_background * weight_foreground * (mean_background - mean_foreground) ** 2
        if variance > best_variance:
            best_variance, best_threshold = variance, threshold
    return best_threshold


def _background(gray: np.ndarray) -> np.ndarray:
    """大半径模糊近似背景（纸张/光照），半径远大于笔画宽度，避免把笔画当背景减掉。"""
    radius = max(3, min(gray.shape) // 12)
    blurred = Image.fromarray(gray).filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(blurred, dtype=np.float32)


def _dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def _erode(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:, :] &= mask[:-1, :]
    out[:-1, :] &= mask[1:, :]
    out[:, 1:] &= mask[:, :-1]
    out[:, :-1] &= mask[:, 1:]
    return out


def thicken_iterations(shape: tuple[int, int]) -> int:
    """按短边比例决定加粗像素数：小图 1px，手机照片 2–4px。"""
    return max(1, min(MAX_THICKEN_PX, round(min(shape) * 0.006)))


def ink_mask(gray: np.ndarray) -> np.ndarray:
    """灰度图 → 墨迹布尔掩膜（True = 墨迹）。"""
    values = gray.astype(np.float32)
    # 深色背景（白字黑底）先反相，后续一律按"深色墨迹、浅色背景"处理
    if float(np.median(values)) < 128:
        values = 255.0 - values
    background = np.maximum(_background(values.astype(np.uint8)), 1.0)
    normalized = np.clip(values / background * 255.0, 0, 255).astype(np.uint8)
    mask = normalized < _otsu_threshold(normalized)
    if float(mask.mean()) > 0.6:  # 前景占比过大说明取反了
        mask = ~mask
    return mask


def enhance_photo(gray: np.ndarray, thicken: int | None = None) -> np.ndarray:
    """灰度照片 → 白底黑字（uint8）。纯色图无法处理时抛 ValueError。"""
    if gray.ndim != 2:
        raise ValueError("gray must be 2D")
    if int(gray.max()) - int(gray.min()) < 8:
        raise ValueError("LOW_CONTRAST")
    ink = ink_mask(gray)
    ink = _dilate(ink)   # 填掉笔画内部的小孔
    ink = _erode(ink)
    iterations = thicken_iterations(gray.shape) if thicken is None else max(0, thicken)
    for _ in range(iterations):
        ink = _dilate(ink)
    return np.where(ink, 0, 255).astype(np.uint8)
