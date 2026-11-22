"""掩膜去噪：用形态学开运算去掉纸纹/污渍形成的小连通块（≈去斑）。

不改笔画主体：开运算核随图片尺寸缩放（照片越大核越大），只删掉比笔画细得多的
孤立小点，避免"整张纸纹理都被当成墨迹"导致外框被撑大、数字被缩小。
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageFilter


def enabled() -> bool:
    return os.getenv("HDR_PREPROCESS_DESPECKLE", "1") != "0"


def kernel_size(shape: tuple[int, int]) -> int:
    """按短边比例取奇数核：小图 3，大照片最多 9。"""
    size = int(min(shape) * 0.004)
    size = max(3, min(9, size))
    if size % 2 == 0:
        size += 1
    return size


def clean_mask(mask: np.ndarray, size: int | None = None) -> np.ndarray:
    """形态学开运算去小连通块；mask 为布尔数组。"""
    if not enabled() or mask is None or mask.ndim != 2 or not mask.any():
        return mask
    kernel = size or kernel_size(mask.shape)
    image = Image.fromarray((mask.astype(np.uint8) * 255))
    opened = image.filter(ImageFilter.MinFilter(kernel)).filter(ImageFilter.MaxFilter(kernel))
    cleaned = np.asarray(opened) > 127
    # 开运算偶尔会删掉很细的整字；这种情况回退到原掩膜
    if cleaned.sum() < max(8, int(mask.sum() * 0.02)):
        return mask
    return cleaned
