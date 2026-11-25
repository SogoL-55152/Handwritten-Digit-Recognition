"""评估指标：混淆矩阵、每类 P/R/F1、宏/加权平均、错误样本回溯。

用桩模型（按样本序号返回固定预测）避免真的训练，跑得很快。
运行：python -m pytest -c pytest-training.ini tests_training/test_evaluation_metrics.py -q
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch")

from train_canvas_aug import detailed_metrics  # noqa: E402


class StubModel:
    """把"第几条样本"编码进像素里，返回可控的 logits。

    用输入自带的序号查表，所以不受批次切分方式影响（不需要维护游标）。
    """

    def __init__(self, predicted, rank=None):
        self.predicted = np.asarray(predicted, dtype=np.int64)
        self.rank = np.asarray(rank if rank is not None else range(len(predicted)), dtype=np.float64)

    def eval(self):
        return self

    def __call__(self, batch):
        index = batch[:, 0, 0, 0].round().long().numpy()
        logits = torch.zeros((len(index), 10))
        for row, sample in enumerate(index):
            # 同一个预测类，rank 越大置信度越高，用于验证"错误样本按置信度倒序"
            logits[row, int(self.predicted[sample])] = 4.0 + float(self.rank[sample]) * 0.05
        return logits


def inputs_for(count):
    """第 i 条样本在左上角像素存 i，其余为 0。"""
    data = np.zeros((count, 1, 28, 28), dtype=np.float32)
    for i in range(count):
        data[i, 0, 0, 0] = float(i)
    return data


def test_perfect_predictions_have_full_scores():
    labels = np.array([0, 1, 2, 3, 4], dtype=np.int64)
    report = detailed_metrics(StubModel([0, 1, 2, 3, 4]), torch, inputs_for(5), labels, "raw_mnist")
    assert report["accuracy"] == 1.0
    assert report["errorCount"] == 0
    assert report["errors"] == []
    assert report["macro"] == {"precision": 1.0, "recall": 1.0, "f1": 1.0, "classes": 5}
    assert report["weighted"]["f1"] == 1.0
    # 没出现过的类不给分数，而不是算成 0
    untouched = [item for item in report["perClass"] if item["support"] == 0]
    assert len(untouched) == 5
    assert all(item["precision"] is None and item["recall"] is None and item["f1"] is None
               for item in untouched)


def test_confusion_matrix_and_per_class_scores():
    labels = np.array([0, 0, 1, 1, 2], dtype=np.int64)
    predicted = [0, 1, 1, 2, 2]
    report = detailed_metrics(StubModel(predicted), torch, inputs_for(5), labels, "canvas_simulated")

    confusion = report["confusion"]
    assert confusion[0] == [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]
    assert confusion[1] == [0, 1, 1, 0, 0, 0, 0, 0, 0, 0]
    assert confusion[2] == [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]

    assert report["total"] == 5
    assert report["correct"] == 3
    assert report["accuracy"] == 0.6
    assert report["errorCount"] == 2

    by_label = {item["label"]: item for item in report["perClass"]}
    assert by_label[0] == {"label": 0, "support": 2, "predicted": 1, "correct": 1,
                           "precision": 1.0, "recall": 0.5, "f1": 0.6667, "accuracy": 0.5}
    assert (by_label[1]["precision"], by_label[1]["recall"], by_label[1]["f1"]) == (0.5, 0.5, 0.5)
    assert (by_label[2]["precision"], by_label[2]["recall"], by_label[2]["f1"]) == (0.5, 1.0, 0.6667)

    assert report["macro"]["precision"] == pytest.approx(0.6667, abs=1e-4)
    assert report["macro"]["recall"] == pytest.approx(0.6667, abs=1e-4)
    assert report["macro"]["f1"] == pytest.approx(0.6111, abs=1e-4)
    assert report["macro"]["classes"] == 3
    assert report["weighted"]["f1"] == pytest.approx(0.6, abs=1e-4)

    # worst 按 f1 升序，只含有样本的类
    assert report["worst"][0]["label"] == 1
    assert [item["label"] for item in report["worst"]] == [1, 0, 2] or \
           [item["label"] for item in report["worst"]] == [1, 2, 0]


def test_errors_are_sorted_by_confidence_and_capped():
    labels = np.array([0, 0, 0, 0], dtype=np.int64)
    predicted = [1, 2, 3, 4]
    # rank 越大置信度越高：索引 2 的错误最"自信"
    report = detailed_metrics(StubModel(predicted, rank=[0, 1, 9, 5]), torch,
                              inputs_for(4), labels, "photo_simulated", max_errors=2)
    assert report["errorCount"] == 4
    assert len(report["errors"]) == 2
    assert [item["index"] for item in report["errors"]] == [2, 3]
    assert report["errors"][0]["truth"] == 0
    assert report["errors"][0]["predicted"] == 3
    assert report["errors"][0]["confidence"] > report["errors"][1]["confidence"]


def test_error_sheet_is_written_only_when_there_are_errors(tmp_path):
    labels = np.array([0, 0], dtype=np.int64)
    report = detailed_metrics(StubModel([1, 1]), torch, inputs_for(2), labels, "canvas_simulated", tmp_path)
    sheet = tmp_path / "errors-canvas_simulated.png"
    assert report["errorSheet"] == sheet.name
    assert sheet.is_file() and sheet.stat().st_size > 0

    clean_dir = tmp_path / "clean"
    clean_dir.mkdir()
    clean = detailed_metrics(StubModel([0, 0]), torch, inputs_for(2), labels, "canvas_simulated", clean_dir)
    assert "errorSheet" not in clean
    assert list(clean_dir.iterdir()) == []


def test_input_scale_beyond_unit_range_does_not_break_the_sheet(tmp_path):
    """评估输入理论上在 0..1，但裁剪要能容忍越界值，不能抛异常。"""
    labels = np.array([0], dtype=np.int64)
    data = np.zeros((1, 1, 28, 28), dtype=np.float32)
    data[0, 0, 5, 5] = 3.5
    report = detailed_metrics(StubModel([1]), torch, data, labels, "raw_mnist", tmp_path)
    assert report["errorCount"] == 1
    assert (tmp_path / "errors-raw_mnist.png").is_file()
