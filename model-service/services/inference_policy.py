"""Experimental selective classification; not a calibrated non-digit detector."""
from collections import deque
from dataclasses import dataclass
import math
from numbers import Real

from services.inference_manifest import BASELINE

POLICY_VERSION = "selective-digit-v1"
REJECTION_MESSAGE = "无法可靠识别该输入，请清空后重新书写单个数字。"


class UncertainPrediction(ValueError):
    def __init__(self, reason):
        super().__init__(REJECTION_MESSAGE)
        self.reason = reason


@dataclass(frozen=True)
class AcceptancePolicy:
    min_confidence: float = 0.90
    min_margin: float = 0.85

    def __post_init__(self):
        for value in (self.min_confidence, self.min_margin):
            if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or not 0 < value <= 1:
                raise ValueError("Acceptance thresholds must be finite numbers in (0, 1]")

    def describe(self):
        return {"version": POLICY_VERSION, "minConfidence": self.min_confidence,
                "minMargin": self.min_margin, "experimental": True}


    @staticmethod
    def _erode(mask):
        import numpy as np

        out = mask.copy()
        out[1:, :] &= mask[:-1, :]
        out[:-1, :] &= mask[1:, :]
        out[:, 1:] &= mask[:, :-1]
        out[:, :-1] &= mask[:, 1:]
        return out

    @classmethod
    def shape_metrics(cls, mask):
        """形状指标：bbox 宽高、最大厚度（腐蚀深度换算）、长宽比。"""
        import numpy as np

        rows, cols = np.nonzero(mask)
        if not len(rows):
            return None
        height = int(rows.max() - rows.min() + 1)
        width = int(cols.max() - cols.min() + 1)
        depth = 0
        current = mask
        while current.any() and depth < 14:
            current = cls._erode(current)
            depth += 1
        thickness = 2 * depth - 1 if depth else 1
        return {"width": width, "height": height, "thickness": thickness,
                "aspect": width / height, "thickRatio": thickness / max(width, height)}

    def _shape_check(self, mask):
        """形状合理性：数字是细长笔画，不是横线、不是实心块、也不是噪点。"""
        metrics = self.shape_metrics(mask)
        if metrics is None:
            raise UncertainPrediction("empty_foreground")
        if max(metrics["width"], metrics["height"]) < 5:
            raise UncertainPrediction("too_small")
        # 横线/宽条：宽高比过大（标定：真实笔迹最大 1.43，横线 20）
        if metrics["aspect"] > 3.0:
            raise UncertainPrediction("too_wide")
        # 实心块：厚度超过最长边的 35%（标定：真实笔迹 ≤0.25，色块 0.95）
        if metrics["thickRatio"] > 0.35:
            raise UncertainPrediction("too_thick")
        return metrics

    def check_input(self, normalized):
        import numpy as np

        data = np.asarray(normalized)
        if data.shape != (1, 28, 28) or not np.isfinite(data).all():
            raise ValueError("Invalid normalized model input")
        # Inspect without mutating pixels or changing the frozen canvas preprocessing.
        mask = (data[0] * BASELINE.std + BASELINE.mean) >= (32 / 255)
        rows, columns = np.nonzero(mask)
        if not len(rows):
            raise UncertainPrediction("empty_foreground")
        height = int(rows.max() - rows.min() + 1)
        width = int(columns.max() - columns.min() + 1)
        fill = len(rows) / (width * height)
        if min(width, height) >= 12 and 0.75 <= width / height <= 1.34 and fill >= 0.90:
            raise UncertainPrediction("solid_fill")
        visited = np.zeros((28, 28), dtype=bool)
        areas = []
        for y, x in zip(rows, columns):
            if visited[y, x]:
                continue
            queue = deque([(int(y), int(x))])
            visited[y, x] = True
            area = 0
            while queue:
                cy, cx = queue.popleft()
                area += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < 28 and 0 <= nx < 28 and mask[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            queue.append((ny, nx))
            areas.append(area)
        significant = sum(area >= max(3, math.ceil(len(rows) * 0.05)) for area in areas)
        if significant >= 4:
            raise UncertainPrediction("fragmented_foreground")
        # 形状判据放在最后：不改变既有输入的拒识理由，只兜住"横线/实心块/噪点"这类漏网输入
        metrics = self._shape_check(mask)
        return {"foregroundPixels": len(rows), "bboxFill": fill, "significantRegions": significant,
                "thickRatio": round(metrics["thickRatio"], 3), "aspect": round(metrics["aspect"], 2)}

    def select(self, probabilities):
        values = list(probabilities)
        if len(values) != 10 or any(isinstance(x, bool) or not isinstance(x, Real) or not math.isfinite(x)
                                    or not 0 <= x <= 1 for x in values) or abs(sum(values) - 1) > 1e-4:
            raise ValueError("Invalid model probabilities")
        order = sorted(range(10), key=lambda index: values[index], reverse=True)
        confidence = float(values[order[0]])
        margin = confidence - float(values[order[1]])
        if confidence < self.min_confidence:
            raise UncertainPrediction("low_score")
        if margin < self.min_margin:
            raise UncertainPrediction("small_margin")
        return order[0], confidence
