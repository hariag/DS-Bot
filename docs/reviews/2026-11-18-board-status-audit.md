# 看板任务状态审核

- 日期：2026-11-18
- 基准：`main` @ `fce9a04f`
- 问题：看板按状态分列后出现「起草中、待准备、等待中、就绪、进行中、待验收、完成、目标中标记完成、已取消」，是否都必要？
- 方法：对照设计（`docs/plans/2026-11-16-board-lifecycle-releases.md` 的状态模型）、任务账本（`task-store.mjs`）的状态写入与读取、看板投影（`board-query.js`、`legacy-goal.js`）和客户端列定义（`task-board.js`），逐状态核对“谁写入、谁读取、去掉会怎样”。

## 1. 结论

**8 个任务账本状态全部必要，不能删除；用户看到的第 9、10 列不是任务状态，而是旧群目标卡片的投影。**「就绪」是内部投递队列状态，保留在账本中有必要，但不必单独占一列。

- 账本状态（`task-store.mjs`）：`draft`、`proposed`、`waiting`、`ready`、`working`、`reported`、`done`、`cancelled`。
- 显示列多出来的部分：
  - `legacy-pending`（未开始）和 `legacy-done`（目标中标记完成）：由 `legacy-goal.js` 从群目标（Group Goal）的旧任务投影出来，不是任务账本状态；`legacy-done` 只表示“群目标里标记完成”，不等于看板的独立验收。
  - `ready`（就绪）：账本里的内部队列状态——执行动作已创建、等待 Bot 领取/已领取；卡片上已有 `Bot queued` / `Sent to Bot` 等投递 chip。
  - `unknown`、`legacy-unverified`、`shared-stale`、`shared-blocked` 是异常或共享投影的兜底，不是常规列。
- 普通看板（无旧目标卡）显示 8 列；有旧目标卡时最多再加 2 列，正好对应用户看到的 9–10 列。

## 2. 逐状态核对

| 状态 | 谁写入 | 谁读取 / 依赖它 | 去掉会怎样 | 结论 |
|---|---|---|---|---|
| `draft` 起草中 | 创建时 `draft:true`（`board-api.create` 自动补 owner/reviewer/acceptance） | `submit`、`cancel` 只在这里可用；快速捕获路径 | 失去“先记标题、后补细节”的草稿；创建必须一次填完整 | **必要**（产品功能） |
| `proposed` 待准备 | 创建默认；`submit`、`restore`、`unschedule`、活跃任务编辑回退 | 只有这里出现 `Schedule Bot`；`edit` 允许；Release start 从 draft/proposed 进入 waiting | 需要一个额外标志才能区分“可排期”与“已排期”，否则排期入口和编辑规则失据 | **必要**（可排期态） |
| `waiting` 等待中 | `register`、从 proposed `schedule`、review rework、`ready` 被 block、Release start、change 任务创建 | `schedule`（依赖完成后转 ready）、`unschedule`、调度器不派发（无 action） | 无法表达“已授权但依赖未完成 / 返工 / 阻塞”；会把未就绪任务误派发 | **必要**（已授权未可执行） |
| `ready` 就绪 | 依赖完成且 authority 就绪时 `ready()` 创建 execute action | 调度器 claim/admit；`start` 要求 ready + accepted 回执；`unschedule`、`block`；Release 活跃检查 | 调度器失去“可 claim”的权威标记；start 无法校验回执；投递队列状态无处表达 | **内部必要**；用户价值低，可由投递 chip 代替 |
| `working` 进行中 | `start`（要求 accepted 回执） | `report` 只在这里；`block`、`cancel`；Release 活跃检查；概览计数 | 无法区分“已领取”与“已开始”，汇报授权和进度都失去依据 | **必要** |
| `reported` 待验收 | `report` | `review` 只在这里；rework 回 waiting；`unblock`/`revalidate` 重开 review；Release 活跃检查 | “汇报”会被当成“完成”，独立验收门禁消失 | **必要**（独立验收） |
| `done` 完成 | `review` pass | 依赖推进（dependents→ready）；Release 完成/发布；概览计数 | 依赖链和 Release 发布失去完成依据 | **必要** |
| `cancelled` 已取消 | `cancel` | `restore` 回 proposed；Release 检查把取消 item 判失败 | 失去保留审计的终止态；只能删除（设计明确不永久删除） | **必要** |
| `legacy-pending` 未开始 | 仅 `legacy-goal.js` 投影 | 旧群目标卡片展示；目标卡编辑 overlay | 旧目标卡被误当成账本任务；不影响调度 | **不是账本状态** |
| `legacy-done` 目标中标记完成 | 仅 `legacy-goal.js` 投影 | 同上；表示群目标里标记完成 | 若并入“完成”会把群目标标记误当成独立验收 | **不是账本状态** |

