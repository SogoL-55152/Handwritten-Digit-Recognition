"""训练流水线：MNIST + CNN，逐 epoch 上报指标并保存权重。"""
import logging

from config import Config
from services.model_registry import registry
from services.task_store import task_store

logger = logging.getLogger(__name__)


def _evaluate(network, loader, device, torch):
    network.eval()
    correct = 0
    total = 0
    with torch.no_grad():
        for images, labels in loader:
            images, labels = images.to(device), labels.to(device)
            predictions = network(images).argmax(dim=1)
            correct += (predictions == labels).sum().item()
            total += labels.size(0)
    return correct / max(total, 1)


def train_task(task_id: str, params: dict) -> dict:
    """执行训练。params 由 API 层标准化，包含 epochs/batchSize/learningRate/modelName。"""
    task_store.update_task(task_id, status="RUNNING", progress=0, metrics=[], error=None)
    try:
        import torch
        from torch import nn, optim
        from torch.utils.data import DataLoader
        from torchvision import datasets, transforms

        from models.cnn import DigitCNN

        epochs = int(params.get("epochs", 3))
        batch_size = int(params.get("batchSize", 128))
        learning_rate = float(params.get("learningRate", 0.001))
        model_name = params.get("modelName") or Config.DEFAULT_MODEL_NAME

        transform = transforms.Compose([
            transforms.RandomRotation(10),
            transforms.RandomAffine(degrees=0, translate=(0.1, 0.1), scale=(0.9, 1.1)),
            transforms.ToTensor(),
            transforms.Normalize((0.1307,), (0.3081,)),
        ])
        plain_transform = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize((0.1307,), (0.3081,)),
        ])

        data_dir = Config.DATA_DIR / "mnist"
        train_set = datasets.MNIST(str(data_dir), train=True, download=True, transform=transform)
        test_set = datasets.MNIST(str(data_dir), train=False, download=True, transform=plain_transform)

        train_loader = DataLoader(train_set, batch_size=batch_size, shuffle=True, num_workers=0)
        test_loader = DataLoader(test_set, batch_size=512, shuffle=False, num_workers=0)

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        network = DigitCNN().to(device)
        criterion = nn.CrossEntropyLoss()
        optimizer = optim.Adam(network.parameters(), lr=learning_rate)

        metrics = []
        for epoch in range(epochs):
            network.train()
            total_loss = 0.0
            seen = 0
            for images, labels in train_loader:
                images, labels = images.to(device), labels.to(device)
                optimizer.zero_grad()
                outputs = network(images)
                loss = criterion(outputs, labels)
                loss.backward()
                optimizer.step()
                total_loss += loss.item() * labels.size(0)
                seen += labels.size(0)

            train_loss = total_loss / max(seen, 1)
            test_accuracy = _evaluate(network, test_loader, device, torch)
            metrics.append({
                "epoch": epoch + 1,
                "loss": round(train_loss, 4),
                "accuracy": round(test_accuracy, 4),
            })
            progress = min(99, int((epoch + 1) / epochs * 100))
            task_store.update_task(
                task_id,
                status="RUNNING",
                progress=progress,
                epoch=epoch + 1,
                metrics=metrics,
            )
            logger.info("Task %s epoch %d/%d loss=%.4f acc=%.4f",
                        task_id, epoch + 1, epochs, train_loss, test_accuracy)

        weights_path = Config.WEIGHTS_DIR / f"{task_id}.pt"
        torch.save(network.state_dict(), weights_path)
        model = registry.register(model_name, weights_path, metrics[-1]["accuracy"])
        task_store.update_task(
            task_id,
            status="SUCCESS",
            progress=100,
            epoch=epochs,
            metrics=metrics,
            model=model,
        )
        return model

    except Exception as exc:
        logger.exception("Training task %s failed", task_id)
        task_store.update_task(task_id, status="FAILED", error=str(exc))
        raise
