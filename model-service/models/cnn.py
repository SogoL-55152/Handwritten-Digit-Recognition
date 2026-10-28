"""W1 MNIST CNN，沿用 9e22dcd 的 DigitCNN 结构与 state_dict 键名。"""

from torch import nn


ARCHITECTURE = {
    "name": "DigitCNN",
    "version": 1,
    "input_shape": [1, 28, 28],
    "num_classes": 10,
    "layers": [
        "Conv2d(1,32,3,padding=1)",
        "ReLU",
        "MaxPool2d(2)",
        "Conv2d(32,64,3,padding=1)",
        "ReLU",
        "MaxPool2d(2)",
        "Flatten",
        "Linear(64*7*7,128)",
        "ReLU",
        "Dropout(0.3)",
        "Linear(128,10)",
    ],
}


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
