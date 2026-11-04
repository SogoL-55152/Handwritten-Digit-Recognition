"""No torch dependency: hash gate, immutability and module import safety."""
from dataclasses import FrozenInstanceError
from pathlib import Path
import subprocess
import sys

import pytest

from services.inference import InferenceService, ModelUnavailable
from services.inference_manifest import BASELINE

SOURCE_ROOT = Path(__file__).resolve().parents[1]


def test_manifest_is_frozen_and_identity_copies_do_not_mutate():
    with pytest.raises(FrozenInstanceError):
        BASELINE.sha256 = "bad"
    identity = BASELINE.identity()
    identity["modelId"] = "attacker"
    assert BASELINE.model_id == "mnist-cnn-w1"
    assert BASELINE.architecture()["input_shape"] == [1, 28, 28]
    assert BASELINE.checkpoint_bytes == 1689984


def test_missing_weights_not_ready(tmp_path):
    service = InferenceService(tmp_path / "missing.pt")
    with pytest.raises(ModelUnavailable):
        service.ensure_ready()
    assert service._model is None


@pytest.mark.parametrize("size", [0, 50, BASELINE.checkpoint_bytes, BASELINE.checkpoint_bytes + 1])
def test_bad_checkpoint_fails_closed_before_torch_import(tmp_path, size, monkeypatch):
    path = tmp_path / "wrong.pt"
    path.write_bytes(b"x" * size)
    monkeypatch.setitem(sys.modules, "torch", None)
    service = InferenceService(path)
    with pytest.raises(ModelUnavailable):
        service.ensure_ready()
    assert service._model is None


def test_failure_is_cached_without_unbounded_disk_retry(tmp_path, monkeypatch):
    service = InferenceService(tmp_path / "missing.pt")
    with pytest.raises(ModelUnavailable):
        service.ensure_ready()
    def forbidden_open(*args, **kwargs):
        raise AssertionError("should not retry loading before restart")
    monkeypatch.setattr(Path, "open", forbidden_open)
    with pytest.raises(ModelUnavailable):
        service.ensure_ready()


def test_service_import_does_not_require_torch_or_torchvision():
    script = """
import sys
sys.path.insert(0, sys.argv[1])
class NoTorch:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('torch', 'torchvision'):
            raise AssertionError('Unexpected heavyweight import: ' + fullname)
sys.meta_path.insert(0, NoTorch())
from services.inference import InferenceService
from services.inference_preprocess import preprocess_image
assert 'torch' not in sys.modules
assert 'torchvision' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE_ROOT)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
