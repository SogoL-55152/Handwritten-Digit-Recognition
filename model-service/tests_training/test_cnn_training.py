"""合成 tensor 只用于单测，不是 MNIST 训练/准确率证据。"""

import json

import pytest


torch = pytest.importorskip("torch")
pytest.importorskip("numpy")

from torch.utils.data import DataLoader, TensorDataset

from models.cnn import ARCHITECTURE, DigitCNN
from services.mnist_training import evaluate, load_checkpoint, save_checkpoint, train_epoch, verify_checkpoint
from services.training_config import parse_args


@pytest.fixture(autouse=True, scope="module")
def cpu_threads():
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    yield
    torch.set_num_threads(previous)


def test_shape_and_backpropagation():
    torch.manual_seed(42)
    model = DigitCNN()
    images = torch.randn(4, 1, 28, 28)
    logits = model(images)
    assert logits.shape == (4, 10)
    loss = torch.nn.functional.cross_entropy(logits, torch.tensor([0, 1, 2, 3]))
    loss.backward()
    assert torch.isfinite(loss)
    assert all(parameter.grad is not None for parameter in model.parameters())
    assert all(torch.isfinite(parameter.grad).all() for parameter in model.parameters())
    assert model.features[0].weight.grad.abs().sum() > 0
    assert model.classifier[3].p == 0.3


def test_checkpoint_weights_only_reload_is_identical(tmp_path, monkeypatch):
    torch.manual_seed(7)
    model = DigitCNN().eval()
    config = parse_args(["--output-dir", str(tmp_path), "--epochs", "2"])
    path = tmp_path / "checkpoint.pt"
    images = torch.randn(3, 1, 28, 28)
    save_checkpoint(path, model, config, final_epoch=2)
    actual_load = torch.load
    load_options = []

    def checked_load(*args, **kwargs):
        load_options.append(kwargs)
        return actual_load(*args, **kwargs)

    monkeypatch.setattr(torch, "load", checked_load)
    reloaded, checkpoint = load_checkpoint(path)
    with torch.inference_mode():
        torch.testing.assert_close(model(images), reloaded(images), rtol=0, atol=0)
    verify_checkpoint(path, model, images, torch.device("cpu"))
    assert all(options["weights_only"] is True for options in load_options)
    assert checkpoint["architecture"] == ARCHITECTURE
    assert checkpoint["config"] == config.as_dict()
    assert checkpoint["epoch"] == 2
    assert checkpoint["checkpoint_selection"] == "final_epoch"
    assert set(checkpoint["state_dict"]) == set(model.state_dict())


def test_train_step_updates_weights_and_evaluation_uses_all_samples():
    torch.manual_seed(3)
    model = DigitCNN()
    dataset = TensorDataset(torch.randn(5, 1, 28, 28), torch.tensor([0, 1, 2, 3, 4]))
    loader = DataLoader(dataset, batch_size=3)  # 最后一批不足 batch size。
    before = model.features[0].weight.detach().clone()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    loss = train_epoch(model, loader, optimizer, torch.device("cpu"))
    assert loss > 0
    assert not torch.equal(before, model.features[0].weight)
    metrics = evaluate(model, loader, torch.device("cpu"))
    assert not model.training
    with torch.inference_mode():
        logits = model(dataset.tensors[0])
        expected_loss = torch.nn.functional.cross_entropy(logits, dataset.tensors[1]).item()
        expected_accuracy = (logits.argmax(1) == dataset.tensors[1]).sum().item() / 5
    assert metrics["test_loss"] == pytest.approx(expected_loss, abs=1e-6)
    assert metrics["test_accuracy"] == expected_accuracy


def test_run_saves_final_epoch_even_when_test_accuracy_decreases(tmp_path, monkeypatch):
    pytest.importorskip("torchvision")
    from services import mnist_data, mnist_training

    dataset = TensorDataset(torch.zeros(4, 1, 28, 28), torch.tensor([0, 1, 2, 3]))
    monkeypatch.setattr(mnist_data, "load_mnist", lambda config: (dataset, dataset, {
        "name": "synthetic-unit-test-only", "scope": "subset/smoke", "subset": True,
        "train_size": 4, "test_size": 4,
    }))
    scores = iter([1.0, 0.0])
    monkeypatch.setattr(mnist_training, "evaluate", lambda *args: {
        "test_loss": 1.0, "test_accuracy": next(scores),
    })
    config = parse_args([
        "--output-dir", str(tmp_path), "--epochs", "2", "--threads", "1",
        "--batch-size", "3", "--train-limit", "4", "--test-limit", "4",
    ])
    metrics = mnist_training.run_training(config)
    stored = json.loads((tmp_path / "metrics.json").read_text(encoding="utf-8"))
    assert metrics == stored
    assert [row["test_accuracy"] for row in stored["epochs"]] == [1.0, 0.0]
    assert stored["checkpoint_selection"] == "final_epoch"
    assert stored["checkpoint_reload_verified"] is True
    assert stored["data"]["subset"] is True
    assert stored["device"] == "cpu"
    assert stored["seed"] == config.seed
    assert stored["duration_seconds"] > 0
    assert {"python", "torch", "torchvision", "numpy", "torch_threads"} <= stored["environment"].keys()
    _, checkpoint = load_checkpoint(tmp_path / "checkpoint.pt")
    assert checkpoint["epoch"] == 2
    with pytest.raises(ValueError, match="output-dir"):
        mnist_training.run_training(config)


def test_unavailable_cuda_gives_cpu_guidance(monkeypatch):
    from services.mnist_training import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(ValueError, match="cpu"):
        resolve_device("cuda")
