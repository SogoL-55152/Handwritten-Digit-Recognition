r"""PRE-W3 local sample diagnostics; no capture, training, downloads or calibration.

Run from the source checkout, never the sample directory::
    python -I model-service/evaluate_samples.py --manifest C:/samples/manifest.json \
        --checkpoint C:/trusted/baseline.pt --output model-service/runs/new-session

All three paths are explicit; --output is a NEW directory with an existing parent.
The recommended location is ignored model-service/runs/ (no implicit output).
--save-preprocessed opts into grayscale 28x28 PNGs; originals are never copied.
Manifest: {"samples": [{"id": "s1", "file": "s1.png", "label": 1,
"origin": "synthetic", "writerId": "w1", "captureSessionId": "c1",
"consent": true}]}. Empty samples means missing evidence, not successful evaluation.
Use anonymous IDs (ASCII letters/digits/_/-, <=64 chars), not names or accounts.
Labels are integers 0..9, "non-digit", or "ambiguous". Origins are:
actual-user-board, actual-user-album, browser-scripted, devtools-scripted, synthetic.
At most 200 samples; each image <=5 MiB with header dimensions <=2048 per edge.
Only explicitly listed PNG/JPEG files inside the manifest directory are read.
Symlinks/junctions, duplicate IDs/paths and undeclared fields are refused.
Consent covers local diagnostics of those files, NOT directory scanning or upload.
Origins/labels/consent are declarations, not verified provenance: an unknown UI
screenshot must NOT be called an actual user's original canvas/album image.
Keep inputs and reports private; review before sharing even anonymous metadata.
"""
import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from evaluate_acceptance import aggregate_metrics, classify_case, outcome_counts
from services.inference_manifest import BASELINE, IMAGE_MAX_BYTES
from services.inference_policy import AcceptancePolicy
from services.inference_preprocess import InvalidImage, preprocess_image

ORIGINS = {"actual-user-board": "REAL", "actual-user-album": "REAL",
           "browser-scripted": "SCRIPTED", "devtools-scripted": "SCRIPTED",
           "synthetic": "SYNTHETIC"}
FIELDS = {"id", "file", "label", "origin", "writerId", "captureSessionId", "consent"}
LIMITATIONS = [
    "Origins, labels and consent are self-declared, not independently verified.",
    "Unknown UI screenshots are not actual original user samples; retain honest provenance.",
    "SCRIPTED/SYNTHETIC results are not real-user handwriting accuracy; empty groups have null rates.",
    "Softmax rejection is experimental, not a calibrated non-digit detector; leaks are possible.",
    "Rejections are never correct digit predictions; ambiguous inputs have no accuracy metric.",
    "No original-9 reproduction/fix is claimed without that exact user-supplied input.",
    "No MNIST/training data, network, tuning, original-image copying or automatic capture.",
]


