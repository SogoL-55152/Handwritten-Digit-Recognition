"""train_canvas_aug 的配方/几何校验：不加载 torch，不训练，不读真实数据。"""
import numpy as np
import pytest
from PIL import Image

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from train_canvas_aug import CanvasAugConfig, canvas_style, production_geometry, read_idx, read_labels


def test_config_rejects_out_of_range_values():
    for kwargs in ({'epochs': 0}, {'epochs': 21}, {'samples': 10}, {'samples': 60001},
                   {'batch': 50}, {'learning_rate': 0.0}, {'learning_rate': 0.5},
                   {'seed': -1}, {'seed': 2**32}):
        with pytest.raises(ValueError):
            CanvasAugConfig(**kwargs)


def test_config_accepts_documented_recipe():
    config = CanvasAugConfig(epochs=3, samples=48000, batch=64, learning_rate=0.001, seed=20261107)
    assert (config.epochs, config.samples, config.batch) == (3, 48000, 64)


def test_production_geometry_matches_model_input_contract():
    image = Image.new('L', (280, 280), 0)
    image.paste(Image.new('L', (60, 200), 255), (110, 40))  # 一条竖笔画，模拟墨迹
    prepared = production_geometry(image)
    assert prepared is not None
    assert prepared.shape == (28, 28)
    assert prepared.dtype == np.float32
    assert np.isfinite(prepared).all()


def test_production_geometry_returns_none_for_blank_input():
    assert production_geometry(Image.new('L', (280, 280), 0)) is None


def test_canvas_style_is_deterministic_per_seed():
    digit = np.zeros((28, 28), dtype=np.uint8)
    digit[4:24, 10:18] = 255
    first = np.asarray(canvas_style(digit, np.random.default_rng(7)))
    second = np.asarray(canvas_style(digit, np.random.default_rng(7)))
    assert np.array_equal(first, second)
    assert first.shape in {(280, 280), (320, 320), (360, 360)}


def test_idx_readers_reject_foreign_files(tmp_path):
    bad = tmp_path / 'bad'
    bad.write_bytes(b'\x00\x00\x00\x00' + b'\x00' * 32)
    with pytest.raises(ValueError):
        read_idx(bad)
    with pytest.raises(ValueError):
        read_labels(bad)
