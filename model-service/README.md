# model-service — W2 可信基线推理与 W1 独立训练

推荐 Python 3.11。服务仅由 Java 内部调用；W2 新增带独立认证的 `/internal/v2/ready`、`/internal/v2/predict`，保留 W1 健康检查和离线训练原样。**没有在线训练 API，不重训、不随机权重兜底、不自动联网下载。**

## 通用拒识（本地实验策略）

新增 `selective-digit-v1` 接受策略：明显宽幅实心块/显著分散区域，或最高分低于0.90/前两类分差低于0.85时，内部返回422 `UNRECOGNIZED_INPUT`，不返回猜测数字。权重、预处理和成功响应不变；这不是经过真实手写校准的非数字检测器，已测留出乱画仍有漏拒。环境变量 `RECOGNITION_MIN_CONFIDENCE`/`RECOGNITION_MIN_MARGIN` 必须为有限合法值。

本地离线评估工具 `evaluate_acceptance.py` 只读已有可信权重及MNIST测试IDX，拒绝覆盖输出、不下载/训练。不要仅凭接受子集准确率报告质量提高；同时报告覆盖率、合法数字拒绝率和非数字漏拒。用户 9→7 的原样例仍未提供（只有开发者工具截图），但已用截图裁切复现：换成 `w2-canvas-photo-3epoch` 基线后同一输入 top-1 从 7 变为 9，只是分数 0.802/分差 0.607 低于当前阈值、按诚实拒识处理。完整数据、失败案例和真实422链路见 [拒识验证与局限](../docs/通用拒识-验证与局限.md) 与 [画板识别失败诊断](../docs/画板识别失败诊断-20261107.md)。

## W2：本地推理与部署

以下命令从 `model-service/` 执行。为 W2 新建环境，不向已有 W1 训练环境安装包。下面是环境准备说明，不表示当前机器已经安装这些依赖。

```bash
python -I -m venv .venv-inference
source .venv-inference/bin/activate  # Windows: .venv-inference\Scripts\activate
# CPU torch 单独来自官方源；其他依赖来自 PyPI，不混合索引选择依赖。
python -I -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.6.0+cpu
python -I -m pip install -r requirements-inference.txt
cp .env.example .env
# 在 .env 注入 MODEL_INTERNAL_TOKEN（Java 同值）和管理员控制的权重绝对路径。
python -I serve.py                  # Waitress，默认 127.0.0.1:5001
# 仅本地调试也可 python -I app.py；不使用 Flask 开发服务器部署。
```

- `MODEL_INTERNAL_TOKEN` 必填，使用足够长的随机共享密钥；不写进 Git、前端、小程序或镜像。未配置时两个内部入口都返回 503；错误凭据返回 401。比较使用常量时间函数，解析上传前先鉴权。
- `MODEL_CHECKPOINT_PATH` 只能由服务端环境配置，默认是源码目录下 `weights/w2-canvas-photo/checkpoint.pt`；推荐绝对路径。不能从 multipart、查询参数、URL 或文件名选择路径。缺权重、摘要/大小不符、加载失败均 503，不降级随机网络或 smoke 权重。
- 本地 `HOST=127.0.0.1`；容器 Dockerfile 显式 `HOST=0.0.0.0`，不要将模型端口发布到公网，浏览器 CORS 不对内部路由开放。内部认证不是最终用户授权，workspaceId 权限仍由 Java 检查。
- `serve.py` 使用单进程 Waitress，4 个请求线程、最多 32 个连接，推理/解码并发严格限制为 2；额外推理返回 429 `MODEL_BUSY`、`Retry-After: 1`。设置 `OMP_NUM_THREADS=2`、`MKL_NUM_THREADS=2` 限制 CPU 线程；多进程会各自加载模型并拥有独立的并发预算，不应在 W2 随意增加 worker。
- 首次鉴权 readiness/预测按需加载一次，重用 `services/mnist_training.py::load_checkpoint` 的 `weights_only=True`、架构校验、strict state_dict 和 eval 行为；torch/torchvision 均不在 Flask 导入时加载，推理不导入 torchvision。仅经固定 SHA 验证的同一份有界 bytes 传给加载器，避免摘要校验与重开路径之间的替换。运行 torch.inference_mode；加载失败缓存，修复配置/文件后需重启。
- 原 W1 的 torch 2.5.1+cpu 可读取同一可信 checkpoint；新环境/Docker 推荐 2.6 CPU。即使使用 weights_only，也绝不接受未固定摘要的外来 checkpoint。

### 冻结的内部 API

所有请求使用 `X-HDR-Internal-Token`。成功 envelope 为 `{code:0,message:"ok",data:...}`；内部错误使用真实 HTTP 4xx/5xx，`{code:<status>,message,data:{category}}`。429 额外有 `data.retryAfterSeconds`。反向代理/Waitress 在 Flask 前拒绝的请求可能不是 JSON。W1 `/api/v1` 的 404/413 历史 HTTP 200 行为保持隔离。

