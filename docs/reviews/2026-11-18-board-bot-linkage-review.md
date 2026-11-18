# Trello 面板与 DS-Bot 双向联动复核

- 日期：2026-11-18
- 基准：`main` HEAD `04ba5398` 加本轮工作区改动
- 依据：
  - `docs/plans/2026-11-16-board-lifecycle-releases.md`（状态模型、Bot 双向联动与 proposal、Scheduler、API、UI）
  - `docs/plans/2026-11-17-release-lifecycle-closure.md`（看板 → DS-Bot 同步、调度与执行、发布门禁与总结）
  - `docs/plans/2026-11-13-continuous-task-boards.md`（持久任务账本、调度回执与不确定结果）
- 方法：把设计条款拆成“方向 + 行为”，逐条对照当前 host、client、fixture 和 e2e；符合的写证据，缺失的补齐，属于产品边界的改写为边界。

## 1. 复核矩阵

| 方向 | 设计条款 | 实现与证据 | 结论 |
|---|---|---|---|
| 用户 → 看板 | 内容/状态/负责人/Release 归属编辑走确认层、revision 与 activity | `task-board.js` 的确认层与 revision fence；host tests | 符合 |
| 用户 → Bot（活跃任务） | 活跃任务的内容修改生成 change-request 任务，含 before/after，依赖源任务 | `task-store.mjs` 的 `proposeChange`；`board-service.js` 的任务提示词；`board-service.test.mjs` | 符合（描述/类型；见第 3 节边界） |
| 用户 → Bot（调度） | `listSchedule` 按 running release、releasePosition、普通任务排序；queued/draft/published 不派发 | `task-store.mjs` 的 `listSchedule`；`task-driver.mjs`；host tests | 符合 |
| 看板 → 群/PM | 卡片内容、状态、负责人、Release 归属变化通知 Release 群日志与 PM 私聊 | `board-service.js` 的 `releaseSyncTypes`、`notifyRelease`、`notifyBoardChange`；`board-service.test.mjs` 中编辑/评论/附件/归属/确认 proposal 用例 | 符合 |
| 看板 → 群/PM | 发布或失败时通知 Release 群与 PM，并生成 Markdown/HTML 总结报告 | `checkAndReportRelease`、`releaseReport`；lifecycle e2e；本轮补齐自动发布路径（2.2） | 补齐后符合 |
| Bot → 看板（写法） | Bot 不能直接写内容/状态；`propose` 只写 proposal，用户确认后才应用 | `workflow.mjs` 的 `propose`/`proposal`；`store.decideProposal` 同事务应用；`workflow-proposal.test.mjs` | 符合 |
| Bot → 看板（范围） | proposal 支持 create/update/status/release；只能为自己可见的任务/scope 提议 | `workflow.mjs`；`board-service.test.mjs` | 符合 |
| Bot → 看板（确认） | 确认时再次检查 owner/reviewer 权限与当前 revision | revision 由 baseRevision + store CAS 检查；权限复核本轮补齐（2.1） | 补齐后符合 |
| Bot → 看板（幂等） | 一个 operation id 对应一次精确的逻辑请求 | 本轮补齐不同内容复用同一 operation id 的冲突检测（2.4） | 补齐后符合 |
| Bot → 看板（读取） | `board_task show` 是 Bot 读取任务的入口；change-request 的 before/after 必须可复查 | 本轮补齐 show 的卡片内容与变更 before/after（2.3） | 补齐后符合 |
| Bot → 看板（计划） | `board_task plan` 只允许该 Release 的 PM 或群管理员 | `boardPlanRelease` 权限检查；本轮新增拒绝/允许测试（2.5） | 符合 |
| Bot 执行 → 看板 | start/report/review/block/unblock 保留证据链并产生状态与 activity | `task-store.mjs` 命令、`workflow.mjs`、`task-driver.mjs`；host tests | 符合 |
| 调度 → Bot | 执行/复核 promt 投递到 owner/reviewer 的私有任务会话，并在准入前后复验授权 | `board-service.js` 的 admission；`board-service.test.mjs` 派发用例 | 符合 |
| 看板 → 调度 | 发布后自动启动下一个 queued Release，并尽快派发其 item | `task-store.mjs` 的 `reconcileRelease`/`checkRelease`；本轮补齐发布后的调度唤醒（2.2） | 补齐后符合 |
| 看板 → 用户 | Changes 面板显示 pending proposal 的 diff，确认/拒绝；未读 badge | `task-board.js` 的 `ProposalPanel`、`proposalUnread`；browser fixture | 符合 |
| 看板 → 用户 | Release 详情显示门禁、Check 与总结报告入口；HTML 报告不注入 UI | `task-board.js` 的 `ReleaseDetailDialog`/`ReleaseReportDialog`；lifecycle e2e | 符合 |
| 看板 ↔ 归档 | 归档卡不参与调度；不能从归档视图再次调度 | `listSchedule` 排除归档；本轮补齐 `schedule` 拒绝与命令投影排除（2.6） | 补齐后符合 |

