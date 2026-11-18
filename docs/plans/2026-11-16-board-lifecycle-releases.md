# 看板生命周期、任务类型与 Release

- 日期：2026-11-16
- 阶段：Trello 核心体验之后的生命周期阶段
- 相关：`src/host/task-store.mjs`、`board-service.js`、`board-api.js`、`board-query.js`、`src/client/task-board.js`、`task-tool.mjs`、`workflow.mjs`、`task-driver.mjs`
- 后续闭环：[Release 生命周期闭环与 DS-Bot 群协作](2026-11-17-release-lifecycle-closure.md)
- 状态：实现完成；host 单元测试、浏览器 fixture、真实 e2e 已通过
- 预览：[生命周期看板](../images/task-board-lifecycle-preview-2026-11-16.png) · [类型视图](../images/task-board-types-preview-2026-11-16.png) · [Release 视图](../images/task-board-releases-preview-2026-11-16.png) · [卡片详情](../images/task-card-preview-2026-11-16.png)

## 目标

让看板成为团队唯一的交付控制面：

1. 用任务 `type` 覆盖需求、设计、功能拆分、开发、测试、部署/运维、Bugfix、UI、UX 等生命周期类型。
2. 任务状态覆盖起草、准备中、等待、就绪（排队）、运行中、待验收、完成、已取消；支持按状态和按类型查看。
3. 用户和 Bot 都可以改变卡片内容/状态；**Bot 发起的改变先形成 proposal，必须由用户确认**。用户直接编辑也要经过确认步骤。
4. 每次确认产生新 revision；活跃任务的内容变化生成 change-request 任务，调度器把 before/after 差异发给 owner，让 Bot 检查并重新分配/返工。
5. Release 是一组有顺序的任务；用户创建 release、把 item 拉进去、选择执行。执行中的 release 的 item 优先调度；全部完成后记录版本发布。
6. 多个 release 由用户排序，串行推进；任何时刻同一看板最多一个 running release，不跨 release 同时执行。

## 状态模型

| UI 状态 | 内部 status | 含义 |
|---|---|---|
| 起草中 | `draft` | 只用于整理，未进入执行流程 |
| 准备中 | `proposed` | 信息完整，等待用户/依赖/排期 |
| 等待中 | `waiting` | 依赖未满足、被阻塞或排队 |
| 就绪 | `ready` | 已创建执行动作，等待 Bot claim |
| 运行中 | `working` | Bot 已开始 |
| 待验收 | `reported` | Bot 已报告，等待独立验收 |
| 已完成 | `done` | 验收通过 |
| 已取消 | `cancelled` | 保留审计，不再执行 |

- `draft` 卡片必须有 title/owner/reviewer/acceptance（沿用现有创建校验），但不会进入调度；用户点“提交”或拖到准备中后变 `proposed`。
- `cancel` 只允许用户发起（Bot 只能 proposal）；取消时把 pending action 置 cancelled，并把状态置 `cancelled`；被依赖的卡片保持阻塞。
- `restore` 把 `cancelled` 回到 `proposed`，不恢复旧的 action。
- `ready` 和 `reported` 保留，作为运行中/验收中的内部排队态；UI 显示为“就绪/待验收”。

## 任务类型

`type` 枚举：

`requirement` 需求、`design` 设计、`feature` 功能拆分、`development` 开发、`test` 测试、`deployment` 部署、`operations` 运维、`bugfix` 缺陷、`ui` UI 设计、`ux` UX 交互、`other` 其他。

- 新任务默认 `feature`；可从创建对话框、卡片详情和 Bot proposal 修改。
- 卡片正面显示类型 chip；搜索覆盖类型；筛选器增加类型。
- “按类型”视图以类型为列，只读分组，拖动不改变状态；“按状态”视图保留现有工作流拖动；“按 Release”视图以 release 为列。

## Release 模型

`releases` 表（body JSON）：

```
{
  id, scope, revision,
  name, version, position,          // position 决定串行顺序
  status: 'draft'|'queued'|'running'|'published'|'cancelled',
  createdAt, updatedAt, startedAt?, publishedAt?,
  createdBy: 'user',
  note?: string
}
```

任务 body 增加 `releaseId: string|null`、`releasePosition: string|null`。一个任务同一时刻只属于一个 release；release item 的顺序由 `releasePosition` 决定。

生命周期：

