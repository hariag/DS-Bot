# Trello 面板 UI / UX / 视觉审查

- 日期：2026-11-17
- 范围：`ds-bot/src/client/task-board.js`、`i18n.js`、`client.js`
- 基准：Trello 核心交互、`docs/design/ui-standard.md`、DeepSeek Harness 视觉语言
- 方法：代码审查 + 合成数据 Playwright 截图（40 cards / 8 lanes / 4 releases）+ 1440、1024、390 三档 + 深色 + reduced-motion + 焦点/尺寸/字体/溢出测量
- 状态：审查完成；可复现 UI/UX 问题已修复，原生 Trello 扩展边界见修复记录
- 修复记录：[2026-11-17-task-board-ui-ux-fixes.md](2026-11-17-task-board-ui-ux-fixes.md)

## 1. 结论与评分

| 维度 | 评分 | 判断 |
|---|---:|---|
| Trello 核心 UI 还原 | 7.5 / 10 | 列表、卡片、拖拽、标签、截止、检查项、评论、封面都已具备；视觉是 Harness 极简风格，不是 Trello 彩色复刻，属于有意适配 |
| 功能还原 | 7.5 / 10 | 核心卡片闭环完整，并额外有类型、Release、门禁、Bot 确认；缺归档、批量、文件附件、键盘快捷键、列表操作 |
| UX 流畅度（桌面） | 7.5 / 10 | 卡片详情、拖拽、确认层、视图切换成熟；缺少撤销、实时刷新和批量操作 |
| UX 流畅度（移动） | 5.5 / 10 | 顶部工具/恢复/Release 区占高过大；卡片详情关键操作在长内容之后 |
| 信息交互完整性 | 8 / 10 | 状态、类型、负责人、验收人、Release、门禁、进度都能看见；没有全局仪表盘和实时变更提示 |
| 直观 / 可视化 | 7.5 / 10 | 状态点、类型 chip、进度条、Release 进度和门禁 chip 清晰；横向轨道和筛选在窄屏可发现性不足 |
| 整体美学 / 风格统一 | 8 / 10 | token、发丝边、圆角、字号基本统一；少量 10–12px 特例和恢复工具的开发感拖累完成度 |
| 多风格适配 | 7 / 10 | 浅色/深色/移动/缩小宽度均可工作；深色对比和移动信息层级仍需打磨 |
| 可用性 / 实用性 / 效率 | 7 / 10（桌面）、5.5 / 10（移动） | 单人单卡效率高；快速捕获、批量、筛选、角色配置效率不足 |
| **综合** | **7.3 / 10** | 已达到“可用的 Trello 风格交付看板”，下一阶段应从“功能齐全”转向“高密度专业工具的效率与移动体验” |

## 2. 主要优点

1. **卡片详情是完成度最高的部分**：标题、状态、类型、负责人/验收人、描述、检查项、附件/封面、评论、历史、依赖、分享分区明确；两栏布局在桌面端可扫描。
2. **状态与类型语言统一**：状态点、类型 chip、Release chip、门禁 chip 使用同一套数据结构；颜色只承担辅助，不单独承载语义。
3. **关键操作有安全边界**：编辑确认层、Bot proposal 确认、Release 取消确认、拖拽类型确认；比一般 Trello 克隆更重视不可逆操作。
4. **Release/生命周期信息可视化**：Release lane 显示版本、状态、PM、角色数、item 进度和四道门禁；这是普通 Trello 没有的增值信息。
5. **焦点与键盘基础可用**：所有按钮有可访问名称；board/card 两层 dialog 均有 `aria-modal`、`Esc`、焦点陷阱；实测焦点不会逃出卡片层。
6. **无水平溢出**：1440/1024/390 三档 body、dialog、content 均无横向溢出；窄屏自动全屏。

## 3. Trello 功能对照

> 下表是 2026-11-17 审查时的基线，保留原判断用于对照。当前实现状态、已补齐项和明确边界见 [修复记录](2026-11-17-task-board-ui-ux-fixes.md) 与 [未完成事项复核](2026-11-17-unfinished-items-audit.md)。

