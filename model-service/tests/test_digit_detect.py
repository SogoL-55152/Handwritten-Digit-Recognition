"""门牌数字定位与切分过滤的单元测试。"""
import numpy as np
import pytest

from services.digit_detect import Box, best_segments, candidates, plausible_segments, rank
from services.multidigit import Segment


def plate(width=200, height=120, box=(60, 30, 140, 90), dark=20, bright=240):
    """深色背景上的一块亮招牌。"""
    image = np.full((height, width), dark, dtype=np.uint8)
    left, top, right, bottom = box
    image[top:bottom, left:right] = bright
    return image


def test_large_region_crops_the_bright_plate():
    gray = plate()
    found = candidates(gray)
    names = [name for name, _ in found]
    assert "bright" in names
    cropped = dict(found)["bright"]
    assert cropped.shape[0] < gray.shape[0] and cropped.shape[1] < gray.shape[1]
    assert cropped.size > 0


def test_uniform_image_yields_no_extra_candidates():
    gray = np.full((60, 60), 128, dtype=np.uint8)
    names = [name for name, _ in candidates(gray)]
    assert names == ["original"]


def test_plausible_segments_drops_short_noise():
    mask = np.zeros((40, 100), dtype=bool)
    mask[5:35, 10:20] = True    # 正常高度
    mask[5:35, 30:40] = True    # 正常高度
    mask[35:37, 60:62] = True   # 噪声：只有 2 像素高
    segments = [Segment(10, 20), Segment(30, 40), Segment(60, 62)]
    kept = plausible_segments(segments, mask, 4)
    assert [item.left for item in kept] == [10, 30]


def test_plausible_segments_keeps_when_everything_is_flat():
    mask = np.zeros((10, 60), dtype=bool)
    mask[2:8, 10:20] = True
    mask[2:8, 30:40] = True
    kept = plausible_segments([Segment(10, 20), Segment(30, 40)], mask, 4)
    assert len(kept) == 2


def test_rank_prefers_more_segments_but_penalises_overflow():
    assert rank([], 3) == -1
    assert rank([1, 2, 3], 3) > rank([1, 2], 3)
    assert rank([1, 2, 3, 4], 3) == -1


def test_best_segments_falls_back_to_original_unfiltered():
    gray = plate()
    original_segments = [Segment(70, 80), Segment(90, 100)]

    def segments_fn(image):
        mask = np.zeros((image.shape[0], image.shape[1]), dtype=bool)
        # 只给一个 1 像素的"片段"，过滤会把它全部丢掉
        mask[10:11, 10:11] = True
        return [Segment(10, 11)], np.zeros_like(image), mask

    name, segments, _, _ = best_segments(gray, 3, segments_fn)
    assert name in ("original-unfiltered", "bright", "dark", "original")
    assert segments, "至少要返回原始片段，不能返回空"


def test_best_segments_rejects_blank_input():
    gray = np.zeros((40, 40), dtype=np.uint8)

    def segments_fn(image):
        raise ValueError("BLANK_IMAGE")

    with pytest.raises(ValueError):
        best_segments(gray, 3, segments_fn)


def test_box_width_and_height():
    box = Box(10, 20, 40, 60)
    assert box.width == 30 and box.height == 40
