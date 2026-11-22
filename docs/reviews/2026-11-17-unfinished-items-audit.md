# 看板未完成事项复核与收尾

- 日期：2026-11-17
- 基准：工作区 `main`，HEAD `4b6b2b5e`（未提交改动全部纳入本次复核）
- 范围：`docs/plans/2026-11-16-trello-parity-board.md`、`2026-11-16-board-lifecycle-releases.md`、`2026-11-17-release-lifecycle-closure.md`、`docs/reviews/2026-11-17-task-board-ui-ux-review.md`、`2026-11-17-task-board-ui-ux-fixes.md`
- 方法：逐条读取文档中的“未完成 / 未验证 / 暂不 / 已知限制 / 建议”，对照当前 host、client、fixture 和 host tests；能实现且属于本看板范围的补齐，明确属于产品边界或外部系统的改写为设计边界。

## 1. 已补齐的真实缺口

| 事项 | 原文档位置 | 处理 | 证据 |
|---|---|---|---|
| Bot 创建全新卡片的 proposal | 生命周期计划“未在本轮验证：Bot 创建全新 item 的 proposal” | `board_task propose` 支持 `change.kind='create'`，不需要 `task_id`；用户确认后通过 `board-api.create` 落卡；支持查询 proposal、幂等 operation、scope 校验 | `workflow.mjs`、`board-service.js`、`task-store.mjs`；`workflow-proposal.test.mjs`、`board-service.test.mjs` |
| 归档仍可能被调度 / 与 Release 冲突 | UI/UX 修复记录“归档卡片从 Release 视图隐藏”，但 store 未处理调度和 Release 计数 | 归档拒绝 `ready/working/reported`；拒绝 active Release 中的卡片；`listSchedule` 排除 archived；档案恢复后重新参与 | `task-store.mjs`；`task-store.test.mjs` |
| 调度无撤销 | UI/UX 修复记录“schedule 仍依赖确认层/安全操作” | 新增 `unschedule` 命令：pending execute action 取消并回到 waiting；无 action 的 waiting 回到 proposed；UI toast 映射 `schedule → unschedule` | `task-store.mjs`、`board-api.js`、`task-board.js`；`task-store.test.mjs` |
| 批量复制 / 批量移动 | UI/UX 修复记录“没有批量复制/移动” | 新增 `Duplicate selected`；个人看板新增 `Move selected` 到 todo/doing/finished。工作流状态仍走既有 submit/schedule/cancel/restore，不伪造任意跨列移动 | `task-board.js` |
| 列表“还有 N 列” / 列索引 | UI/UX 审查 P1-6 | `ColumnRail` 显示 `Columns x–y of n` 与 `· N more`，随滚动、resize、内容变化更新 | `task-board.js`、`task-board.browser.mjs` |
| Release 卡片密度 / Cancel 误触 | UI/UX 审查 P2-4 | Release chip 只显示 `version · done/total`，状态放入 `title/aria-label`；Cancel、上移、下移收进 `···` 菜单；空 Release 条不再占位 | `task-board.js`、`task-board.browser.mjs` |
| 筛选在移动端占满工具栏 | UI/UX 审查 P1-1 | 移动端打开筛选改为底部固定面板，限制高度并可滚动；容量数字在移动端隐藏 | `task-board.js` |
| 键盘 / 无拖拽等价操作 | UI/UX 审查 P2-3 | 卡片状态区新增 `Move to…` 菜单，复用 submit / schedule / restore / cancel；个人看板继续使用进度选择 | `task-board.js` |
| 批量类型编辑没有 Undo | UI/UX 修复记录与代码不一致 | 记录每张卡原类型，Undo 逐张恢复；文档不再声称“类型编辑有 Undo”而实际没有 | `task-board.js` |
| 标签移除按钮命中区 | UI/UX 审查 P2-3 | 视觉仍为 14px，但按钮盒改为 28×28 并用负 margin 保持标签高度 | `task-board.js` |
| 移动端卡片关键属性 | UI/UX 审查 P1-2 | sticky 条增加 DueChip；状态、类型、负责人、截止、Manage 同屏 | `task-board.js` |
| 空恢复工具面板 | UI/UX 审查 P2-1 | 无 interrupted turn / queued delivery 且记录完整时不再渲染 `Interrupted work` 空面板 | `task-board.js` |
| Release 缺失角色提示 | UI/UX 审查 P1-4 的“创建缺失角色入口” | 对话框列出没有候选 Bot 的 required 角色，并指向 Bot 设置创建；不伪造 Bot 创建流程 | `task-board.js`、`i18n.js` |