| 能力 | 状态 | 说明 |
|---|---|---|
| Board / List / Card | ✅ | 状态、类型、Release 三种 lane 视图 |
| 拖拽 / 同列排序 / 跨列 | ✅ | 有 drop 指示线、跨列确认和释放视角 |
| 标签 / 截止 / 检查项 / 评论 / 封面 | ✅ | 均有编辑与持久化 |
| 图片附件 | ✅ | PNG/JPEG/WebP/GIF；非图片文件拒绝 |
| 搜索 / 成员 / 标签 / 类型 / 截止筛选 | ✅ | 客户端即时筛选；移动端横向滚动 |
| 负责人 / 独立验收人 | ✅ | 比 Trello 更严格 |
| Activity / History | △ | 有卡片历史/活动记录，但默认折叠，无 board 级 feed |
| 归档 / 关闭 | △ | 用 Done / Cancelled 列代替；没有独立 Archive，Done 列会持续增长 |
| 批量选择 / 批量移动 | ✗ | 无多选、批量改状态/负责人/Release |
| 列表操作 | ✗ | 无重命名/归档/排序/移动整列 |
| 键盘快捷键 | ✗ | 无 `N` 新建、`/` 搜索、方向键卡片导航等 |
| 文件附件 | ✗ | 只支持图片，不支持 PDF/zip/代码文件 |
| 自定义字段 / 模板 / 自动化规则 | ✗ | Release/类型是固定字段 |
| 撤销 | ✗ | 拖拽/状态变更后无 undo toast |
| 实时协作 | ✗ | 需要手动刷新才能看到 Bot 新 proposal/状态 |
| 移动端拖拽 | △ | HTML5 drag 在触屏不可依赖；卡片详情按钮可替代 |
| 看板成员管理 | △ | 有成员筛选，缺少看板级成员/角色配置入口 |

## 4. 本轮已修复的问题

### P0-1 卡片被 flex 压缩导致裁切

- 现象：lane 内卡片超过约 4–5 张后，卡片被纵向压缩，标题/标签/底部信息被裁切；Release 的 Unassigned lane 36 张卡片几乎变成一条条空条。
- 原因：`.bt-board-lane-cards` 是纵向 flex 容器，`.bt-board-card` 默认 `flex-shrink:1`；卡片总高度超过容器时被压扁而不是滚动。
- 修复：`.bt-board-lane-cards > .bt-board-card{flex:none}`。
- 结果：40 张卡片的 lane 正常显示完整卡片并内部滚动；Release 视图卡片恢复可读高度。

### P0-2 状态操作与当前状态矛盾

- 现象：Draft 卡片同时显示 `Schedule Bot`、`Submit card`、`Restore card`、`Cancel card`；界面一边提示“Draft cards are not scheduled”，一边提供调度按钮。
- 原因：UI 只看 command 是否存在，没有按 task.status 过滤。
- 修复：
  - `Submit` 仅 `draft`；
  - `Restore` 仅 `cancelled`；
  - `Cancel` 排除 `done`/`cancelled`；
  - `Schedule` 仅 `proposed`/`waiting` 且未 blocked/stale。
- 结果：Draft 只出现 Submit/Cancel；Cancelled 只出现 Restore；卡片详情不再自相矛盾。

### P0-3 Release 取消是一键破坏性操作

- 现象：Release lane 的 `Cancel` 直接调用接口；误点会使版本不可恢复。
- 修复：点击 Cancel 先进入看板级 before/after 确认层，确认后才调用 `board-release-cancel`。
- 结果：浏览器 fixture 已同步验证确认流程。

### P1 其他已做的小修正

- Release 封面操作从重复的 `Cover` 改为 `Remove cover`，避免封面 badge 与按钮同名。
- 状态视图的 Type 视图 tab 高度从 26 → 28px，命中 28px 最小点击区。
- 卡片 owner 头像 20 → 22px，首字母 9 → 10px（仍低于标准 11px，见 P2）。
- 卡片详情标题下方新增状态 chip + 类型 chip，移动端无需滚动到侧栏即可确认关键属性。
- 移动端筛选/恢复工具/Release chips 改为单行横向滚动，并加右侧渐隐提示；减少顶部高度约 70px。
- `bt-card-mini` 最小点击区 28×28，卡片内小操作更容易点中。

## 5. 审查发现（修复结果见修复记录）

> 以下 P1/P2 是审查时列出的待处理项；可复现项已处理，剩余项及设计边界见复核文档。保留原文是为了让“问题—修复—证据”可追溯。

