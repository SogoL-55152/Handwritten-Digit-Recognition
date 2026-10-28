"""本文件构造的 IDX 仅是单测夹具，不下载也不声称是真实 MNIST 结果。"""

import struct

import pytest


torch = pytest.importorskip("torch")


@pytest.fixture
def data_module():
    pytest.importorskip("torchvision")
    from services import mnist_data
    return mnist_data


def write_synthetic_idx(root):
    raw = root / "MNIST" / "raw"
    raw.mkdir(parents=True)
    for prefix, count in [("train", 4), ("t10k", 2)]:
        (raw / f"{prefix}-images-idx3-ubyte").write_bytes(
            struct.pack(">IIII", 2051, count, 28, 28) + bytes(count * 28 * 28)
        )
        (raw / f"{prefix}-labels-idx1-ubyte").write_bytes(
            struct.pack(">II", 2049, count) + bytes(range(count))
        )


def test_raw_idx_loader_disables_legacy_pickle_and_marks_subset(tmp_path, monkeypatch, data_module):
    from services.training_config import parse_args

    write_synthetic_idx(tmp_path)
    # 标准类/子类路径均放不可读的旧缓存，任何 pickle 读取都会让测试失败。
    for name in ("MNIST", "RawMNIST"):
        processed = tmp_path / name / "processed"
        processed.mkdir(parents=True)
        for filename in ("training.pt", "test.pt"):
            (processed / filename).write_bytes(b"not a trusted pickle")

    def forbidden(*args, **kwargs):
        raise AssertionError("不得加载 pickle 或隐式下载")

    monkeypatch.setattr(torch, "load", forbidden)
    monkeypatch.setattr(data_module.RawMNIST, "download", forbidden)
    monkeypatch.setattr(data_module.RawMNIST, "_load_legacy_data", forbidden)
    config = parse_args(["--data-dir", str(tmp_path), "--train-limit", "3", "--test-limit", "1"])
    train, test, info = data_module.load_mnist(config)
    assert (len(train), len(test)) == (3, 1)
    assert (info["full_train_size"], info["full_test_size"]) == (4, 2)
    assert info["subset"] is True
    assert info["scope"] == "subset/smoke"
    images, label = train[0]
    assert images.shape == (1, 28, 28)
    assert images.dtype == torch.float32
    assert images.mean().item() == pytest.approx(-0.1307 / 0.3081, abs=1e-6)
    assert label == 0


def test_missing_data_does_not_download(tmp_path, monkeypatch, data_module):
    from services.training_config import parse_args

    def forbidden(*args, **kwargs):
        pytest.fail("download=False 不应发起下载")

    monkeypatch.setattr(data_module.RawMNIST, "download", forbidden)
    with pytest.raises(RuntimeError, match="--download"):
        data_module.load_mnist(parse_args(["--data-dir", str(tmp_path)]))


def test_download_is_explicit_and_uses_unmodified_torchvision_method(tmp_path, monkeypatch, data_module):
    from torchvision.datasets import MNIST
    from services.training_config import parse_args

    assert data_module.RawMNIST.download is MNIST.download
    assert data_module.RawMNIST.resources == MNIST.resources
    write_synthetic_idx(tmp_path)
    calls = []
    monkeypatch.setattr(data_module.RawMNIST, "download", lambda self: calls.append(self.train))
    data_module.load_mnist(parse_args(["--data-dir", str(tmp_path), "--download"]))
    assert calls == [True, False]


def test_missing_data_cli_returns_nonzero_without_traceback(tmp_path, capsys, data_module):
    from train_mnist import main

    result = main([
        "--data-dir", str(tmp_path / "missing"),
        "--output-dir", str(tmp_path / "output"), "--threads", "1",
    ])
    assert result == 1
    stderr = capsys.readouterr().err
    assert "--download" in stderr
    assert "Traceback" not in stderr
    assert not (tmp_path / "output" / "metrics.json").exists()


def test_full_split_and_oversized_limit(tmp_path, data_module):
    from services.training_config import parse_args

    write_synthetic_idx(tmp_path)
    train, test, info = data_module.load_mnist(parse_args(["--data-dir", str(tmp_path)]))
    assert (len(train), len(test)) == (4, 2)
    assert info["subset"] is False
    assert info["scope"] == "full"
    with pytest.raises(ValueError, match="train-limit"):
        data_module.load_mnist(parse_args(["--data-dir", str(tmp_path), "--train-limit", "5"]))
