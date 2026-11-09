"""Read-only, frozen-policy regression. No training, downloads or torchvision.

Example (run from the source checkout, not the data directory)::
    python -I evaluate_acceptance.py --checkpoint C:/trusted/checkpoint.pt \
        --data-dir C:/existing/MNIST/raw --output C:/existing/runs/new.json

MNIST uses original 28x28 pixels, NOT the real canvas pipeline. Synthetic strokes
use the real canvas preprocessing but are NOT evidence of handwriting accuracy.
"""
import argparse
from collections import Counter
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import random
import struct
import sys

# Isolated mode (-I) excludes the script directory. Add only our source, not data.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from services.inference_manifest import BASELINE
from services.inference_policy import AcceptancePolicy, UncertainPrediction

TEST_COUNT = 10_000
MAX_BATCH_SIZE = 256
MNIST_CASE_LIMIT = 20
SYNTHETIC_SPLITS = (("development", 20261103), ("holdout", 20261104))
SYNTHETIC_WARNING = "PROVISIONAL SYNTHETIC NOT HANDWRITING ACCURACY"


def read_idx(path, *, images):
    """Read one bounded, uncompressed IDX file; reject bad/trailing data."""
    import numpy as np

    header_size = 16 if images else 8
    with Path(path).open("rb") as stream:
        header = stream.read(header_size)
        if len(header) != header_size:
            raise ValueError(f"Truncated IDX header: {path}")
        fields = struct.unpack(">IIII" if images else ">II", header)
        magic, count = fields[:2]
        if magic != (2051 if images else 2049):
            raise ValueError(f"Invalid IDX magic: {path}")
        if not 1 <= count <= TEST_COUNT:
            raise ValueError(f"IDX count must be 1..{TEST_COUNT}: {path}")
        if images and fields[2:] != (28, 28):
            raise ValueError(f"IDX image dimensions must be 28x28: {path}")
        payload_size = count * (28 * 28 if images else 1)
        if os.fstat(stream.fileno()).st_size != header_size + payload_size:
            raise ValueError(f"IDX file size disagrees with header: {path}")
        payload = stream.read(payload_size + 1)
        if len(payload) != payload_size:
            raise ValueError(f"IDX payload size changed: {path}")
    values = np.frombuffer(payload, dtype=np.uint8)
    if not images and bool((values > 9).any()):
        raise ValueError(f"IDX labels must be digits 0..9: {path}")
    values = values.reshape(count, 28, 28) if images else values
    return values, hashlib.sha256(header + payload).hexdigest()


def load_mnist_test(data_dir, limit=None):
    data_dir = Path(data_dir)
    if not data_dir.is_dir():
        raise ValueError("--data-dir must be an existing MNIST/raw directory")
    if limit is not None and not 1 <= limit <= TEST_COUNT:
        raise ValueError(f"--test-limit must be 1..{TEST_COUNT}")
    # Deliberately never read train-* or legacy .pt files, nor download anything.
    images, image_hash = read_idx(data_dir / "t10k-images-idx3-ubyte", images=True)
    labels, label_hash = read_idx(data_dir / "t10k-labels-idx1-ubyte", images=False)
    if len(images) != TEST_COUNT or len(labels) != TEST_COUNT:
        raise ValueError("Official MNIST test requires exactly 10000 images and labels")
    count = TEST_COUNT if limit is None else limit
    return images[:count], labels[:count], {
        "name": "MNIST official test (local uncompressed IDX)",
        "purpose": "final frozen regression only; not calibration or threshold tuning",
        "scope": "full" if limit is None else "subset",
        "subset_selection": None if limit is None else "first N in official test order",
        "source_count": TEST_COUNT, "evaluated_count": count,
        "source_sha256": {"images": image_hash, "labels": label_hash},
        "provenance": "User-supplied local test files; no download or external provenance verification",
        "input": "original 28x28 pixels normalized directly; NOT real canvas preprocessing",
    }


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def outcome_counts(records):
    accepted = [case for case in records if case["accepted_digit"] is not None]
    return {
        "samples": len(records), "accepted": len(accepted),
        "rejected": len(records) - len(accepted),
        "accepted_coverage": _ratio(len(accepted), len(records)),
        "rejection_reasons": dict(sorted(Counter(
            case["rejection_reason"] for case in records if case["rejection_reason"]
        ).items())),
        "baseline_prediction_class_counts": {str(d): sum(case["baseline_digit"] == d for case in records) for d in range(10)},
        "accepted_prediction_class_counts": {str(d): sum(case["accepted_digit"] == d for case in records) for d in range(10)},
    }


