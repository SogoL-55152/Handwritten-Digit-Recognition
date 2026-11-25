# -*- coding: utf-8 -*-
"""训练并发/排队测量（交接文档 P0-6）。

连续提交 N 个训练任务，统计每个任务的排队等待（queued→started）与执行时长，
用来对比 1 个 worker 与 2 个 worker 的差别（worker 用 --pool=solo，一个 worker 同时只跑一个任务）。

用法：
    python scripts/train-concurrency-test.py --dataset-id 5 --version-id 5 --count 2
    # 再加一个 worker 后重跑，对比 startedAt 是否并行
"""
import argparse
import datetime as dt
import sys
import time

import requests

FIELDS = {"epochs": 1, "samples": 1000, "batchSize": 64, "learningRate": 0.001,
          "seed": 42, "photoRatio": 0, "useEmnist": False, "earlyStop": False}


def parse(ts):
    if not ts:
        return None
    text = str(ts).replace("Z", "").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8080")
    ap.add_argument("--username", default="admin")
    ap.add_argument("--password", default="HdrAdmin2026!")
    ap.add_argument("--dataset-id", type=int, required=True)
    ap.add_argument("--version-id", type=int, required=True)
    ap.add_argument("--count", type=int, default=2)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    r = requests.post(f"{args.base_url}/api/v2/auth/login",
                      json={"username": args.username, "password": args.password}, timeout=20)
    r.raise_for_status()
    token = r.json()["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}

    ids = []
    submit_at = dt.datetime.now()
    for i in range(args.count):
        body = dict(FIELDS, epochs=args.epochs, datasetVersionId=args.version_id)
        r = requests.post(f"{args.base_url}/api/v2/admin/training/tasks", headers=headers,
                          params={"datasetId": args.dataset_id}, json=body, timeout=60)
        if r.status_code != 200:
            print(f"提交失败：{r.status_code} {r.text[:200]}")
            return 1
        task = r.json()["data"]
        ids.append(task["id"])
        print(f"提交 task {task['id']}  status={task['status']}")
    print(f"提交 {len(ids)} 个任务，用时 {(dt.datetime.now() - submit_at).total_seconds():.1f}s")

    deadline = time.time() + args.timeout
    states = {}
    while time.time() < deadline:
        done = 0
        for tid in ids:
            r = requests.get(f"{args.base_url}/api/v2/admin/training/tasks/{tid}", headers=headers, timeout=30)
            t = r.json()["data"]
            states[tid] = t
            if t["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
                done += 1
        if done == len(ids):
            break
        time.sleep(3)

    print(f"\n{'task':>5} {'status':<10} {'排队(s)':>8} {'执行(s)':>8} {'总(s)':>7}  模型版本")
    total_wait = total_run = 0.0
    for tid in ids:
        t = states.get(tid, {})
        q, s, f = parse(t.get("queuedAt")), parse(t.get("startedAt")), parse(t.get("finishedAt"))
        wait = (s - q).total_seconds() if q and s else None
        run = (f - s).total_seconds() if s and f else None
        total = (f - q).total_seconds() if q and f else None
        if wait is not None:
            total_wait += wait
        if run is not None:
            total_run += run
        fmt = lambda v: "-" if v is None else f"{v:.1f}"  # noqa: E731
        print(f"{tid:>5} {t.get('status', '?'):<10} {fmt(wait):>8} {fmt(run):>8} {fmt(total):>7}  {t.get('modelVersion') or '-'}")
        if t.get("errorMessage"):
            print(f"        error: {t['errorMessage'][:160]}")

    succeeded = sum(1 for t in states.values() if t.get("status") == "SUCCEEDED")
    print(f"\n成功 {succeeded}/{len(ids)}；累计排队 {total_wait:.1f}s，累计执行 {total_run:.1f}s")
    if total_wait > 0 and total_run > 0:
        print(f"并行度估计：累计执行 / 墙钟时长 = {total_run / (total_run + 0)}（仅供参考，见各任务 startedAt 是否重叠）")
    return 0 if succeeded == len(ids) else 1


if __name__ == "__main__":
    sys.exit(main())
