# Release 生命周期闭环与 DS-Bot 群协作

- 日期：2026-11-17
- 阶段：Trello 看板第二阶段之后的任务闭环增强
- 相关：`release-team.mjs`、`board-service.js`、`task-store.mjs`、`workflow.mjs`、`task-tool.mjs`、`task-board.js`
- 状态：实现完成；student-grades 样例端到端通过
- 2026-11-18 更新：下文“每次 Release 新建群并指定 PM 为管理员”记录的是历史设计。当前一个群负责一个大版本，同群可发布多个小版本，沿用该群的管理员与成员；历史 Release 保留原协调群。

## 目标

把 Release 从“看板上的分组”提升为可执行的交付控制面：

1. DS-Bot 对话/PM 分析出的任务可以直接导入看板，类型、负责人、验收人和依赖正确。
2. 看板上的内容/状态修改同步到对应的 DS-Bot 项目群/项目经理。
3. 新建 Release 时自动创建 DS-Bot 群聊，项目经理默认管理员，用户在面板指定角色。
4. 需求 → 设计 → TDD 测试 → 开发 → 测试 → 审核 → 部署 → 运维 → 总结按依赖自动推进。
5. 群管理员/定时器周期检查，满足发布项和四道门禁才发布，无法满足则失败。
6. 文档、成果物、线上环境检查作为发布门禁必须通过。
7. 总结会任务完成后生成 Markdown 和 HTML 总结报告。
8. 用学生成绩管理系统作为样例驱动完整生命周期。

## Release 团队与群聊

`release-team.mjs` 定义 12 个角色：

| 角色 key | 名称 | 必需 |
|---|---|---|
| projectManager | Project Manager | 是 |
| productManager | Product Manager | 是 |
| architect | Architect | 是 |
| uiDesigner | UI Designer | 否 |
| uxDesigner | UX Designer | 否 |
| frontend | Frontend Developer | 是 |
| backend | Backend Developer | 是 |
| apiEngineer | API Engineer | 否 |
| dba | Database Administrator | 否 |
| tester | Test Engineer | 是 |
| reviewer | Independent Reviewer | 是 |
| ops | Operations Engineer | 是 |

- `resolveReleaseTeam` 从显式角色映射或 Bot 的 `role` 标签解析团队；缺必需角色时拒绝创建。
- `createReleaseGroup` 创建 `Release <name> · <version>` 群：
  - PM 是管理员（`admin`）；
  - 所有角色是成员；
  - 群公告写明 PM 管理、看板是任务权威、成员使用 `board_task`；
  - 角色同时被加入项目看板房间，使非 PM 角色可以处理原有 room 范围任务。
- `board-release-create` 接受 `team:{projectManagerId, roles}`；不传时保持旧 release 行为（不建群），兼容旧测试/旧客户端。
- UI 的 Release 创建对话框在 group board 上显示团队角色选择；PM 和所有 required 角色必须选择。

## DS-Bot 生成看板任务

`board_task` 新增 `plan` 动作：

```json
{
  "action": "plan",
  "release_id": "student-grades-1",
  "requirement": "Build a student grade management system ..."
}
```

- 只有该 Release 的 PM（或群管理员）可以调用。
- `lifecyclePlan` 生成带类型和依赖的任务链：
  Requirement → Design → TDD Test Plan → UI/UX（有对应角色时）→ Backend/Frontend → TDD Verification → Independent Review → Deployment → Operations → Summary Meeting。
- 任务以 `proposed` 状态、明确 owner/reviewer/acceptance/dependencies 写入看板；由用户启动 Release 后才进入调度。
- 学生成绩样例中，PM Bot 收到群消息后通过 `board_task plan` 导入 11 个任务，而不是测试脚本直接写 API。

## 看板 → DS-Bot 同步

- 卡片内容/状态/负责人/Release 归属变更后，`board-service` 找到任务所属 Release 的 `groupId` 和 `projectManagerId`。
- 变更会：
  1. 作为 PM 的群消息写入 Release 群日志（`postToRoom`，静默，不强行开启新一轮）；
  2. 作为一条 request 投递给 PM 私聊，PM 可以检查卡片、调整工作或重新分配。
- 单测 `a board edit on a release item is delivered to the release project manager` 覆盖投递；student-grades e2e 通过 `group-search` 验证群内出现 Board change。

## 调度与执行

- Release start 后，无依赖任务进入 Waiting/Ready，调度器按键值依赖推进。
- 为让 owner 真正执行 room 任务，board task prompt 投递到该 Bot 的私有任务会话；任务授权仍由工作流校验其房间成员、owner/reviewer、authority 和版本。
- `board_task start/report/review` 产生的下一次 action 自动唤醒调度器；审核完成会把依赖任务推进到 Ready。
- Release 内只要有任务未完成，Release 保持 running；全部 item done 后仍需四道门禁通过才 publish。
- 同一 scope 最多一个 running Release；发布后自动启动下一个 queued Release。

## 发布门禁、失败与总结

- Release 新增 `gates`：
  - `docs`：README、API 契约、设计/验收文档；
  - `artifacts`：源码、测试、构建产物、迁移包；
  - `environment`：目标环境健康检查/冒烟测试；
  - `summary`：项目总结会完成。
