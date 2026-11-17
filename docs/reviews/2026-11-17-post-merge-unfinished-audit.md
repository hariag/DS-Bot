# 合并后未完成事项复核与收尾（第二轮）

- 日期：2026-11-17
- 基准：`main` HEAD `ddf77269`（上游 v0.3.8 合并与安全收尾之后）加本轮工作区改动
- 范围：本轮实现文档中的“未完成 / 未验证 / 剩余限制 / 已知边界 / 后续”条目：
  - `docs/plans/2026-11-16-trello-parity-board.md`
  - `docs/plans/2026-11-16-board-lifecycle-releases.md`
  - `docs/plans/2026-11-17-release-lifecycle-closure.md`
  - `docs/reviews/2026-11-17-unfinished-items-audit.md`
  - `docs/reviews/2026-11-17-task-board-ui-ux-fixes.md`
  - `docs/reviews/2026-11-17-upstream-v0.3.8-merge.md`
- 方法：逐条读取上述文档的“未完成 / 未验证 / 暂不 / 已知限制 / 建议 / 后续”，对照当前 host、client、浏览器 fixture 和 host tests；能补齐的补齐，属于产品边界或本机权限的改写为边界，并写明证据。行号不作引用，结论以代码路径、测试名称和实际运行结果为准。

## 1. 本轮补齐的缺口

### 1.1 看板变更同步到 Release 群和项目经理的覆盖面不完整

- 原设计（`2026-11-17-release-lifecycle-closure.md`“看板 → DS-Bot 同步”）：卡片内容、状态、负责人或 Release 归属变更后，写入 Release 群日志并作为 request 投递给项目经理。
- 核验前：`board-service.js` 只对 `edit / card-details / submit / cancel / restore / archive / unarchive / release-assign / schedule / unschedule` 这些命令投递。评论、附件、Release 拖入/移出、以及用户确认的 Bot proposal 都静默，PM 与 Release 群看不到这些“内容 / 归属”变更。
- 修复：
  - `releaseSyncTypes` 增加 `card-comment`、`card-comment-edit`、`card-comment-delete`、`attach`、`remove-image`；
  - 图片上传提交成功后按 `attach` 同步；
  - `board-release-assign` 成功后按新 Release 同步；`board-release-remove` 成功后按原 Release 同步（移出后任务已没有 `releaseId`，所以显式传入 Release）；
  - `board-proposal-decide` 确认后按 `proposal-confirm` 同步实际变更；拒绝不产生变更，不投递。
- 证据：`test/board-host/board-service.test.mjs` 新增
  `comments, attachments and release membership changes on a release item reach the project manager`
  与 `a confirmed board proposal on a release item reaches the project manager`；
  运行 `node --import ./test/harness-resolve.mjs --test --test-timeout=120000 --test-force-exit test/board-host/board-service.test.mjs` 得到 **41/41 passed**。

### 1.2 移动端筛选不是完整模态

- 原记录（`2026-11-17-unfinished-items-audit.md` 第 3 节）：移动端筛选是底部面板，没有遮罩，关闭只能再点 Filters。
- 修复：
  - 新增 `.bt-board-filter-scrim`：仅窄屏（≤700px）显示，覆盖整个视口，点击关闭面板；
  - `Escape` 先关闭筛选面板，再关闭看板；
  - `prefers-reduced-motion` 下不播放入场动画。
- 证据：browser fixture 从 285 增至 **289 assertions, 0 failed**；新增断言覆盖遮罩可见、覆盖视口、点击关闭、Escape 先关筛选。

### 1.3 本机环境性测试失败的定位与消除

这些失败此前被记为“已知环境问题”。本轮定位到具体原因，并在不改变产品语义的前提下修正可修正的部分。

