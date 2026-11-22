"""早停相关：参数校验与训练脚本签名。"""
import inspect

import pytest

from api.internal_v2 import _validate_training_params
from train_canvas_aug import run


def params(**overrides):
    base = {
        "epochs": 1, "samples": 1000, "batchSize": 64, "learningRate": 0.001, "seed": 7,
        "photoRatio": 0.5, "useEmnist": False, "initFrom": None, "datasetVersionId": None,
        "dataDir": None, "earlyStop": False, "patience": 3,
        "trainFrom": "all", "trainableLayers": ["conv1", "conv2", "fc1", "fc2"],
        "aug": {"rotate": 0.3, "scale": 0, "brightness": 0, "blur": 0, "mosaic": 0},
    }
    base.update(overrides)
    return base


def test_early_stop_fields_are_accepted():
    assert _validate_training_params(params()) is None
    assert _validate_training_params(params(earlyStop=True, patience=5)) is None


def test_early_stop_validation_rejects_bad_values():
    assert "earlyStop" in _validate_training_params(params(earlyStop="yes"))
    assert "patience" in _validate_training_params(params(patience=0))
    assert "patience" in _validate_training_params(params(patience=11))
    assert "patience" in _validate_training_params(params(patience=True))


def test_run_accepts_early_stop_arguments():
    signature = inspect.signature(run)
    assert "early_stop" in signature.parameters
    assert "patience" in signature.parameters
    assert signature.parameters["early_stop"].default is False
    assert signature.parameters["patience"].default == 3
