"""在 SVHN（train.tar.gz / test.tar.gz）上做**正确率**评测。

这两个包是 SVHN（Street View House Numbers）：图片按序号命名，
`digitStruct.mat`（MATLAB 7.3 / HDF5）里有每张图的数字框与标签（label=10 表示 0）。

三种口径：
- baseline：整图直接送多位识别（线上默认）；
- detect：先用 digit_detect 找数字区再切分（新增的 detect=1）；
- oracle：用数据集给的框裁到数字区再识别（检测上限，衡量"如果检测完美能到多少"）。

用法（在 model-service/ 下）：

    python -I tools/svhn_eval.py --images D:/Temp/hdr-scene/test \
        --labels D:/Temp/hdr-svhn/test/digitStruct.mat --limit 1000 --out D:/Temp/svhn-report.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.digit_detect import best_segments  # noqa: E402
from services.image_enhance import enhance_photo  # noqa: E402
from services.inference import Artifact, InferenceService  # noqa: E402
from services.multidigit import normalize_segment, segments_of, top_guesses  # noqa: E402

CONFIDENCE_MIN = 0.90
MARGIN_MIN = 0.85


def load_service(version: str) -> InferenceService:
    registry = json.loads((ROOT / "weights" / "registry.json").read_text(encoding="utf-8"))
    entry = next((item for item in registry["models"] if item["version"] == version), None)
    if entry is None:
        raise SystemExit(f"模型 {version} 不在注册表里")
    artifact = Artifact(Path(ROOT / "weights" / entry["artifact"]), entry["sha256"], entry["sizeBytes"],
                        entry["modelId"], entry["version"], entry["preprocessVersion"])
    return InferenceService(artifact.path, artifact=artifact)


def read_labels(path: Path) -> dict[str, dict]:
    """返回 {文件名: {'text': '351', 'box': (l, t, r, b)}}；数字按左边界排序。"""
    import h5py

    result: dict[str, dict] = {}
    with h5py.File(path, "r") as handle:
        names = handle["digitStruct/name"]
        boxes = handle["digitStruct/bbox"]

        def values_of(dataset):
            # SVHN 的 bbox 字段是对象引用，需要逐个解引用
            return [int(np.array(handle[ref]).squeeze()) if isinstance(ref, h5py.h5r.Reference) else int(ref)
                    for ref in np.ravel(dataset[:])]

        for index in range(names.shape[0]):
            name_ref = names[index, 0]
            name = "".join(chr(int(code)) for code in np.array(handle[name_ref]).flatten())
            box_group = handle[boxes[index, 0]]
            lefts = values_of(box_group["left"])
            tops = values_of(box_group["top"])
            widths = values_of(box_group["width"])
            heights = values_of(box_group["height"])
            labels = values_of(box_group["label"])
            order = sorted(range(len(lefts)), key=lambda position: lefts[position])
            digits = [0 if labels[position] == 10 else labels[position] for position in order]
            digit_boxes = [(int(lefts[position]), int(tops[position]),
                            int(lefts[position] + widths[position]), int(tops[position] + heights[position]))
                           for position in order]
            left = min(lefts)
            top = min(tops)
            right = max(lefts[position] + widths[position] for position in range(len(lefts)))
            bottom = max(tops[position] + heights[position] for position in range(len(tops)))
            result[name] = {"text": "".join(str(digit) for digit in digits),
                            "boxes": digit_boxes,
                            "box": (int(left), int(top), int(right), int(bottom))}
    return result


def digits_of(service, segments, ink, mask):
    digits = []
    for segment in segments:
        normalized = normalize_segment(mask, ink, segment)
        if normalized is None:
            continue
        digit, confidence, margin = top_guesses(service.probabilities(normalized))
        digits.append({"digit": digit, "confidence": confidence, "margin": margin})
    return digits


def predict_text(service, gray, mode: str, max_digits: int, box: tuple | None):
    if mode == "oracle" and box is not None:
        left, top, right, bottom = box
        pad = max(1, int(round((bottom - top) * 0.06)))
        crop = gray[max(0, top - pad):min(gray.shape[0], bottom + pad),
                    max(0, left - pad):min(gray.shape[1], right + pad)]
        if crop.size:
            gray = crop
    if mode == "detect":
        region, segments, ink, mask = best_segments(gray, max_digits, segments_of)
    else:
        region = "original"
        segments, ink, mask = segments_of(gray)
    if len(segments) > max_digits:
        return {"status": "DIGIT_LIMIT", "text": None}
    digits = digits_of(service, segments, ink, mask)
    if not digits:
        return {"status": "EMPTY", "text": None}
    accepted = all(item["confidence"] >= CONFIDENCE_MIN and item["margin"] >= MARGIN_MIN for item in digits)
    return {"status": "ACCEPTED" if accepted else "LOW_CONFIDENCE", "region": region,
            "text": "".join(str(item["digit"]) for item in digits),
            "digits": digits}


def evaluate(service, images: Path, labels: dict[str, dict], limit: int, max_digits: int, modes):
    files = [path for path in sorted(images.glob("*.png")) if path.name in labels][:limit]
    report = {}
    for mode in modes:
        exact, accepted, reasons = 0, 0, Counter()
        by_length = {}
        per_digits_total, per_digits_correct = 0, 0
        rejected_correct = 0
        for index, path in enumerate(files, start=1):
            truth = labels[path.name]
            gray = np.asarray(Image.open(path).convert("L"))
            try:
                gray = enhance_photo(gray)
            except ValueError:
                reasons["BLANK_IMAGE"] += 1
                continue
            try:
                outcome = predict_text(service, gray, mode, max_digits, truth["box"])
            except ValueError:
                reasons["BLANK_IMAGE"] += 1
                continue
            reasons[outcome["status"]] += 1
            bucket = by_length.setdefault(len(truth["text"]), {"total": 0, "accepted": 0, "exact": 0})
            bucket["total"] += 1
            text = outcome["text"]
            if outcome["status"] == "ACCEPTED":
                accepted += 1
                bucket["accepted"] += 1
                if text == truth["text"]:
                    exact += 1
                    bucket["exact"] += 1
                if text is not None:
                    per_digits_total += len(text)
                    per_digits_correct += sum(1 for a, b in zip(text, truth["text"]) if a == b)
            elif text == truth["text"]:
                rejected_correct += 1
            if index % 500 == 0:
                print(f"  [{mode}] {index}/{len(files)}", flush=True)
        total = len(files)
        report[mode] = {
            "total": total,
            "accepted": accepted,
            "acceptedRate": round(accepted / total, 4) if total else 0,
            "exactMatchOnAccepted": round(exact / accepted, 4) if accepted else 0,
            "exactMatchOverall": round(exact / total, 4) if total else 0,
            "digitAccuracyOnAccepted": round(per_digits_correct / per_digits_total, 4) if per_digits_total else 0,
            "correctButRejected": rejected_correct,
            "byLength": {str(key): {"total": value["total"], "accepted": value["accepted"],
                                     "exact": value["exact"],
                                     "exactRate": round(value["exact"] / value["total"], 4) if value["total"] else 0}
                         for key, value in sorted(by_length.items())},
            "statuses": reasons.most_common(),
        }
        print(f"[{mode}] 接受 {accepted}/{total}，接受内完全正确 {report[mode]['exactMatchOnAccepted']}", flush=True)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--max-digits", type=int, default=3)
    parser.add_argument("--model-version", default="w4-task-8-a1")
    parser.add_argument("--modes", default="baseline,detect,oracle")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    labels = read_labels(args.labels)
    service = load_service(args.model_version)
    started = time.perf_counter()
    modes = [mode.strip() for mode in args.modes.split(",") if mode.strip()]
    report = {"images": str(args.images), "limit": args.limit, "modelVersion": args.model_version,
              "maxDigits": args.max_digits, "labels": len(labels),
              "results": evaluate(service, args.images, labels, args.limit, args.max_digits, modes)}
    report["elapsedSeconds"] = round(time.perf_counter() - started, 1)
    if args.out:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"报告已写入 {args.out}")
    print(json.dumps(report["results"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
