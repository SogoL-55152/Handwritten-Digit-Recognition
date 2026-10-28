"""MNIST 原始 IDX 数据入口；不读取旧版 processed/*.pt pickle 缓存。"""

from pathlib import Path

from torch.utils.data import Subset
from torchvision import datasets, transforms


NORMALIZATION = {"mean": [0.1307], "std": [0.3081]}


class RawMNIST(datasets.MNIST):
    @property
    def raw_folder(self):
        # torchvision 默认使用类名作为目录；子类仍兼容标准 MNIST/raw 布局。
        return str(Path(self.root) / "MNIST" / "raw")

    def _check_legacy_exist(self):
        # torchvision 0.20.1 的旧缓存分支使用非 weights-only torch.load。
        # 不允许进入该分支；保留官方下载的 MD5 校验及原始 IDX 解析。
        return False


def limit_dataset(dataset, limit, name):
    if limit is None:
        return dataset
    if limit > len(dataset):
        raise ValueError(f"{name}-limit={limit} 超过 {name} 集大小 {len(dataset)}")
    return Subset(dataset, range(limit))


def load_mnist(config):
    transform = transforms.Compose(
        [transforms.ToTensor(), transforms.Normalize(**NORMALIZATION)]
    )
    try:
        train_full = RawMNIST(config.data_dir, train=True, download=config.download, transform=transform)
        test_full = RawMNIST(config.data_dir, train=False, download=config.download, transform=transform)
    except (OSError, RuntimeError, ValueError, AssertionError, KeyError, IndexError) as exc:
        raise RuntimeError(
            f"无法读取 MNIST：{config.data_dir / 'MNIST' / 'raw'}。"
            "请准备 torchvision 标准的原始 IDX 文件，或使用 --download 显式下载；"
            "仅有 processed/*.pt 旧缓存不受支持。"
            f"原始错误：{exc}"
        ) from exc
    train = limit_dataset(train_full, config.train_limit, "train")
    test = limit_dataset(test_full, config.test_limit, "test")
    subset = config.train_limit is not None or config.test_limit is not None
    metadata = {
        "name": "MNIST",
        "format": "raw IDX (torchvision; legacy pickle cache disabled)",
        "split": "official train/test",
        "train_size": len(train),
        "test_size": len(test),
        "full_train_size": len(train_full),
        "full_test_size": len(test_full),
        "subset": subset,
        "scope": "subset/smoke" if subset else "full",
        "subset_selection": "first N from each official split" if subset else None,
        "normalization": NORMALIZATION,
    }
    return train, test, metadata