| 失败 | 根因 | 处理与结果 |
|---|---|---|
| `repository-sync` 的 `spawnSync git ENOENT` | 本机 Machine PATH 中有一项以单引号开头（位于用户目录的 Python 用户脚本目录），Windows 对后续目录的可执行搜索因此失效；Node 子进程 `spawnSync('git')` 和 `spawnSync('node')` 均 ENOENT | 清掉该条目的 PATH 后 `repository-sync` **6/6 passed**；属于本机环境问题，见第 4 节 |
| `connectors-gateway-egress` 4 条超时/断言失败、`connectors-gateway` 2 条子进程超时、`plugin-reload` 1 条、`roster` 1 条 | 同一 PATH 问题导致子进程或引擎探测失败，以及并发时序；`connectors-gateway` 的子脚本还用 1 秒 abort 上限，机器繁忙时会被误判为超时 | 清理 PATH 后分别为 **16/16 passed**、`plugin-reload` **9/9 passed**、`roster` **63/63 passed**；`connectors-gateway` 子脚本的上限放宽为 3 秒、外层等待放宽为 15 秒 |
| `link-bundle`、`phone.test.js` | `link/` 的依赖（`@noble/*`、`@lukeburns/clatterjs`、`ws`）未安装 | 在 `link/` 执行 `npm install`（安装物不入库）后 `link-bundle` + `phone` **4/4 passed** |
| `doctor` 两条 | 测试用 POSIX 的 `true` 当假 pnpm，Windows 没有这个命令 | 测试改为在临时目录生成跨平台空操作脚本（Windows 为 `.cmd`），**7 passed / 1 skipped** |
| `local-agents` 环境清理 | Windows 的环境变量键是 `Path`，测试固定断言 `env.PATH` | 断言改为大小写不敏感；**81 passed** |
| `local-agents` 本地 CLI part 不应在步骤前检查 | 采用上游 v0.3.8 `parts.js` 后，pre-step 读取 `rt.live`，而用例的 fake runtime 没有 `live` | 补齐 fake runtime 的 `live: new Map()`；通过 |
| `board-images`、`mobile` 的符号链接用例 | 本机账户没有 SeCreateSymbolicLinkPrivilege，文件符号链接 `EPERM` | 用例在此类会话跳过并写 diagnostic；目录 junction 与 Linux CI 仍覆盖 |
| `private-storage` 的 Windows ACL 用例 | 第二次 `Set-Acl` 需要 SeSecurityPrivilege，本机账户没有 | 用例在缺少该权限时跳过并写明原因；隔离目录断言仍执行 |

### 1.4 生命周期样例的同步断言在负载下过紧

- 现象：在完整测试同时占用 CPU 时，`lifecycle.e2e.mjs` 中“看板编辑 -> Release 群出现 Board change”的检查固定等待 1.2 秒后查询，偶发失败。
- 定位：用同一个 bench home 重启后单独执行同样的 `card-details` 编辑，Release 群 ledger 在 1 秒时仍为空、3 秒时已出现完整的 `Board change ...` 记录；说明 host 的后台投递正常，失败来自固定等待窗口过短。
- 修复：样例改为 `waitFor` 轮询 `group-search`，最多 20 秒，等群消息真正出现；不再用一次固定 sleep 判定。

## 2. 核验后确认已完成（保留证据）

| 事项 | 来源 | 证据 |
|---|---|---|
| 归档拒绝 `ready/working/reported`，并拒绝 active Release 中的卡片；`listSchedule` 排除归档 | UI/UX 修复记录、复核第 1 节 | `src/host/task-store.mjs` 的 `archive` 分支与 `listSchedule`；`test/board-host/task-store.test.mjs` |
| `unschedule` 取消 pending execute action、waiting 回 proposed | 复核第 1 节 | `task-store.mjs` 的 `unschedule` 分支；`board-api.js` 命令投影；fixture |
| Bot 创建全新卡片的 proposal | 复核第 1 节 | `src/host/workflow.mjs` 的 `change.kind='create'`；`board-service.test.mjs` 的新卡 proposal 用例 |
| Release 团队自动填充、缺失角色提示 | UI/UX 修复记录 | `board-api.js` 的 `releaseCandidates`；`task-board.js` 的角色下拉与缺失角色文案；fixture |
| 15 秒轻量刷新、窗口聚焦刷新、Changes 未读 badge | UI/UX 修复记录 | `task-board.js` 的 `setInterval(refresh, 15_000)`、focus 监听、`proposalUnread`；fixture |
| 横向轨道列区间与剩余列提示 | UI/UX 审查 P1-6 | `task-board.js` 的 `Columns {from}–{to} of {total}`；fixture |
| lane 折叠/重命名/左右移动/归档全部、排序 | UI/UX 修复记录 | `task-board.js` 的 lane menu 与 `lanePrefs`；fixture |
| 批量归档/取消/类型/负责人/Release/复制/状态与 Undo | 批量记录 | `task-board.js` 批量动作与 Undo；fixture 289 assertions |
| Board 级 Activity 视图 | 看板计划、修复记录 | `board-query.js` 的 `boardActivity`；`task-board.js` 的 Activity 视图 |
| `N` 新建、`/` 聚焦搜索 | UI/UX 修复记录 | `task-board.js` 的键盘处理；fixture |
| Release 发布/失败通知群与 PM，并生成总结报告 | 生命周期计划第 8 条“后续可以创建发布任务/通知” | `board-service.js` 的 `notifyRelease` 与发布检查；`lifecycle.e2e.mjs` 的群内 Board change 与报告断言 |
| Release 全部 item 完成后发布，并自动启动下一个 queued Release | 看板生命周期计划 | `task-store.mjs` 的 `checkRelease` 与 next queued 启动；host tests |
| change-request 任务带 before/after 并依赖原任务 | 看板生命周期计划 | `task-store.mjs` 的 `proposeChange`；`board-service.js` 的任务提示词；host tests |
| 上游 v0.3.8 并行/后台 part 已采用 | 合并记录 | `8971cda7`、`f0cfb975`；`parallel-parts`、`switch-keeps-input` 等用例 |
| 合并后看板与真实 e2e 仍通过 | 合并记录 | 本轮 board e2e 22/22、browser fixture 289/0、lifecycle e2e 见第 5 节 |

