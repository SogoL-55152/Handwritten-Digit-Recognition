# model-service — Flask 骨架与 W1 独立训练

推荐 Python 3.11。Web 服务只在内网被 Spring Boot 调用，目前仍只提供健康检查与统一响应；W1 新增的 MNIST/CNN 训练是**独立命令行程序**，不经过 Flask。

## Flask 本地启动

以下命令从 `model-service/` 执行。

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
cp .env.example .env
python app.py                    # http://localhost:5001
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查 |

统一响应：`{ "code": 0, "message": "ok", "data": ... }`，见 `api/common.py` 的 `ok()` / `fail()`。

## W1：独立 MNIST/CNN 训练

### 边界与环境

- 复用 `9e22dcd` 的 `DigitCNN` 结构：Conv(1→32) → Pool → Conv(32→64) → Pool → FC(128) → Dropout(0.3) → FC(10)。输入为 `N×1×28×28`，输出为 10 类 logits。
- 只实现离线数据加载、训练、测试集指标、最终权重保存及重载验证；**不恢复 registry、task_store、Celery、Redis、训练 API 或生产推理链路**。
- `requirements-train.txt` 与 Flask 的 `requirements.txt` / `requirements-ci.txt` 隔离。训练环境不需要安装 Flask；轻量 CI 不需要安装 torch。
- CPU 训练推荐 Python 3.11、官方 `torch==2.5.1+cpu` / `torchvision==0.20.1+cpu` wheels 与 `numpy<2`。`+cpu` 是对应稳定版本的 CPU 构建标记，安装文件使用 PyTorch 官方 CPU wheel 源；面向 Windows/Linux CPU 环境。

单独创建训练虚拟环境，不复用轻量 Flask 环境。

```bash
python3.11 -m venv .venv-train     # Windows: py -3.11 -m venv .venv-train
source .venv-train/bin/activate   # Windows: .venv-train\Scripts\activate
python -m pip install -r requirements-train.txt
python -I train_mnist.py --help
```

`-I` 隔离调用目录及用户 Python 环境；入口只补入自身源码目录。参数校验和 `--help` 不加载 torch。

### 数据与运行命令

相对 `--data-dir` / `--output-dir` **始终从 `model-service/` 计算**，不受调用者 cwd 影响；也可传绝对路径。默认数据目录为 `data/`，默认输出为 `weights/mnist-cnn/`。

- 默认 `download=False`，没有数据会非零退出并提示 `--download`，不会隐式联网。
- 显式 `--download` 调用 torchvision 官方 MNIST 下载流程，保留下载归档的 MD5 完整性校验及原始 IDX 解析，不替换下载源、不跳过校验。
- 离线使用时提供标准 `data/MNIST/raw/` 下四个解压后的文件：`train-images-idx3-ubyte`、`train-labels-idx1-ubyte`、`t10k-images-idx3-ubyte`、`t10k-labels-idx1-ubyte`。仅有压缩包时，仍需 `--download` 让 torchvision 校验/解压，或自行从可信来源准备原始 IDX。
- 禁用 torchvision 的旧版 `processed/*.pt` 数据缓存分支，**不加载不可信 pickle 数据集**。图片通过 `ToTensor()` 和 MNIST mean=0.1307 / std=0.3081 归一化。
- checkpoint 只重载本工具生成的可信产物，显式使用 `weights_only=True`，不保存或加载整个 Python 模型对象。

首次 smoke（真实 MNIST 的确定性前 N 项子集；需要网络时显式下载）

```bash
python -I train_mnist.py --data-dir data --output-dir weights/w1-smoke \
  --download --epochs 1 --batch-size 64 --learning-rate 0.001 \
  --seed 42 --device cpu --num-workers 0 --threads 2 \
  --train-limit 1024 --test-limit 256
```

上面的换行使用 Bash 语法；Windows PowerShell/cmd 可将其写成一行。只要指定任一 limit，`metrics.json` 就标记 `data.subset=true`、`data.scope="subset/smoke"`，并记录完整/实际样本数与选择方法。子集 smoke 只能验证链路，**不代表全量 MNIST 训练完成或达到某个准确率**。limit 必须为正且不能超过对应数据集大小。

已有完整数据后运行全量训练（不加 limit，也无需再次下载）

```bash
python -I train_mnist.py --data-dir data --output-dir weights/w1-full \
  --epochs 5 --batch-size 64 --learning-rate 0.001 --seed 42 \
  --device cpu --num-workers 0 --threads 2
```

