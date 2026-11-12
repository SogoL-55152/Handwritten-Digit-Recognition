# 手写数字样本采集页

一个单文件 HTML，双击即用，**不联网、不上传、不起服务**。用于采集真实画板手写样本，产出的 ZIP 可直接交给 `model-service/evaluate_samples.py` 评测。

## 为什么需要它

W6 要验收「单字与 4 位串（间隔式）准确率 ≥90%」，而现有所有百分比都来自 MNIST/EMNIST/模拟增广，**没有一条来自真实用户笔迹**（自采数据长期为 0 条）。公开数据集能用于训练增广，但不能当验收证据——否则等于自己给自己出题。

采集工具才是卡点：1000 条按每条 4 秒算，总共约 67 分钟书写量。

## 用法

1. 双击 `index.html`（Edge / Chrome 均可）
2. 填「书写者标识」（如 `m1`、`zhang`）——用于按人分折，**同一人不能既训又测**
3. 点数字按钮（或按键盘 `0`–`9`）选中要写的数字
4. 在画板写一个数字，按 `Enter`（或点「保存」）→ 自动跳到下一个待采集数字
5. 写错：`Backspace` 撤销一笔，`Esc` 清空
6. 达到目标数量后勾选同意 → 点「导出 ZIP」

建议配额：**每人 200 条（0–9 各 20 遍）**，5 人即可到 1000 条。

## 导出内容

```
samples-<书写者>-<会话>.zip
├── <writer>-<digit>-<序号>.png   画板原始导出（线宽 = 画布 5.5%，与线上一致）
├── manifest.json                 评测脚本输入清单
└── README.txt                    字段说明
```

`manifest.json` 字段与 `docs/templates/recognition-samples.example.json` 一致：

```json
{"samples": [{"id": "m1-7-001", "file": "m1-7-001.png", "label": 7,
  "origin": "actual-user-board", "writerId": "m1",
  "captureSessionId": "c…", "consent": true}]}
```

## 与线上画板的一致性

| 参数 | 值 | 说明 |
|---|---|---|
| 画布逻辑边长 | 320 | 与前端 `drawing-board.js` 一致 |
| 线宽 | 画布 × 0.055 | 同上，比例一致 |
| 颜色 | 白底 + `#111` | 同上 |
| 导出分辨率 | 640×640（2×） | 与 DPR 缩放等价，预处理会裁到墨迹外框再缩到 20px |

预处理会按墨迹外框裁剪并缩放到 28×28，所以绝对分辨率不影响结果，**关键是"线宽 / 字高"比例**——这正是本页对齐的参数。

## 已验证

| 验证项 | 方法 | 结果 |
|---|---|---|
| 页面可运行 | 无头 Edge 加载 `?selftest=1` | `SELFTEST_OK`（合成 1 条：PNG 15.3 KB、ZIP 15.8 KB、manifest 字段正确） |
| ZIP 可解 | 抽出内置 zip 代码生成 → Python `zipfile.testzip()` | 无错误，文件名与 manifest 均可读 |
| 评测可对接 | 用采集页 schema 造 3 张图 → `evaluate_samples.py` | 识别为 `REAL` 组，3/3 正确 |

内置 ZIP 写出器只做 STORE（PNG 已压缩），因此**不需要任何第三方库**，断网也能用。

## 交接与评测

采集完成后把 ZIP 放到任意本地目录，然后：

```bash
cd model-service
python evaluate_samples.py \
  --manifest <解压后的>/manifest.json \
  --checkpoint <绝对路径>/weights/w2-canvas-photo/checkpoint.pt \
  --output <新目录>
```

注意：`--checkpoint` 必须是**绝对路径且文件存在**，`--output` 必须是**新目录**。报告在 `<新目录>/report.json`，按 `origin` 分组统计（`actual-user-board` 会归入 `REAL`）。

## 注意

- 数据只存在页面内存里，**关闭页面前必须导出**
- 页面不联网、不上传；ZIP 由使用者自己交给维护者
- 只有勾选同意后才允许导出；`consent=false` 的样本不得进入评测记录
- 建议每个数字换着写，而不是一次写完 20 个同一数字（后者会让单字样本过于雷同）