### P1-1 移动端首屏被“工具墙”占据

- 实测 390×844：内容区从 y=281 开始，lane 从 y=424 开始；首张卡片高 326px，首屏只能完整看到一张卡。
- 占用来源：标题/搜索/4 个筛选/Changes/3 个恢复工具/Release 条/轨道箭头。
- 建议：
  - 恢复工具在无异常时完全隐藏，或收进一个 `Board tools` 弹出菜单；
  - 筛选改为一个 `Filter` 按钮 + 底部 sheet，只显示已启用筛选项；
  - Release 条在没有 Release 时隐藏，有 Release 时只保留紧凑 chip；
  - 移动端标题区合并为两行，把容量/模式降为次级信息。

### P1-2 移动端卡片详情的关键操作在长内容之后

- 当前顺序：标题 → 描述 → 检查项 → 附件 → 评论 → 状态/负责人/类型/截止。
- 实测移动端打开卡片后，状态侧栏完全在首屏之外；用户要滚动很久才能改状态/类型/负责人。
- 建议：
  - 标题下增加 sticky/compact action row：状态、类型、负责人、截止；
  - 或把侧栏的 Status/People/Type 三块前置到描述之前；
  - 保留底部 sticky 的 `Save/Close` 或状态切换。
- 这是移动端最高优先级的 UX 改进。

### P1-3 快速捕获仍然过重

- Quick add 只输入标题后，仍需打开完整对话框；完整对话框要求 Owner、Reviewer、Acceptance 都填写，`Save as draft` 也不例外。
- Trello 的核心体验是“先记下来，再补细节”；当前更接近“先立项”。
- 建议：
  - Draft 允许仅标题创建，owner/reviewer/acceptance 可后补；
  - 或 quick add 直接创建 draft，再打开详情补充；
  - 对群看板保留“创建并调度”需要完整字段的严格路径。

### P1-4 Release 团队配置成本高

- 创建 Release 时需要手动选择 PM + 8 个 required 角色；actor 下拉只有名字，没有角色标签；没有“使用现有角色 Bot”一键填充。
- 建议：
  - board-list 返回每个角色的候选 Bot（按 `role` 标签匹配）；
  - 创建按钮旁提供“Auto-fill roles”；
  - 显示 `Project Manager · Alice` 这类 role/name 组合；
  - 缺少角色时提供“创建缺失角色”入口，而不是只显示 host 错误。

### P1-5 看板不是“活的”

- Bot 新的 proposal、任务状态、Release 进度需要手动 Refresh；`Changes` 只在已有 proposal 时显示数字，没有 toast/红点。
- 建议：
  - 30–60s 轻量轮询 `board-list`，或在 DSH 连接上推送 board revision；
  - proposal 到达时在 Changes 上显示未读 badge；
  - 拖拽/状态变更使用 optimistic UI + undo toast。

### P1-6 横向轨道可发现性不足

- 1440 下 8 个 lane 只有 6 个可见，轨道宽 2158/1350；滚动条被隐藏，靠右上角两个箭头。
- 1024 下 5 个可见；390 下 2 个可见。
- 建议：左右边缘渐隐、可点击的 lane 索引/跳转、滚动时 sticky lane header；移动端保留滑动手势但提供明确的“还有 3 列”提示。

### P2-1 恢复工具的开发感

- `Interrupted work 0`、`Work decisions`、`Manual notes (optional)` 常驻在搜索栏下方，即使数量为 0。
- 建议：无待处理项时隐藏；有异常时显示红点/计数，并进入 `Board tools`。
- 这是造成“像内部调试面板而不是产品”的主要因素。

### P2-2 字号/行高/颜色仍有标准偏差

- 测量到的字号组合除 13/18、11/16、12/16、17/24 外，还有 `12/14`、`11/18`、`11/16.5`、`13/16.9`、`13/normal`、`10/14`、`12/12`。
- 卡片 owner 首字母 10px，低于 `ui-standard` 的 11px 最小文字档。
- `--bt-ink-3` 的 11px 元数据（时间、计数、占位）在浅色/深色上都接近低对比阈值，建议做一次 contrast 检查后再调整。
- 建议：把状态/类型/元数据统一到 11/16 或 12/16；头像字号允许图形例外并写入标准。

