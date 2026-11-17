# Trello 面板 UI/UX 修复记录

- 日期：2026-11-17
- 关联审查：[2026-11-17-task-board-ui-ux-review.md](2026-11-17-task-board-ui-ux-review.md)
- 范围：`ds-bot/src/client/task-board.js`、`i18n.js`、`client.js`、`board-api.js`、browser fixture
- 状态：审查中可复现的 UI/UX 问题已修复；剩余项见 [未完成事项复核](2026-11-17-unfinished-items-audit.md)

## 结论

本轮把审查中列出的 **P0/P1/P2 UI/UX 问题**逐项处理，重点不是继续加功能，而是让看板在桌面、移动端、深色和长列表下都可用、可扫描、可操作。

整体从 **7.3/10** 提升到约 **8.2/10**（主观评分）。桌面端已达到稳定的 Trello 风格交付看板水平；移动端从“能用但拥挤”提升为“首屏可完成主要操作”。

## 已修复

### 布局与长列表

- **lane 卡片被 flex 压扁**：`.bt-board-lane-cards > .bt-board-card{flex:none}`。40 张卡片的 lane 现在完整滚动，不再裁切标题/标签。
- **横向轨道**：增加 `scroll-snap` 和右侧渐隐，保留箭头；滚动位置更容易感知。
- **移动端顶部工具墙**：
  - 恢复工具在无异常时隐藏（`hasBoardTools`），有异常时通过 `Board tools` 展开；
  - Filters 改为按需展开的筛选区，默认只保留 `Filters` 按钮；
  - 移动端隐藏顶部 `New release` 按钮，Release 视图仍可创建；
  - 内容区起点从 y≈281 降到 y≈198，lane 起点从 y≈424 降到 y≈301。
- **移动端卡片详情**：
  - 标题下新增 sticky 状态/类型/负责人条，`Manage` 直接滚动到侧栏；
  - 状态/类型/负责人无需滚过描述、检查项、附件和评论才能看到。

### 交互与数据

- **Draft 快速捕获**：草稿现在只填标题即可保存；owner/reviewer 自动取看板内可用 Bot，acceptance 默认 `To be defined.`，之后可补充。
- **Release 团队自动填充**：
  - board-list 返回 `releaseCandidates`（按 Bot `role` 标签匹配）；
  - Release 对话框自动预选 PM 和 required 角色；
  - 保留 `Auto-fill roles` 按钮；
  - 角色下拉显示 `Name · Role`。
- **实时刷新**：
  - 看板打开时每 15 秒轻量刷新，窗口重新聚焦时刷新；
  - 卡片/创建对话框打开时暂停；
  - Changes 有新 proposal 时显示强调色未读 badge，打开 Changes 后清零。
- **Archive**：
  - task 增加 `archivedAt`，host 支持 `archive` / `unarchive` 命令；
  - Status view 增加 `Archive` 视图，归档卡片从工作流/类型/Release 视图隐藏；
  - 卡片 More actions 提供 `Archive card` / `Restore from archive`；
  - 批量归档后 toast 提供 Undo，可恢复整批卡片。
- **批量归档/取消**：`Select` 进入选择模式，卡片出现复选框；`Archive selected` / `Cancel selected` 批量执行并 reload；toast 里的 Undo 通过 `unarchive`/`restore` 恢复。
- **列操作**：每条 lane 可折叠/展开，减少长看板的视觉噪音。
- **撤销**：归档/批量归档和批量取消提供 Undo toast；类型编辑提供局部 Undo。状态/Release 变更仍依赖确认层和安全操作。
- **键盘**：`N` 打开新建卡片，`/` 聚焦搜索；`Esc` 仍是关闭最上层。
- **看板概览**：状态视图显示 Working / Waiting / Blocked / Overdue / Done 计数；移动端隐藏以免占高。
- **Release 取消**：仍保留 before/after 确认；浏览器 fixture 已覆盖确认按钮。
- **状态操作**：Draft 只 Submit/Cancel；Cancelled 只 Restore；Done 不显示 Cancel；Schedule 只在 Proposed/Waiting 且未 blocked/stale 出现。
- **封面操作**：已设封面时显示 `Remove cover`，不再出现两个 `Cover`。
- **ARIA**：打开卡片/创建层时底层 board dialog 的 `aria-modal` 不再同时为 true。