## 2. 本轮补齐的缺口

### 2.1 确认 proposal 时没有复核提案 Bot 的当前权限

- 问题：设计要求“确认时再次检查 owner/reviewer 权限和当前 revision”。revision 已由 baseRevision 与 store CAS 检查，但提案 Bot 在提议后被移出群、删除或设为私有 Bot 时，任务 revision 不变，原实现仍允许用户确认。
- 修复：`board-service.js` 增加 `proposerStillAuthorized`，确认前检查：Bot 仍存在且不是私有 Bot；对已有卡片仍是 owner/reviewer，且仍是对应 room 的成员；对新建卡片，提案 scope 仍是该 Bot 可见的 room 或它自己的个人看板。不满足时拒绝确认，proposal 保持 pending，用户可拒绝。
- 证据：`board-service.test.mjs` 的 `confirming a Bot proposal rechecks that the proposing Bot still holds its role` 与 `confirming a new-card proposal rechecks that the proposing Bot can still see the board`。

### 2.2 review 直接发布 Release 时跳过了报告、通知与调度唤醒

- 问题：`task-store` 在最后一条 review 通过、且四道门禁已通过时，会在任务事务里直接把 Release 发布并自动启动下一个 queued Release（`reconcileRelease`）。这条路径绕过了 `board-service` 的 `checkRelease`，因此不生成 Markdown/HTML 总结报告、不通知 Release 群与 PM；同时 `board-release-check`/monitor 发布后也没有唤醒调度器派发下一个 Release 的 item。
- 修复：
  - `task-store.mjs` 新增 `listPublishedWithoutReport()`；
  - `board-service.js` 新增 `ensureReleaseReport`（幂等、并发去重）与 `sweepReleaseReports`；
  - Bot 命令结束时（`board_task` 的 wake 回调）先扫描并补写报告，让 review 触发的发布立即生成报告并通知；
  - monitor 周期扫描“已发布但没有报告”的 Release 作为兜底；
  - `checkAndReportRelease` 发布分支复用 `ensureReleaseReport`，并在发布（含自动启动下一个 Release）后唤醒调度器；monitor 补写报告后同样唤醒调度器。
- 证据：`board-service.test.mjs` 的 `a release published by its last review still writes the report and tells the project manager`（设置 1 秒 monitor 间隔，走真实 review → 自动发布 → sweep 报告/通知）。

### 2.3 `board_task show` 读不到卡片内容与变更 before/after

- 问题：设计把 change-request 的 before/after 交给 owner 复查，但 Bot 的 show 投影只有标题、验收、依赖、证据等；描述、类型、标签、截止、检查项和 change 记录都不在投影里。派发提示携带一次后，Bot 在换段、重启或再次 show 时无法恢复这些内容。
- 修复：`workflow.mjs` 的 `projectDirect` 增加 `description`、`type`、`labels`、`dueDate`、`dueComplete`、`checklist`，以及 `change`（sourceTaskId/sourceRevision/before/after）；变更记录中的 dependencies 沿用与用户投影一致的可见性过滤，避免跨看板泄露 ID。
- 证据：`workflow-proposal.test.mjs` 的 `board_task show returns the card content and the change before/after a Bot must reconcile`。

### 2.4 复用同一 operation id 提交不同内容时会静默返回旧 proposal

- 问题：`propose` 在发现同 id 的既有 proposal 时直接返回，不比较内容。Bot 用同一个 operation id 重试但改了内容时，会收到旧 proposal，误以为自己新的请求已登记。
- 修复：先构造完整 proposal，再与既有记录比较 kind/scope/taskId/baseRevision/command/before/after/note；完全一致时按幂等返回既有记录，不一致时报 `operation id conflict`。工具参数说明同步写清 update/status/release 各自接受的字段。
- 证据：`workflow-proposal.test.mjs` 的 `a reused proposal operation id with different content is refused`。

### 2.5 补充 plan 权限的独立验证

