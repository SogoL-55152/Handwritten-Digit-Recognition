"""门牌/街景数字：先找数字区再切分。

线上原有的多位切分假设"画布上只有数字"，遇到招牌照片时背景会被当成笔画，
切出一堆无意义片段。这里补两步：

1. 定位：把图片缩小后按亮度找最大的矩形区块（招牌、门牌），按原始比例裁回来；
2. 过滤：切分后丢掉明显不是数字的片段（过窄、过矮）。

两个候选（原图、亮区、暗区）都会跑一遍切分，取"片段数量落在 1..maxDigits 且高度覆盖"
最好的那个；都不理想时退回原图，保证行为不会比现在更差。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

SMALL_WIDTH = 160
BRIGHT_RATIO = 0.62
DARK_RATIO = 0.38
MIN_AREA_RATIO = 0.02
MAX_AREA_RATIO = 0.92
MIN_HEIGHT_RATIO = 0.55
MIN_WIDTH_RATIO = 0.015
MAX_WIDTH_RATIO = 0.85


@dataclass(frozen=True)
class Box:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top


def _large_region(gray: np.ndarray, bright: bool) -> Box | None:
    """缩小后取最大的近似矩形区域（不依赖 scipy 的连通域）。"""
    height, width = gray.shape
    if height < 8 or width < 8:
        return None
    scale = min(1.0, SMALL_WIDTH / width)
    small_size = (max(8, int(round(width * scale))), max(8, int(round(height * scale))))
    small = np.asarray(Image.fromarray(gray).resize(small_size, Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
    mask = small >= BRIGHT_RATIO if bright else small <= DARK_RATIO
    if not mask.any():
        return None

    seen = np.zeros_like(mask, dtype=bool)
    best: tuple[int, int, int, int, int] | None = None
    height_s, width_s = mask.shape
    for y0 in range(height_s):
        for x0 in range(width_s):
            if not mask[y0, x0] or seen[y0, x0]:
                continue
            stack = [(y0, x0)]
            seen[y0, x0] = True
            count = 0
            min_x = max_x = x0
            min_y = max_y = y0
            while stack:
                y, x = stack.pop()
                count += 1
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
                for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height_s and 0 <= nx < width_s and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            box = (min_x, min_y, max_x + 1, max_y + 1, count)
            if best is None or box[4] > best[4]:
                best = box
    if best is None:
        return None

    min_x, min_y, max_x, max_y, count = best
    area_ratio = count / float(height_s * width_s)
    if not (MIN_AREA_RATIO <= area_ratio <= MAX_AREA_RATIO):
        return None
    box_width = max_x - min_x
    box_height = max_y - min_y
    if box_width < 6 or box_height < 6:
        return None
    aspect = box_width / box_height
    if not 0.2 <= aspect <= 8.0:
        return None
    # 映射回原尺寸，留一点边
    scale_x = width / width_s
    scale_y = height / height_s
    pad_x = max(1, int(round(box_width * 0.04)))
    pad_y = max(1, int(round(box_height * 0.04)))
    left = max(0, int((min_x - pad_x) * scale_x))
    top = max(0, int((min_y - pad_y) * scale_y))
    right = min(width, int((max_x + pad_x) * scale_x))
    bottom = min(height, int((max_y + pad_y) * scale_y))
    if right - left < 8 or bottom - top < 8:
        return None
    return Box(left, top, right, bottom)


def crop(gray: np.ndarray, box: Box) -> np.ndarray:
    return gray[box.top:box.bottom, box.left:box.right]


def candidates(gray: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """候选输入：原图优先，然后是亮区、暗区；去重后返回。"""
    result: list[tuple[str, np.ndarray]] = [("original", gray)]
    for name, bright in (("bright", True), ("dark", False)):
        box = _large_region(gray, bright)
        if box is None:
            continue
        cropped = crop(gray, box)
        if cropped.shape == gray.shape:
            continue
        result.append((name, cropped))
    return result


def plausible_segments(segments, mask: np.ndarray, max_digits: int):
    """丢掉过窄/过矮的片段；高度按"片段之间"比较，避免背景把阈值抬高。"""
    if mask.ndim != 2 or mask.size == 0:
        return list(segments)
    width = mask.shape[1]

    measured = []
    for segment in segments:
        segment_width = segment.right - segment.left
        if segment_width < max(2, int(round(width * MIN_WIDTH_RATIO))):
            continue
        if segment_width > width * MAX_WIDTH_RATIO:
            continue
        cols = mask[:, segment.left:segment.right]
        rows_of_segment = np.nonzero(cols.any(axis=1))[0]
        if rows_of_segment.size == 0:
            continue
        segment_height = int(rows_of_segment.max()) - int(rows_of_segment.min()) + 1
        measured.append((segment, segment_height))
    if not measured:
        return []
    tallest = max(height for _, height in measured)
    kept = [segment for segment, height in measured if height >= tallest * MIN_HEIGHT_RATIO]
    return kept or [segment for segment, _ in measured]


def rank(candidate_segments, max_digits: int) -> float:
    """评分：优先片段数接近位数上限、并且不空。"""
    count = len(candidate_segments)
    if count == 0 or count > max_digits:
        return -1.0
    return 10.0 - abs(max_digits - count)


def best_segments(gray: np.ndarray, max_digits: int, segments_fn):
    "在多个候选上切分，返回评分最高的那组（保证不劣于原图）。"
    best = None
    for name, image in candidates(gray):
        try:
            segments, ink, mask = segments_fn(image)
        except ValueError:
            continue
        filtered = plausible_segments(segments, mask, max_digits)
        score = rank(filtered, max_digits)
        if best is None or score > best[0]:
            best = (score, name, image, filtered, ink, mask)
    if best is None:
        raise ValueError("BLANK_IMAGE")
    _, name, image, segments, ink, mask = best
    if not segments:
        # 过滤把片段清空了：退回原图未过滤的结果，保证不比改造前更差
        try:
            segments, ink, mask = segments_fn(gray)
            name = "original-unfiltered"
        except ValueError:
            raise ValueError("BLANK_IMAGE")
    return name, segments, ink, mask