## 2. 明确为设计边界（不再作为未完成）

| 事项 | 处理 |
|---|---|
| 跨群 Release | 一个 Release 只属于一个 board scope；`assignRelease` 继续拒绝跨 scope。计划文档已改为边界，而不是“未验证”。 |
| 真实 git tag / 部署 | host 只记录 Release 版本、门禁证据和报告；tag/部署由 Bot 外部工具执行，host 不伪造。 |
| 自定义列表增删 | 工作流状态是权威；UI 的 lane 重命名/左右移动/折叠只影响本机显示，不写 host。 |
| 自定义字段 / 模板 / Power-Ups / 自动化 / 成员邀请 | Trello 外围协作能力，仍不在本任务范围。 |
| 真实模型生命周期 | lifecycle e2e 使用 mock LLM 驱动真实 `board_task` 协议；真实模型是否按角色指令执行不在本仓库可控范围。 |

## 3. 仍未覆盖 / 保留的限制

- 批量工作流移动仍不是“任意拖到任意列”：状态由任务账本和工作流动作决定。第二轮新增 `Apply status`（Submit / Schedule / Restore / Restore from archive），只执行当前卡片可用 command；个人看板支持批量移动三个进度列。
- 批量 Undo 已覆盖状态、负责人、Release 归属、复制副本和个人进度移动；归档/取消/类型编辑保留。
- Archive 视图支持选中归档卡片并批量恢复。
- `Move to…` 菜单只列当前命令允许的目标，不提供伪造的状态跳转。
- Release 对话框没有直接创建 Bot 的表单；缺少角色时给出明确操作提示，创建 Bot 仍在 Bot 设置中完成。
- 乐观 UI 未实现；所有写操作仍以 host 回执和重新读取为准，避免回执不确定时显示假状态。
- `Work decisions` 仍需用户展开 Board tools 后按需读取；没有常驻的空面板。
- 移动端筛选为底部面板，但不是带遮罩的完整 modal；关闭仍通过 Filters 按钮。**2026-11-17 第二轮已补**：窄屏显示全屏遮罩，点击遮罩关闭，`Escape` 先关筛选；见 [合并后复核](2026-11-17-post-merge-unfinished-audit.md)。
- 真实 iOS/Android WebView 的手势和软键盘未验证。

## 4. 后续验证

本轮收尾后重新执行：

- `node scripts/build-client.mjs --check`：通过。
- `node test/task-board.browser.mjs`：**285 assertions, 0 failed**。
- `node test/e2e/board.e2e.mjs --fresh`：**22/22 passed**，run `20261117070314`。
- board-host 全量：**234 tests，231 passed，1 failed（Windows symlink `EPERM`），2 skipped**。
- `node test/e2e/lifecycle.e2e.mjs --fresh`：**PASS**（11 tasks、TDD/app tests、HTTP health/GPA、publish、summary report）。
- `npm run lint`：**0 errors**，96 条既有 warning。
- 完整 `npm test`：**2894 tests，2871 passed，11 failed，12 skipped**。11 个失败中 2 个是新 i18n 键缺失，已补齐并单独重跑 `i18n.test.js` / `legacy-review-i18n.test.js` 为 4/4 通过；其余 9 个为已知 Windows 环境/依赖问题（symlink EPERM、缺少 link 依赖、ACL、connectors/phone/local-agent、`git` 不在 Node 子进程 PATH、roster 并发时序）。

具体结果记录在修复记录、第二轮批量记录和 PR 描述中；不以“代码看起来正确”代替实际运行。

第二轮记录：[批量操作与 Undo 完善记录](2026-11-17-bulk-actions-undo-round.md)。

合并后第二轮复核：[合并后未完成事项复核与收尾（第二轮）](2026-11-17-post-merge-unfinished-audit.md)。