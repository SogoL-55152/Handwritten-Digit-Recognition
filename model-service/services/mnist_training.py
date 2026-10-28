"""离线 MNIST 训练；不依赖 app/config、Flask、Redis 或任务注册表。"""

import json
import os
import platform
import random
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from models.cnn import ARCHITECTURE, DigitCNN


def resolve_device(requested):
    device = torch.device(requested)
    if device.type == "cuda":
        if not torch.cuda.is_available():
            raise ValueError("CUDA 不可用；CPU 环境请使用 --device cpu（默认）。")
        index = device.index if device.index is not None else torch.cuda.current_device()
        if index >= torch.cuda.device_count():
            raise ValueError(f"CUDA 设备索引 {index} 不存在。")
        return torch.device("cuda", index)
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise ValueError("MPS 不可用；请使用 --device cpu。")
    return device


def seed_worker(_worker_id):
    # DataLoader 已为 torch 设置 worker seed；同步 numpy/random。
    worker_seed = torch.initial_seed() % (2**32)
    np.random.seed(worker_seed)
    random.seed(worker_seed)


def configure_runtime(config):
    # CUDA 的确定性 matmul 需要在创建 CUDA context 之前设置。
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    if config.threads is not None:
        torch.set_num_threads(config.threads)
    random.seed(config.seed)
    np.random.seed(config.seed)
    torch.manual_seed(config.seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    return resolve_device(config.device)


def train_epoch(model, loader, optimizer, device):
    model.train()
    criterion = nn.CrossEntropyLoss()
    total_loss = 0.0
    total = 0
    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)
        optimizer.zero_grad(set_to_none=True)
        logits = model(images)
        loss = criterion(logits, labels)
        loss.backward()
        optimizer.step()
        total_loss += loss.item() * labels.size(0)
        total += labels.size(0)
    if total == 0:
        raise ValueError("训练集为空。")
    return total_loss / total


@torch.inference_mode()
def evaluate(model, loader, device):
    model.eval()
    criterion = nn.CrossEntropyLoss(reduction="sum")
    total_loss = 0.0
    correct = 0
    total = 0
    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)
        logits = model(images)
        total_loss += criterion(logits, labels).item()
        correct += (logits.argmax(dim=1) == labels).sum().item()
        total += labels.size(0)
    if total == 0:
        raise ValueError("测试集为空。")
    return {"test_loss": total_loss / total, "test_accuracy": correct / total}


def save_checkpoint(path, model, config, final_epoch):
    # 仅保存参数 tensor + 基础类型元数据，不 pickle 整个 nn.Module。
    torch.save(
        {
            "format_version": 1,
            "architecture": ARCHITECTURE,
            "config": config.as_dict(),
            "epoch": final_epoch,
            "checkpoint_selection": "final_epoch",
            "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
        },
        path,
    )


def load_checkpoint(path, device="cpu"):
    # 仅重载本工具产生的可信权重，绝不回退到 weights_only=False。
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("format_version") != 1 or checkpoint.get("architecture") != ARCHITECTURE:
        raise ValueError("checkpoint 格式或 DigitCNN 架构不匹配。")
    model = DigitCNN()
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.to(device).eval()
    return model, checkpoint


@torch.inference_mode()
def verify_checkpoint(path, model, images, device):
    model.eval()
    reloaded, _ = load_checkpoint(path, device)
    images = images.to(device)
    if not torch.equal(model(images), reloaded(images)):
        raise RuntimeError("最终 checkpoint 重载后的输出不一致，不能视为成功训练。")


def run_training(config):
    # torchvision 也延迟导入：CNN/保存重载单测只需要 torch。
    import torchvision

    from services.mnist_data import load_mnist

    started = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    output = Path(config.output_dir)
    checkpoint_path = output / "checkpoint.pt"
    metrics_path = output / "metrics.json"
    if checkpoint_path.exists() or metrics_path.exists():
        raise ValueError(f"{output} 已有训练产物；请换一个 --output-dir，避免覆盖或混合结果。")
    device = configure_runtime(config)
    train, test, data_info = load_mnist(config)
    # 在开始耗时训练前确认输出目录可写。
    output.mkdir(parents=True, exist_ok=True)
    probe = output / ".write-check"
    with probe.open("x", encoding="utf-8"):
        pass
    probe.unlink()

    train_loader = DataLoader(
        train,
        batch_size=config.batch_size,
        shuffle=True,
        num_workers=config.num_workers,
        worker_init_fn=seed_worker,
        generator=torch.Generator().manual_seed(config.seed),
    )
    test_loader = DataLoader(
        test,
        batch_size=config.batch_size,
        shuffle=False,
        num_workers=config.num_workers,
        worker_init_fn=seed_worker,
        generator=torch.Generator().manual_seed(config.seed),
    )
    model = DigitCNN().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    print(
        f"MNIST {data_info['scope']}: train={len(train)}, test={len(test)}, "
        f"device={device}, seed={config.seed}, threads={torch.get_num_threads()}",
        flush=True,
    )
    history = []
    for epoch in range(1, config.epochs + 1):
        epoch_started = time.perf_counter()
        train_loss = train_epoch(model, train_loader, optimizer, device)
        scores = evaluate(model, test_loader, device)
        record = {
            "epoch": epoch,
            "train_loss": train_loss,
            **scores,
            "duration_seconds": time.perf_counter() - epoch_started,
        }
        history.append(record)
        print(
            f"epoch {epoch}/{config.epochs}: loss={train_loss:.6f}, "
            f"test_accuracy={scores['test_accuracy']:.4%}",
            flush=True,
        )
    # 测试集仅用于报告；不早停、不搜索、不按 test accuracy 选择权重。
    save_checkpoint(checkpoint_path, model, config, config.epochs)
    images, _ = next(iter(test_loader))
    verify_checkpoint(checkpoint_path, model, images, device)
    metrics = {
        "format_version": 1,
        "architecture": ARCHITECTURE,
        "config": config.as_dict(),
        "optimizer": "Adam",
        "loss": "CrossEntropyLoss",
        "data": data_info,
        "device": str(device),
        "seed": config.seed,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "torch": str(torch.__version__),
            "torchvision": str(torchvision.__version__),
            "numpy": np.__version__,
            "cuda_runtime": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "device_name": torch.cuda.get_device_name(device) if device.type == "cuda" else platform.processor(),
            "torch_threads": torch.get_num_threads(),
            "torch_interop_threads": torch.get_num_interop_threads(),
            "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        },
        "started_at_utc": started_at,
        "finished_at_utc": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": time.perf_counter() - started,
        "epochs": history,
        "accuracy_unit": "fraction (0 to 1)",
        "checkpoint": checkpoint_path.name,
        "checkpoint_selection": "final_epoch",
        "checkpoint_reload_verified": True,
    }
    # 不输出 NaN/Inf 伪指标；写完再替换，避免中断产生半份 JSON。
    temporary_metrics = metrics_path.with_suffix(".json.tmp")
    temporary_metrics.write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary_metrics.replace(metrics_path)
    return metrics