| 方法 | 路径 | 请求/响应 |
|---|---|---|
| GET | `/api/v1/health` | 无认证，仅进程存活，不代表模型可用 |
| GET | `/internal/v2/ready` | 200 data 为 `{status:"UP",modelId,modelVersion,preprocessVersion,sha256}`；未就绪 503 |
| POST | `/internal/v2/predict` | multipart 唯一 `image` 文件，以及唯一字符串 `workspaceId/requestId/modelId/modelVersion/preprocessVersion`；禁止多余字段、重复字段和查询参数 |

预测 data 固定为 `{requestId,digit,confidence,modelId,modelVersion,preprocessVersion,processingMs}`。workspaceId 是正十进制 signed-64 ID 字符串，requestId 是标准带连字符 UUID，按原值返回；digit 为 0..9 整数，confidence 有限且在 0..1，processingMs 非负整数，包含预处理和首次加载耗时。Python 不存储原图或记录，不负责请求幂等；Java 应遵守 2s 连接/10s 读取预算、不得自动重发 POST。

| manifest 字段 | 固定值 |
|---|---|
| modelId / modelVersion | `mnist-cnn-w1` / `w2-canvas-photo-3epoch` |
| preprocessVersion | `adaptive-mnist-v2` |
| checkpoint SHA-256 | `72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa` |
| checkpoint 大小 | 1,690,340 bytes |
| 架构 / 输入 / 输出 | DigitCNN v1 / 1×28×28 / 10 logits |
| MNIST mean / std | 0.1307 / 0.3081 |

允许清单在不可变 `services/inference_manifest.py` 中，不存在任意路径/URL 注册模型接口。模型未就绪 503 `MODEL_UNAVAILABLE`，非法模型引用 400 `MODEL_NOT_ALLOWED`，输入空白 400 `BLANK_IMAGE`，格式不符 400/415，文件/尺寸/请求超限 413。

### 画板预处理与限额

- PNG/JPEG 真实格式与上传 MIME 必须一致；不依赖文件名。只允许这两类解码插件。文件最大 5 MiB、完整请求 6 MiB、最大边长 2048、总像素 4,194,304；读取有界，在解压前检查头尺寸。multipart 最多 6 个部分，普通字段内存另有限额。
- 拒绝动画/多帧、截断/损坏、空白/近似纯色；不启用 Pillow 容忍截断开关。尺寸上限内也会做 verify 与完整 load。
- EXIF 方向处理后把透明层合成到白底、转灰度；以边框中位数判断明暗底色，转换成黑底白字。灰度跨度小于 16 视为空白，墨迹低于 32 去除背景噪声，再裁剪前景。
- 保持宽高比，将前景缩至 20×20 内，几何居中到黑色 28×28，不随意旋转、拉伸；最后按 MNIST mean/std 归一化 float32。透明图等价于在白底上绘制，不是把透明黑色误判成墨迹。
- 仅面向单字画板，不承诺自然场景照片识别；MNIST 99.10% 是 W1 历史测试集指标，单次 confidence 不是线上准确率。

### 画板与照片域基线（w2-canvas-photo-3epoch / adaptive-mnist-v2）

W1 基线只在 MNIST 原图上训练，真实画板笔迹上 top-1 明显下降，且"裁剪墨迹外接框→缩放到 20px"的几何归一化与训练分布不一致（对照实验：同一批 MNIST 数字直喂 99.0%，走完整链路仅 93.8%）。相册照片还有第二个问题：固定 32/255 阈值会把灰纸背景整片当成墨迹。现方案：

1. 预处理改为**背景归一化**（相对背景的归一化偏离 + 逐像素模糊背景兜底），灰纸浅笔、白底黑字、黑底白字走同一条对称路径；
2. 训练输入**直接复用线上 `canvas_input`**，训练与线上逐像素同源；
3. 增广同时覆盖画板风格（大画布、粗笔画、倾斜、缩放）与**照片风格**（纸面底色、光照渐变、低对比笔迹、模糊、噪声、JPEG 伪影）；
4. 数据加入官方 EMNIST digits（24 万张、不同书写者），与 MNIST 各半。

复现命令（在 `model-service/` 下，需 torch 训练环境与本地 EMNIST 压缩包；输出目录必须是新目录）：

```text
python -I train_canvas_aug.py --data-dir data/MNIST/raw --emnist-zip <本地>/gzip.zip \
  --output-dir weights/w2-canvas-photo --init weights/w2-canvas-aug/checkpoint.pt \
  --epochs 3 --samples 60000 --photo-ratio 0.5 --seed 20261107 --threads 2
```

| 指标 | W1 基线 | 上一版基线 | 现基线 |
|---|---|---|---|
| MNIST test 直喂（1000 张） | 98.9% | 98.6% | 97.7% |
| 画板风格模拟集（1000 张） | 92.1% | 98.3% | **99.1%** |
| 照片风格模拟集（1000 张） | — | 38.7% | **84.0%** |
| EMNIST digits 未见书写者（1000 张，画板风格） | — | — | **98.5%** |
| 真实生产链路 MNIST 拒绝率（1000 张，阈值 0.90/0.85） | 14.2% | 5.3% | 3.8%（画板域） |
| 照片风格模拟集：接受覆盖率 / 接受后正确率（0.90/0.85） | — | — | 63.1% / 99.37% |

