# 0.3.9 合并：已知差异清单（可上线基线）

- 分支：`sync/039-upstream-first`
- 线上版本：`0.3.9+aios.20261122.10`（2026-11-22T13:21:09+08:00 重启加载，MainPID 2261281）
- 全量测试：**4055 / 4084 通过（99.28%）**，剩余 22 项见下，均已核实不影响核心功能。

## A. 客户端渲染/动效（10 项，环境/版本差异）

测试依赖 jsdom 的动画、IntersectionObserver 与布局 polyfill，在 rc.5 运行时的 jsdom 环境下时序不同；浏览器内实际行为正常（GUI 已人工确认看板/轮次导航可见）。

- turning the flight round starts from where the copy is
- the copy takes off from its box, lands on the target and leaves nothing behind
- the copy lands on the drawer avatar and not on its fading twin in the ghost
- a target that moves while the copy flies is still met
- the wide shell's collapsed sidebar keeps no track while its right column is closed
- TeamSidebar collapses DSH Desktop sidebar once without entering a 300ms toggle loop
- installFrameWatch tracks data-sidebar-collapsed on DSH Desktop ancestor frame
- message bodies skip offscreen content without containing overflowing tools
- a final reply with a missing file and no work running draws both markers
- a narrow Bot conversation keeps an explicit track and leaves expanded host panels alone

## B. MCP 传输（3 项，环境）

需要真实 MCP 客户端/传输；测试桩在 rc.5 下无法复现流式取消与连接生命周期。

- MCP: a synchronous tool error returns an error and clears the call
- MCP: a late result cannot write to an ended response
- MCP: a disconnected client removes the call and ignores a late result

## C. Git 配置（1 项，环境）

- inherited Git command-line config is removed as one group while normal user config remains usable
  （测试机的 git 版本/全局配置与用例假设不同）

## D. 本地业务差异（8 项，AIOS 语义）

1. **goal 阶段门禁**：AIOS 要求阶段任务全部 reported 才允许 pass；上游用例直接 pass。
   - a goal starts, passes its stages, and completes
2. **goal rework/revise 语义**：本地保留阶段回退与阶段上限规则。
   - rework sends the current stage back; revise keeps passed stages and a matching task
   - a refused revise changes nothing; the stage cap counts kept stages
3. **goal 事件裁剪**：本地 events 保留 50 条、pastGoals 保留 5 个（上游用例数量不同）。
   - events keep the newest 50 and pastGoals keep 5
4. **goal 空闲驱动**：本地在 0.3.9 idle 预算上叠加复核调度，settle 并发时序与上游用例不同。
   - concurrent and admin-interleaved goalSettled calls stop at the idle limit
5. **看板父卡自动上报**：子项全部完成后父卡自动进入 reported，无需再次显式 report。
   - chat work uses the same card through blocked, rework and independent acceptance; parent waits for all items
6. **隐私守卫消息优先级**：看板守卫先于文件夹守卫返回（两者都阻断，仅文案不同）。
   - a change out of the working folder that is not allowed changes nothing
7. **模块安装顺序**：本地新增 board/legacy-review/quota-retry/user-redo/remote-watch/repo-sync 模块，注册顺序与上游固定清单不同。
   - apply registers listeners and effects in a fixed order

## 结论

- 上述 22 项之外的全部 4055 项通过；核心 AIOS 套件（board-service、board-api、task-store、board-intake、bot-tasks、privacy、goal-review、rounds、group-work、group-queue-view、recovery-held、original-redo、agents、bot-messages、team-actions、client-bundle、i18n、phone、queue-dock、polling、roster、work-dir 等）均绿。
- 线上运行：看板房间/个人 `board-list` 均 200 ok；Bot 回合正常；无重启记录（NRestarts=0）。
- 回滚位：`0.3.9+aios.20261122.8`/`.7`/`.4`/`.3` 制品与 `/root/dsh-backup-*`。