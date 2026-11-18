# 官方 DeepSeek Harness 兼容性复核

- 日期：2026-11-18
- 基准：`main` @ `6302fa54`（已并入本分支）加本轮改动
- 目标：DS-Bot 必须运行在官方 `deepseek-ai/deepseek-harness` 发布的包上；此前使用的 `hariag/deepseek-harness`（官方源码加一个补丁）不再需要，也不作为受支持的环境。

## 1. 结论

DS-Bot 与官方 DSH 兼容：

- 所有 `@deepseek-ai/*` 引用都来自 npm 上的官方包；`peerDependencies` 未改。
- 此前 fork 的唯一补丁是“在运行期导出 Cordis fiber state”。官方 `@deepseek-ai/cordis` 4.1.0 已经提供 `Fiber`、`uid` 和 `ctx.fiber`：`lib/index.js` 在创建 fiber 时执行 `this.ctx = this.context = parent.extend({ fiber: this })`，fiber 释放后 `uid` 为 `null`。DS-Bot 只以可选方式读取 `ctx.fiber`（`parts.js`）并使用 `ctx.plugin()` 返回的 fiber（`agent-commands.js`、`capabilities.js`），不依赖 fork 的补丁。
- 测试、lint、看板/生命周期测试台都用 `dev/harness/` 里 `npm run harness` 从 npm 安装的官方包，不需要任何 DSH 源码 checkout。
- `app/`（桌面应用）本来就依赖官方 `0.2.2-rc.1` 系列包，没有引用 fork。
- 仓库内不再有任何 `hariag/deepseek-harness` 引用（`CHANGELOG` 里的 `hariag/DS-Bot` 只是本仓库的历史 PR 链接）。

## 2. 本轮改动

### 2.1 统一的 harness 解析

新增 `ds-bot/test/harness-root.mjs`，按顺序解析：

1. `DSH_HARNESS`（必须是官方安装或官方源码 checkout）；
2. `dev/harness/`（`npm run harness` 从 npm 安装的官方包）；
3. 插件旁边、或 git 主工作树旁边的 `deepseek-harness/` 官方源码 checkout。

`test/harness-resolve.mjs` 改为复用该解析器，行为与之前一致，但只有一处实现。个人 fork 不受支持：fork 可能带有官方发行版没有的补丁，插件必须跑在官方包上。

### 2.2 浏览器 fixture 不再需要 DSH 源码 checkout

`task-board.browser.mjs`、`local-queue.browser.mjs`、`review-timeline.browser.mjs` 之前要求 `DSH_HARNESS` 指向一个带 `apps/web` 的源码 checkout，并从那里取 React 和 Playwright。现在：

- harness 可选；React 18 的 UMD 构建由 `BOARD_REACT_DIR` 提供；
- Playwright 优先取 harness 里的，取不到就用插件自己的 `playwright-core`；
- 只有两者都不可用时才报错，并在错误里说明 `BOARD_REACT_DIR` 和官方 checkout 两条路径。

这样删除本地 fork 后，`npm run test:board:browser`、`test/local-queue.browser.mjs`、`test/review-timeline.browser.mjs` 仍可运行。

### 2.3 CI 覆盖官方 next 版本

`.github/workflows/test.yml` 的矩阵新增官方 `0.2.2-rc.4`（npm `next` 标签）。原矩阵保留官方 `0.2.2-rc.1`（`latest`）与 `0.2.0-rc.2`。三个版本都用同一版本的官方 testkit。

### 2.4 文档

- `AGENTS.md`：明确只支持官方仓库；测试台使用 `dev/harness` 的 npm 包，源码 checkout 仅用于从源码构建或启动 DSH 的 Linux 开发脚本。
- `CONTRIBUTING.md` / `CONTRIBUTING.zh.md`：单元测试、lint、看板/生命周期测试台不需要 checkout；Linux 开发测试台、截图和桌面测试台才需要官方 checkout；个人 fork 不受支持。
- `ds-bot/README.md`：开发依赖说明改为 Node + npm + `npm run harness`；源码 checkout 只用于 Linux 开发脚本和桌面测试台。
- `ds-bot/test/e2e/README.md`、`docs/plans/2026-11-13-continuous-task-boards.md`：测试台与浏览器 fixture 的依赖说明同步更新。

## 3. 验证

### 官方 0.2.2-rc.1（npm `latest`，`dev/harness`）

- 完整 `npm test`（合并 `6302fa54` 之后的树）：**3437 tests，3418 passed，4 failed，15 skipped**。4 个失败中：
  - 2 个是既有的 Node 24.14 + Windows + `--test-force-exit` 退出期 libuv 断言（`connectors-gateway.test.js`、`local-agents-mcp-races.test.js` 的子用例全部通过，去掉 force-exit 重跑退出码 0）；
  - 2 个是并发负载下的计时/时序用例（`connectors-gateway-egress` 的 dispatcher 超时、`roster` 的出队重试）偶发；单独重跑 `browser-downloads`、`connectors-gateway-egress`、`roster` 三个文件为 **101/101 passed**。
- Browser fixture（不设 `DSH_HARNESS`，只给 `BOARD_REACT_DIR`）：**289 assertions, 0 failed**。
- `local-queue.browser.mjs`、`review-timeline.browser.mjs`：PASS，退出码 0。
- `npm run lint`：0 errors（99 条既有 warning）。

### 官方 0.2.2-rc.4（npm `next`，临时安装到工作区外）

- 完整 `npm test`（同一棵合并后的树）：**3437 tests，3419 passed，3 failed，15 skipped**。3 个失败中：
  - 2 个是上面同一组 `--test-force-exit` 退出期断言；
  - 1 个是 `connectors-gateway-egress` 的 dispatcher 计时用例在并发负载下偶发；单独重跑 `browser-downloads`、`connectors-gateway-egress`、`roster` 为 **101/101 passed**。
- 真实 `dsh web` + 插件冒烟：用 `0.2.2-rc.4` 启动测试台，插件正常加载，`state` 请求成功，创建群聊与看板任务（`board-command`/`board-list`）成功。

### 其余

- Board e2e（官方 `dev/harness`，不设 `DSH_HARNESS`）：**22/22 passed**，run `20261118030920`。
- Lifecycle e2e `--fresh`：**PASS**（11 个类型化任务、TDD、health/GPA、publish、总结报告）。
- Leak scan（提交树）：**0 must-fix**（1148 条既有 can-stay）。

## 4. 边界

- Linux 的 `dev/bench.sh`、`dev/check.sh`、截图和 `dev/desktop-linux/desktop.sh` 从 DSH 源码启动或构建，仍需要官方源码 checkout（`../deepseek-harness` 或 `DSH_HARNESS`）；这不影响 `npm test`、lint 和看板/生命周期测试台。
- `0.2.2-rc.4` 是 npm `next` 预发布，不是 `latest`；CI 新增它用于提前发现官方后续版本的不兼容，不改变插件对 `latest` 的支持声明。
- 真实模型行为仍不在 mock 测试覆盖范围内。