def no_links(path):
    for part in (path, *path.parents):
        if part.is_symlink() or getattr(part.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("Symlinks/junctions/reparse points are refused")


def read_bounded(path, maximum):
    no_links(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise ValueError("Expected a bounded regular file")
    with path.open("rb") as stream:
        payload = stream.read(maximum + 1)
    if len(payload) > maximum:
        raise ValueError("File exceeds size limit")
    return payload


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON fields are refused")
        result[key] = value
    return result


def load_samples(manifest):
    """Validate every declaration and image before any model import/weight load."""
    manifest = Path(manifest).absolute()
    document = json.loads(read_bounded(manifest, 256 * 1024), object_pairs_hook=unique_object)
    if not isinstance(document, dict) or set(document) != {"samples"}:
        raise ValueError("Manifest must contain only a samples list")
    samples = document["samples"]
    if not isinstance(samples, list) or len(samples) > 200:
        raise ValueError("samples must be a list of at most 200 entries")
    if not samples:
        raise ValueError("missing samples: supply explicitly consented original images")
    root, ids, paths, declared = manifest.parent.resolve(), set(), set(), []
    for index, sample in enumerate(samples, 1):
        if not isinstance(sample, dict) or set(sample) != FIELDS:
            raise ValueError(f"Sample {index}: expected exactly the documented fields")
        if any(not isinstance(sample[key], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", sample[key])
               for key in ("id", "writerId", "captureSessionId")):
            raise ValueError(f"Sample {index}: use anonymous identifier tokens")
        label, origin, name = sample["label"], sample["origin"], sample["file"]
        if not (type(label) is int and 0 <= label <= 9 or isinstance(label, str) and label in ("non-digit", "ambiguous")):
            raise ValueError(f"Sample {index}: invalid label")
        if not isinstance(origin, str) or origin not in ORIGINS or sample["consent"] is not True:
            raise ValueError(f"Sample {index}: known origin and consent:true required")
        if (not isinstance(name, str) or not name or len(name) > 512 or "\\" in name or ":" in name
                or any(c in name for c in "\x00\r\n") or PurePosixPath(name).is_absolute()
                or any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in name.split("/"))):
            raise ValueError(f"Sample {index}: file must be a relative path inside the manifest directory")
        path = root / name
        no_links(path)
        if not path.resolve().is_relative_to(root) or path.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            raise ValueError(f"Sample {index}: only local PNG/JPEG paths are allowed")
        key = str(path.resolve()).casefold()
        if sample["id"] in ids or key in paths:
            raise ValueError(f"Sample {index}: duplicate id or image path")
        ids.add(sample["id"])
        paths.add(key)
        declared.append((sample, path))
    from PIL import Image

    prepared = []
    for index, (sample, path) in enumerate(declared, 1):
        payload = read_bounded(path, IMAGE_MAX_BYTES)
        mime = "image/png" if payload.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if payload.startswith(b"\xff\xd8\xff") else None
        try:
            normalized = preprocess_image(payload, mime)  # Header limits precede decode.
        except InvalidImage as error:
            if error.category != "BLANK_IMAGE":
                raise ValueError(f"Sample {index}: image validation failed ({error.category})") from None
            normalized = None  # Valid blank image: report a preprocessing rejection.
        with Image.open(BytesIO(payload), formats=("PNG", "JPEG")) as image:
            width, height = image.size  # Original header dimensions, before EXIF orientation.
        metadata = {key: value for key, value in sample.items() if key != "file"}
        metadata.update({"group": ORIGINS[sample["origin"]], "original_sha256": hashlib.sha256(payload).hexdigest(),
                         "mime_type": mime, "bytes": len(payload), "width": width, "height": height})
        prepared.append((metadata, normalized))
    return prepared


def group_metrics(records):
    groups = {}
    for group in ("REAL", "SCRIPTED", "SYNTHETIC"):
        cases = [case for case in records if case["group"] == group]
        negatives = outcome_counts([case for case in cases if case["label"] == "non-digit"])
        negatives.update({"leak_count": negatives["accepted"], "leak_rate": negatives["accepted_coverage"]})
        groups[group] = {"status": "available" if cases else "missing samples", "samples": len(cases),
                         "digits": aggregate_metrics([case for case in cases if type(case["label"]) is int]),
                         "non_digit": negatives,
                         "ambiguous": outcome_counts([case for case in cases if case["label"] == "ambiguous"])}
    return groups


def validate_output(output):
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("--output must be a NEW directory; existing outputs are refused")
    if not output.parent.is_dir():
        raise ValueError("--output requires an existing parent directory")
    no_links(output.parent)
    return output


def evaluate(manifest, checkpoint, output, *, save_preprocessed=False, service_factory=None):
    output = validate_output(output)
    prepared = load_samples(manifest)
    checkpoint = Path(checkpoint)
    if not checkpoint.is_absolute() or not checkpoint.is_file():
        raise ValueError("--checkpoint must be an absolute existing trusted file")
    if service_factory is None:
        from services.inference import InferenceService
        service_factory = InferenceService
    policy = AcceptancePolicy()  # Frozen defaults; no environment overrides or fitting.
    service = service_factory(checkpoint, policy=policy)
    identity = service.ensure_ready()  # Trusted size/digest gate BEFORE probabilities.
    records = []
    for index, (metadata, normalized) in enumerate(prepared, 1):
        truth = metadata["label"] if type(metadata["label"]) is int else None
        if normalized is None:
            case = {"id": metadata["id"], "true_digit": truth, "baseline_digit": None,
                    "accepted_digit": None, "top_two": None, "margin": None, "quality": None,
                    "quality_reason": "BLANK_IMAGE", "score_reason": None, "rejection_reason": "preprocess:BLANK_IMAGE"}
        else:
            case = classify_case(policy, normalized, service.probabilities(normalized), case_id=metadata["id"], true_digit=truth)
        records.append({**case, **metadata, "baseline": identity, "policy_version": policy.describe()["version"],
                        "preprocessed_file": f"preprocessed/{index:04d}.png" if save_preprocessed and normalized is not None else None})
    report = {"schema_version": 1, "purpose": "PRE-W3 local frozen sample diagnostics",
              "baseline": identity, "policy": policy.describe(), "save_preprocessed": save_preprocessed,
              "groups": group_metrics(records), "cases": records, "limitations": LIMITATIONS,
              "metric_definitions": {"digits": "Digit labels only; rejected digits are never correct; zero denominators are null.",
                                     "non_digit_leak_rate": "Accepted non-digits / non-digit samples; not accuracy.",
                                     "ambiguous": "Outcomes only, never included in digit accuracy or non-digit leak rates.",
                                     "blank_images": "Preprocessing rejection; no baseline/top-two or 28x28 export exists."}}
    content = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    validate_output(output)
    output.mkdir()  # Atomic exclusive reservation; never reuse an existing directory.
    if save_preprocessed:
        import numpy as np
        from PIL import Image

        (output / "preprocessed").mkdir()
        for case, (_, normalized) in zip(records, prepared):
            if case["preprocessed_file"]:
                pixels = np.rint(np.clip(normalized[0] * BASELINE.std + BASELINE.mean, 0, 1) * 255).astype(np.uint8)
                with (output / case["preprocessed_file"]).open("xb") as stream:
                    Image.fromarray(pixels).save(stream, format="PNG")
    with (output / "report.json").open("x", encoding="utf-8") as stream:
        stream.write(content)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, required=True, help="Explicit local samples JSON; no directory scans")
    parser.add_argument("--checkpoint", type=Path, required=True, help="Absolute existing trusted baseline checkpoint")
    parser.add_argument("--output", type=Path, required=True, help="NEW directory, existing parent; recommend model-service/runs/<new-name>")
    parser.add_argument("--save-preprocessed", action="store_true", help="Explicitly save only processed 28x28 PNGs")
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.manifest, args.checkpoint, args.output, save_preprocessed=args.save_preprocessed)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        # JSON/decode/OS exception text can contain private filenames or input fragments.
        message = str(error) if type(error) is ValueError else type(error).__name__
        parser.exit(2, f"Evaluation failed: {message}\n")
    print(json.dumps({"samples": len(report["cases"]), "groups": {key: value["samples"] for key, value in report["groups"].items()}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
