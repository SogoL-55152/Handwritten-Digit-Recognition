"""图像预处理：将小程序画板/任意图片归一化为 MNIST 分布。

步骤：灰度 → 反色（保证黑底白字）→ 阈值 → 外接框裁剪 → 等比缩放至 20×20
→ 居中粘贴到 28×28 → 标准化（MNIST mean=0.1307, std=0.3081）。
"""
import io

import numpy as np
from PIL import Image

TARGET_SIZE = 28
CROP_SIZE = 20
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081


def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """返回形状为 (1, 1, 28, 28) 的 float32 数组。"""
    if not image_bytes:
        raise ValueError("图片内容为空")

    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("L")
    except Exception as exc:
        raise ValueError("无法解析图片，请上传 PNG/JPG 格式") from exc

    array = np.array(image, dtype=np.uint8)

    # 小程序画板是白底黑字，MNIST 是黑底白字，按整体亮度自动反色
    if float(array.mean()) > 127:
        array = 255 - array

    mask = array > 40
    if not mask.any():
        raise ValueError("图片中没有可识别的笔画")

    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    top, bottom = int(np.argmax(rows)), int(len(rows) - 1 - np.argmax(rows[::-1]))
    left, right = int(np.argmax(cols)), int(len(cols) - 1 - np.argmax(cols[::-1]))
    cropped = array[top:bottom + 1, left:right + 1]

    height, width = cropped.shape
    scale = CROP_SIZE / max(height, width)
    new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    resized = Image.fromarray(cropped).resize(new_size, Image.Resampling.LANCZOS)

    canvas = Image.new("L", (TARGET_SIZE, TARGET_SIZE), 0)
    offset = ((TARGET_SIZE - new_size[0]) // 2, (TARGET_SIZE - new_size[1]) // 2)
    canvas.paste(resized, offset)

    normalized = np.asarray(canvas, dtype=np.float32) / 255.0
    normalized = (normalized - MNIST_MEAN) / MNIST_STD
    return normalized.reshape(1, 1, TARGET_SIZE, TARGET_SIZE)
