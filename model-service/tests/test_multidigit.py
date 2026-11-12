"""多位数字切分：黄金用例（合成图）验证切分与归一化口径。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from services.multidigit import (MAX_DIGITS, Segment, normalize_segment, segment_mask,
                                 segments_of, top_guesses)


def draw_string(count: int, width: int = 640, height: int = 320, gap: int = 50) -> tuple[np.ndarray, int]:
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    cell = (width - gap * (count - 1)) // count
    for index in range(count):
        left = index * (cell + gap) + 20
        draw.line([(left + 10, 60), (left - 5, 160), (left + 5, 260)], fill=17, width=18)
    return np.asarray(image, dtype=np.uint8), cell


def test_single_digit_yields_one_segment():
    gray, _ = draw_string(1)
    segments, _, mask = segments_of(gray)
    assert len(segments) == 1
    assert mask.any()


def test_three_digits_yield_three_segments_in_order():
    gray, _ = draw_string(3)
    segments, ink, mask = segments_of(gray)
    assert len(segments) == 3
    assert segments == sorted(segments, key=lambda item: item.left)
    for segment in segments:
        normalized = normalize_segment(mask, ink, segment)
        assert normalized is not None
        assert normalized.shape == (1, 28, 28)
        assert np.isfinite(normalized).all()


def test_two_digits_written_touching_still_split_or_keep_one_segment():
    """写得太近时宁可少切，也不要把一个数字切成两半。"""
    gray, _ = draw_string(2, gap=2)
    segments, _, _ = segments_of(gray)
    assert 1 <= len(segments) <= 2


def test_blank_image_is_rejected():
    blank = np.full((200, 200), 255, dtype=np.uint8)
    try:
        segments_of(blank)
    except ValueError as error:
        assert str(error) == "BLANK_IMAGE"
    else:
        raise AssertionError("空白图应当被拒绝")


def test_segment_width_floor_filters_noise():
    mask = np.zeros((100, 200), dtype=bool)
    mask[10:40, 10:40] = True      # 宽 30 的主体
    mask[10:40, 45:46] = True      # 宽 1 的噪点
    segments = segment_mask(mask, min_gap_ratio=0.01)
    assert all(item.right - item.left >= 2 for item in segments)


def test_top_guesses_reports_margin():
    probabilities = [0.0, 0.0, 0.1, 0.6, 0.3] + [0.0] * 5
    digit, confidence, margin = top_guesses(probabilities)
    assert digit == 3
    assert abs(confidence - 0.6) < 1e-9
    assert abs(margin - 0.3) < 1e-9


def test_max_digits_contract():
    assert MAX_DIGITS == 4
    assert normalize_segment(np.zeros((10, 10), dtype=bool), np.zeros((10, 10), dtype=np.uint8),
                             Segment(0, 5)) is None
