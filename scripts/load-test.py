# -*- coding: utf-8 -*-
"""识别链路压测（交接文档 P0-5）。

两个目标：
  backend  走完整业务链路（登录 → 限流 → 识别），得到端到端 QPS/延迟/错误率
  model    直连模型服务 /internal/v2/predict，绕过网关限流，得到纯推理容量

用法：
    python scripts/load-test.py --mode backend --duration 60 --concurrency 8 --users 4
    python scripts/load-test.py --mode model   --duration 60 --concurrency 4

说明：后端对识别有硬限流（全局 240/分钟、每用户 W2_RECOGNITION_PER_MINUTE/分钟），
      所以 backend 模式的 QPS 上限由限流决定，超限返回 429 —— 这是设计行为，不是故障。
"""
import argparse
import json
import statistics
import sys
import threading
import time
import uuid
from pathlib import Path

import requests

RESULTS = []
LOCK = threading.Lock()


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round((pct / 100.0) * (len(ordered) - 1)))
    return ordered[idx]


def record(kind, latency_ms, status, note=""):
    with LOCK:
        RESULTS.append({"kind": kind, "latency_ms": latency_ms, "status": status, "note": note})


def login_users(base, username, password, count, batch=""):
    """注册/登录 count 个压测账号，返回 [(token, workspaceId), ...]。"""
    sessions = []
    for i in range(count):
        name = username if i == 0 else f"{username}L{i}{batch}"
        payload = {"username": name, "password": password, "nickname": f"load{i}"}
        created = requests.post(f"{base}/api/v2/auth/register", json=payload, timeout=20)
        r = requests.post(f"{base}/api/v2/auth/login", json={"username": name, "password": password}, timeout=20)
        if r.status_code != 200:
            print(f"登录 {name} 失败（注册 HTTP {created.status_code}）：{r.text[:120]}")
            continue
        d = r.json()["data"]
        sessions.append((d["token"], d["defaultWorkspaceId"], name))
    return sessions


