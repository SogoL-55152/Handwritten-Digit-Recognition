# -*- coding: utf-8 -*-
"""部署验收冒烟（对应交接文档第 13 节）。

覆盖：健康检查 → 登录 → 单字识别 → 数据集导入并生成版本 → 提交训练任务并等待逐轮指标
     → 激活新模型 → 确认识别切换到了新版本。

用法（后端/模型服务/worker 都已在运行时）：
    python scripts/smoke-test.py
    python scripts/smoke-test.py --skip-train          # 只验收识别与导入
    python scripts/smoke-test.py --images D:\\imgs --import-dir D:\\import-set

退出码 0 表示全部通过；非 0 表示有步骤失败（会打印失败原因）。
"""
import argparse
import json
import sys
import time
import uuid
from pathlib import Path

try:
    import requests
except ImportError:
    print("缺少 requests：python -m pip install requests")
    raise SystemExit(2)

REQUIRED_TRAIN_FIELDS = {
    "epochs": 2, "samples": 1000, "batchSize": 64, "learningRate": 0.001,
    "seed": 42, "photoRatio": 0, "useEmnist": False,
}

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8080")
    ap.add_argument("--model-url", default="http://127.0.0.1:5001")
    ap.add_argument("--username", default="admin")
    ap.add_argument("--password", default="HdrAdmin2026!")
    ap.add_argument("--images", default=r"D:\HDR-runtime\smoke-digits", help="画板样式 PNG 目录（文件名含数字标签）")
    ap.add_argument("--import-dir", default=r"D:\HDR-runtime\import-set", help="0-9 子目录的导入集")
    ap.add_argument("--import-limit", type=int, default=120, help="每类最多导入多少张（0 表示跳过导入）")
    ap.add_argument("--train-samples", type=int, default=1000)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--train-timeout", type=int, default=900)
    ap.add_argument("--skip-train", action="store_true")
    ap.add_argument("--skip-import", action="store_true")
    ap.add_argument("--json-out", default="")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")

    # 1. 健康检查
    try:
        r = requests.get(f"{base}/api/health", timeout=15)
        record("后端健康 /api/health", r.status_code == 200 and r.json()["data"]["status"] == "UP", r.text[:120])
    except Exception as exc:  # noqa: BLE001
        record("后端健康 /api/health", False, str(exc))
        return finish(args)
    try:
        r = requests.get(f"{args.model_url.rstrip('/')}/api/v1/health", timeout=15)
        record("模型服务健康 /api/v1/health", r.status_code == 200, r.text[:120])
    except Exception as exc:  # noqa: BLE001
        record("模型服务健康 /api/v1/health", False, str(exc))
        return finish(args)

    # 2. 注册（已存在则忽略）并登录
    requests.post(f"{base}/api/v2/auth/register",
                  json={"username": args.username, "password": args.password, "nickname": "验收账号"},
                  timeout=20)
    r = requests.post(f"{base}/api/v2/auth/login",
                      json={"username": args.username, "password": args.password}, timeout=20)
    if not record("登录", r.status_code == 200, r.text[:160]):
        return finish(args)
    session = r.json()["data"]
    token, wid = session["token"], session["defaultWorkspaceId"]
    role = session["user"]["platformRole"]
    headers = {"Authorization": f"Bearer {token}"}
    print(f"        账号={args.username} 角色={role} 默认空间={wid}")

    # 3. 单字识别
    images = sorted(Path(args.images).glob("digit-*.png"))
    if not images:
        record("单字识别", False, f"{args.images} 下没有 digit-*.png")
        return finish(args)
    hits, details = 0, []
    for path in images:
        expected = path.stem.split("-")[-1]
        with path.open("rb") as fh:
            r = requests.post(f"{base}/api/v2/workspaces/{wid}/recognitions",
                              headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
                              data={"source": "WEB"},
                              files={"image": (path.name, fh, "image/png")}, timeout=120)
        if r.status_code != 200:
            details.append(f"{path.name}:HTTP{r.status_code}")
            continue
        data = r.json()["data"]
        if str(data.get("digit")) == expected:
            hits += 1
        details.append(f"{path.name}->{data.get('digit')}({data.get('confidence'):.3f},{data.get('processingMs')}ms)")
    record(f"单字识别 {hits}/{len(images)}", hits == len(images), "; ".join(details))

    # 4. 数据集导入 + 版本
    version_id = None
    if args.skip_import or args.import_limit <= 0:
        print("[SKIP] 数据集导入（--skip-import）")
    else:
        import_dir = Path(args.import_dir)
        r = requests.post(f"{base}/api/v2/workspaces/{wid}/datasets", headers=headers,
                          json={"name": f"验收数据集-{time.strftime('%m%d-%H%M%S')}",
                                "description": "smoke-test.py 自动创建"}, timeout=30)
        if not record("新建数据集", r.status_code in (200, 201), r.text[:160]):
            return finish(args)
        ds = r.json()["data"]
        ds_id = ds.get("id") or ds.get("datasetId")

        r = requests.post(f"{base}/api/v2/workspaces/{wid}/datasets/import-wizard/preview", headers=headers,
                          json={"directory": str(import_dir)}, timeout=300)
        ok = r.status_code == 200
        detail = r.text[:200]
        if ok:
            p = r.json()["data"]
            detail = f"format={p['format']} total={p['total']} skipped={p['skipped']}"
        if not record("导入预览", ok, detail):
            return finish(args)

        r = requests.post(f"{base}/api/v2/workspaces/{wid}/datasets/{ds_id}/import-wizard", headers=headers,
                          json={"directory": str(import_dir)}, timeout=1800)
        ok = r.status_code == 200
        detail = r.text[:200]
        if ok:
            d = r.json()["data"]
            detail = f"imported={d['imported']} duplicates={d['duplicates']} failed={d['failed']}"
        if not record("导入提交", ok, detail):
            return finish(args)

        r = requests.post(f"{base}/api/v2/workspaces/{wid}/datasets/{ds_id}/versions", headers=headers,
                          json={"version": "v1", "splitRule": "RANDOM", "valPercent": 10, "testPercent": 10},
                          timeout=600)
        ok = r.status_code == 200
        detail = r.text[:200]
        if ok:
            v = r.json()["data"]
            version_id = v["id"]
            detail = f"version={v['version']} samples={v['sampleCount']} writers={v['writerCount']} status={v['status']}"
        if not record("生成数据集版本", ok, detail):
            return finish(args)

    # 5. 训练
    if args.skip_train or version_id is None:
        print("[SKIP] 训练（--skip-train 或没有新版本）")
    else:
        body = dict(REQUIRED_TRAIN_FIELDS)
        body["epochs"] = args.epochs
        body["samples"] = max(args.train_samples, 1000)
        body["datasetVersionId"] = int(version_id)
        r = requests.post(f"{base}/api/v2/admin/training/tasks", headers=headers,
                          params={"datasetId": ds_id}, json=body, timeout=120)
        if not record("提交训练任务", r.status_code == 200, r.text[:200]):
            return finish(args)
        task = r.json()["data"]
        tid = task["id"]
        print(f"        taskId={tid} status={task['status']}")

        deadline = time.time() + args.train_timeout
        task = None
        while time.time() < deadline:
            r = requests.get(f"{base}/api/v2/admin/training/tasks/{tid}", headers=headers, timeout=30)
            task = r.json()["data"]
            if task["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
                break
            time.sleep(3)
        ok = task is not None and task["status"] == "SUCCEEDED"
        metrics = (task or {}).get("metrics") or {}
        epochs_seen = len(metrics.get("epochs") or metrics.get("history") or []) if isinstance(metrics, dict) else 0
        record("训练完成", ok, f"status={(task or {}).get('status')} metrics 轮数={epochs_seen} "
                              f"error={(task or {}).get('errorMessage')}")
        if not ok:
            r = requests.get(f"{base}/api/v2/admin/training/tasks/{tid}/logs", headers=headers, timeout=30)
            print("        训练日志尾部：", r.text[-600:])
            return finish(args)

        # 6. 激活新模型并确认切换
        new_version = task.get("modelVersion")
        r = requests.get(f"{base}/api/v2/admin/models", headers=headers, timeout=30)
        models = r.json()["data"]
        target = next((m for m in models if m["version"] == new_version), None)
        if not record("新模型已登记", target is not None, f"modelVersion={new_version}"):
            return finish(args)
        r = requests.post(f"{base}/api/v2/admin/models/{target['id']}/activate", headers=headers, timeout=30)
        record("激活新模型", r.status_code == 200, r.text[:160])

        sample = images[0]
        with sample.open("rb") as fh:
            r = requests.post(f"{base}/api/v2/workspaces/{wid}/recognitions",
                              headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
                              data={"source": "WEB"},
                              files={"image": (sample.name, fh, "image/png")}, timeout=120)
        used = r.json()["data"].get("modelVersion") if r.status_code == 200 else None
        record("识别使用新模型版本", used == new_version, f"期望={new_version} 实际={used}")

    return finish(args)


def finish(args):
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("\n结果：%d/%d 通过" % (passed, total))
    for name, ok, detail in results:
        if not ok:
            print("  失败：%s — %s" % (name, detail))
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps({"passed": passed, "total": total,
                        "results": [{"name": n, "ok": o, "detail": d} for n, o, d in results]},
                       ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