### P2-3 可访问性细节

- 卡片模态打开时 board 和 card 两个 dialog 同时 `aria-modal="true"`；语义上应只有最上层 modal 为 modal，底层用 `inert` 或 `aria-hidden`。
- 卡片内仍有一个小于 28×28 的控件（标签移除，14px）；建议扩大命中区或移入菜单。
- 拖拽没有键盘等价操作；目前依赖卡片详情的状态按钮替代，建议补“Move to…”菜单。
- 菜单/详情里的方向键导航仍不完整；建议按 `ui-standard` 统一。

### P2-4 Release 视图的信息重复与密度

- Release chip 同时展示 name、version、status、count；Release lane 又展示同名/版本/状态/门禁；顶部还有 Release tab。
- 建议：chip 只保留 `v1.0 · 1/4`，详细状态放 lane/detail；New release 只保留一个入口。
- Release lane 的 `Cancel` 虽已加确认，但仍与 Start/Queue 同排；建议将 Cancel 收进 `...` 菜单，减少误触。

## 6. 设计风格与适配判断

- **与 Harness 的契合**：surface/hairline/12px card/token 使用正确，整体像 Harness 内的一个专业工作台，而不是 Trello 皮肤。
- **与 Trello 的差异**：Trello 的彩色背景、列表操作、卡片快速捕获、活动 feed 和快捷键没有照搬；这是合理的产品取舍，但“快速捕获”和“列表操作”是 Trello 效率的核心，应优先补。
- **深色模式**：token 替换整体成立；卡片边界、类型 chip 和次级文字对比度需要真实主题下逐项检查。
- **移动端**：全屏 board/card 是正确的方向，但当前首屏信息和操作顺序不适合手机；需要重排，而不是继续压缩。

## 7. 建议优先级

### 立即（下一轮）

1. 移动端顶部工具收敛：恢复工具隐藏/收进菜单、筛选 sheet、Release 条按需显示。
2. 移动端卡片详情增加标题下关键属性 action row，或前置 Status/People/Type。
3. Draft 允许标题-only 快速创建，补“先记下来”的 Trello 核心路径。
4. Release 团队自动填充/角色标签，减少 9 次手动选择。

### 短期

5. 轻量轮询/实时 board revision + Changes 未读 badge。
6. 横向轨道 edge fade / lane 索引；移动端列数提示。
7. 撤销 toast + 拖拽/状态变更 optimistic UI。
8. 字号/对比度统一，移除 10px 以下文字；补齐最小点击区。

### 中期

9. Archive、批量选择、列表操作、文件附件、键盘快捷键。
10. Board 级 activity feed / 全局状态仪表盘（按状态、类型、Release、阻塞、逾期）。
11. 深色主题真实截图逐项对比；补齐 dialog `inert`/aria 语义。

## 8. 验证

- 修复后 `node scripts/build-client.mjs --check` 通过；`npm run lint` 0 errors。
- Browser fixture：268 assertions，0 failed（已同步 Release 取消确认流程）。
- Board e2e：22/22 passed（run `20261116211040`）。
- UI 测量：1440 无水平溢出；390 board/card 均全屏且无水平溢出；焦点陷阱通过。
- 本报告截图使用 40 cards / 8 lanes / 4 releases 的合成数据，覆盖 1440、1024、390、深色和 reduced-motion；不是生产数据。

## 9. 截图

- [状态视图 1440](../images/review-board-status-2026-11-17.png)
- [Release 视图 1440](../images/review-release-view-2026-11-17.png)
- [卡片详情 1440](../images/review-card-detail-2026-11-17.png)
- [状态视图 390](../images/review-mobile-board-2026-11-17.png)
- [卡片详情 390](../images/review-mobile-card-2026-11-17.png)
- [深色状态视图 1440](../images/review-dark-board-2026-11-17.png)

## 10. 说明

- 本轮已修改 `task-board.js`、`i18n.js`、`client.js` 和 browser fixture 的取消确认断言；未修改 host 协议。
- 审查截图和测量脚本在 `D:\aios\artifacts-tmp\ui-review\`，属于临时验证材料，不进入仓库。
- 所有产品代码改动已在 2026-11-17 收尾后按分支/PR 处理；具体 commit 以 PR 为准。