边界：画板/照片模拟集与训练增广同源，数字偏乐观；MNIST 与 EMNIST 都是域内指标；**没有一项是真实画板或真实相册照片准确率**。真实结论仍需 W3 自采画板与相册数据。诊断与逐例证据见 [画板识别失败诊断](../docs/画板识别失败诊断-20261107.md) 与 [照片导入修复与基线切换记录](../docs/照片导入修复与基线切换-20261107.md)。

拒识阈值保持 0.90/0.85：照片域实测放宽到 0.70/0.50 可把覆盖率从 63.1% 提到 73.8%、接受后正确率降到 98.2%，属于产品取舍，尚未采用。

### 镜像与只读权重

`.dockerignore` 排除 weights/data、checkpoint、环境密钥、虚拟环境及测试；Docker 构建不下载 MNIST、不烘焙本地权重。容器用非 root UID 65532。运行时将已校验 checkpoint **只读挂载**，例如（不发布模型端口）

```bash
docker build -t hdr-model-w2 .
docker run --rm --network hdr-internal \
  -e MODEL_INTERNAL_TOKEN -e MODEL_CHECKPOINT_PATH=/weights/checkpoint.pt \
  --mount type=bind,source=/absolute/trusted/checkpoint.pt,target=/weights/checkpoint.pt,readonly \
  hdr-model-w2
```

此网络名称是部署示例；与 Java 使用同一内部网络并注入同值 token。不要把 `.env` 或权重复制到镜像，不从容器内创建或写入权重目录。

### W2 指标 schema（仅约定，未实现训练接口）

未来指标事件字段为 `taskId/attempt/seq/epoch/totalEpochs/trainLoss/valLoss/valAccuracy/elapsedMs/recordedAt`：taskId 字符串，attempt 正整数、seq 为同一次 attempt 内递增非负整数；epoch/totalEpochs 正整数且 epoch≤totalEpochs，loss 为有限非负数，valAccuracy 有限 0..1，elapsedMs 非负整数，recordedAt 为 UTC ISO-8601。尚未测量的指标为 null/缺失，不能造假 0。W1 的 test_loss/test_accuracy 继续叫 test，不改名为 validation。W2 不创建 task/worker、训练提交接口或曲线。

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

### W2 轻量 Flask / 预处理测试（不安装 torch）

```bash
python -I -m pip install -r requirements-ci.txt
python -I -m pytest -c pytest.ini tests -q
```

`tests/` 使用 Flask/Pillow/NumPy，预测器在契约测试中显式注入测试替身；真实图片解码/限额测试不以替身代替。覆盖认证先于解析、allowlist、错误 HTTP 状态、重复/额外字段、UUID/空间 ID、并发、PNG/JPEG/透明/EXIF/比例/空白/损坏/尺寸/字节限制、无 torch 导入及 v1 回归。默认 `pytest.ini` 不收集训练/真实权重测试。

### W2 真实 checkpoint 测试（显式 opt-in）

```bash
# 在已有推理依赖环境中；为测试额外准备 pytest，不修改 W1 训练环境。
HDR_TEST_CHECKPOINT=/absolute/trusted/checkpoint.pt \
  python -I -m pytest -c pytest-inference.ini tests_inference -q
```

未设置 `HDR_TEST_CHECKPOINT` 会跳过，不能记为真实推理通过；显式指定后缺文件/缺 torch/错误摘要会失败，不自动跳过。测试验证 full checkpoint 摘要、weights_only 重载一次、eval/inference_mode、有限结果、重复及双线程一致性，不把合成画板例子的输出当作画板准确率。若从仓库根调用，请同时为 `-c` 和测试目录加 `model-service/` 前缀，避免 pytest 从调用目录误收集其他套件。

2026-11-03已获准准备独立W2完整环境（不修改W1）：Python3.11.16、torch2.6.0+cpu、Flask3.1.3、Pillow13.0.0、NumPy2.4.6、Waitress3.0.2。`tests/` **94项全部通过**，显式full checkpoint **4项通过**；Waitress实际启动，内部认证ready、Java真实HTTP调用及PC鼠标画板识别/落库已验证。11月2日的分环境子集记录仅为历史；Docker及微信工具/真机仍未验收，见 [W2交付记录](../docs/W2-交付与验证记录.md)。

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

- 新内部接口前缀 `/internal/v2`；`api/common.py` 的 v1 `fail()` 不用于内部 v2。
- 只有 W1 健康检查无认证；内部路由必须认证，仍不可将 5001 端口公开到公网。
- `requirements.txt` / `requirements-ci.txt` 保持无 torch；`requirements-inference.txt` 单独引入 CPU 推理依赖，不带 torchvision/在线训练。
- `services/inference_manifest.py` / `inference_preprocess.py` / `inference.py` 为 W2 清单、预处理与只读加载服务；`api/internal_v2.py` 实现内部合同，`serve.py` 是单进程运行入口。