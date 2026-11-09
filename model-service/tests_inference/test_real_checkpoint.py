"""Explicit opt-in, real trusted checkpoint; no downloads or training.

HDR_TEST_CHECKPOINT=/absolute/path/checkpoint.pt python -I -m pytest -c pytest-inference.ini
Missing opt-in is skipped, not a successful real-weight validation.
"""
from io import BytesIO
import os
from pathlib import Path
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw
import pytest

from services.inference import InferenceService
from services.inference_manifest import BASELINE
from services.inference_preprocess import preprocess_image


@pytest.fixture(scope="module")
def loaded():
    path = os.environ.get("HDR_TEST_CHECKPOINT")
    if not path:
        pytest.skip("Set HDR_TEST_CHECKPOINT to explicitly run real trusted checkpoint tests")
    assert Path(path).is_absolute() and Path(path).is_file(), "Explicit checkpoint is missing/not absolute"
    # Explicit opt-in must fail (not skip) if torch is unavailable.
    import torch
    torch.set_num_threads(2)
    service = InferenceService(path)
    original = torch.load
    calls = []
    def checked_load(*args, **kwargs):
        calls.append(kwargs.copy())
        return original(*args, **kwargs)
    torch.load = checked_load
    try:
        service.ensure_ready()
    finally:
        torch.load = original
    return service, calls


def sample():
    image = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(image).line([(20, 20), (80, 20), (40, 80)], fill="black", width=8)
    stream = BytesIO()
    image.save(stream, format="PNG")
    return preprocess_image(stream.getvalue(), "image/png")


def test_real_manifest_hash_and_readiness(loaded):
    service, _ = loaded
    assert service.ensure_ready() == {"status": "UP", **BASELINE.identity(), "sha256": BASELINE.sha256}


def test_real_safe_loader_once_and_eval(loaded):
    service, calls = loaded
    assert len(calls) == 1 and calls[0] == {"map_location": "cpu", "weights_only": True}
    first_model = service._model
    service.ensure_ready()
    assert first_model is service._model and not first_model.training
    assert "torchvision" not in sys.modules


def test_real_prediction_is_finite_and_deterministic(loaded):
    service, _ = loaded
    normalized = sample()
    first = service.predict(normalized)
    assert first == service.predict(normalized)
    assert type(first[0]) is int and 0 <= first[0] <= 9
    assert np.isfinite(first[1]) and 0 <= first[1] <= 1
    assert all(parameter.grad is None for parameter in service._model.parameters())


def test_real_two_parallel_calls(loaded):
    service, _ = loaded
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(service.predict, [sample(), sample()]))
    assert results[0] == results[1]
