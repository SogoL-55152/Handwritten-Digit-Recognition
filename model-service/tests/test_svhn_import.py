"""SVHN 导入脚本的单元测试：裁剪与单段校验。"""
import io

import numpy as np
from PIL import Image

from tools.svhn_import import crop_box, digit_crop, segment_count


def canvas(width=200, height=80, ink_boxes=((45, 25, 55, 55),)):
    """白底黑字；墨迹块比裁剪框小，保证裁图里有背景。"""
    image = np.full((height, width), 255, dtype=np.uint8)
    for left, top, right, bottom in ink_boxes:
        image[top:bottom, left:right] = 0
    return image


def test_crop_box_clamps_to_image():
    image = canvas()
    crop = crop_box(image, (-5, -5, 30, 30), 0.1)
    assert crop is not None
    assert crop.shape[0] > 0 and crop.shape[1] > 0


def test_single_digit_crop_passes_the_gate():
    image = canvas()
    png, reason = digit_crop(image, (40, 20, 60, 60), 0.0)
    assert reason is None
    assert png and png[:8] == b'\x89PNG\r\n\x1a\n'


def test_two_digits_in_one_crop_are_rejected():
    # 两个墨迹块相邻：加大边距后裁图里会出现两段
    image = canvas(ink_boxes=((45, 25, 55, 55), (62, 25, 72, 55)))
    png, reason = digit_crop(image, (40, 20, 75, 60), 0.0)
    assert png is None
    assert reason in ('multiSegment', 'tooSmall')


def test_tiny_crop_is_rejected():
    image = canvas()
    png, reason = digit_crop(image, (40, 20, 43, 23), 0.0)
    assert png is None
    assert reason == 'tooSmall'


def test_blank_crop_is_rejected():
    image = np.full((40, 40), 255, dtype=np.uint8)
    png, reason = digit_crop(image, (5, 5, 35, 35), 0.0)
    assert png is None
    assert reason in ('multiSegment', 'empty')


def test_segment_count_handles_blank_canvas():
    blank = np.full((30, 30), 255, dtype=np.uint8)
    assert segment_count(blank) == 0


def test_png_bytes_are_readable_by_pillow():
    image = canvas()
    png, reason = digit_crop(image, (40, 20, 60, 60), 0.0)
    assert reason is None
    opened = Image.open(io.BytesIO(png))
    assert opened.size == (20, 40)
