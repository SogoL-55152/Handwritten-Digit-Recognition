"""W2 唯一允许的、不可变的基线清单；不从请求/远端读取模型信息。"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelManifest:
    model_id: str
    model_version: str
    preprocess_version: str
    sha256: str
    checkpoint_bytes: int
    architecture_name: str
    architecture_version: int
    input_shape: tuple
    num_classes: int
    layers: tuple
    mean: float
    std: float

    def identity(self):
        return {
            "modelId": self.model_id,
            "modelVersion": self.model_version,
            "preprocessVersion": self.preprocess_version,
        }

    def architecture(self):
        return {
            "name": self.architecture_name,
            "version": self.architecture_version,
            "input_shape": list(self.input_shape),
            "num_classes": self.num_classes,
            "layers": list(self.layers),
        }


BASELINE = ModelManifest(
    model_id="mnist-cnn-w1",
    model_version="w2-canvas-photo-3epoch",
    preprocess_version="adaptive-mnist-v2",
    sha256="72e27abd7440c47dce6196f0624d82704935297adbbd4da86edb4418fafed2aa",
    checkpoint_bytes=1690340,
    architecture_name="DigitCNN",
    architecture_version=1,
    input_shape=(1, 28, 28),
    num_classes=10,
    layers=(
        "Conv2d(1,32,3,padding=1)", "ReLU", "MaxPool2d(2)",
        "Conv2d(32,64,3,padding=1)", "ReLU", "MaxPool2d(2)",
        "Flatten", "Linear(64*7*7,128)", "ReLU", "Dropout(0.3)", "Linear(128,10)",
    ),
    mean=0.1307,
    std=0.3081,
)

IMAGE_MAX_BYTES = 5 * 1024 * 1024
REQUEST_MAX_BYTES = 6 * 1024 * 1024
IMAGE_MAX_EDGE = 2048
IMAGE_MAX_PIXELS = 4194304
INFERENCE_CONCURRENCY = 2