- `board-release-gate` 记录每个门禁的状态和证据；`board-release-check` 在 running 状态检查：
  - 有 item 被取消、无 item 或任一门禁 failed → `failed`，写入 `failure`；
  - 所有 item done 且四道门禁 passed → `published`，记录 `publishedAt`。
- `board-service` 每 30 秒运行 `release-monitor`，对每个 running Release 做一次检查；显式 Check 按钮和 API 也能立即检查。
- publish 后生成：
  - `<home>/bot/board-v1/release-reports/<releaseId>/summary.md`
  - `<home>/bot/board-v1/release-reports/<releaseId>/summary.html`
- 报告包含 release 状态/版本/群/PM、团队角色、所有 item 的 owner/reviewer/状态、四道门禁证据和总结会结论。
- 看板 Release 详情显示门禁和报告入口；HTML 报告通过 API 返回，UI 只显示 Markdown 文本，不注入 HTML。

## 学生成绩管理系统样例

脚本：`ds-bot/test/e2e/lifecycle.e2e.mjs`

流程：

1. 启动 mock LLM + dsh web，创建 10 个角色 Bot（PM、产品、架构、UI、UX、前端、后端、测试、审核、运维）。
2. 创建项目群，PM 为管理员。
3. 创建 `Student Grades 1.0.0` Release，指定全部角色；验证新 Release 群 PM 是 admin、10 个角色都在群。
4. 通过群消息让 PM 调用 `board_task plan`，导入 11 个类型化任务（requirement/design/test/development/ui/deployment/operations/other）。
5. 在面板修改设计卡描述，验证 Release 群出现 Board change。
6. 启动 Release；mock Bot 按真实 `board_task` 工具链 start/report/review；依赖链自动推进，11 个任务全部 done。
7. 创建并实际执行 docs、artifact、最小学生成绩应用：`node --test` 通过，HTTP `/health` 与 `/gpa` 通过；设置四道门禁为 passed。
8. 等待 30 秒发布监控（测试中压缩为 1 秒）自动 publish；读取 summary.md 和 summary.html，验证文件存在且包含总结会证据。

实际结果（20261117 本轮）：

- `lifecycle.e2e`：`PASS lifecycle sample: group/roles, typed plan, TDD chain, reviews, release gates, summary report`
- 11 个任务 done；`node --test` 通过；HTTP `/health` 与 `/gpa` 通过；周期监控自动 publish；MD/HTML 报告生成。
- 样例报告副本：[summary.md](../reports/student-grades-1.0.0/summary.md)、[summary.html](../reports/student-grades-1.0.0/summary.html)
- 样例 docs / artifact：[design-and-acceptance.md](../samples/student-grades/docs/design-and-acceptance.md)、[student-grades-1.0.0.txt](../samples/student-grades/artifacts/student-grades-1.0.0.txt)
- 样例应用：[grades.mjs](../samples/student-grades/app/src/grades.mjs)、[grades.test.mjs](../samples/student-grades/app/test/grades.test.mjs)、[server.mjs](../samples/student-grades/app/src/server.mjs)
- UI 预览：[Release 团队创建](../images/release-team-create-preview-2026-11-17.png) · [Release 门禁详情](../images/release-gates-preview-2026-11-17.png) · [总结报告](../images/release-report-preview-2026-11-17.png)
- 原 board e2e：22/22 passed（run `20261116174430`）。
- Browser fixture：268 assertions, 0 failed。
- Release UI harness（临时，非仓库测试）：41 checks passed，覆盖团队选择、PM 必选、门禁证据、Check、报告只读展示、手机宽度。
- Board-host：226 tests，223 passed，1 failed（Windows symlink EPERM），2 skipped。
- 全量 `npm test`：2886 tests，2866 passed，8 failed，12 skipped；除 7 个已知环境用例外，另有 roster 并发失败，单跑 `test/roster.test.js` 为 62/62 passed。
- `node scripts/build-client.mjs --check` 通过；`npm run lint` 0 errors。

## 边界与后续

- 群聊任务消息本身不会自动开启 group round；执行任务投递到 owner 私聊，群内保留状态/变更通知和 PM 协调。这是为了不依赖“群里有人说话”才推进任务。
- 样例使用 `MOCK_BOARD_AUTORUN` 驱动的 mock LLM 执行 `board_task` 协议；真实模型是否按角色指令自主编码不在本次 mock e2e 覆盖范围。样例 app 是测试环境生成并实际跑 `node --test`、HTTP 健康检查的最小应用，用于验证发布门禁与报告闭环；不能把它当作真实团队的生产交付。
- 发布仍是看板记录 + 版本证据 + 总结报告；真实 git tag/部署由 Bot 的外部工具执行，host 不伪造。
- 门禁是证据门禁（文本/路径），host 不替代外部 CI 或生产探针；样例中生成了实际 docs/artifact 文件并执行了 HTTP 健康检查。
- UI 的团队/门禁/报告面板由浏览器 fixture 与临时 harness 验证；真实 Release 群创建和完整生命周期由 lifecycle e2e 验证。2026-11-17 收尾后 board e2e 与 browser fixture 重新通过；完整 lifecycle e2e 仍以 mock LLM 驱动，真实模型行为不在覆盖范围。
- 收尾后所有改动将按分支/PR 落线；文档不再固定写“未提交”。