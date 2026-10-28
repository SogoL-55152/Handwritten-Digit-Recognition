"""只依赖标准库的训练参数；--help 和参数校验不需要 PyTorch/Flask。"""

import argparse
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class TrainingConfig:
    data_dir: Path
    output_dir: Path
    download: bool = False
    epochs: int = 5
    batch_size: int = 64
    learning_rate: float = 0.001
    seed: int = 42
    device: str = "cpu"
    num_workers: int = 0
    threads: int | None = None
    train_limit: int | None = None
    test_limit: int | None = None

    def as_dict(self):
        config = asdict(self)
        config["data_dir"] = str(self.data_dir)
        config["output_dir"] = str(self.output_dir)
        return config


def positive_int(value):
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("必须是正整数") from exc
    if number <= 0:
        raise argparse.ArgumentTypeError("必须是正整数")
    return number


def nonnegative_int(value):
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("必须是非负整数") from exc
    if number < 0:
        raise argparse.ArgumentTypeError("必须是非负整数")
    return number


def seed_value(value):
    number = nonnegative_int(value)
    if number > 2**32 - 1:
        raise argparse.ArgumentTypeError("seed 必须在 0 到 4294967295 之间")
    return number


def positive_float(value):
    try:
        number = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("必须是有限的正数") from exc
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("必须是有限的正数")
    return number


def device_value(value):
    if value not in ("cpu", "mps", "cuda") and not re.fullmatch(r"cuda:[0-9]+", value):
        raise argparse.ArgumentTypeError("device 必须是 cpu、mps、cuda 或 cuda:N")
    return value


def resolve_path(value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else SERVICE_ROOT / path).resolve()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="W1 独立 MNIST/CNN 训练（不启动 Flask/Redis，不提供生产推理）。"
    )
    parser.add_argument("--data-dir", default="data", help="MNIST 根目录；相对 model-service/")
    parser.add_argument("--output-dir", default="weights/mnist-cnn", help="输出目录；相对 model-service/")
    parser.add_argument("--download", action="store_true", help="显式允许 torchvision 下载并校验 MNIST；默认不下载")
    parser.add_argument("--epochs", type=positive_int, default=5)
    parser.add_argument("--batch-size", type=positive_int, default=64)
    parser.add_argument("--learning-rate", type=positive_float, default=0.001)
    parser.add_argument("--seed", type=seed_value, default=42)
    parser.add_argument("--device", type=device_value, default="cpu")
    parser.add_argument("--num-workers", type=nonnegative_int, default=0, help="DataLoader worker 数；Windows 推荐 0")
    parser.add_argument("--threads", type=positive_int, help="限制 PyTorch CPU 计算线程数")
    parser.add_argument("--train-limit", type=positive_int, help="只用训练集前 N 项；标记为 subset/smoke")
    parser.add_argument("--test-limit", type=positive_int, help="只用测试集前 N 项；标记为 subset/smoke")
    args = parser.parse_args(argv)
    args.data_dir = resolve_path(args.data_dir)
    args.output_dir = resolve_path(args.output_dir)
    return TrainingConfig(**vars(args))
