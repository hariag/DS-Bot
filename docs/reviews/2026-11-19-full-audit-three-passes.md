# 2026-11-19 三轮全面审核与修复

- 审核基线：`main` @ `e751eda2`（拉取最新后），随后合并当时最新 `main`（`65095ca3`）再复验。
- 方式：三轮不同视角的审核，均以可复现证据为准；只修真实缺陷，不做风格重构。

## 第一轮：自动化门禁

- `build-client --check`、lint：通过。
- 完整 `npm test`：3508 tests，3490 passed，3 failed。
  - `test/install.test.js`「apply registers listeners and effects in a fixed order」：真实的过期断言。最新代码新增了 `on session/event`、`on agent-preset/selected`、`cancel Fanttec quota retries`、`schedule/changed`、`schedule/resolve-agent` 等注册；更新期望顺序后 9/9 通过。
  - `test/connectors-gateway.test.js`、`test/local-agents-mcp-races.test.js`：Node 24.14 + Windows `--test-force-exit` 的 libuv `UV_HANDLE_CLOSING` 环境断言；去掉 force-exit 后两文件 9/9 通过。
  - `test/roster.test.js` 的一条时序断言在整套并发下偶发失败；单独运行 65/65 通过，属已知套件负载时序，不是代码回归。

## 第二轮：Host / 领域审核

发现并修复：

1. **取消运行中的发布不会重置子任务**：`cancelRelease` 只遍历带 `releaseId` 的父卡，`startRelease` 已给可执行子项发放 `authority/ready` 和执行 action。现在把子项一起纳入活跃工作检查和重置，取消后子项回到 `proposed`、清空 action/authority/blocked/evidence，不再被调度。
2. **发布成员变更绕过“发布不可编辑”保护**：`assignRelease` 只检查目标发布，`release-assign` 的 `releaseId:null` 分支完全跳过检查。现在只要卡片当前挂在 running/published 发布上，就不能改挂或移除。
3. **独立验收人可同时承担交付角色**：`resolveReleaseTeam` 只做逐任务 owner≠reviewer，未阻止 reviewer 同时是 tester/frontend/ops。现在拒绝“Independent Reviewer 与其他发布角色为同一 Bot”。
4. **取消已汇报卡片后证据残留**：`restore` 保留了 `evidence`，导致恢复后的 `proposed` 卡片无法重新 schedule/edit。现在 restore 清空 evidence（历史仍在任务日志里）。
5. **归档的等待卡被依赖完成推到 ready**：`ready()` 未检查 `archivedAt`，会产生永远不会被调度的 execute action。现在归档卡保持 waiting，不再生成 action。
6. **board-api 测试使用了不可达状态**：测试给 `proposed` 行伪造了 `actionRevision:2` 和活跃 action，断言“proposed 无 Schedule”。改为真实 `actionRevision:null`，并单独覆盖真正带活跃 action 的 proposed 行。

新增 4 个 task-store 回归测试，更新 release-team/board-api 测试。

## 第三轮：Client / 交互审核

发现并修复：

1. **一次性发布团队表单预填并可零操作保存**：编辑已有发布时不再自动填入第一个候选；必须手动选择或点「Auto-fill roles」，保存前至少要有 PM 和全部必需角色。
2. **发布 revision 变化时团队表单静默消失**：保留表单，显示“发布已变化，请关闭并重新打开”并禁用保存/自动填充；不再丢失已选内容。
3. **保存请求挂起时对话框无法关闭**：Escape/背景/✕/取消不再被 `saving` 锁死；请求继续在后台由 operation fence 处理，关闭后可回到详情并用 Check action 核查。
4. **创建发布在响应丢失后重试会重复创建**：发布创建对话框保留同一 `operationId` 和 release id；失败后先查 `board-operation`，已提交则直接加载，明确拒绝则清空后重试，未知则保留同一操作供用户重试。
5. 复核后保持不动的两项：
   - 「中断的工作」默认不显示数量，是 PR #51 为延迟采样做的性能取舍；展开时才拉取完整恢复记录。
   - board 级错误与恢复读取错误共用同一错误槽；要彻底区分需要新增轻量恢复摘要接口，本轮未改协议。

## 验证

- 浏览器 fixture：**355 assertions, 0 failed**（含团队表单空初值/保存禁用、Auto-fill 路径）。
- Board e2e：**22/22 passed**，run `20261119013717`。
- Lifecycle e2e：PASS，11 done，发布报告生成并发布。
- Host + i18n：290 tests，288 passed（2 skipped），0 failed。
- 完整测试套件（合并最新 main 后）：见提交说明。
- `build-client --check`、lint：通过（0 errors）。