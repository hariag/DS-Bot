# 批量操作与 Undo 完善记录

- 日期：2026-11-17
- 基线：`main` @ `463f6d85`
- 范围：`ds-bot/src/client/task-board.js`、`i18n.js`、`client.js`、`test/task-board.browser.mjs`
- 状态：实现完成；fixture、board e2e、i18n 测试通过

## 本轮改动

### 批量状态

选中卡片后新增 `Apply status` 选择器，按当前 command 能力执行：

- `Submit`：draft → proposed
- `Schedule Bot`：proposed/waiting → ready
- `Restore card`：cancelled → proposed
- `Restore from archive`：archived → unarchived

不会把卡片直接推到不受支持的状态；不可执行的卡片会被跳过。

### 批量 Undo

- 状态：submit → cancel，schedule → unschedule，restore → cancel，unarchive → archive。
- 负责人：记录每张卡原 owner，撤销时发回原 owner。
- Release 归属：记录原 releaseId；原为空时 remove，原有其他 release 时重新 assign。
- 批量复制：记录新建卡片 ID，撤销时归档这些副本。
- 个人看板移动：记录原 progress，撤销时移回。
- 归档/取消/类型编辑的既有 Undo 保留。

### Archive 视图

Archive 视图支持选中归档卡片并批量 `Restore from archive`，不必逐张打开卡片。

### 测试

- Browser fixture 新增：批量 submit + Undo、Archive 视图批量 restore、个人看板批量 move、批量复制 + Undo、批量 owner + Undo。
- 断言数从 278 增至 **285**。

## 验证

- `node scripts/build-client.mjs --check`：通过
- `node test/task-board.browser.mjs`：**285 assertions, 0 failed**
- `node test/e2e/board.e2e.mjs --fresh`：**22/22 passed**，run `20261117070314`
- `i18n.test.js` / `legacy-review-i18n.test.js`：4/4 passed
- `npm run lint`：0 errors

## 保留边界

- 仍不提供任意工作流状态跳转；批量状态只调用当前卡片真实可用的 command。
- 批量 Release 归属撤销依赖目标 Release 仍存在且处于可编辑状态；缺失时该条会报告未撤销。
- 批量复制撤销采用归档副本，不永久删除历史记录。