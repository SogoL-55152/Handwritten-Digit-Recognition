"""Synthetic fixtures and mock scores ONLY; no actual-user evaluation or torch."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import numpy as np
from PIL import Image, ImageDraw
import pytest

import evaluate_samples as evaluation
from services.inference_manifest import BASELINE, IMAGE_MAX_BYTES

SOURCE = Path(__file__).resolve().parents[1]


def image_bytes(fmt="PNG", size=(48, 64), blank=False):
    image = Image.new("RGB", size, "white")
    if not blank:
        ImageDraw.Draw(image).line((24, 10, 24, 50), fill="black", width=4)
    stream = BytesIO()
    image.save(stream, format=fmt)
    return stream.getvalue()


@pytest.fixture
def fixture(tmp_path):
    payload = image_bytes()
    # Private filenames never appear in reports, logs or exported filenames.
    (tmp_path / "private-person.png").write_bytes(payload)
    manifest = tmp_path / "manifest.json"
    sample = {"id": "s1", "file": "private-person.png", "label": 1, "origin": "synthetic",
              "writerId": "w1", "captureSessionId": "c1", "consent": True}
    manifest.write_text(json.dumps({"samples": [sample]}), encoding="utf-8")
    checkpoint = tmp_path / "unused-test-checkpoint.pt"
    checkpoint.write_bytes(b"mock only, never deserialized")
    return manifest, sample, checkpoint, tmp_path / "new-output", payload


def write_manifest(fixture, samples):
    fixture[0].write_text(json.dumps({"samples": samples}), encoding="utf-8")


def run(fixture, scores=None, **kwargs):
    service = Mock()
    service.ensure_ready.return_value = {**BASELINE.identity(), "sha256": BASELINE.sha256}
    service.probabilities.return_value = scores if scores is not None else [.001, .991] + [.001] * 8
    factory = Mock(return_value=service)
    report = evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=factory, **kwargs)
    assert [call[0] for call in service.method_calls] == ["ensure_ready", "probabilities"]
    normalized = service.probabilities.call_args.args[0]
    assert normalized.shape == (1, 28, 28) and normalized.dtype == np.float32
    return report


def test_synthetic_report_metadata_actual_bytes_and_no_original_storage(fixture):
    report = run(fixture)
    case = report["cases"][0]
    assert case["original_sha256"] == hashlib.sha256(fixture[4]).hexdigest()
    assert (case["mime_type"], case["bytes"], case["width"], case["height"]) == ("image/png", len(fixture[4]), 48, 64)
    assert case["baseline_digit"] == case["accepted_digit"] == 1
    assert case["top_two"] == [{"digit": 1, "score": .991}, {"digit": 0, "score": .001}]
    assert case["margin"] == pytest.approx(.99) and case["rejection_reason"] is None
    assert case["baseline"]["sha256"] == BASELINE.sha256
    assert case["baseline"]["preprocessVersion"] == BASELINE.preprocess_version
    assert report["policy"] == {"version": "selective-digit-v1", "minConfidence": .9, "minMargin": .85, "experimental": True}
    assert report["groups"]["REAL"]["digits"]["accepted_accuracy"] is None
    assert report["groups"]["SCRIPTED"]["status"] == "missing samples"
    assert report["groups"]["SYNTHETIC"]["digits"]["samples"] == 1
    assert list(fixture[3].iterdir()) == [fixture[3] / "report.json"]
    content = (fixture[3] / "report.json").read_text(encoding="utf-8")
    assert "private-person" not in content and str(fixture[2]) not in content
    assert json.loads(content) == report


def test_processed_png_requires_explicit_flag_and_is_only_28_pixels(fixture):
    report = run(fixture, save_preprocessed=True)
    png = fixture[3] / report["cases"][0]["preprocessed_file"]
    with Image.open(png) as image:
        assert image.format == "PNG" and image.size == (28, 28) and image.mode == "L"
    assert set(path.relative_to(fixture[3]).as_posix() for path in fixture[3].rglob("*") if path.is_file()) == {"report.json", "preprocessed/0001.png"}


@pytest.mark.parametrize("scores,reason", [([.11, .89] + [0.] * 8, "low_score"), ([.1, .9] + [0.] * 8, "small_margin")])
def test_rejected_correct_baseline_is_never_accepted_correct(fixture, scores, reason):
    report = run(fixture, scores=scores)
    case, metrics = report["cases"][0], report["groups"]["SYNTHETIC"]["digits"]
    assert case["baseline_digit"] == 1 and case["accepted_digit"] is None
    assert case["score_reason"] == case["rejection_reason"] == reason
    assert metrics["baseline_correct"] == 1 and metrics["accepted_correct"] == 0
    assert metrics["accepted_accuracy"] is None and metrics["reject_valid_rate"] == 1


@pytest.mark.parametrize("label,key", [("non-digit", "non_digit"), ("ambiguous", "ambiguous")])
def test_non_digit_and_ambiguous_labels_are_not_digit_truths(fixture, label, key):
    write_manifest(fixture, [{**fixture[1], "label": label}])
    report = run(fixture)
    assert report["cases"][0]["true_digit"] is None
    assert report["groups"]["SYNTHETIC"]["digits"]["samples"] == 0
    assert report["groups"]["SYNTHETIC"][key]["accepted"] == 1


def test_model_failure_and_invalid_scores_leave_no_outputs(fixture):
    with pytest.raises(ValueError, match="probabilities"):
        run(fixture, scores=[float("nan")] * 10)
    assert not fixture[3].exists()
    service = Mock()
    service.ensure_ready.side_effect = RuntimeError("unavailable")
    with pytest.raises(RuntimeError, match="unavailable"):
        evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=Mock(return_value=service))
    service.probabilities.assert_not_called()
    assert not fixture[3].exists()


def test_actual_jpeg_bytes_override_png_filename(fixture):
    payload = image_bytes("JPEG")
    (fixture[0].parent / fixture[1]["file"]).write_bytes(payload)
    case = run(fixture)["cases"][0]
    assert case["mime_type"] == "image/jpeg"
    assert case["original_sha256"] == hashlib.sha256(payload).hexdigest()


@pytest.mark.parametrize("label", [True, -1, 10, 9.0, "9", "other", [], None])
def test_invalid_labels_fail_before_factory(fixture, label):
    write_manifest(fixture, [{**fixture[1], "label": label}])
    factory = Mock()
    with pytest.raises(ValueError, match="label"):
        evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=factory)
    factory.assert_not_called()
    assert not fixture[3].exists()


@pytest.mark.parametrize("change", [{"consent": False}, {"consent": 1}, {"origin": "unknown"}, {"origin": []},
                                     {"writerId": "private@email"}, {"captureSessionId": "../c1"}, {"id": "x" * 65},
                                     {"extra": "private"}, {"file": "../outside.png"}, {"file": "/outside.png"},
                                     {"file": "C:/outside.png"}, {"file": "C:outside.png"}, {"file": "a\\b.png"},
                                     {"file": "a/../b.png"}, {"file": "./a.png"}, {"file": "a//b.png"},
                                     {"file": "a /b.png"}, {"file": "a\x00.png"}, {"file": ""}])
def test_strict_manifest_fields_and_paths(fixture, change):
    write_manifest(fixture, [{**fixture[1], **change}])
    with pytest.raises(ValueError):
        evaluation.load_samples(fixture[0])


@pytest.mark.parametrize("document", [[], {}, {"samples": None}, {"samples": "x"}, {"samples": [{}] * 201},
                                        {"samples": [], "private": "x"}, {"samples": [None]}])
def test_root_schema_is_bounded(fixture, document):
    fixture[0].write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ValueError):
        evaluation.load_samples(fixture[0])


def test_duplicate_json_fields_ids_and_paths(fixture):
    fixture[0].write_text('{"samples": [], "samples": []}', encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate JSON"):
        evaluation.load_samples(fixture[0])
    for second in (fixture[1], {**fixture[1], "id": "s2"}):
        write_manifest(fixture, [fixture[1], second])
        with pytest.raises(ValueError, match="duplicate"):
            evaluation.load_samples(fixture[0])


def test_all_declarations_and_images_validated_before_model(fixture, monkeypatch):
    second = {**fixture[1], "id": "s2", "file": "bad.png"}
    (fixture[0].parent / "bad.png").write_bytes(b"not an image")
    factory = Mock()
    write_manifest(fixture, [fixture[1], second])
    with pytest.raises(ValueError, match="Sample 2: image validation failed"):
        evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=factory)
    factory.assert_not_called()
    assert not fixture[3].exists()
    preprocess = Mock(side_effect=AssertionError("No decoding before all declarations validated"))
    monkeypatch.setattr(evaluation, "preprocess_image", preprocess)
    write_manifest(fixture, [fixture[1], {**second, "label": 99}])
    with pytest.raises(ValueError, match="label"):
        evaluation.load_samples(fixture[0])
    preprocess.assert_not_called()


@pytest.mark.parametrize("kind", ["corrupt", "oversize", "dimensions", "bmp"])
def test_bad_images_fail_without_output_or_weights(fixture, monkeypatch, kind):
    payload = {"corrupt": fixture[4][:50], "oversize": b"x" * (IMAGE_MAX_BYTES + 1),
               "dimensions": image_bytes(size=(2049, 2)), "bmp": image_bytes("BMP")}[kind]
    (fixture[0].parent / fixture[1]["file"]).write_bytes(payload)
    if kind in ("oversize", "dimensions"):
        monkeypatch.setattr(Image.Image, "load", Mock(side_effect=AssertionError("Decode must not run")))
    factory = Mock()
    with pytest.raises(ValueError):
        evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=factory)
    factory.assert_not_called()
    assert not fixture[3].exists()


def test_blank_is_rejection_not_correct_or_model_scored(fixture):
    (fixture[0].parent / fixture[1]["file"]).write_bytes(image_bytes(blank=True))
    service = Mock()
    service.ensure_ready.return_value = BASELINE.identity()
    report = evaluation.evaluate(fixture[0], fixture[2], fixture[3], service_factory=Mock(return_value=service), save_preprocessed=True)
    service.probabilities.assert_not_called()
    assert report["cases"][0]["rejection_reason"] == "preprocess:BLANK_IMAGE"
    assert report["cases"][0]["preprocessed_file"] is None
    digits = report["groups"]["SYNTHETIC"]["digits"]
    assert digits["accepted_correct"] == 0 and digits["reject_valid_rate"] == 1
    assert digits["accepted_accuracy"] is None


def test_groups_do_not_mix_origins_digit_accuracy_leaks_or_ambiguity():
    # Fictional metadata records only, not images falsely presented as actual users.
    def record(group, label, accepted):
        return {"group": group, "label": label, "true_digit": label if type(label) is int else None,
                "baseline_digit": 7, "accepted_digit": accepted, "rejection_reason": None if accepted is not None else "low_score"}
    groups = evaluation.group_metrics([record("REAL", 9, 7), record("REAL", 7, None),
                                      record("SCRIPTED", 7, 7), record("SYNTHETIC", "non-digit", 7),
                                      record("SYNTHETIC", "non-digit", None), record("SYNTHETIC", "ambiguous", 7)])
    assert groups["REAL"]["digits"]["accepted_correct"] == 0
    assert groups["REAL"]["digits"]["accepted_7_9_confusion"]["true_9_pred_7"] == 1
    assert groups["SCRIPTED"]["digits"]["accepted_correct"] == 1
    assert groups["SYNTHETIC"]["digits"]["samples"] == 0
    negatives = groups["SYNTHETIC"]["non_digit"]
    assert negatives["leak_count"] == 1 and negatives["leak_rate"] == .5
    assert "accepted_accuracy" not in negatives
    assert groups["SYNTHETIC"]["ambiguous"]["samples"] == 1


def test_empty_template_cli_fails_missing_samples_before_weight_import(fixture, capsys):
    template = SOURCE.parent / "docs/templates/recognition-samples.example.json"
    assert json.loads(template.read_text(encoding="utf-8")) == {"samples": []}
    with pytest.raises(SystemExit) as error:
        evaluation.main(["--manifest", str(template), "--checkpoint", "missing.pt", "--output", str(fixture[3])])
    assert error.value.code == 2 and "missing samples" in capsys.readouterr().err
    assert not fixture[3].exists()


def test_only_explicit_files_read_and_manifest_size_bounded(fixture, monkeypatch):
    original, reads = evaluation.read_bounded, []
    def tracked(path, maximum):
        reads.append(path.name)
        return original(path, maximum)
    monkeypatch.setattr(evaluation, "read_bounded", tracked)
    (fixture[0].parent / "train-images-idx3-ubyte").write_bytes(b"never read")
    (fixture[0].parent / "not-consented.png").write_bytes(b"never read")
    run(fixture)
    assert reads == ["manifest.json", "private-person.png"]
    fixture[0].write_bytes(b" " * (256 * 1024 + 1))
    with pytest.raises(ValueError, match="bounded"):
        evaluation.load_samples(fixture[0])


def test_symlinks_in_sample_or_parent_and_output_parent_refused(fixture, monkeypatch):
    original = Path.is_symlink
    for forbidden in (fixture[0], fixture[0].parent, fixture[0].parent / fixture[1]["file"]):
        monkeypatch.setattr(Path, "is_symlink", lambda self: self == forbidden or original(self))
        with pytest.raises(ValueError, match="Symlinks"):
            evaluation.load_samples(fixture[0])
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == fixture[3].parent or original(self))
    with pytest.raises(ValueError, match="Symlinks"):
        evaluation.validate_output(fixture[3])


def test_output_existing_and_creation_race_refuse_overwrite(fixture, monkeypatch):
    fixture[3].mkdir()
    (fixture[3] / "keep").write_text("unchanged", encoding="utf-8")
    with pytest.raises(ValueError, match="existing outputs"):
        run(fixture)
    assert (fixture[3] / "keep").read_text(encoding="utf-8") == "unchanged"
    output = fixture[3] / "race"
    monkeypatch.setattr(evaluation, "validate_output", lambda path: (output.mkdir(exist_ok=True) or output))
    factory = Mock()
    factory.return_value.ensure_ready.return_value = BASELINE.identity()
    factory.return_value.probabilities.return_value = [.001, .991] + [.001] * 8
    with pytest.raises(FileExistsError):
        evaluation.evaluate(fixture[0], fixture[2], output, service_factory=factory)
    assert list(output.iterdir()) == []


def test_cli_requires_paths_and_sanitizes_private_filename(fixture, capsys):
    for args in ([], ["--manifest", str(fixture[0])]):
        with pytest.raises(SystemExit) as error:
            evaluation.main(args)
        assert error.value.code == 2
    (fixture[0].parent / fixture[1]["file"]).unlink()
    with pytest.raises(SystemExit) as error:
        evaluation.main(["--manifest", str(fixture[0]), "--checkpoint", str(fixture[2]), "--output", str(fixture[3])])
    assert error.value.code == 2 and "private-person" not in capsys.readouterr().err
    assert not fixture[3].exists()


def test_import_and_invalid_manifest_do_not_import_model_or_torch(fixture):
    write_manifest(fixture, [])
    script = """
import sys
sys.path.insert(0, sys.argv[1])
class NoModel:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('torch', 'torchvision', 'models') or fullname == 'services.inference':
            raise AssertionError('Unexpected model import: ' + fullname)
sys.meta_path.insert(0, NoModel())
import evaluate_samples
assert evaluate_samples.group_metrics([])['REAL']['digits']['accepted_accuracy'] is None
try:
    evaluate_samples.main(['--manifest', sys.argv[2], '--checkpoint', 'missing.pt', '--output', sys.argv[3]])
except SystemExit as error:
    assert error.code == 2
else:
    raise AssertionError('Empty manifest must fail')
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE), str(fixture[0]), str(fixture[3])],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert "missing samples" in result.stderr and not fixture[3].exists()
