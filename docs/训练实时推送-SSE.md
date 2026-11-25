# 训练实时推送（SSE）

> 对应交接文档 P1-11：「训练实时推送改 SSE（现在 2 秒轮询）——已有 ticket 接口」
> 完成日期：2026-11-25

---

## 1. 改动前

| 页面 | 状态 |
|---|---|
| 训练记录（`Training.vue`） | 已经用 SSE，但**轮询一直开着**：`loadAll()` 无条件 `board.start()`，实时连着也每 4 秒拉一次列表 |
| 训练模型 · 监控（`TrainingWizard.vue`） | **每 2 秒轮询**一次任务列表 + 日志，页面上还写着"这是历史任务回放，不是实时推送" |

后端其实早就齐了：`TrainingEventBus`（票据 120 秒、单次有效、25 秒心跳、每用户最多 5 条连接）、
`POST /admin/training/tasks/events/ticket`、`GET /admin/training/tasks/events?ticket=…`，
`TrainingService` 在**创建**和**每次状态变更**时都会 `events.publish(...)`。所以这项工作的重点不是造管道，而是**把前端接对，并且让轮询只在必要时跑**。

## 2. 现在的行为

### 2.1 分工规则（`frontend/src/training/live.js`）

```js
shouldPoll(status)      // status !== 'live' → 需要轮询兜底
pollIntervalMs(status)  // live 时返回 0（不起定时器）
```

只有 `live` 才停轮询：`connecting` / `reconnecting` / `unavailable` 都继续轮询。
这一点是刻意的——如果 SSE 建连失败就停掉轮询，界面会彻底不刷新，比慢一点更糟。

### 2.2 两个页面

- **训练记录**：`liveStatus` + 任务列表任一变化时决定 `board.start()` / `board.stop()`；页面提示改为"推送连着时不轮询；断开或不可用时每 4 秒轮询兜底"。
- **训练模型 · 监控**：接入同一个 SSE 客户端，推来的任务按 id 覆盖进列表；3 秒的定时器只负责
  **拉日志**（SSE 不推日志）和刷新"已运行 N 秒"，并且**只有当 `shouldPoll` 为真时才顺带拉任务列表**。
  监控区多了一行实时状态（`实时推送已连接` / `推送断开，正在重连` / `实时推送不可用，使用轮询兜底`）。

### 2.3 沿用既有安全设计

EventSource 不能带 `Authorization` 头，所以仍是"**已鉴权接口换一次性票据 → 用票据订阅**"：
票据 120 秒过期、用一次即废、每用户最多 5 条连接、25 秒心跳保活、30 分钟自动断开后客户端 4 秒重连。

## 3. 验证

| 项 | 结果 |
|---|---|
| 前端单测 | 新增 `tests/training-live.test.js` **4 项**（只有 live 才停轮询、间隔为 0、状态文案、活跃状态判定）；前端 **310 项**全通过 |
| 构建 | `npm run build` 通过 |
| 端到端（真实部署） | 见下 |

端到端实测（`verify_p111.py`）：

| 场景 | 结果 |
|---|---|
| 换票据 → 订阅 | HTTP 200，**首帧就是 `ready`**，`expiresInSeconds=120` |
| 提交训练任务 | 收到 5 帧：`ready` → `task:QUEUED` → `task:RUNNING` → `task:RUNNING` → **`task:SUCCEEDED`** |
| 同一票据二次订阅 | 第一次 200、第二次 **401**（单次有效） |
| 不带票据订阅 | **401** `未登录或登录已过期` |

## 4. 已知局限

1. **单实例内存广播**：`TrainingEventBus` 的订阅者与票据都在进程内。多实例部署时，连在 A 实例上的浏览器
   收不到 B 实例产生的任务事件；前端会靠轮询兜底，但实时性失效。要多实例需换 Redis Pub/Sub（交接文档已列为后续）。
2. **日志不在推送范围内**：`training:log:<id>` 仍走 REST 拉取（3 秒一次），因此"秒级日志"仍是近实时。
3. **一次 RUNNING 任务可能推多帧**（每轮指标回调都会 `applyState` → `publish`），前端按 id 覆盖，重复帧无副作用。
4. **`live` 判定依赖 `ready` 事件**：若代理缓冲了 SSE（如某些 Nginx 默认配置），首帧迟迟不到，前端会一直按"非 live"轮询——
   功能不受影响，只是退化回轮询。部署时需对 `/api/v2/admin/training/events` 关闭代理缓冲（`proxy_buffering off`）。
