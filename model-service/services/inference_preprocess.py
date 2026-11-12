"""有界画板预处理，独立于 torch；输出 1×28×28 float32 MNIST 输入。"""
from io import BytesIO

import numpy as np
from PIL import Image, ImageFilter

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


def _background_level(gray):
    """背景亮度取全图中位数：纸/画板通常占据多数像素。"""
    return float(np.median(gray.astype(np.float32)))


def _border_level(gray):
    """边框亮度中位数：紧裁切时数字可能占满画面，此时全图中位数会当成背景。"""
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    return float(np.median(border.astype(np.float32)))


def _deviation(gray, background, bright_background):
    """把像素换算成"相对背景朝墨迹方向的偏离"，0=背景，1=最深/最亮的墨迹。"""
    values = gray.astype(np.float32)
    if bright_background:
        extreme = float(np.percentile(values, 2))
        span = max(background - extreme, 1.0)
        return np.clip((background - values) / span, 0.0, None)
    extreme = float(np.percentile(values, 98))
    span = max(extreme - background, 1.0)
    return np.clip((values - background) / span, 0.0, None)


def _local_deviation(gray, blurred, bright_background):
    """逐像素模糊背景的偏离：抵消照片的光照渐变与纸面底色。"""
    values = gray.astype(np.float32)
    if bright_background:
        span = max(float(np.percentile(values, 50)) - float(np.percentile(values, 2)), 1.0)
        return np.clip((blurred - values) / span, 0.0, None)
    span = max(float(np.percentile(values, 98)) - float(np.percentile(values, 50)), 1.0)
    return np.clip((values - blurred) / span, 0.0, None)


def foreground_ink(gray):
    """背景归一化后的墨迹图（0..255）；无法分离前景时返回 None。

    用"相对背景的归一化偏离"替代固定 32/255 阈值：低对比照片（灰纸浅笔）与
    白底黑字、黑底白字走同一条对称路径。只有当背景本身被当成前景（覆盖率过高）
    时才退到局部背景，避免把照片的光照不均当成一大片墨迹。
    """
    if int(gray.max()) - int(gray.min()) < 16:
        return None
    # 背景有两个候选：全图中位数（背景占多数，如整幅纸面）与边框中位数
    # （数字占满画面但四周仍有留白，如紧裁切图）。取前景覆盖更小的一个——
    # 数字总比背景小，覆盖过大说明把背景本身当成了墨迹。
    candidates = []
    for background in (_background_level(gray), _border_level(gray)):
        bright_background = background >= 128
        candidates.append((background, bright_background, _deviation(gray, background, bright_background)))
    background, bright_background, deviation = min(
        candidates, key=lambda item: float((item[2] >= 0.25).mean())
    )
    mask = deviation >= 0.25
    if float(mask.mean()) > 0.60:
        # 光照不均/背景偏灰：改用大窗口模糊作为局部背景。
        # 大半径模糊（≥ 笔画宽度的数倍）保证粗笔画内部不会因为背景被减掉而掏空，
        # 因此这里以局部结果为准，不能再与全局结果取最大值（否则污染又被带回来）。
        radius = max(2, min(gray.shape) // 8)
        blurred = np.asarray(
            Image.fromarray(gray).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32
        )
        deviation = _local_deviation(gray, blurred, bright_background)
        mask = deviation >= 0.25
        if float(mask.mean()) > 0.60:
            for threshold in (0.4, 0.55, 0.7):
                candidate = deviation >= threshold
                if float(candidate.mean()) <= 0.60:
                    mask = candidate
                    break
    if not mask.any():
        return None
    ink = np.where(mask, deviation * 255.0, 0.0)
    return np.clip(ink, 0, 255).astype(np.uint8)


def canvas_input(gray):
    """灰度图 → 1×28×28 标准化输入；训练脚本复用同一函数，避免与线上漂移。"""
    ink = foreground_ink(gray)
    if ink is None:
        raise InvalidImage("请先书写数字，不能识别空白图片", category="BLANK_IMAGE")
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


def gray_from_payload(payload, content_type):
    """上传字节 → 灰度 numpy 数组（含 EXIF 方向校正与白底合成）。多位切分也走这里。"""
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError

    if not payload:
        raise InvalidImage("图片不能为空")
    if len(payload) > IMAGE_MAX_BYTES:
        raise InvalidImage("图片超过 5 MiB", 413, "IMAGE_TOO_LARGE")
    if content_type not in ("image/png", "image/jpeg"):
        raise InvalidImage("只接受 PNG/JPEG", 415, "UNSUPPORTED_IMAGE")
    try:
        with Image.open(BytesIO(payload), formats=("PNG", "JPEG")) as image:
            _check_header(image, content_type)
            image.verify()
        with Image.open(BytesIO(payload), formats=("PNG", "JPEG")) as image:
            _check_header(image, content_type)
            image.load()
            oriented = ImageOps.exif_transpose(image)
            rgba = oriented.convert("RGBA")
            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            return np.asarray(Image.alpha_composite(white, rgba).convert("L"))
    except InvalidImage:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidImage("图片尺寸超过限制", 413, "IMAGE_TOO_LARGE") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as exc:
        raise InvalidImage("图片损坏或格式不受支持") from exc


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

    return canvas_input(gray)
