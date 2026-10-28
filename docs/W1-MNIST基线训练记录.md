# W1 MNIST 基线训练记录

> 主责：M3　|　日期：2026-10-28　|　状态：真实子集 smoke、全量基线、权重重载与训练测试均已完成

## 1. 结论

使用标准 MNIST **60,000 条训练数据 / 10,000 条测试数据**，在 CPU 上训练 DigitCNN **3 轮**，最终测试准确率为 **99.10%**。保存最后一轮 checkpoint，重载后同批数据的输出逐位一致。

这是 MNIST 测试集成绩，**不是小程序真实手写场景准确率，也不替代后续自采数据 ≥90% 的验收**。没有用合成单测数据冒充真实实验，没有根据测试集选择最佳 checkpoint。

## 2. 环境与配置

| 项目 | 实际值 |
|---|---|
| 环境 | Windows，独立虚拟环境 `D:/Temp/hdr-w1-train` |
| Python | 3.11.16 |
| PyTorch / torchvision | 2.5.1+cpu / 0.20.1+cpu |
| NumPy | 1.26.4 |
| 模型 | DigitCNN：两层卷积/池化 + 128 单元全连接 + Dropout(0.3) + 10 类输出 |
| 优化器 / 损失函数 | Adam / CrossEntropyLoss |
| epochs / batch size / learning rate | 3 / 64 / 0.001 |
| seed / device / workers / CPU threads | 42 / cpu / 0 / 2 |
| 预处理 | `ToTensor`，mean=0.1307、std=0.3081 归一化 |
| 数据划分 | MNIST 官方 train/test，完整基线不设置子集限制 |
| 全量训练下载参数 | false，首次 smoke 下载完成后离线使用数据 |
| 确定性算法 | 启用；不承诺跨硬件、跨版本逐位一致 |

依赖来自获准使用的 PyTorch 官方 CPU wheel 源与 PyPI。下载由 torchvision MNIST 标准流程完成；禁用旧的 pickle 数据集缓存分支。

## 3. 实际执行命令

在仓库根目录执行：

```bash
# 训练单测：真实 torch / torchvision 环境，37 passed、0 skipped
D:/Temp/hdr-w1-train/Scripts/python.exe -I -X utf8 -m pytest -c model-service/pytest-training.ini model-service/tests_training -q -rs

# 真实 MNIST 子集 smoke：首次显式下载
D:/Temp/hdr-w1-train/Scripts/python.exe -I -X utf8 model-service/train_mnist.py --download --epochs 1 --threads 2 --train-limit 1024 --test-limit 256 --output-dir weights/w1-smoke

# 全量基线：不下载、不限制样本
D:/Temp/hdr-w1-train/Scripts/python.exe -I -X utf8 model-service/train_mnist.py --epochs 3 --threads 2 --seed 42 --output-dir weights/w1-full
```

相对数据与输出路径以 `model-service/` 为根。重跑时使用新的输出目录，程序不会覆盖已有 checkpoint/metrics。

## 4. 结果

### 子集 smoke（仅验证流程）

- 训练 1,024 条，测试 256 条，1 轮。
- 测试准确率 **69.140625%**，总耗时 **21.035 秒**（包括首次数据准备）。
- 权重保存与重载一致性检查通过。
- 明确标记 `subset/smoke`，不能当作全量基线。
- 原始指标：[mnist-smoke-metrics.json](evidence/w1/mnist-smoke-metrics.json)。

### 全量基线

| Epoch | 训练 loss | 测试 loss | 测试准确率 | 本轮耗时（秒） |
|---|---:|---:|---:|---:|
| 1 | 0.167941 | 0.050141 | 98.36% | 20.257 |
| 2 | 0.056592 | 0.032926 | 98.99% | 20.343 |
| 3 | 0.040716 | 0.026385 | **99.10%** | 20.364 |

- 起止时间（UTC）：2026-10-28 05:11:43 至 05:12:44。
- 总耗时：**61.059 秒**，包含数据加载、训练和 checkpoint 验证，不包含依赖安装。
- 保存策略：`final_epoch`；不是根据测试准确率挑选“最佳”权重。
- 重载检查：`checkpoint_reload_verified = true`。
- 原始指标：[mnist-full-metrics.json](evidence/w1/mnist-full-metrics.json)，数值来自程序实际输出。

## 5. 产物

| 产物 | 本地位置 |
|---|---|
| 全量最终权重 | `model-service/weights/w1-full/checkpoint.pt` |
| 全量原始指标 | `model-service/weights/w1-full/metrics.json` |
| 子集 smoke | `model-service/weights/w1-smoke/` |
| MNIST 原始文件 | `model-service/data/MNIST/raw/` |
| 便于阅读/版本保存的指标副本 | `docs/evidence/w1/mnist-*-metrics.json` |

全量 checkpoint 大小 **1,689,984 字节**，SHA-256：

```text
656afea28cd929a15da8dad24fe69d278554c061380e34bf679be03a45b781b4
```

数据、权重和虚拟环境均被 Git 忽略，继续保留本地；训练代码、本记录及轻量指标副本随 M3 的 `feature/m3-w1` 分支提交、推送，不上传数据集和权重。

## 6. 过程问题与边界

- 最初在无 torch 的轻量环境执行，结果是 27 passed / 2 个模块 skipped；该轮没有冒充训练通过。
- 首次依赖安装被权限拦截；获准后曾遇到 Windows GBK 解码错误，通过 UTF-8 模式安装解决，依赖文件也已加编码声明。
- 最终在独立 Python 3.11 训练环境重新执行 **37 项测试全部通过，无跳过**。
- 这份记录证明离线基线可运行，不证明 Flask 在线推理、Java 转发、小程序真实识别或自采准确率已完成。
