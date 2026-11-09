"""Decision tests are not handwriting-accuracy or universal OOD evidence."""
import math

import numpy as np
from PIL import Image, ImageDraw
import pytest

from app import create_app
from services.inference import InferenceService, ModelUnavailable
from services.inference_manifest import BASELINE
from services.inference_policy import AcceptancePolicy, UncertainPrediction, REJECTION_MESSAGE


def normalized(pixels):
    return ((np.asarray(pixels, dtype=np.float32) / 255 - BASELINE.mean) / BASELINE.std)[None]


def glyph(kind):
    image = Image.new("L", (28, 28), 0)
    draw = ImageDraw.Draw(image)
    if kind == "1":
        draw.line([(14, 3), (14, 24)], fill=255, width=3)
    elif kind == "8":
        draw.ellipse((7, 2, 21, 15), outline=255, width=3)
        draw.ellipse((7, 13, 21, 26), outline=255, width=3)
    elif kind == "9":
        draw.ellipse((7, 2, 21, 17), outline=255, width=3)
        draw.line([(21, 9), (17, 26)], fill=255, width=3)
    return normalized(image)


def test_geometry_does_not_reject_vertical_one_or_digit_loops():
    policy = AcceptancePolicy()
    for kind in ("1", "8", "9"):
        assert policy.check_input(glyph(kind))["significantRegions"] <= 2


def test_solid_block_and_four_separated_areas_are_declined_without_changing_input():
    policy = AcceptancePolicy()
    solid = Image.new("L", (28, 28), 0)
    ImageDraw.Draw(solid).rectangle((4, 4, 23, 23), fill=255)
    data = normalized(solid)
    original = data.copy()
    with pytest.raises(UncertainPrediction, match=REJECTION_MESSAGE) as result:
        policy.check_input(data)
    assert result.value.reason == "solid_fill"
    np.testing.assert_array_equal(data, original)
    scattered = Image.new("L", (28, 28), 0)
    draw = ImageDraw.Draw(scattered)
    for x, y in ((3, 3), (20, 3), (3, 20), (20, 20)):
        draw.rectangle((x, y, x + 3, y + 3), fill=255)
    with pytest.raises(UncertainPrediction) as result:
        policy.check_input(normalized(scattered))
    assert result.value.reason == "fragmented_foreground"


def test_small_noise_does_not_turn_legitimate_one_into_fragmented_input():
    data = glyph("1")
    noise = data.copy()
    for y, x in ((0, 0), (0, 27), (27, 0), (27, 27)):
        noise[0, y, x] = (1 - BASELINE.mean) / BASELINE.std
    assert AcceptancePolicy().check_input(noise)["significantRegions"] == 1


def test_score_and_margin_decline_uncertainty_not_infrastructure():
    policy = AcceptancePolicy()
    assert policy.select([.95, .05] + [0.] * 8) == (0, .95)
    for scores, reason in (([.89, .11] + [0.] * 8, "low_score"),
                           ([.90, .10] + [0.] * 8, "small_margin"),
                           ([.5, .5] + [0.] * 8, "low_score")):
        with pytest.raises(UncertainPrediction) as result:
            policy.select(scores)
        assert result.value.reason == reason


@pytest.mark.parametrize("value", [False, True, None, "0.9", 0, -1, 1.1, math.nan, math.inf])
def test_invalid_configuration_is_not_silent_acceptance(value):
    with pytest.raises(ValueError):
        AcceptancePolicy(min_confidence=value)
    with pytest.raises(ValueError):
        AcceptancePolicy(min_margin=value)


@pytest.mark.parametrize("scores", [[.95], [math.nan] * 10, [math.inf] * 10, [-.1] * 10,
                                    [True] + [0.] * 9, [.2] * 10, ["0.1"] * 10])
def test_invalid_model_scores_are_not_business_rejections(scores):
    with pytest.raises(ValueError) as result:
        AcceptancePolicy().select(scores)
    assert not isinstance(result.value, UncertainPrediction)


def test_service_uses_acceptance_policy_without_fabricating_prediction():
    service = InferenceService("unused.pt")
    service.ensure_ready = lambda: {}
    service.probabilities = lambda _data: [.90, .10] + [0.] * 8
    with pytest.raises(UncertainPrediction):
        service.predict(glyph("1"))
    service.probabilities = lambda _data: [math.nan] * 10
    with pytest.raises(ModelUnavailable):
        service.predict(glyph("1"))


@pytest.mark.parametrize("key", ["RECOGNITION_MIN_CONFIDENCE", "RECOGNITION_MIN_MARGIN"])
def test_app_rejects_invalid_policy_config_at_startup(key):
    with pytest.raises(ValueError):
        create_app({key: float("nan")})