def aggregate_metrics(records):
    """Digit-labeled samples only. A rejection is NEVER a correct prediction."""
    summary = outcome_counts(records)
    baseline_correct = sum(case["baseline_digit"] == case["true_digit"] for case in records)
    accepted_correct = sum(case["accepted_digit"] is not None and case["accepted_digit"] == case["true_digit"] for case in records)
    summary.update({
        "baseline_correct": baseline_correct,
        "baseline_accuracy": _ratio(baseline_correct, len(records)),
        "accepted_correct": accepted_correct,
        "accepted_accuracy": _ratio(accepted_correct, summary["accepted"]),
        "correct_over_all_samples": _ratio(accepted_correct, len(records)),
        "reject_valid_rate": _ratio(summary["rejected"], len(records)),
        "accepted_7_9_confusion": {
            "true_7_pred_9": sum(case["true_digit"] == 7 and case["accepted_digit"] == 9 for case in records),
            "true_9_pred_7": sum(case["true_digit"] == 9 and case["accepted_digit"] == 7 for case in records),
        },
        "class_counts": {},
    })
    for digit in range(10):
        cases = [case for case in records if case["true_digit"] == digit]
        accepted = sum(case["accepted_digit"] is not None for case in cases)
        summary["class_counts"][str(digit)] = {
            "samples": len(cases), "accepted": accepted, "rejected": len(cases) - accepted,
            "baseline_correct": sum(case["baseline_digit"] == digit for case in cases),
            "accepted_correct": sum(case["accepted_digit"] == digit for case in cases),
        }
    return summary


def classify_case(policy, normalized, probabilities, *, case_id, true_digit=None):
    # Score even quality-rejected inputs for diagnostics, not to override rejection.
    quality = quality_reason = score_reason = accepted_digit = None
    try:
        quality = policy.check_input(normalized)
    except UncertainPrediction as error:
        quality_reason = error.reason
    try:
        digit, _ = policy.select(probabilities)
        if quality_reason is None:
            accepted_digit = digit
    except UncertainPrediction as error:
        score_reason = error.reason
    order = sorted(range(10), key=lambda digit: probabilities[digit], reverse=True)
    return {
        "id": case_id, "true_digit": true_digit,
        "baseline_digit": order[0], "accepted_digit": accepted_digit,
        "top_two": [{"digit": digit, "score": float(probabilities[digit])} for digit in order[:2]],
        "margin": float(probabilities[order[0]] - probabilities[order[1]]),
        "quality": quality, "quality_reason": quality_reason, "score_reason": score_reason,
        "rejection_reason": quality_reason or score_reason,
    }


def evaluate_mnist(service, policy, images, labels, batch_size):
    import numpy as np

    service.ensure_ready()  # The only model loader: frozen size/digest/weights-only gate.
    torch = service._torch
    records = []
    with torch.inference_mode():
        for start in range(0, len(images), batch_size):
            normalized = images[start:start + batch_size].astype(np.float32) / np.float32(255)
            normalized = np.ascontiguousarray(((normalized - BASELINE.mean) / BASELINE.std)[:, None])
            # Offline diagnostic batching only; do not alter service request behavior.
            logits = service._model(torch.from_numpy(normalized))
            if tuple(logits.shape) != (len(normalized), 10) or not torch.isfinite(logits).all().item():
                raise ValueError("Invalid model output")
            probabilities = torch.softmax(logits, dim=1).tolist()
            for offset, scores in enumerate(probabilities):
                index = start + offset
                records.append(classify_case(policy, normalized[offset], scores,
                                             case_id=f"test-{index}", true_digit=int(labels[index])))
    return {
        "metrics": aggregate_metrics(records),
        "diagnostic_case_selection": f"first {MNIST_CASE_LIMIT} evaluated cases, not error-selected",
        "cases": records[:MNIST_CASE_LIMIT],
    }


