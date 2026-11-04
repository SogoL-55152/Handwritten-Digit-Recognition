"""有界画板预处理，独立于 torch；输出 1×28×28 float32 MNIST 输入。"""
from io import BytesIO

from services.inference_manifest import (
    BASELINE, IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS,
)


class InvalidImage(ValueError):
    def __init__(self, message, status=400, category="INVALID_IMAGE"):
        super().__init__(message)
        self.status = status
        self.category = category


def _check_header(image, content_type):
    expected = {"PNG": "image/png", "JPEG": "image/jpeg"}
    if image.format not in expected or content_type != expected[image.format]:
        raise InvalidImage("只接受与实际格式一致的 PNG/JPEG", 415, "UNSUPPORTED_IMAGE")
    width, height = image.size
    if (width < 1 or height < 1 or max(width, height) > IMAGE_MAX_EDGE
            or width * height > IMAGE_MAX_PIXELS):
        raise InvalidImage("图片尺寸超过限制", 413, "IMAGE_TOO_LARGE")
    if getattr(image, "n_frames", 1) != 1:
        raise InvalidImage("不接受动画或多帧图片")


def preprocess_image(payload, content_type):
    if not payload:
        raise InvalidImage("图片不能为空")
    if len(payload) > IMAGE_MAX_BYTES:
        raise InvalidImage("图片超过 5 MiB", 413, "IMAGE_TOO_LARGE")
    if content_type not in ("image/png", "image/jpeg"):
        raise InvalidImage("只接受 PNG/JPEG", 415, "UNSUPPORTED_IMAGE")
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        # 限定解码插件；先检查头尺寸再 verify/load，不能先解压再检查。
        with Image.open(BytesIO(payload), formats=("PNG", "JPEG")) as image:
            _check_header(image, content_type)
            image.verify()
        with Image.open(BytesIO(payload), formats=("PNG", "JPEG")) as image:
            _check_header(image, content_type)
            image.load()  # Pillow 默认拒绝截断，不设置 LOAD_TRUNCATED_IMAGES。
            oriented = ImageOps.exif_transpose(image)
            rgba = oriented.convert("RGBA")
            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            gray = np.asarray(Image.alpha_composite(white, rgba).convert("L"))
    except InvalidImage:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidImage("图片尺寸超过限制", 413, "IMAGE_TOO_LARGE") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as exc:
        raise InvalidImage("图片损坏或格式不受支持") from exc

    # 画板边框估计底色，支持白底黑字与黑底白字；透明层始终先合成到白底。
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    ink = 255 - gray if np.median(border) >= 128 else gray
    if int(gray.max()) - int(gray.min()) < 16:
        raise InvalidImage("请先书写数字，不能识别空白图片", category="BLANK_IMAGE")
    ink = np.where(ink >= 32, ink, 0).astype(np.uint8)
    bounds = Image.fromarray(ink).getbbox()
    if bounds is None:
        raise InvalidImage("请先书写数字，不能识别空白图片", category="BLANK_IMAGE")
    foreground = Image.fromarray(ink).crop(bounds)
    width, height = foreground.size
    scale = 20 / max(width, height)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    foreground = foreground.resize(target, Image.Resampling.LANCZOS)
    canvas = Image.new("L", (28, 28), 0)
    canvas.paste(foreground, ((28 - target[0]) // 2, (28 - target[1]) // 2))
    values = np.asarray(canvas, dtype=np.float32) / np.float32(255)
    return np.ascontiguousarray(((values - BASELINE.mean) / BASELINE.std)[None, :, :])
