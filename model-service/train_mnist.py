"""W1 独立训练 CLI。用 python -I /absolute/path/train_mnist.py ... 运行。"""

import sys
from pathlib import Path

# -I 不加入脚本目录；只补入受信任的项目源码目录，不加入调用者 cwd/数据目录。
SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from services.training_config import parse_args


def main(argv=None):
    config = parse_args(argv)
    try:
        # 延迟导入，保证 --help/非法参数/轻量参数测试无需安装 torch。
        from services.mnist_training import run_training

        metrics = run_training(config)
    except ImportError as exc:
        print(
            "训练依赖缺失或无法导入。请使用 Python 3.11 和 requirements-train.txt "
            f"安装官方 CPU 训练依赖。详情：{exc}",
            file=sys.stderr,
        )
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"训练失败：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("训练已中断；未完成的输出不能作为训练结果。", file=sys.stderr)
        return 130
    print(f"训练完成（{metrics['data']['scope']}）；指标：{config.output_dir / 'metrics.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