# Pen trajectories, not fonts. Coordinates are a unit square; variants perturb
# only generated fixtures, never BASELINE or the real preprocessing geometry.
DIGIT_STROKES = (
    (((.5, .03), (.2, .12), (.1, .5), (.2, .9), (.5, .98), (.8, .88), (.9, .5), (.8, .12), (.5, .03)),),
    (((.3, .2), (.55, .03), (.55, .98)),),
    (((.1, .2), (.3, .03), (.7, .03), (.9, .2), (.85, .4), (.1, .98), (.9, .98)),),
    (((.1, .08), (.7, .03), (.9, .22), (.7, .45), (.4, .48), (.75, .5), (.9, .75), (.7, .97), (.1, .9)),),
    (((.7, .03), (.1, .6), (.95, .6)), ((.7, .03), (.7, .98))),
    (((.85, .03), (.2, .03), (.15, .45), (.65, .42), (.88, .6), (.85, .85), (.6, .98), (.15, .9)),),
    (((.8, .06), (.5, .03), (.2, .35), (.1, .7), (.25, .94), (.6, .98), (.85, .8), (.8, .55), (.5, .45), (.12, .65)),),
    (((.1, .03), (.9, .03), (.4, .98)),),
    (((.5, .03), (.2, .12), (.2, .32), (.8, .65), (.85, .85), (.5, .98), (.15, .85), (.2, .65), (.8, .32), (.8, .12), (.5, .03)),),
    (((.82, .4), (.55, .5), (.2, .42), (.1, .2), (.3, .03), (.65, .03), (.85, .2), (.82, .55), (.65, .98)),),
)