1. 用户新建 release（`draft`），可命名/填写版本号，排到用户指定顺序。
2. 用户把任务拖到 release（或卡片详情的 Release 选择器）→ 设置 `releaseId/releasePosition`。
3. 用户点“执行” → release `running`；同看板已有 running 时拒绝。
4. `startRelease` 按 item 顺序把这些任务推进到可调度状态（draft→proposed→waiting/ready，必要时写入 authority 和 execute action），并唤醒调度器。
5. 调度器优先派发 running release 的 item；其他 release 的 item 不派发；非 release 任务可以在 release item 无可执行动作时继续（但不会并发第二个 release）。
6. 当 release 的 item 全部 `done`，release 变 `published`，记录 `publishedAt`，然后自动启动下一个 `queued` release（按 position）。
7. 有 item 被取消/移除时 release 不完成；用户可以移除 item 或取消 release。
8. “发布版本”首先记录看板上的版本与 item 证据；真实 git tag/部署仍由 Bot 执行，后续可以在 release 完成时创建发布任务/通知。2026-11-17 落地为：发布或失败时通知 Release 群与项目经理并生成 Markdown/HTML 总结报告；不自动创建部署任务（部署由 Bot 执行）。

约束：
- 同一 scope 最多一个 `running` release。
- 只有 `draft`/`queued` 可以增删 item；running 时只能移除未开始的 item 或取消 release。
- `published`/`cancelled` release 不可重新启动；要再发版新建 release。
- release 顺序由 `position` 字符串排序；UI 提供上移/下移和拖拽排序。

## Bot 双向联动与 proposal

### 用户发起的修改

- 卡片详情里的内容/状态编辑先显示确认层（before/after diff）；确认后走原有 `board-command` + revision fence。
- 确认后 revision 增加，history 记录 before/after；活跃任务（working/reported/done）的修改沿用现有 change-request 任务，change task 的 prompt 带有 before/after；owner 被要求检查并重新报告/再分配。
- 拖动状态/派发/个人进度是用户明确的直接操作，不再额外确认；但会产生 revision/activity。

### Bot 发起的修改

新增 `board_task` 工具动作：`propose`、`proposal`。

```
board_task {
  action: 'propose'|'proposal',
  task_id?: string,
  operation_id?: string,
  expected_revision?: number,
  proposal?: {
    kind: 'create'|'update'|'status'|'release',
    task?: {...},          // create
    value?: {...},         // update/status/release
    note?: string
  }
}
```

- Bot 不能直接写任务内容/状态；`propose` 只写 proposal，不改变任务。
- `proposal` 查询自己的 proposal 状态（pending/confirmed/rejected）。
- Proposal 存在 `proposals` 表，body 含 scope、taskId、baseRevision、before、after、proposer、status、timestamps。
- 用户在看板“变更”面板看到 diff，确认或拒绝；确认在同一个事务里应用变更并写 proposal 决策。
- Bot 只能为自己可见的任务/scope 提议，不能越权；确认时再次检查 owner/reviewer 权限和当前 revision。
- 执行类的 `start/report/review/block/unblock` 保留现有证据链，不由 proposal 替代；它们不是“内容改写”，但仍产生状态与 activity。

## Scheduler 与版本差异

- `task-driver` 改为使用 `store.listSchedule()` 的排序：
  1. 当前 `running` release 的 item，按 `releasePosition`；
  2. 无 release 的普通任务；
  3. `queued`/`draft`/`published` release 的 item 不参与派发。
- 每个 execute/review action 仍按 revision bound；任务 revision 变化时旧 pending action 取消/失效。
- 用户确认修改活跃任务时：
  - `working/reported/done` → 现有 `proposeChange` 生成 change-request 任务（type `bugfix` 或原 type），依赖源任务，包含 before/after；
  - `proposed/waiting/ready` → 直接更新；若已排队，取消旧 action，必要时回到 proposed 重新排期。
- change-request 任务的 prompt 明确列出 before/after，要求 owner “比较两版、检查当前实现、按差异返工/重新分配”， reviewer 独立验收。

## API 端点

新增 board 端点（均走用户会话授权）：

- `board-release-list` `{scope}` → releases + items 摘要
- `board-release-create` `{scope, operationId, release:{name, version, position, note?}}`
- `board-release-update` `{scope, operationId, releaseId, expectedRevision, value:{name?,version?,position?,note?}}`
- `board-release-assign` `{scope, operationId, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision, afterId?}`
- `board-release-remove` `{scope, operationId, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision}`
- `board-release-start` `{scope, operationId, releaseId, expectedRevision}`
- `board-release-queue` `{scope, operationId, releaseId, expectedRevision}`
- `board-release-cancel` `{scope, operationId, releaseId, expectedRevision}`
- `board-proposal-list` `{scope}` → pending/recent proposals + diff
- `board-proposal-decide` `{scope, operationId, proposalId, expectedRevision, decision:'confirm'|'reject', note?}`

`board-list` 增加：
- task `type`, `releaseId`
- `releases` 摘要（id/name/version/status/position/itemCount/doneCount）；卡片上的 release 名称/状态由客户端用 `releaseId` 关联
- `proposals` 摘要（pending）

## 迁移与兼容

