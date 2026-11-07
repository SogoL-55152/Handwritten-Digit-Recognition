"""Synthetic images validate preprocessing only, not handwriting accuracy."""
from io import BytesIO
import struct
import zlib

import numpy as np
from PIL import Image, ImageDraw
import pytest

from services.inference_manifest import BASELINE, IMAGE_MAX_BYTES
from services.inference_preprocess import InvalidImage, preprocess_image


def encode(image, image_format="PNG", **kwargs):
    stream = BytesIO()
    image.save(stream, format=image_format, **kwargs)
    return stream.getvalue()


def drawing(size=(80, 100), background="white", foreground="black", mode="RGB"):
    image = Image.new(mode, size, background)
    ImageDraw.Draw(image).line([(size[0] // 2, 20), (size[0] // 2, size[1] - 20)], fill=foreground, width=9)
    return image


def values(normalized):
    return normalized[0] * BASELINE.std + BASELINE.mean


@pytest.mark.parametrize("image_format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_shape_dtype_finite_normalization(image_format, mime):
    normalized = preprocess_image(encode(drawing(), image_format), mime)
    assert normalized.shape == (1, 28, 28)
    assert normalized.dtype == np.float32 and normalized.flags.c_contiguous
    assert np.isfinite(normalized).all()
    assert normalized.min() == pytest.approx(-0.1307 / 0.3081)
    assert values(normalized).max() == pytest.approx(1, abs=0.005)


def test_polarity_equivalence():
    dark = preprocess_image(encode(drawing()), "image/png")
    light = preprocess_image(encode(drawing(background="black", foreground="white")), "image/png")
    np.testing.assert_array_equal(dark, light)


def test_alpha_composited_to_white_before_polarity():
    transparent = drawing(background=(0, 0, 0, 0), foreground=(0, 0, 0, 255), mode="RGBA")
    np.testing.assert_array_equal(
        preprocess_image(encode(transparent), "image/png"),
        preprocess_image(encode(drawing()), "image/png"),
    )


def test_palette_transparency():
    image = drawing().convert("P", palette=Image.Palette.ADAPTIVE, colors=2)
    white_index = image.getpixel((0, 0))
    result = preprocess_image(encode(image, transparency=white_index), "image/png")
    assert values(result).max() > 0.9


def test_exif_orientation_is_applied():
    image = Image.new("RGB", (100, 60), "white")
    ImageDraw.Draw(image).rectangle((15, 25, 85, 33), fill="black")
    exif = image.getexif()
    exif[274] = 6  # clockwise quarter-turn, converting horizontal stroke to vertical
    normalized = preprocess_image(encode(image, "JPEG", exif=exif), "image/jpeg")
    ys, xs = np.nonzero(values(normalized) > 0.1)
    assert ys.max() - ys.min() > 4 * (xs.max() - xs.min())


@pytest.mark.parametrize("size", [(120, 80), (80, 200), (2048, 2048)])
def test_crop_center_and_preserve_aspect(size):
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).rectangle((10, 20, 19, 59), fill="black")  # 10×40 → 5×20
    normalized = preprocess_image(encode(image), "image/png")
    ys, xs = np.nonzero(values(normalized) > 0.5)
    assert (xs.min(), xs.max(), ys.min(), ys.max()) == (11, 15, 4, 23)


def test_single_pixel_stroke_is_not_blank():
    image = Image.new("RGB", (50, 50), "white")
    image.putpixel((25, 25), (0, 0, 0))
    assert values(preprocess_image(encode(image), "image/png")).max() > 0.9


@pytest.mark.parametrize("mode,color", [("RGB", "white"), ("RGB", "black"), ("L", 127), ("RGBA", (0, 0, 0, 0))])
def test_blank_rejected(mode, color):
    with pytest.raises(InvalidImage) as caught:
        preprocess_image(encode(Image.new(mode, (30, 30), color)), "image/png")
    assert caught.value.category == "BLANK_IMAGE"


@pytest.mark.parametrize("payload", [b"", b"not an image", b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n"])
def test_empty_and_malformed(payload):
    with pytest.raises(InvalidImage):
        preprocess_image(payload, "image/png")


@pytest.mark.parametrize("image_format", ["PNG", "JPEG"])
def test_truncated_image(image_format):
    payload = encode(drawing(), image_format)
    with pytest.raises(InvalidImage):
        preprocess_image(payload[:len(payload) // 2], "image/png" if image_format == "PNG" else "image/jpeg")


@pytest.mark.parametrize("mime", ["image/jpeg", "image/gif", "application/octet-stream", ""])
def test_mime_mismatch_and_unsupported(mime):
    with pytest.raises(InvalidImage) as caught:
        preprocess_image(encode(drawing()), mime)
    assert caught.value.status == 415


def test_actual_gif_with_png_mime_rejected():
    with pytest.raises(InvalidImage):
        preprocess_image(encode(drawing(), "GIF"), "image/png")


def test_animated_png_rejected():
    payload = encode(drawing(), save_all=True, append_images=[drawing(background="black", foreground="white")], duration=100)
    with pytest.raises(InvalidImage, match="动画"):
        preprocess_image(payload, "image/png")


def test_byte_limit_checked_before_decode():
    with pytest.raises(InvalidImage) as caught:
        preprocess_image(b"x" * (IMAGE_MAX_BYTES + 1), "image/png")
    assert caught.value.status == 413


@pytest.mark.parametrize("dimensions", [(2049, 1), (1, 2049), (3000, 2000), (100000, 100000)])
def test_dimensions_rejected_from_header_before_load(dimensions, monkeypatch):
    payload = bytearray(encode(drawing()))
    payload[16:24] = struct.pack(">II", *dimensions)
    payload[29:33] = struct.pack(">I", zlib.crc32(payload[12:29]))
    def forbidden_load(*args, **kwargs):
        raise AssertionError("oversized image decoded before limits")
    monkeypatch.setattr(Image.Image, "load", forbidden_load)
    with pytest.raises(InvalidImage) as caught:
        preprocess_image(bytes(payload), "image/png")
    assert caught.value.status == 413


def test_corrupted_png_crc_rejected():
    payload = bytearray(encode(drawing()))
    payload[-5] ^= 0xFF
    with pytest.raises(InvalidImage):
        preprocess_image(bytes(payload), "image/png")


def photo_like(paper, ink, size=(200, 200), gradient=0):
    """模拟相册照片：整幅纸面 + 光照渐变 + 低对比笔迹。"""
    image = Image.new("L", size, paper)
    pixels = image.load()
    if gradient:
        for x in range(size[1]):
            level = max(0, min(255, int(paper + gradient * (x / size[1] - 0.5) * 2)))
            for y in range(size[0]):
                pixels[x, y] = level
    ImageDraw.Draw(image).line([(size[0] // 2, 40), (size[0] // 2, size[1] - 40)], fill=ink, width=14)
    return image


def test_photo_like_low_contrast_keeps_only_the_stroke():
    # 灰纸 150、浅笔 110：旧实现会把整张纸当成墨迹，外接框变成整幅图。
    normalized = preprocess_image(encode(photo_like(150, 110)), "image/png")
    foreground = int((values(normalized) > 0.5).sum())
    assert 20 <= foreground <= 140, foreground
    ys, xs = np.nonzero(values(normalized) > 0.5)
    assert ys.max() - ys.min() > 2 * (xs.max() - xs.min())  # 笔画保持竖长，没有扩散成整块


def test_photo_like_gradient_does_not_become_ink():
    normalized = preprocess_image(encode(photo_like(190, 120, gradient=60)), "image/png")
    assert int((values(normalized) > 0.5).sum()) <= 160


def test_photo_like_polarity_equivalence():
    dark = preprocess_image(encode(photo_like(150, 110)), "image/png")
    light = preprocess_image(encode(photo_like(90, 190)), "image/png")
    np.testing.assert_array_equal(dark, light)
