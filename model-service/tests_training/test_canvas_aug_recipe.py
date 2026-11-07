"""train_canvas_aug 的配方/渲染校验：不加载 torch，不训练，不读真实数据。"""
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.inference_preprocess import InvalidImage, canvas_input
from train_canvas_aug import (CanvasAugConfig, canvas_style, photo_style, read_idx, read_labels)


def test_config_rejects_out_of_range_values():
    for kwargs in ({'epochs': 0}, {'epochs': 21}, {'samples': 10}, {'samples': 200001},
                   {'batch': 50}, {'learning_rate': 0.0}, {'learning_rate': 0.5},
                   {'seed': -1}, {'seed': 2**32}, {'photo_ratio': -0.1}, {'photo_ratio': 1.1}):
        with pytest.raises(ValueError):
            CanvasAugConfig(**kwargs)


def test_config_accepts_documented_recipe():
    config = CanvasAugConfig(epochs=3, samples=60000, batch=64, learning_rate=0.001,
                             seed=20261107, photo_ratio=0.5)
    assert (config.epochs, config.samples, config.batch) == (3, 60000, 64)
    assert config.photo_ratio == 0.5


def digit():
    image = np.zeros((28, 28), dtype=np.uint8)
    image[4:24, 10:18] = 255
    return image


def test_canvas_style_is_deterministic_per_seed():
    first = canvas_style(digit(), np.random.default_rng(7))
    second = canvas_style(digit(), np.random.default_rng(7))
    assert np.array_equal(first, second)
    assert first.shape[0] == first.shape[1] and first.shape[0] in (280, 320, 360)


def test_photo_style_produces_paper_levels_and_darker_ink():
    rendered = photo_style(digit(), np.random.default_rng(11))
    assert rendered.dtype == np.uint8
    assert rendered.shape[0] == rendered.shape[1]
    # 纸面是多数像素，笔迹显著更暗。
    assert float(np.median(rendered)) > float(rendered.min()) + 10


def test_canvas_input_matches_model_contract():
    prepared = canvas_input(canvas_style(digit(), np.random.default_rng(3)))
    assert prepared.shape == (1, 28, 28) and prepared.dtype == np.float32
    assert np.isfinite(prepared).all()


def test_canvas_input_rejects_blank():
    with pytest.raises(InvalidImage) as caught:
        canvas_input(np.full((60, 60), 200, dtype=np.uint8))
    assert caught.value.category == 'BLANK_IMAGE'


def test_idx_readers_reject_foreign_files(tmp_path):
    bad = tmp_path / 'bad'
    bad.write_bytes(b'\x00\x00\x00\x00' + b'\x00' * 32)
    with pytest.raises(ValueError):
        read_idx(bad)
    with pytest.raises(ValueError):
        read_labels(bad)


def test_emnist_reader_rejects_missing_archive(tmp_path):
    from train_canvas_aug import read_emnist_digits
    with pytest.raises(Exception):
        read_emnist_digits(tmp_path / 'missing.zip', 'train', 10)