def synthetic_cases(partition, seed):
    """36 fixed bounded cases per split; no fixture or user image files written."""
    from PIL import Image, ImageDraw

    if partition not in {name for name, _ in SYNTHETIC_SPLITS}:
        raise ValueError("Unknown synthetic partition")
    rng = random.Random(seed)
    holdout = partition == "holdout"

    def finish(image, name, category, parameters, digit=None):
        stream = BytesIO()
        image.save(stream, format="PNG")
        return {"id": f"{partition}-{name}", "category": category,
                "true_digit": digit, "parameters": parameters}, stream.getvalue()

    for digit, strokes in enumerate(DIGIT_STROKES):
        for variant in range(2):
            image = Image.new("L", (112, 112), 255)
            draw = ImageDraw.Draw(image)
            angle = rng.uniform(-15, 15) if holdout else rng.uniform(-8, 8)
            width = rng.randint(7, 10) if holdout else rng.randint(5, 8)
            x_scale = rng.uniform(.75, 1.05)
            theta = math.radians(angle)
            for stroke in strokes:
                points = []
                for x, y in stroke:
                    x, y = (x - .5) * 64 * x_scale, (y - .5) * 72
                    points.append((round(56 + x * math.cos(theta) - y * math.sin(theta)),
                                   round(56 + x * math.sin(theta) + y * math.cos(theta))))
                draw.line(points, fill=0, width=width, joint="curve")
            yield finish(image, f"digit-{digit}-{variant}", "digit_stroke",
                         {"variant": variant, "angle_degrees": angle, "stroke_width": width, "x_scale": x_scale}, digit)

    for category in ("dense_crosshatch", "random_scribble", "filled_block", "disjoint_marks"):
        for variant in range(3):
            image = Image.new("L", (112, 112), 255)
            draw = ImageDraw.Draw(image)
            width = rng.randint(3, 6)
            parameters = {"variant": variant, "stroke_width": width}
            if category == "dense_crosshatch":
                step = rng.randint(7, 10)
                parameters["grid_step"] = step
                for pos in range(16, 97, step):
                    draw.line(((16, pos), (96, pos)), fill=0, width=width)
                    draw.line(((pos, 16), (pos, 96)), fill=0, width=width)
            elif category == "random_scribble":
                count = (24 if holdout else 18) + variant
                parameters["vertices"] = count
                draw.line([(rng.randint(16, 96), rng.randint(16, 96)) for _ in range(count)],
                          fill=0, width=width, joint="curve")
            elif category == "filled_block":
                side = rng.randint(38, 74)
                parameters["side"] = side
                draw.rectangle((56 - side // 2, 56 - side // 2, 56 + side // 2, 56 + side // 2), fill=0)
            else:
                radius = rng.randint(3, 6)
                parameters["mark_radius"] = radius
                for x, y in ((24, 24), (88, 24), (24, 88), (88, 88)):
                    x, y = x + rng.randint(-3, 3), y + rng.randint(-3, 3)
                    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=0)
            yield finish(image, f"{category}-{variant}", category, parameters)

    # Ambiguous, NOT labeled as negatives: a single stroke can be a valid 1/7.
    for orientation, endpoints in (
        ("near_vertical", (56, 20, 56, 92)), ("near_horizontal", (20, 56, 92, 56)),
        ("diagonal_up", (20, 92, 92, 20)), ("diagonal_down", (20, 20, 92, 92)),
    ):
        image = Image.new("L", (112, 112), 255)
        points = tuple(value + rng.randint(-4, 4) for value in endpoints)
        width = rng.randint(4, 9)
        ImageDraw.Draw(image).line(points, fill=0, width=width)
        yield finish(image, f"single_line-{orientation}", "ambiguous_single_line",
                     {"orientation": orientation, "endpoints": points, "stroke_width": width})


def evaluate_synthetic(service, policy):
    from services.inference_preprocess import InvalidImage, preprocess_image

    reports = {}
    for partition, seed in SYNTHETIC_SPLITS:
        records = []
        for metadata, png in synthetic_cases(partition, seed):
            try:
                normalized = preprocess_image(png, "image/png")
            except InvalidImage as error:
                record = {"baseline_digit": None, "accepted_digit": None, "top_two": None,
                          "margin": None, "quality": None, "quality_reason": error.category,
                          "score_reason": None, "rejection_reason": f"preprocess:{error.category}"}
            else:
                record = classify_case(policy, normalized, service.probabilities(normalized),
                                       case_id=metadata["id"], true_digit=metadata["true_digit"])
            records.append({**record, **metadata})
        digits = [case for case in records if case["category"] == "digit_stroke"]
        negatives = [case for case in records if case["category"] not in ("digit_stroke", "ambiguous_single_line")]
        lines = [case for case in records if case["category"] == "ambiguous_single_line"]
        reports[partition] = {
            "label": SYNTHETIC_WARNING, "seed": seed, "count": len(records),
            "digit_strokes": aggregate_metrics(digits),
            "negative_probes": outcome_counts(negatives),
            "negative_categories": {name: outcome_counts([case for case in negatives if case["category"] == name])
                                    for name in sorted({case["category"] for case in negatives})},
            "ambiguous_single_lines": outcome_counts(lines), "cases": records,
        }
    return {
        "label": SYNTHETIC_WARNING, "generator": "explicit-pen-trajectories-v1; Pillow PNG; 112x112 white canvas",
        "input": "preprocess_image(PNG) -> InferenceService.probabilities -> frozen AcceptancePolicy",
        "split_caveat": "Separate seeds/geometry variants share templates; holdout is NOT independent human handwriting",
        "single_line_caveat": "Unlabeled ambiguous probes, not counted as invalid inputs or accuracy samples",
        "threshold_tuning": False, "splits": reports,
    }


def validate_output(path):
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"Refusing to overwrite output: {path}")
    if path.suffix.lower() != ".json" or not path.parent.is_dir():
        raise ValueError("--output must be a NEW .json file in an existing directory")
    return path


