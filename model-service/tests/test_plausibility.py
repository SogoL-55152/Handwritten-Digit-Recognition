"""形状判据：横线、色块、噪点应被拒；正常笔迹应通过。"""
import numpy as np
from PIL import Image, ImageDraw

from services.inference_policy import AcceptancePolicy, UncertainPrediction
from services.inference_preprocess import canvas_input

POLICY = AcceptancePolicy()


def normalized(draw):
    image = Image.new("L", (320, 320), 255)
    draw(ImageDraw.Draw(image))
    return canvas_input(np.asarray(image))


def reason(value):
    try:
        POLICY.check_input(value)
    except UncertainPrediction as error:
        return error.reason
    return None


def test_digit_stroke_passes():
    def draw(pen):
        pen.line([(160, 60), (150, 160), (155, 260)], fill=17, width=17)
    assert reason(normalized(draw)) is None


def test_digit_zero_ring_passes():
    def draw(pen):
        pen.ellipse([100, 80, 220, 240], outline=17, width=16)
    assert reason(normalized(draw)) is None


def test_horizontal_line_is_rejected():
    def draw(pen):
        pen.line([(60, 170), (260, 170)], fill=17, width=14)
    assert reason(normalized(draw)) == "too_wide"


def test_filled_blob_is_rejected():
    def draw(pen):
        pen.ellipse([110, 110, 210, 210], fill=120)
    assert reason(normalized(draw)) == "too_thick"


def test_tiny_mark_is_rejected():
    # 归一化会把小黑点放大成实心块，因此这里只要求"被拒"，不绑定具体理由
    def draw(pen):
        pen.rectangle([150, 150, 153, 153], fill=17)
    assert reason(normalized(draw)) in {"too_small", "solid_fill", "too_thick"}


def test_metrics_expose_thickness_and_aspect():
    mask = np.zeros((28, 28), dtype=bool)
    mask[4:24, 12:16] = True          # 竖直细条：厚 4、高 20
    metrics = AcceptancePolicy.shape_metrics(mask)
    assert metrics["width"] == 4 and metrics["height"] == 20
    assert 0.1 <= metrics["thickRatio"] <= 0.3
    assert metrics["aspect"] < 0.5