## 3. 设计边界（不再作为未完成）

- 任意跨列工作流状态跳转：状态由任务账本和真实 command 决定，不支持伪造跳转。
- 乐观 UI：写操作仍以 host 回执和重新读取为准，避免回执不确定时显示假状态。
- 真实 iOS/Android WebView 的手势与软键盘：本机没有对应真机环境。
- 真实 git tag/部署：host 只记录版本、门禁证据与报告，实际发布由 Bot 的外部工具执行。
- 跨群 Release：一个 Release 只属于一个 board scope。
- 自定义字段、模板、Power-Ups、自动化、成员邀请：Trello 外围协作能力，不在本任务范围。
- Release 完成时只通知 Release 群/PM 并生成总结报告，不自动创建部署任务；看板是任务权威，部署动作由 Bot 执行。

## 4. 本机剩余限制

- 本机 Machine 级 PATH 有一项以单引号开头（位于 `C:\Users\<user>` 下的 Python 用户脚本目录），导致 Windows 对后续目录的可执行搜索失效。修复方式是由管理员去掉该条目的前导单引号；修复前在本机跑测试需先清理 PATH 中的该条目。此问题不属于仓库缺陷，本轮通过清理 PATH 获得可复现结果。
- 文件符号链接需要 SeCreateSymbolicLinkPrivilege，设置 ACL 所有者需要 SeSecurityPrivilege。本机账户没有这两项权限；相关用例按第 1.3 节跳过并写明原因，Linux CI 仍覆盖对应安全路径。
- 真实模型生命周期仍只在 mock LLM 下验证；`lifecycle.e2e.mjs` 用 `MOCK_BOARD_AUTORUN=1` 驱动真实 `board_task` 协议，不覆盖真实模型的自主编码行为。
- Node 24.14 + Windows + `--test-force-exit`：`connectors-gateway.test.js` 与 `local-agents-mcp-races.test.js` 的所有子用例都通过，但测试运行器强制退出时进程在 `src\win\async.c` 的 libuv 断言处中止，整文件被记为失败。同一文件去掉 `--test-force-exit` 运行则 `pass` 且退出码为 0（已实测），所以这是运行器/Node 在 Windows 上的退出期缺陷，不是产品断言失败。`--test-force-exit` 用于避免个别用例挂住整个运行，本轮未全局移除。

## 5. 验证记录

- `node scripts/build-client.mjs --check`：通过（生成物与源码一致）。
- Browser fixture：**289 assertions, 0 failed**。
- Board e2e：**22/22 passed**，run `20261117142347`。
- Lifecycle e2e `--fresh`：**PASS**（release 群与 10 个角色、11 个类型化任务、TDD 测试、HTTP health/GPA、四道门禁、publish、Markdown/HTML 总结报告）。
- 完整 `npm test`（清理 PATH、使用 `dev/harness`）：**3421 tests，3404 passed，2 failed，15 skipped**。两个失败均为上述 Node/Windows `--test-force-exit` 退出期断言：`connectors-gateway.test.js` 与 `local-agents-mcp-races.test.js` 的子用例全部通过，去掉 force-exit 重跑均 `pass`、退出码 0。
- `npm run lint`：**0 errors**，99 条既有 warning（与本轮前一致）。

## 6. 变更文件

- `ds-bot/src/host/board-service.js`：同步覆盖面、Release 归属与确认后 proposal 的 PM/群通知。
- `ds-bot/src/client/task-board.js`、`ds-bot/client.js`：移动端筛选遮罩与 Escape 行为。
- `ds-bot/test/board-host/board-service.test.mjs`：两条新增同步用例。
- `ds-bot/test/task-board.browser.mjs`：4 条移动端筛选断言。
- `ds-bot/test/board-host/board-images.test.mjs`、`ds-bot/test/mobile.test.js`、`ds-bot/test/private-storage.test.js`：无权限会话的跳过守卫与诊断。
- `ds-bot/test/doctor.test.js`、`ds-bot/test/local-agents.test.js`：跨平台假 pnpm、`Path` 键大小写、fake runtime 补齐。
- `ds-bot/test/e2e/lifecycle.e2e.mjs`：同步断言改为轮询等待，避免负载下固定 1.2 秒窗口误判。
- `ds-bot/test/connectors-gateway.test.js`：子进程 abort 上限与等待时间放宽，避免繁忙机器上的假超时。
- `docs/reviews/2026-11-17-unfinished-items-audit.md`：记录第二轮复核入口与本轮已补项。
- `docs/plans/2026-11-16-board-lifecycle-releases.md`：发布通知的落地说明。
