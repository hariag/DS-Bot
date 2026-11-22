# 上游 DS-Bot 0.3.9 功能合入审计

- 审计对象：上游 `Fei2411/DS-Bot` v0.3.9 = `881b57b5`（0.3.8 基线 `5e9b7da8`）
- 本仓库：`sync/039-upstream-first`（审计时 `fb543c58`）
- 线上：`0.3.9+aios.20261122.21`（2026-11-22T20:38:59+08:00 加载，MainPID 3152384，NRestarts 0）
- 审计时间：2026-11-22（Asia/Shanghai）

## 一、文件级

| 项 | 结果 |
|---|---|
| 0.3.9 新增文件 | 132 个，HEAD 中 **全部存在**（missing=0） |
| 0.3.9 删除文件 | 0 个 |
| 0.3.9 修改文件 | 147 个，**全部已合并**；不再有“整文件仍是我们 fork 0.3.8 版本”的文件 |
| 唯一遗漏并已修复 | `src/client/frame-watch.js`：本地 rescan 优化保留，补入 0.3.9 的抽屉 position 判断与 `width:auto` 规则（`browser-frame`/`frame-layout` 35/35） |

逐行抽查 147 个修改文件：仅 13 个文件存在“上游新增行未命中”，其中 12 个为预期差异（`client.js` 为构建产物、`index.js` MODULES/UI 并集、`package.json` 版本、`goal/header/channel/delivery/goals/models/privacy` 的本地等价改写），1 个即上述 `frame-watch.js`，已补齐。

## 二、功能级（对照 0.3.9 CHANGELOG）

新增功能全部有代码/测试落点：

- 后台任务与异步 Bot 工作：`task_start/send/stop/list`、`bot-tasks.js`、Tasks 页、Dynamic Island、移动端任务条、Background work 设置
- DeepSeek 官方服务：`auto` 搜索、`read_document`、语音听写/朗读、`deepseek-services.js`
- Web remote：`remote.mux` / “Open in a browser”
- 定时任务暂停/恢复、浏览器登录导入、本地 MCP 访问、MCP OAuth 与客户端配置指南
- 内置手册与 bug 上报（`manual-skills.js`、`issue-report.js`、`prepare_ds_bot_issue`）
- 模型菜单搜索、Bot 终端标签页、手机端新增、IM 出站图片/微信引用、群审批岛与 New session

变更项：

- 记忆工具更名为 `bot_remember/bot_forget/bot_recall`（已生效）
- 启动/聊天/搜索/Usage/手机传输性能组：`usage.js`、`chat-index.js` 等与上游逐字节一致
- 草稿随会话保留（`DraftKeeper`）、102 条主机错误翻译

修复项：以文件级合并为准，全部随 147 个修改文件与 132 个新增文件进入本仓库；本地语义差异见第四节。

## 三、测试级

- 0.3.9 新增测试文件：38 个，全部存在。
- 批量运行 0.3.9 新增套件：**320 / 344 通过**。
- 23 个失败全部为环境类：
  - `test/browser/write-safety.test.js`（20 个）与 `test/browser/isolation.test.js`（2 个）：需要真实浏览器/CDP 的自动化用例，测试机无浏览器；
  - `test/local-agents-env.test.js`（1 个）：测试机 git 全局配置与用例假设不同。
  - 非浏览器类 0.3.9 用例全部通过。

## 四、有意保留的本地业务差异（非遗漏）

1. 群通知上限本地 4000（上游 2000）；
2. goal 阶段门禁（先汇报再 pass）与复核节奏；
3. 看板父卡在子项全部完成后自动进入 reported；
4. 看板守卫与文件夹守卫的报错优先级；
5. 本地模块（board/legacy-review/quota-retry/user-redo/remote-watch/repo-sync）导致的安装顺序差异。

## 五、范围提示

审计只覆盖 **0.3.9**。上游随后已发布 **0.3.10**（`d104d9ca`，距 0.3.9 有 222 个提交，含 settings console、feature-pack 团队管理、移除 Bot sessions 等）。这些**不在本次审计与合并范围**；如需跟进 0.3.10 需另开同步。