def run_backend(args, images):
    batch = time.strftime("%H%M%S")
    sessions = login_users(args.base_url, args.username, args.password, args.users, batch)
    if not sessions:
        print("没有可用账号")
        return 1
    print(f"压测账号 {len(sessions)} 个，并发 {args.concurrency}，时长 {args.duration}s")

    deadline = time.time() + args.duration
    counter = {"i": 0}

    def worker(slot):
        session = sessions[slot % len(sessions)]
        token, wid, _ = session
        headers = {"Authorization": f"Bearer {token}"}
        local = 0
        while time.time() < deadline:
            path = images[(counter["i"] + local) % len(images)]
            with LOCK:
                counter["i"] += 1
            started = time.perf_counter()
            try:
                with path.open("rb") as fh:
                    r = requests.post(f"{args.base_url}/api/v2/workspaces/{wid}/recognitions",
                                      headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
                                      data={"source": "WEB"},
                                      files={"image": (path.name, fh, "image/png")}, timeout=60)
                elapsed = (time.perf_counter() - started) * 1000
                record("ok" if r.status_code == 200 else f"http{r.status_code}", elapsed, r.status_code)
            except Exception as exc:  # noqa: BLE001
                elapsed = (time.perf_counter() - started) * 1000
                record("error", elapsed, 0, str(exc)[:80])
            local += 1

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(args.concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return 0


def run_model(args, images):
    token = args.internal_token
    if not token:
        print("model 模式需要 --internal-token（与后端 MODEL_INTERNAL_TOKEN 一致）")
        return 2
    url = f"{args.model_url}/internal/v2/predict"
    print(f"直连模型服务，并发 {args.concurrency}，时长 {args.duration}s")

    deadline = time.time() + args.duration
    counter = {"i": 0}

    def worker():
        local = 0
        while time.time() < deadline:
            path = images[(counter["i"] + local) % len(images)]
            with LOCK:
                counter["i"] += 1
            payload = {
                "workspaceId": "1",
                "requestId": str(uuid.uuid4()),
                "modelId": args.model_id,
                "modelVersion": args.model_version,
                "preprocessVersion": args.preprocess_version,
            }
            started = time.perf_counter()
            try:
                with path.open("rb") as fh:
                    r = requests.post(url, headers={"X-HDR-Internal-Token": token},
                                      data=payload,
                                      files={"image": (path.name, fh, "image/png")}, timeout=60)
                elapsed = (time.perf_counter() - started) * 1000
                record("ok" if r.status_code == 200 else f"http{r.status_code}", elapsed, r.status_code, r.text[:80])
            except Exception as exc:  # noqa: BLE001
                elapsed = (time.perf_counter() - started) * 1000
                record("error", elapsed, 0, str(exc)[:80])
            local += 1

    threads = [threading.Thread(target=worker) for _ in range(args.concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return 0


def summarize(args):
    total = len(RESULTS)
    if total == 0:
        print("没有采样")
        return 1
    ok = [r for r in RESULTS if r["kind"] == "ok"]
    lat_ok = [r["latency_ms"] for r in ok]
    lat_all = [r["latency_ms"] for r in RESULTS]
    kinds = {}
    for r in RESULTS:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1

    print("\n=== 汇总 ===")
    print(f"总请求      {total}")
    print(f"成功 200    {len(ok)}（{len(ok) * 100.0 / total:.1f}%）")
    print(f"吞吐        {len(ok) / args.duration:.2f} 成功请求/秒（{len(ok) * 60 / args.duration:.0f}/分钟）")
    for kind, count in sorted(kinds.items(), key=lambda kv: -kv[1]):
        if kind == "ok":
            continue
        print(f"{kind:11s} {count}（{count * 100.0 / total:.1f}%）")
    if lat_ok:
        print(f"延迟(成功)  平均 {statistics.mean(lat_ok):.1f}ms  P50 {percentile(lat_ok, 50):.1f}ms  "
              f"P95 {percentile(lat_ok, 95):.1f}ms  P99 {percentile(lat_ok, 99):.1f}ms  最大 {max(lat_ok):.1f}ms")
    print(f"延迟(全部)  P95 {percentile(lat_all, 95):.1f}ms")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps({
            "mode": args.mode, "duration_s": args.duration, "concurrency": args.concurrency,
            "total": total, "ok": len(ok), "kinds": kinds,
            "latency_ok": {"mean": round(statistics.mean(lat_ok), 1) if lat_ok else None,
                           "p50": round(percentile(lat_ok, 50), 1),
                           "p95": round(percentile(lat_ok, 95), 1),
                           "p99": round(percentile(lat_ok, 99), 1),
                           "max": round(max(lat_ok), 1) if lat_ok else None},
            "qps_ok": round(len(ok) / args.duration, 2),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["backend", "model"], default="backend")
    ap.add_argument("--base-url", default="http://127.0.0.1:8080")
    ap.add_argument("--model-url", default="http://127.0.0.1:5001")
    ap.add_argument("--username", default="admin")
    ap.add_argument("--password", default="HdrAdmin2026!")
    ap.add_argument("--internal-token", default="")
    ap.add_argument("--model-id", default="mnist-cnn-w1")
    ap.add_argument("--model-version", default="w4-task-8-a1")
    ap.add_argument("--preprocess-version", default="adaptive-mnist-v2")
    ap.add_argument("--images", default=r"D:\HDR-runtime\smoke-digits")
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--users", type=int, default=4)
    ap.add_argument("--json-out", default="")
    args = ap.parse_args()

    images = sorted(Path(args.images).glob("digit-*.png"))
    if not images:
        print(f"{args.images} 下没有 digit-*.png")
        return 2
    # 预热：第一次识别会加载模型，单独打一次避免污染延迟统计
    code = run_model(args, images[:1]) if args.mode == "model" else run_backend_warmup(args, images[0])
    RESULTS.clear()
    code = run_backend(args, images) if args.mode == "backend" else run_model(args, images)
    if code != 0:
        return code
    return summarize(args)


def run_backend_warmup(args, image):
    sessions = login_users(args.base_url, args.username, args.password, 1)
    if not sessions:
        return 1
    token, wid, _ = sessions[0]
    with image.open("rb") as fh:
        requests.post(f"{args.base_url}/api/v2/workspaces/{wid}/recognitions",
                      headers={"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid.uuid4())},
                      data={"source": "WEB"}, files={"image": (image.name, fh, "image/png")}, timeout=60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
