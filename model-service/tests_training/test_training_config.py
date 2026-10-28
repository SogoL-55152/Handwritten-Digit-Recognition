"""轻量训练 CLI 测试：本文件及参数模块均不导入 torch。"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from services.training_config import SERVICE_ROOT, parse_args


SCRIPT = SERVICE_ROOT / "train_mnist.py"


def test_defaults_are_offline_cpu_and_service_relative(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = parse_args([])
    assert config.download is False
    assert config.device == "cpu"
    assert config.num_workers == 0
    assert config.threads is None
    assert config.data_dir == SERVICE_ROOT / "data"
    assert config.output_dir == SERVICE_ROOT / "weights" / "mnist-cnn"
    assert config.train_limit is config.test_limit is None
    assert json.loads(json.dumps(config.as_dict()))["seed"] == 42


def test_explicit_options_and_absolute_paths(tmp_path):
    config = parse_args([
        "--data-dir", str(tmp_path / "data"),
        "--output-dir", str(tmp_path / "run"),
        "--download", "--epochs", "2", "--batch-size", "16",
        "--learning-rate", "0.02", "--seed", "0", "--device", "cuda:1",
        "--num-workers", "2", "--threads", "3",
        "--train-limit", "20", "--test-limit", "10",
    ])
    assert config.data_dir == (tmp_path / "data").resolve()
    assert config.output_dir == (tmp_path / "run").resolve()
    assert config.download is True
    assert (config.epochs, config.batch_size, config.learning_rate) == (2, 16, 0.02)
    assert (config.seed, config.device, config.num_workers, config.threads) == (0, "cuda:1", 2, 3)
    assert (config.train_limit, config.test_limit) == (20, 10)


def test_relative_paths_ignore_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = parse_args(["--data-dir", "data/run1", "--output-dir", "weights/run1"])
    assert config.data_dir == SERVICE_ROOT / "data" / "run1"
    assert config.output_dir == SERVICE_ROOT / "weights" / "run1"


@pytest.mark.parametrize("option,value", [
    ("--epochs", "0"), ("--epochs", "1.5"),
    ("--batch-size", "-1"), ("--batch-size", "abc"),
    ("--learning-rate", "0"), ("--learning-rate", "-0.1"),
    ("--learning-rate", "nan"), ("--learning-rate", "inf"), ("--learning-rate", "abc"),
    ("--seed", "-1"), ("--seed", "4294967296"), ("--seed", "abc"),
    ("--device", "auto"), ("--device", "cuda:-1"), ("--device", "cpu:0"),
    ("--num-workers", "-1"), ("--threads", "0"),
    ("--train-limit", "0"), ("--test-limit", "-1"),
    ("--download", "false"),
])
def test_invalid_arguments_exit_nonzero(option, value, capsys):
    with pytest.raises(SystemExit) as error:
        parse_args([option, value])
    assert error.value.code == 2
    assert "error:" in capsys.readouterr().err


def test_help_works_in_isolated_python_from_other_cwd(tmp_path):
    result = subprocess.run(
        [sys.executable, "-I", str(SCRIPT), "--help"],
        cwd=tmp_path, capture_output=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert b"--download" in result.stdout
    assert b"--threads" in result.stdout


def test_invalid_cli_fails_before_loading_torch(tmp_path):
    # -S 隐藏 site-packages：即使完全没有 torch 也必须先得到参数错误。
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(SCRIPT), "--epochs", "0"],
        cwd=tmp_path, capture_output=True, timeout=30,
    )
    assert result.returncode == 2
    assert b"--epochs" in result.stderr
    assert b"Traceback" not in result.stderr


def test_missing_training_dependency_is_friendly(tmp_path):
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(SCRIPT)],
        cwd=tmp_path, capture_output=True, timeout=30,
    )
    assert result.returncode == 1
    assert b"requirements-train.txt" in result.stderr
    assert b"Traceback" not in result.stderr


def test_training_sources_do_not_reference_service_runtime():
    # 限定 W1 文件，防止训练入口以后意外耦合到 Web/任务服务。
    import ast

    sources = [SCRIPT, SERVICE_ROOT / "models" / "cnn.py"]
    sources += [SERVICE_ROOT / "services" / name for name in (
        "training_config.py", "mnist_data.py", "mnist_training.py",
    )]
    banned = {"flask", "redis", "celery", "app", "config", "tasks", "celery_app"}
    for source in sources:
        tree = ast.parse(Path(source).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue
            assert not any(module.split(".")[0] in banned for module in modules), source