- SQLite 新增 `releases`、`proposals`、`operations` 表（release/proposal 的 operation 回执不能用 `events` 的 task 外键）；打开旧库时只创建缺失的新表，并重新校验 schema；不重写旧任务。
- 旧任务缺省 `type:'other'`、`releaseId:null`；旧状态不变。
- 旧客户端/旧测试仍收到未知字段时忽略；新客户端以 `releases` / `releaseRoles` 是否存在判断 host 是否支持 Release UI。
- 任务账本、operation receipt、revision fence、图片校验、共享授权语义不变。

## UI

- 看板头部增加视图切换：`状态` / `类型` / `Release`。
- `状态` 视图新增 起草中、已取消 列；`ready` 显示为“就绪”。
- `类型` 视图按 type 分列；把卡片拖到另一类型列会先显示看板级确认，确认后只修改类型、不改变状态。
- `Release` 视图：release 列表/列，显示 status、版本、item 数、完成数；支持新建、排序、执行、取消、拖入/拖出 item。
- 状态视图顶部保留 Release 快捷条：新建/查看 release，卡片可拖到 release chip 完成归属；release running 时显示进度。
- 工具栏增加类型筛选；卡片显示 type chip。
- 增加“变更”入口（pending proposals 数）；打开 diff 面板，确认/拒绝。
- 编辑确认层：在卡片详情内显示 before/after，Confirm/Cancel；确认后调用原命令。
- 视觉继续沿用 Harness tokens/type scale/hairline。

## 验证

以下结果于 2026-11-16 在 `D:\DS-Bot` 当前工作区实测；2026-11-17 收尾后重新跑了 board e2e、browser fixture 和 board-host。提交/推送状态以当前分支和 PR 为准。

1. **host unit（board-host）**：219 tests，216 passed，1 failed，2 skipped。新增覆盖类型/起草/取消/恢复、release CRUD/顺序/start/串行/publish/auto-advance、proposal 权限与版本冲突、schema v5→v6 迁移、`board_task propose/proposal`。唯一失败是本机无法创建指向 `D:\etc\passwd` 的符号链接（Windows `EPERM`），与看板代码无关。
2. **browser fixture**：`node test/task-board.browser.mjs`，**268 assertions, 0 failed**（约 16–22 秒）。覆盖阶段一全部断言、类型 chip/筛选/类型拖动确认、Draft/Cancelled 创建与提交/取消/恢复、Release 条/视图/拖入拖出/Queue/Start/Cancel、proposal 确认/拒绝，以及编辑确认层。
3. **real e2e**：`node test/e2e/board.e2e.mjs --fresh`，run `20261116154127`，**22 passed, 0 failed**。新增 Status/Type 视图切换、Draft 卡片创建/提交/取消/恢复、Release 视图、release 创建/分配/移除，以及真实 release start 后 item 进入调度列并保持 running；原有创建、拖动、派发、描述/标签/截止/检查项、评论、图片/封面、刷新持久化全部通过。
4. **回归**：阶段一看板行为保留；`node scripts/build-client.mjs --check` 通过；`npm run lint` 为 96 warnings、0 errors。完整 `npm test`：2879 tests，2860 passed，7 failed，12 skipped；失败仍为本机 Windows 符号链接/ACL、缺少 `link` 构建依赖、connectors/phone/local-agent/env-sanitization 等既有环境用例，未涉及看板路径。
5. **本轮已验证**：真实 git tag/部署、跨群 Release 属于设计边界（一个 Release 只属于一个 board scope；真实发布由 Bot 外部工具执行）。Bot 创建全新 item 的 proposal 已在 2026-11-17 收尾中实现：`propose` 支持 `change.kind='create'`，用户确认后落卡。

2026-11-18 的双向联动复核见 [Trello 面板与 DS-Bot 双向联动复核](../reviews/2026-11-18-board-bot-linkage-review.md)。

## 分阶段实现

- A. 数据模型与 host API：type、draft/cancelled、release 表/命令、proposal 表、迁移、board-list 投影、测试。
- B. 调度器：release priority、start 时排期、完成后 publish/auto-advance；task-tool propose/proposal；change-request diff prompt；测试。
- C. 客户端：类型/状态视图、release 条/视图、draft/cancel、编辑确认、proposal 面板、类型筛选。
- D. 端到端与回归：browser fixture、real e2e、docs、最终验证。

## 决策

- Release 的“发布”先做看板记录与版本证据；真正 git tag/部署留给 Bot 执行，不在 host 内伪造发布。
- Release 串行以“同一 scope 一个 running”实现；不同群/个人看板之间不互相阻塞。
- Bot 执行类动作保留现有工作流，不改成 proposal；Bot 的**内容/状态改写**必须走 proposal。
- 用户直接编辑统一加确认层；拖拽派发属于明确操作，不重复确认。