补充：`blocked`、`stale`、`dispatchState`、`personalProgress` 是与状态正交的标记，不占列；`personalProgress`（待办/进行中/个人完成）只属于个人看板，和账本状态分开。

## 3. 建议

### 3.1 已采用：账本不动，显示精简为 7 列

1. **把 `ready` 并入「等待中」列**：等待中/就绪在用户眼里都是“排队等 Bot”，卡片保留“就绪/已派发”chip；账本仍是 `waiting`→`ready` 两步，调度与回执不变。
2. **旧目标卡移出工作流状态列**：收进独立的「目标卡片」区域，不再让 `未开始/目标中标记完成` 看起来像工作流状态；卡片保留 Goal 标记，避免把目标标记完成误当成独立验收。
3. 结果：普通看板固定 7 列——起草中 / 待准备 / 等待中（含就绪） / 进行中 / 待验收 / 完成 / 已取消；有旧目标卡时也不增加工作流列。

### 3.2 备选

- **只合并就绪**：7 列；旧目标卡仍按需多出 1–2 列。
- **再合并起草与待准备**：6 列；但失去“先记标题、后补细节”的草稿路径，不建议。
- **保持现状**：8–10 列，各状态语义完整，但列数多、横向空间紧张。

### 3.3 实施影响（已按推荐方案实施）

- 只改客户端：`COLUMNS`/`boardColumns`、列标签、拖动与排序规则、概览计数、fixture 断言。
- 任务账本、`workflow.mjs`、调度器、Release 门禁、proposal 规则均不改。
- 合并后同一列内 `waiting` 与 `ready` 仍不能互相重排（账本按状态分 lane）；就绪卡在合并列里不再作为拖动把手，跨状态拖动仍走 schedule/unschedule 等真实命令。
- 旧目标卡在独立的「目标卡片」区域中保留编辑、评论、附件和只读历史能力，但不再占用工作流列。

## 4. 实施与验证

- 状态视图固定 7 列；就绪卡显示在「等待中」列，卡片详情仍显示“就绪”，概览的 Wait 计数合并等待+就绪。
- 旧目标卡收进「目标卡片」区域；区域标题和说明为新增文案，旧目标卡的状态文案（未开始/目标中标记完成）仍用于卡面。
- `node scripts/build-client.mjs --check`：通过。
- 浏览器 fixture：**291 assertions, 0 failed**（新增就绪并入等待中、旧目标卡独立区域的断言）。
- Board e2e：**22/22 passed**，run `20261118055630`。
- i18n：`test/i18n.test.js` + `test/task-board-locales.test.js` **4/4 passed**。
- 未跑全量 `npm test`（按用户要求只做改动范围内回归）。

## 5. 证据位置

- 状态模型：`docs/plans/2026-11-16-board-lifecycle-releases.md`「状态模型」。
- 状态写入：`ds-bot/src/host/task-store.mjs`（`create`、`submit`、`register`、`schedule`、`unschedule`、`start`、`report`、`review`、`block`、`unblock`、`cancel`、`restore`、`startRelease`、`proposeChange`）。
- 看板投影：`ds-bot/src/host/board-query.js`、`ds-bot/src/host/legacy-goal.js`。
- 显示列：`ds-bot/src/client/task-board.js` 的 `COLUMNS`、`boardColumns`、`statusValueLabel`。
- 设计边界：`docs/plans/2026-11-16-board-lifecycle-releases.md` 明确 `draft` 不进入调度、`reported` 保留为验收中、`cancelled` 保留审计。