从仓库根目录调用时，只把脚本改成 `model-service/train_mnist.py`；数据及输出参数无需改成带 `model-service/` 的路径。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--data-dir` | `data` | torchvision MNIST 根目录 |
| `--output-dir` | `weights/mnist-cnn` | 独立一次运行的输出目录 |
| `--download` | false | 无值开关，显式允许下载 |
| `--epochs` | 5 | 正整数，固定训练轮数 |
| `--batch-size` | 64 | 正整数 |
| `--learning-rate` | 0.001 | 有限正数，Adam 学习率 |
| `--seed` | 42 | 0…4294967295；同步 Python/NumPy/torch 与 DataLoader |
| `--device` | `cpu` | 支持 `cpu`、`cuda`、`cuda:N`、`mps`；不可用则报错，不静默回退 |
| `--num-workers` | 0 | 非负整数；Windows 推荐 0 |
| `--threads` | 不覆盖 torch 默认值 | 正整数；限制 PyTorch CPU 计算线程数 |
| `--train-limit` / `--test-limit` | 不限制 | 使用对应官方 split 前 N 项，标记 subset/smoke |

CPU wheels 不支持 CUDA。设置随机种子及确定性算法可帮助同环境复现，但不承诺不同硬件/库版本逐位一致。非法参数返回退出码 2；缺依赖、缺数据、设备不可用或写入失败返回非零并给出提示。输出目录已存在 `checkpoint.pt` 或 `metrics.json` 时拒绝覆盖，请为下一次运行使用新的输出目录。

### 输出与验收依据

一次成功运行产生两个文件。

- `checkpoint.pt`：最终轮的 `state_dict`、配置、架构、轮数及 `checkpoint_selection="final_epoch"`。测试集仅用于报告每轮指标，**不选择最佳测试集 checkpoint、不早停、不搜索参数**。
- `metrics.json`：完整命令配置、架构、优化器/损失、环境版本、数据划分与样本数、设备、seed、线程数、UTC 起止时间/耗时、每轮训练 loss、测试 loss、测试 accuracy 和轮次耗时。accuracy 单位是 0…1，控制台显示百分比。
- 保存后在同一批测试图片上比较原模型与重载模型的 eval logits，必须逐位一致才写成功指标，记录 `checkpoint_reload_verified=true`。总耗时包括数据准备、训练和 checkpoint 验证，不含最后的 JSON 写入。

中断/失败可能留下权重，但没有完整成功的 `metrics.json` 就不能作为一次成功训练。运行产物保留本地，不提交数据、权重或虚拟环境；本说明不预填准确率，也不把合成单测或 skip 当作真实训练成果。

## 本次真实基线

在 Python 3.11.16、PyTorch 2.5.1+cpu、torchvision 0.20.1+cpu 环境完成 37 项训练测试（无跳过），并实际运行 MNIST 60,000 条训练 / 10,000 条测试，CPU、seed=42、3 epoch：最终测试准确率 **99.10%**，最终 checkpoint 重载输出一致。完整参数、逐轮指标和边界见 [W1 MNIST 基线记录](../docs/W1-MNIST基线训练记录.md)。这是 MNIST 指标，不代表真实小程序画板准确率。

## 测试

### 原有轻量 Flask 测试（不安装 torch）

```bash
python -m pip install -r requirements-ci.txt
python -m pytest -q
```

默认 `pytest.ini` 仍只收集 `tests/`，不把训练依赖带进现有 CI。

### 独立训练测试集

```bash
# 可在轻量环境运行：参数/路径/错误提示测试不依赖 torch
python -I -m pytest -c pytest-training.ini tests_training/test_training_config.py -q

# 在 requirements-train.txt 环境中验证全部训练单测
python -I -m pytest -c pytest-training.ini -q
```

`tests_training/` 与 Web 测试分开收集。未安装 torch 时，shape/backprop/save-load 等模块通过 `pytest.importorskip` 跳过，不会在收集阶段导入失败。数据加载与训练整合单测还需要 torchvision。单测只使用临时目录里的合成 tensor/IDX，验证形状、反向传播、最终权重重载一致性、指标写入、子集标记、缺数据提示和禁用旧 pickle；**skip 仅表示该环境未执行相关测试，不表示训练通过**。真实 MNIST smoke/全量训练须另外运行上述命令并保留实际产物。

## 目录与服务约定

```text
app.py / config.py           Flask 入口与环境配置
api/common.py / health.py   统一响应与健康检查
train_mnist.py               W1 独立训练 CLI
models/cnn.py                DigitCNN 结构
services/training_config.py  无 torch 的参数与路径解析
services/mnist_data.py       原始 MNIST 数据、归一化及子集选择
services/mnist_training.py   训练/评估/最终 checkpoint 与指标
requirements-train.txt      独立 CPU 训练依赖
pytest-training.ini         独立训练测试配置
tests/                      原有轻量 Web 测试
tests_training/             训练参数及可选 torch 单测
weights/ / data/            本地训练产物与数据（不提交）
```

- 新 Web 接口放 `api/`，在 `app.py` 注册，前缀统一 `/api/v1`；W1 不新增业务接口。
- 该 Flask 服务没有鉴权，只应作为内网服务被 Spring Boot 调用；生产环境不要将 5001 端口暴露到公网。
- `requirements.txt` 仍仅含 Flask 依赖；现有镜像/CI 不安装训练依赖，也不在构建时下载 MNIST。
