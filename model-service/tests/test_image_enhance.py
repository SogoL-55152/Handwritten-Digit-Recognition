"""照片增强：二值化、加粗比例与不破坏笔画形状。"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from services.image_enhance import MAX_THICKEN_PX, enhance_photo, ink_mask, thicken_iterations


def synth_photo(digit: str = "7", width: int = 640, height: int = 480, shadow: bool = True) -> np.ndarray:
    image = Image.new("L", (width, height), 150)
    draw = ImageDraw.Draw(image)
    if digit == "7":
        draw.line([(200, 100), (430, 105), (280, 380)], fill=40, width=18, joint="curve")
    elif digit == "1":
        draw.line([(320, 90), (300, 200), (315, 390)], fill=40, width=16)
    else:
        draw.ellipse([200, 110, 430, 370], outline=40, width=18)
    array = np.asarray(image, dtype=np.float32)
    if shadow:
        # 从左到右的光照渐变 + 纸纹噪声：模拟真实照片
        gradient = np.linspace(0.72, 1.12, width)[None, :]
        rng = np.random.default_rng(7)
        noise = rng.normal(0, 4, (height, width))
        array = np.clip(array * gradient + noise, 0, 255)
    return array.astype(np.uint8)


def ink_ratio(image: np.ndarray) -> float:
    return float((image < 128).mean())


def test_enhance_returns_pure_black_and_white():
    result = enhance_photo(synth_photo())
    assert set(np.unique(result)).issubset({0, 255})
    assert 0.002 < ink_ratio(result) < 0.2


def test_enhance_thickens_strokes():
    gray = synth_photo()
    thin = enhance_photo(gray, thicken=0)
    thick = enhance_photo(gray, thicken=2)
    assert ink_ratio(thick) > ink_ratio(thin)
    assert ink_ratio(thick) < ink_ratio(thin) * 3  # 不能糊成一片


def test_enhance_makes_shadowed_photo_binary_and_readable():
    with_shadow = enhance_photo(synth_photo(shadow=True))
    without_shadow = enhance_photo(synth_photo(shadow=False))
    # 阴影不该变成墨迹：两种输入的面积应当接近
    assert abs(ink_ratio(with_shadow) - ink_ratio(without_shadow)) < 0.05


def test_enhance_handles_inverted_white_on_black():
    gray = 255 - synth_photo(digit="1", shadow=False)
    mask = ink_mask(gray)
    assert 0.002 < float(mask.mean()) < 0.2


def test_blank_image_is_rejected():
    flat = np.full((200, 200), 200, dtype=np.uint8)
    try:
        enhance_photo(flat)
    except ValueError as error:
        assert str(error) == "LOW_CONTRAST"
    else:
        raise AssertionError("纯色图应当被拒绝")


def test_thicken_iterations_scale_with_size():
    assert thicken_iterations((200, 200)) == 1
    assert thicken_iterations((480, 640)) == 3
    assert thicken_iterations((80, 80)) == 1
    assert thicken_iterations((3000, 3000)) == MAX_THICKEN_PX
