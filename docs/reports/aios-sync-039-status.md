# AIOS × DS-Bot 0.3.9 合并状态（上游优先）

- 分支：`sync/039-upstream-first`
- 上游基线：`Fei2411/DS-Bot` v0.3.9（`881b57b5`）
- 本地来源：`hariag/DS-Bot`（AIOS 定制）
- 记录时间：2026-11-22

## 策略

1. 上游 0.3.9 为唯一基线，上游全部变更保留。
2. 本地 195 个新增文件叠加在上游之上。
3. 对上游文件的本地需求一律以**纯增量**方式实现（新增导出、新增 hook、附加字段），不改变上游既有语义。
4. 本地业务逻辑与上游语义冲突处单独列出，待决策。

## 当前测试基线（DSH rc.5 运行时，本地 harness）

| 范围 | 结果 |
|---|---|
| 全量 `test/*.test.js` + `test/board-host/*.mjs` | **4050 / 4084（99.2%）** |
| board-service | 60/61 |
| task-store | 61/61 |
| bot-tasks | 17/17 |
| privacy（含看板守卫） | 26/26 |
| goal-review due/guard | 3/3 |
| rounds + group-work | 183/184 |
| group-goal | 25/30（上游 idle 驱动已并入本地 goalDrive） |
| group-queue-view | 8/8 |
| original-redo-journal | 34/34 |
| recovery-held / room-patrol-activity / version-info | 全部通过 |
| client-bundle / link-bundle | 3/3、1/1 |

## 已完成的本地增量接回

- `privacy.js`：看板路径守卫（仅 Bot 调用），依赖 shell 分词/here-doc 剥离等本地助手。
- `delivery.js`：`prepareBoardTaskMessage` 与 `beforeAdmission/afterAdmission` 观测（无观测时行为与上游一致）。
- `goals.js`：本地 review 子系统（`reviewIsDue`、`goalReviewGuard`、复核清扫器/巡检/verdict、`taskNoteUnchanged`）。
- `store.js`：home lock、pending 输入、recovery 游标等本地字段与助手（上游 `taskOwners` 保留）。
- `resume.js`：`boundedRecoveryView`。
- `groups.js`：`roomBusyForPatrol`。
- `channel.js`：`groupQueueView / earlierPrivateQueueView / roomPostQueueView`、`recoveryNoted`、`QUEUE_PREVIEW_MAX`。
- `package.json`：`dsBot` 构建身份元数据（version-info 依赖）。
- `client.js / office.js / link.js`：按合并后源码重建。

## 待决策的业务冲突

### 冲突 1：群通知长度上限

- 上游 0.3.9：`ROOM_NOTICE_MAX = 2000`
- 本地 AIOS：业务要求 4000（`test/json-reply.test.js` 断言 4000）
- 现状：按“上游为准”保留 2000，该用例失败。
- 建议：若业务确需 4000，作为本地常量覆盖（向后兼容，无上游语义冲突），需明确批准。

### 冲突 2：目标空闲/唤醒模型

- 上游 0.3.9：`goalDrive` 在每轮结束后按 `GOAL_IDLE_NUDGES = 2` 唤醒管理员做 goal check；两次无进展进入 idle（#1330 系列测试）。
- 本地 AIOS：以定时复核（scheduled review / 清扫器 / admin-pass / nudge-limit）驱动，`goalDrive` 主要处理复核结果，不做逐轮唤醒。
- 现状：已采用**上游驱动为基础**（goal 逐轮 check、GOAL_IDLE_NUDGES、goalSettled/SETTLE_ROUND 已并入本地 goalDrive），本地复核作为其上的调度层；`group-goal` 由 19/30 提升到 25/30，剩余 5 项为本地复核/阶段门禁差异。

## 环境/版本类失败（非产品缺陷）

- 客户端动效/侧栏/翻译插值等约 10 项：随 DSH 客户端版本变化；
- 测试夹具 `session.seq`/`some` 未定义：上游测试夹具形状，真实 DSH 不会出现；
- MCP 传输、Git 配置、构建产物校验等零散项。

## 上线门槛建议

1. 冲突 1、2 决策并完成适配；
2. 关键本地套件保持全绿、全量失败全部归类；
3. 以 `.11` 为回滚位构建 `0.3.9+AIOS` 制品；
4. 空闲窗口灰度切换，观察后收尾。