### 字号、对比度、命中区

- Owner 头像 20→22px，首字母 9→10→11px；卡片底部更易读。
- 元数据（评论/附件计数、+N 标签、ID）从 `--bt-ink-3` 提升到 `--bt-ink-2`，改善 11px 文字对比。
- Release 封面 flag/action 10/14 → 11/16。
- `bt-card-mini` 最小 28×28；卡片删除按钮 28×28；标签移除按钮加 28×28 透明命中区。
- 状态/类型/Release tab 26→28px。
- 卡片 person 行高从 1.3 归于 16px。

### 本轮验证

- `build-client --check` 通过；`npm run lint` 0 errors（96 条既有 warning）。
- Browser fixture：278 assertions，0 failed（新增列区间/Release 紧凑 chip/取消菜单/空恢复面板断言）。
- Board e2e：22/22 passed（run `20261117060903`）。
- Board-host：234 tests，231 passed，1 failed（Windows symlink `EPERM`），2 skipped。
- Lifecycle e2e：`--fresh` 通过（11 tasks、app tests、health、publish、report）。
- 完整 `npm test`：2894 tests，2871 passed，11 failed，12 skipped；2 个 i18n 缺键已修复并单独重跑通过，其余为已知 Windows 环境/依赖失败。
- 移动端审查：390×844 内容起点 y≈198、lane y≈301；无水平溢出。

## 原生 Trello 扩展与边界

本轮已补齐此前列出的核心缺口；剩余项按产品边界记录，不用 UI 假象冒充完成：

- **批量操作**：归档/取消/类型/负责人/Release/复制；个人看板支持批量移动到 todo/doing/finished。工作流跨列仍由 submit/schedule/cancel/restore 等真实命令驱动，不支持任意状态跳转。
- **文件附件**：支持 PNG/JPEG、PDF、ZIP、纯文本、Markdown、JSON；图片可预览/设为封面，其他文件显示文件卡并可下载。host 校验内容 magic、UTF-8/JSON、大小和名称；单文件 5 MiB、每批 10 个、每任务 20 个。
- **列表菜单**：lane 支持折叠/展开、重命名、左/右移动、归档全部卡片，以及手动/截止/标题/类型排序；轨道显示当前列区间和剩余列数。
- **撤销**：归档/批量归档/批量取消/类型编辑/状态取消提交/Release 移动/同列拖拽排序/调度有 Undo；跨列状态变更仍依赖各自命令和确认层。`unschedule` 只取消尚未被 claim 的 pending execute action。
- **Board activity feed**：新增 Activity 视图，聚合各卡片最近变更（操作、任务、操作者、时间）。
- **拖拽键盘等价**：卡片状态区的 `Move to…` 菜单提供当前允许的 submit/schedule/restore/cancel；个人进度使用选择器。
- **Release**：chip 只显示版本和完成数；Cancel/上移/下移收进 `···` 菜单；没有 Release 时不显示空 track。
- **移动端**：Filters 打开为底部固定面板；卡片 sticky 条包含状态、类型、负责人、截止日期和 Manage。

这些之外的自定义字段、模板、Power-Ups、自动化、跨群 Release、真实 git tag/部署仍属于明确的产品边界，见复核文档。

## 验证边界

- UI 截图使用 40 cards / 8 lanes / 4 releases 的合成数据，不代表生产真实数据。
- 移动端审查为 Chromium 390×844；未在真实 iOS/Android WebView 上跑手势和软键盘。
- 本轮收尾的 host/UI 变更已重新跑 fixture、board e2e 和 host tests；结果见 PR 描述。未运行真实模型生命周期。

## 截图

- [状态视图 1440](../images/review-board-status-2026-11-17.png)
- [Release 视图 1440](../images/review-release-view-2026-11-17.png)
- [卡片详情 1440](../images/review-card-detail-2026-11-17.png)
- [状态视图 390](../images/review-mobile-board-2026-11-17.png)
- [卡片详情 390](../images/review-mobile-card-2026-11-17.png)
- [深色状态视图 1440](../images/review-dark-board-2026-11-17.png)
- [Archive 视图](../images/review-archive-2026-11-17.png)