- 问题：`board_task plan` 的 PM/群管理员限制此前只有 e2e 正向路径覆盖，没有非 PM 拒绝的独立用例。
- 修复：新增 `only the release project manager may import a lifecycle plan`，非 PM 调用被拒绝，PM 调用成功生成任务链。

### 2.6 归档卡片仍可被调度

- 问题：归档允许 `waiting` 卡片；此状态下 `Schedule Bot` 仍出现在命令列表，store 也不拒绝。调度结果会写入 action，但 `listSchedule` 排除归档，卡片变成“ready 但永远不会派发、也不在工作流视图里”的孤儿。
- 修复：`task-store.mjs` 的 `schedule` 拒绝 `archivedAt` 非空的卡片；`board-api.js` 的 `canSchedule` 增加归档判断，归档视图不再显示 Schedule。
- 证据：`task-store.test.mjs` 的归档用例新增调度拒绝断言；`board-service.test.mjs` 的 `an archived card is not offered for scheduling and cannot be scheduled`。

### 2.7 变更请求的 PM 通知语义

- 问题：用户修改活跃任务时，host 生成 change-request 任务、源卡片不变；但发给 PM/群的通知仍写作“源卡片发生 change 类型变化”，与事实不符。
- 修复：`mutate` 检测到返回的是 change-request 任务时，通知改为 `change-request · changeTaskId=… · sourceTaskId=… · fields=…`；确认 Bot proposal 触发 change-request 时同样带上新任务信息。

## 3. 明确边界（设计允许或本任务之外）

- 卡片呈现字段（标签、截止日期、检查项）在活跃任务上直接更新，不生成 change-request；验收相关字段（标题、负责人、验收标准、依赖、描述、类型）才走 change-request 或 proposal。设计中的“内容变化”按影响验收的内容理解。
- Bot 的 `update` proposal 覆盖卡片呈现字段（描述、类型、标签、截止、检查项）；标题、负责人、验收标准、依赖的变更保持用户编辑路径（活跃任务生成 change-request），不对 Bot 开放，以免责任变更绕过确认与返工链路。
- 发布只记录版本、门禁证据并生成报告；真实 git tag/部署仍由 Bot 的外部工具执行，host 不自动创建部署任务。
- 从 Release 群会话发起的新卡片 proposal 落在该群自己的看板；Release 项的执行仍由派发到 owner 私有任务会话的提示驱动，群用于协调。
- 普通（非 Release）卡片的变化不通知项目群/PM；群与 PM 的联动仅针对 Release 项、Release 状态与门禁/报告。
- 真实模型行为不在 mock e2e 覆盖范围内。

## 4. 验证

- `node scripts/build-client.mjs --check`：客户端未改，生成物与源码一致。
- Browser fixture：289 assertions, 0 failed。
- 完整 `npm test`（清理本机损坏 PATH 条目、使用 `dev/harness`）：**3429 tests，3412 passed，2 failed，15 skipped**。两个失败仍是既有的 Node 24.14 + Windows + `--test-force-exit` 退出期 libuv 断言（`connectors-gateway.test.js`、`local-agents-mcp-races.test.js` 的子用例全部通过，去掉 force-exit 重跑退出码 0），与本次改动无关。
- `npm run lint`：0 errors（99 条既有 warning）。
- Board-host 全量（`test/board-host/*.test.mjs`）：**244 tests，242 passed，0 failed，2 skipped**（跳过项为本机无权限的符号链接用例）。
- Board e2e：**22/22 passed**，run `20261118001901`。
- Lifecycle e2e `--fresh`：**PASS**（Release 群与 10 个角色、11 个类型化任务、TDD 测试、HTTP health/GPA、四道门禁、publish、Markdown/HTML 总结报告）。
- Leak scan（提交树）：**0 must-fix**（1148 条既有 can-stay）。

## 5. 变更文件

- `ds-bot/src/host/board-service.js`：确认前复核提案 Bot、自动发布报告/通知/调度唤醒、change-request 通知语义。
- `ds-bot/src/host/workflow.mjs`：show 投影、proposal operation id 冲突检测、归档卡 proposal 拒绝。
- `ds-bot/src/host/task-store.mjs`：`listPublishedWithoutReport`、归档卡调度拒绝。
- `ds-bot/src/host/board-api.js`：归档卡不再提供 Schedule。
- `ds-bot/src/host/task-tool.mjs`：proposal 字段说明。
- `ds-bot/test/board-host/board-service.test.mjs`、`workflow-proposal.test.mjs`、`task-store.test.mjs`：新增/扩展用例。
