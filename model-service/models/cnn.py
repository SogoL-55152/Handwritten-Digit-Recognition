"""MNIST 手写数字 CNN。

结构：Conv(1→32) → Pool → Conv(32→64) → Pool → FC(128) → FC(10)。
"""
try:
    import torch.nn as nn

    class DigitCNN(nn.Module):
        def __init__(self):
            super().__init__()
            self.features = nn.Sequential(
                nn.Conv2d(1, 32, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),
                nn.Conv2d(32, 64, kernel_size=3, padding=1),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),
            )
            self.classifier = nn.Sequential(
                nn.Flatten(),
                nn.Linear(64 * 7 * 7, 128),
                nn.ReLU(inplace=True),
                nn.Dropout(0.3),
                nn.Linear(128, 10),
            )

        def forward(self, x):
            return self.classifier(self.features(x))

except ImportError:  # 允许在未安装 PyTorch 的环境中导入其他模块（如预处理测试）

    class DigitCNN:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("PyTorch 未安装，请先执行 pip install -r requirements.txt")