def write_report(path, report):
    path = validate_output(path)
    content = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)


def bounded_int(maximum):
    def parse(value):
        try:
            number = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError("Expected an integer") from error
        if not 1 <= number <= maximum:
            raise argparse.ArgumentTypeError(f"Expected 1..{maximum}")
        return number
    return parse


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True, help="Absolute existing trusted baseline file")
    parser.add_argument("--data-dir", type=Path, required=True, help="Existing MNIST/raw directory; test IDX only")
    parser.add_argument("--output", type=Path, required=True, help="NEW .json file; existing parent required")
    parser.add_argument("--batch-size", type=bounded_int(MAX_BATCH_SIZE), default=128)
    parser.add_argument("--test-limit", type=bounded_int(TEST_COUNT), help="First N test samples; explicitly labeled subset")
    args = parser.parse_args(argv)
    try:
        if not args.checkpoint.is_absolute() or not args.checkpoint.is_file():
            raise ValueError("--checkpoint must be an absolute existing trusted file")
        output = validate_output(args.output)
        images, labels, dataset = load_mnist_test(args.data_dir, args.test_limit)
        from services.inference import InferenceService

        # Explicit constants: no environment override, search, fitting or tuning.
        policy = AcceptancePolicy(min_confidence=.90, min_margin=.85)
        service = InferenceService(args.checkpoint, policy=policy)
        identity = service.ensure_ready()
        torch = service._torch
        torch.set_num_threads(1)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        service._model.eval()
        mnist = evaluate_mnist(service, policy, images, labels, args.batch_size)
        report = {
            "schema_version": 1, "purpose": "offline final frozen selective-classification regression",
            "policy": policy.describe(), "baseline": identity,
            "parameters": {"checkpoint": str(args.checkpoint.resolve()), "data_dir": str(args.data_dir.resolve()),
                           "batch_size": args.batch_size, "test_limit": args.test_limit,
                           "mean": BASELINE.mean, "std": BASELINE.std, "device": "cpu",
                           "torch_version": torch.__version__, "threads": 1, "torch_seed": 0,
                           "deterministic_algorithms": True},
            "metric_definitions": {
                "baseline_accuracy": "baseline correct / digit-labeled samples, before any rejection",
                "accepted_coverage": "accepted / all samples in this group",
                "accepted_accuracy": "accepted correct / accepted digit-labeled samples; null if none accepted",
                "correct_over_all_samples": "accepted correct / all digit-labeled samples; rejections never correct",
                "reject_valid_rate": "rejected / digit-labeled samples (synthetic labels are only intended strokes)",
                "null_rates": "A zero denominator is JSON null, never NaN or perfect accuracy",
            },
            "mnist_test": {**dataset, **mnist},
            "synthetic": evaluate_synthetic(service, policy),
            "limitations": [
                "Softmax thresholds are uncalibrated, not a reliable non-digit detector; negative probes may be accepted.",
                "MNIST benchmark is not real canvas handwriting. Synthetic scores are provisional, not human handwriting accuracy.",
                "Neither MNIST test nor synthetic development/holdout is used to tune the frozen policy.",
                "The user's original 9 PNG is unavailable: no reproduction or fix of that input is claimed.",
                "No training data read, weights modified, network access, images stored or artifacts uploaded.",
                "Deterministic within this recorded runtime; cross-version/hardware floating-point equality is not promised.",
            ],
        }
        write_report(output, report)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"Evaluation failed: {error}\n")
    print(json.dumps({"output": str(output.resolve()), "mnist_metrics": report["mnist_test"]["metrics"],
                      "synthetic": {name: {"digits": split["digit_strokes"], "negatives": split["negative_probes"],
                                           "ambiguous_lines": split["ambiguous_single_lines"]}
                                    for name, split in report["synthetic"]["splits"].items()}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
