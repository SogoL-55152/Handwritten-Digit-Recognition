"""门牌/街景数据集的批量评测：对比"原点切分"与"检测后再切分"。

用法（在 model-service/ 下运行）：

    python -I tools/scene_eval.py --images D:/Temp/hdr-scene/test --limit 2000 --out D:/Temp/scene-report.json

两种口径都与线上 predict/multi 一致：
- 逐字置信度 >= 0.90 且与次优分差 >= 0.85 视为接受；
- 片段数超过 maxDigits 记为 DIGIT_LIMIT（线上同样不返回结果）。

这是"接受率/行为"评测，不是准确率评测：该数据集没有标签文件。
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


def digits_of(service, segments, ink, mask):
    digits = []
    for segment in segments:
        normalized = normalize_segment(mask, ink, segment)
        if normalized is None:
            continue
        digit, confidence, margin = top_guesses(service.probabilities(normalized))
        digits.append({"digit": digit, "confidence": confidence, "margin": margin})
    return digits


def evaluate(service, files, max_digits: int, detect: bool):
    accepted, lengths, texts, reasons = 0, Counter(), Counter(), Counter()
    confidences, segments_seen = [], []
    for index, path in enumerate(files, start=1):
        gray = np.asarray(Image.open(path).convert("L"))
        try:
            gray = enhance_photo(gray)
        except ValueError:
            reasons["BLANK_IMAGE"] += 1
            continue
        region = "original"
        try:
            if detect:
                region, segments, ink, mask = best_segments(gray, max_digits, segments_of)
            else:
                segments, ink, mask = segments_of(gray)
        except ValueError:
            reasons["BLANK_IMAGE"] += 1
            continue
        if len(segments) > max_digits:
            reasons["DIGIT_LIMIT"] += 1
            continue
        digits = digits_of(service, segments, ink, mask)
        if not digits:
            reasons["EMPTY"] += 1
            continue
        segments_seen.append(len(digits))
        if all(item["confidence"] >= CONFIDENCE_MIN and item["margin"] >= MARGIN_MIN for item in digits):
            accepted += 1
            lengths[len(digits)] += 1
            texts["".join(str(item["digit"]) for item in digits)] += 1
            confidences.extend(item["confidence"] for item in digits)
        else:
            reasons["LOW_CONFIDENCE"] += 1
        if index % 500 == 0:
            print(f"  {index}/{len(files)} 已处理", flush=True)
    total = len(files)
    return {
        "detect": detect,
        "total": total,
        "accepted": accepted,
        "acceptRate": round(accepted / total, 4) if total else 0,
        "lengths": dict(sorted(lengths.items())),
        "topResults": texts.most_common(10),
        "confidenceMean": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "segmentsMean": round(sum(segments_seen) / len(segments_seen), 3) if segments_seen else None,
        "reasons": reasons.most_common(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--max-digits", type=int, default=3)
    parser.add_argument("--model-version", default="w4-task-8-a1")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    files = sorted(args.images.glob("*.png"))[: args.limit]
    if not files:
        raise SystemExit(f"{args.images} 下没有 PNG")
    print(f"图片 {len(files)} 张，模型 {args.model_version}，maxDigits={args.max_digits}", flush=True)
    service = load_service(args.model_version)

    started = time.perf_counter()
    baseline = evaluate(service, files, args.max_digits, detect=False)
    print(f"原点切分：接受率 {baseline['acceptRate']}", flush=True)
    detected = evaluate(service, files, args.max_digits, detect=True)
    print(f"检测后切分：接受率 {detected['acceptRate']}", flush=True)
    report = {"images": str(args.images), "count": len(files), "modelVersion": args.model_version,
              "maxDigits": args.max_digits, "elapsedSeconds": round(time.perf_counter() - started, 1),
              "baseline": baseline, "detected": detected}
    if args.out:
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"报告已写入 {args.out}")
    print(json.dumps({key: report[key] for key in ("count", "elapsedSeconds")}, ensure_ascii=False))
    print(json.dumps({"baseline": baseline["acceptRate"], "detected": detected["acceptRate"],
                      "baseline_reasons": baseline["reasons"], "detected_reasons": detected["reasons"]},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
