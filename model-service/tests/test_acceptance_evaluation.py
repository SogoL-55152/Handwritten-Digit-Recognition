"""Offline evaluator tests; no checkpoint, torch, torchvision or network needed."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys

import numpy as np
import pytest

import evaluate_acceptance as evaluation
from services.inference_manifest import BASELINE
from services.inference_policy import AcceptancePolicy

SOURCE_ROOT = Path(__file__).resolve().parents[1]


def write_idx(path, *, images, count=2, labels=None):
    header = struct.pack(">IIII", 2051, count, 28, 28) if images else struct.pack(">II", 2049, count)
    payload = bytes(count * 784) if images else (bytes(count) if labels is None else bytes(labels))
    path.write_bytes(header + payload)
    return path


@pytest.mark.parametrize("images", [True, False])
def test_strict_idx_valid_and_digest(tmp_path, images):
    path = write_idx(tmp_path / "data.idx", images=images)
    values, digest = evaluation.read_idx(path, images=images)
    assert values.dtype == np.uint8
    assert values.shape == ((2, 28, 28) if images else (2,))
    assert digest == hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("header,payload,images", [
    (b"", b"", True),
    (struct.pack(">II", 2051, 1), b"", True),
    (struct.pack(">IIII", 2049, 1, 28, 28), bytes(784), True),
    (struct.pack(">IIII", 2051, 0, 28, 28), b"", True),
    (struct.pack(">IIII", 2051, 10001, 28, 28), b"", True),
    (struct.pack(">IIII", 2051, 0xFFFFFFFF, 28, 28), b"", True),
    (struct.pack(">IIII", 2051, 1, 27, 28), bytes(756), True),
    (struct.pack(">IIII", 2051, 1, 28, 0xFFFFFFFF), b"", True),
    (struct.pack(">IIII", 2051, 1, 28, 28), bytes(783), True),
    (struct.pack(">IIII", 2051, 1, 28, 28), bytes(785), True),
    (struct.pack(">II", 2051, 1), b"\0", False),
    (struct.pack(">II", 2049, 0), b"", False),
    (struct.pack(">II", 2049, 10001), b"", False),
    (struct.pack(">II", 2049, 2), b"\0", False),
    (struct.pack(">II", 2049, 1), b"\0\0", False),
    (struct.pack(">II", 2049, 1), b"\x0a", False),
    (struct.pack(">II", 2049, 1), b"\xff", False),
])
def test_strict_idx_rejects_malformed(tmp_path, header, payload, images):
    path = tmp_path / "bad.idx"
    path.write_bytes(header + payload)
    with pytest.raises(ValueError):
        evaluation.read_idx(path, images=images)


def test_official_test_only_and_subset_label(tmp_path, monkeypatch):
    write_idx(tmp_path / "t10k-images-idx3-ubyte", images=True, count=10000)
    write_idx(tmp_path / "t10k-labels-idx1-ubyte", images=False, count=10000)
    # If training files were opened their malformed headers would fail parsing.
    (tmp_path / "train-images-idx3-ubyte").write_bytes(b"do not read training")
    (tmp_path / "train-labels-idx1-ubyte").write_bytes(b"do not read training")
    opened = []
    original = evaluation.read_idx

    def tracked(path, **kwargs):
        opened.append(path.name)
        return original(path, **kwargs)

    monkeypatch.setattr(evaluation, "read_idx", tracked)
    images, labels, full = evaluation.load_mnist_test(tmp_path)
    assert len(images) == len(labels) == 10000
    assert full["scope"] == "full"
    images, labels, subset = evaluation.load_mnist_test(tmp_path, 7)
    assert len(images) == len(labels) == subset["evaluated_count"] == 7
    assert subset["scope"] == "subset"
    assert subset["source_count"] == 10000
    assert subset["subset_selection"] == "first N in official test order"
    # Even an explicit limit equal to the full count remains labeled subset.
    assert evaluation.load_mnist_test(tmp_path, 10000)[2]["scope"] == "subset"
    assert set(opened) == {"t10k-images-idx3-ubyte", "t10k-labels-idx1-ubyte"}


@pytest.mark.parametrize("image_count,label_count", [(2, 2), (10000, 9999)])
def test_loader_rejects_small_or_mismatched_test_files(tmp_path, image_count, label_count):
    write_idx(tmp_path / "t10k-images-idx3-ubyte", images=True, count=image_count)
    write_idx(tmp_path / "t10k-labels-idx1-ubyte", images=False, count=label_count)
    with pytest.raises(ValueError, match="exactly 10000"):
        evaluation.load_mnist_test(tmp_path)


@pytest.mark.parametrize("limit", [0, -1, 10001])
def test_loader_limit_is_bounded(tmp_path, limit):
    with pytest.raises(ValueError, match="test-limit"):
        evaluation.load_mnist_test(tmp_path, limit)


def case(truth, baseline, accepted, reason=None):
    return {"true_digit": truth, "baseline_digit": baseline,
            "accepted_digit": accepted, "rejection_reason": reason}


def test_metrics_never_count_rejection_correct_and_keep_7_9_confusion():
    records = [case(7, 7, 7), case(9, 7, 7), case(7, 9, 9),
               case(9, 9, None, "low_score"), case(1, 1, None, "solid_fill")]
    metrics = evaluation.aggregate_metrics(records)
    assert metrics["samples"] == 5
    assert metrics["baseline_correct"] == 3
    assert metrics["baseline_accuracy"] == .6
    assert metrics["accepted_correct"] == 1
    assert metrics["accepted_coverage"] == .6
    assert metrics["accepted_accuracy"] == pytest.approx(1 / 3)
    assert metrics["correct_over_all_samples"] == .2
    assert metrics["reject_valid_rate"] == .4
    assert metrics["accepted_7_9_confusion"] == {"true_7_pred_9": 1, "true_9_pred_7": 1}
    assert metrics["rejection_reasons"] == {"low_score": 1, "solid_fill": 1}
    assert metrics["class_counts"]["9"] == {
        "samples": 2, "accepted": 1, "rejected": 1, "baseline_correct": 1, "accepted_correct": 0,
    }


def test_metrics_none_accepted_are_null_not_perfect_accuracy():
    metrics = evaluation.aggregate_metrics([case(9, 9, None, "small_margin")])
    assert metrics["baseline_accuracy"] == 1
    assert metrics["accepted_accuracy"] is None
    assert metrics["accepted_correct"] == 0
    assert metrics["correct_over_all_samples"] == 0
    assert metrics["accepted_coverage"] == 0
    assert metrics["reject_valid_rate"] == 1
    assert '"accepted_accuracy": null' in json.dumps(metrics, allow_nan=False)


def test_empty_metrics_all_denominators_null():
    metrics = evaluation.aggregate_metrics([])
    for name in ("baseline_accuracy", "accepted_accuracy", "accepted_coverage",
                 "correct_over_all_samples", "reject_valid_rate"):
        assert metrics[name] is None
    assert metrics["samples"] == metrics["accepted_correct"] == 0


def test_diagnostics_keep_quality_priority_and_top_two():
    normalized = np.full((1, 28, 28), (1 - BASELINE.mean) / BASELINE.std, dtype=np.float32)
    scores = [0.] * 10
    scores[7], scores[9] = .51, .49
    record = evaluation.classify_case(AcceptancePolicy(), normalized, scores, case_id="solid", true_digit=9)
    assert record["accepted_digit"] is None
    assert record["quality_reason"] == record["rejection_reason"] == "solid_fill"
    assert record["score_reason"] == "low_score"
    assert record["top_two"] == [{"digit": 7, "score": .51}, {"digit": 9, "score": .49}]
    assert record["margin"] == pytest.approx(.02)


def test_diagnostics_accept_with_no_rejection():
    normalized = np.full((1, 28, 28), -BASELINE.mean / BASELINE.std, dtype=np.float32)
    normalized[0, 4:24, 13:15] = (1 - BASELINE.mean) / BASELINE.std
    scores = [.001] * 10
    scores[1] = .991
    record = evaluation.classify_case(AcceptancePolicy(), normalized, scores, case_id="stroke", true_digit=1)
    assert record["accepted_digit"] == 1
    assert record["quality"]["foregroundPixels"] == 40
    assert record["rejection_reason"] is None


def test_output_is_exclusive_and_json_is_strict(tmp_path):
    output = tmp_path / "report.json"
    evaluation.write_report(output, {"value": None})
    original = output.read_bytes()
    with pytest.raises(FileExistsError):
        evaluation.write_report(output, {"value": 1})
    assert output.read_bytes() == original
    invalid = tmp_path / "invalid.json"
    with pytest.raises(ValueError):
        evaluation.write_report(invalid, {"value": float("nan")})
    assert not invalid.exists()
    with pytest.raises(ValueError):
        evaluation.write_report(tmp_path / "not-json.txt", {})
    with pytest.raises(ValueError):
        evaluation.write_report(tmp_path / "missing-parent" / "report.json", {})


def test_exclusive_open_prevents_output_check_race(tmp_path, monkeypatch):
    output = tmp_path / "race.json"

    def race(path):
        path.write_text("created by someone else", encoding="utf-8")
        return path

    monkeypatch.setattr(evaluation, "validate_output", race)
    with pytest.raises(FileExistsError):
        evaluation.write_report(output, {})
    assert output.read_text(encoding="utf-8") == "created by someone else"


@pytest.mark.parametrize("option,value", [("--batch-size", "0"), ("--batch-size", "257"),
                                           ("--batch-size", "text"), ("--test-limit", "10001")])
def test_cli_rejects_unbounded_options(option, value):
    with pytest.raises(SystemExit) as error:
        evaluation.main(["--checkpoint", "missing.pt", "--data-dir", ".", "--output", "unused.json", option, value])
    assert error.value.code == 2


def test_cli_requires_absolute_checkpoint(tmp_path, capsys):
    with pytest.raises(SystemExit):
        evaluation.main(["--checkpoint", "relative.pt", "--data-dir", str(tmp_path),
                         "--output", str(tmp_path / "output.json")])
    assert "absolute existing trusted file" in capsys.readouterr().err
    assert not (tmp_path / "output.json").exists()


def test_fixtures_are_bounded_deterministic_and_distinct():
    development = list(evaluation.synthetic_cases(*evaluation.SYNTHETIC_SPLITS[0]))
    repeat = list(evaluation.synthetic_cases(*evaluation.SYNTHETIC_SPLITS[0]))
    holdout = list(evaluation.synthetic_cases(*evaluation.SYNTHETIC_SPLITS[1]))
    assert development == repeat
    assert len(development) == len(holdout) == 36
    assert development != holdout
    assert 2 * len(development) + evaluation.MNIST_CASE_LIMIT <= 100
    assert {metadata["true_digit"] for metadata, _ in development if metadata["category"] == "digit_stroke"} == set(range(10))
    assert all(len(png) < 10000 for _, png in development + holdout)
    assert len({metadata["id"] for metadata, _ in development + holdout}) == 72


def test_synthetic_uses_real_preprocessing_and_separates_ambiguous_lines():
    class FakeService:
        calls = 0

        def probabilities(self, normalized):
            self.calls += 1
            assert normalized.shape == (1, 28, 28)
            assert normalized.dtype == np.float32
            assert np.isfinite(normalized).all()
            return [.001] * 9 + [.991]

    service = FakeService()
    report = evaluation.evaluate_synthetic(service, AcceptancePolicy())
    assert service.calls == 72
    assert report["label"] == evaluation.SYNTHETIC_WARNING
    assert report["threshold_tuning"] is False
    for split in report["splits"].values():
        assert split["count"] == 36
        assert split["digit_strokes"]["samples"] == 20
        assert split["negative_probes"]["samples"] == 12
        assert split["ambiguous_single_lines"]["samples"] == 4
        assert "accepted_accuracy" not in split["negative_probes"]
        assert set(split["negative_categories"]) == {"dense_crosshatch", "random_scribble", "filled_block", "disjoint_marks"}


def test_import_parser_and_metrics_do_not_import_torch():
    script = """
import sys
sys.path.insert(0, sys.argv[1])
class NoTorch:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('torch', 'torchvision'):
            raise AssertionError('Unexpected heavyweight import: ' + fullname)
sys.meta_path.insert(0, NoTorch())
import evaluate_acceptance as evaluation
assert evaluation.aggregate_metrics([])['accepted_accuracy'] is None
assert evaluation.bounded_int(256)('128') == 128
assert 'torch' not in sys.modules
assert 'torchvision' not in sys.modules
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE_ROOT)],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
