import io

import numpy as np
import pytest
from PIL import Image, ImageDraw

from services.preprocess import preprocess_image


def _image_bytes(background=255, stroke=0, size=(200, 200), draw=True):
    image = Image.new("L", size, background)
    if draw:
        drawer = ImageDraw.Draw(image)
        drawer.line((40, 100, 160, 100), fill=stroke, width=16)
        drawer.line((100, 40, 100, 160), fill=stroke, width=16)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_output_shape_and_dtype():
    result = preprocess_image(_image_bytes())
    assert result.shape == (1, 1, 28, 28)
    assert result.dtype == np.float32


def test_white_and_dark_background_are_normalized_consistently():
    white_bg = preprocess_image(_image_bytes(background=255, stroke=0))
    dark_bg = preprocess_image(_image_bytes(background=0, stroke=255))
    # 反色后两者应高度接近
    assert np.mean(np.abs(white_bg - dark_bg)) < 0.2


def test_blank_image_is_rejected():
    with pytest.raises(ValueError, match="没有可识别的笔画"):
        preprocess_image(_image_bytes(draw=False))


def test_invalid_bytes_are_rejected():
    with pytest.raises(ValueError, match="无法解析图片"):
        preprocess_image(b"not-an-image")
