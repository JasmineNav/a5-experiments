# AGENTS.md

本文件是本仓库唯一的 AI 编码助手指引（Codex 直接读取，Claude Code 经 CLAUDE.md 的 `@AGENTS.md` 导入）。只在这里修改，不要在 CLAUDE.md 另写一份。

## 语言

在输出为用户展示的内容时，始终使用简体中文。仓库文档、注释和错误信息也以中文为主，修改时保持一致。

## 仓库结构

npm 工作区单仓，每套实验是根目录下的 `f5-<sh|sl|mh|ml>-<版本>` 目录（当前有 `f5-sh-pilot`、`f5-sl-pilot`），内容、预分配、配置、测试和数据在各自目录内；共用代码在 `packages/`：`@a5/glasses`（眼镜契约、Mock/雷鸟适配器、Android 显示端 `rayneo-display/`，所有分项发消息都走它）和 `@a5/desktop`（静态桌面模拟：状态机、存储、导出、被试端与后台页，SH、SL 共用）。以后的动态行走分项只依赖 `@a5/glasses`。根目录只放共用启动器 `scripts/`、`tsconfig.base.json` 和工作区配置。`reffers/` 是外部参考项目，不属于工作区。

## 常用命令

需要 Node.js 24+（直接运行 `.ts`，无构建步骤；`tsconfig` 为 `noEmit` + `erasableSyntaxOnly`，只能用可擦除的 TS 语法，导入需带 `.ts` 扩展名）。

```sh
npm ci                                              # 仓库根目录安装
npm run check                                       # 全部工作区 typecheck + test + doctor，外加启动器测试
npm run start --workspace=f5-sh-pilot               # 启动服务，后台 http://127.0.0.1:5173/admin
npm run start --workspace=f5-sl-pilot               # SL，后台 http://127.0.0.1:5174/admin
npm run dev --workspace=f5-sh-pilot                 # node --watch
npm run test:launcher                               # 仅启动器测试
npm run launcher                                    # 交互式启动器（同 .command/.bat）
```

在 `f5-sh-pilot/`（`f5-sl-pilot/` 同理，生成脚本只有各自的 `build_task_content.py`，SL 没有 `extract_materials.py`）内：

```sh
npm run typecheck
npm test                                            # node --test tests/*.test.ts
node --test tests/core.test.ts                      # 单个文件
node --test --test-name-pattern="关键字" tests/core.test.ts   # 单个用例
npm run doctor                                      # 材料与启动自检
python scripts/build_task_content.py                # 编辑 content/revisions.json 后重建 tasks.json/stimuli.json
python scripts/extract_materials.py                 # 仅从 docs/ 重新提取原始材料（content/source、participants.source.json），不动 tasks/stimuli
```

手动启动测试服务必须隔离数据：`PORT=5199 A5_RUNTIME_DIR=... A5_EXPORT_DIR=...`，不要复用 `runtime/` 中的正式被试数据库。`qa/browser/` 的 Playwright 脚本不在 check 内，部分已过时（无教程流程、旧选择器），不能视为当前验收通过的依据。

Android 显示端（`packages/a5-glasses/rayneo-display/`，JDK 21）：

```sh
./gradlew :app:assembleDebug :app:lintDebug --console=plain
node scripts/verify-apk-runtime.mjs app/build/outputs/apk/debug/app-debug.apk
```

## 架构要点（@a5/desktop，以 f5-sh-pilot 为例）

以下 `src/`、`public/` 路径均指 `packages/a5-desktop/`，适配器指 `packages/a5-glasses/src/adapters/`。分项目录里只有入口 `src/server.ts`/`doctor.ts`（设置 `A5_EXPERIMENT_ROOT` 后加载公共包）、`config/experiment.json`（experiment_id、任务组前缀、是否有附件、F 标记单元）、`content/`、`config/`、文档与测试；公共包不得写死某个分项的编号或规则，分项差异只能通过 `experiment.json` 或 `content/tasks.json` 的字段声明（如 SL 的 `t0_trigger`、`items` 评分、`tutorial_notice_after_practice`），且新字段缺省时必须保持 SH 原有行为。

电脑端是 Node 服务 + 原生 ES module 浏览器页面（`public/experiment.*` 被试端、`public/admin.*` 主试后台，样式隔离）；眼镜端是雷鸟 X3 Pro Android 应用，经 USB/ADB 与服务通信。

- `src/server.ts` 组装 Store → Engine → App，并每秒 tick：回收设备事件、执行设备控制任务、推进各会话。`A5_GLASSES_MODE=mock|rayneo` 选择适配器（`src/adapters/`），默认 mock；真机模式由启动器在检测到 `.a5-local/device.json` 时设置，失败不回退 mock。
- `src/engine.ts` 是服务端权威状态机（教程（含 TUTORIAL_REST）→ INTRO → CARD → UNIT → COMPREHENSION → RATINGS → 下一组 CARD … → 终态；V2 取消组间休息，改为 U2 内被试自主休息与 T2，旧快照仍有 BREAK；暂停只在 view 上呈现 PAUSED）。每页有 `page_token` 防旧页提交，`command_id` + 请求指纹去重。评分与答案只在服务端，公开 view 不含答案。
- `src/store.ts` 使用 Node 内置 SQLite（WAL、synchronous=FULL）。事件表与设备原始事件只追加，禁止更新/删除；会话删除只是 `state.deleted` 软标记。
- 会话创建时固定题目、刺激和配置快照；修改 `content/` 或 `config/` 不影响已有会话。配置文件在 `config/notifications/*.json`，`display_mode` 逐通知配置（`legacy_8500` / `tone_8500` / `confirm_until_ack`）。
- 消息流程：先在事务中保存 `request_id` 与发送意图，再异步调用适配器；回执和设备事件按 `request_id` 合并。重启时未完成发送标为 unknown，绝不重放。`interventions.data_kind` 区分 formal / tutorial / manual。
- 眼镜 APK 必须保持最新：服务端用 `Engine.requireFixedDuration()` 核对显示端声明的 `fixed_duration_ms`，不支持当前固定时长就拒绝建会话和发通知，后台提示更新 APK。改动通知时长只需改 `content/tasks.json` 的 `message_duration_ms`（1000—60000 整数）；服务端按它配置适配器发送前允许值（也可用 `A5_DISPLAY_DURATIONS_MS` 覆盖），`admin.js` 的 `FIXED_DURATION_MS` 只影响后台设备提示，需要时一并改。共享显示端按 `capabilities.text_duration_ms` 声明范围，无需改 APK。显示端版本/提交/APK SHA 只在根目录 `display-release.json` 固定。
- 时间：`elapsed_ms` 用服务器单调时钟；浏览器可见证据、服务器接收时间、设备原始时间分开存储，不直接相减。

## 必须遵守的约束

- 实验规则以各分项的 `DECISIONS.md` 为准（SL 只写与 SH 不同的规则，其余沿用 SH）；`docs/` 下是原始需求，与 DECISIONS 冲突时以 DECISIONS 为准。不得为让测试或脚本通过而改动正式预分配（P01—P28）或绕过确认规则。
- 不伪造证据：Mock 不生成真机证据，未知时间留空，drawn 不等于光学出光，cue_started 不等于听到，`pilot_ready`/`real_presentation_verified` 不自动置真。
- `f5-sh-pilot/docs/PRD.md` 必须保持 LF 换行（启动时做 SHA-256 完整性校验）；`.bat` 使用 CRLF，其余 LF。
- 新实验接入启动器需在其 `package.json` 声明 `a5.launcher`（entry/port/health_path/admin_path），健康接口返回 `ok:true` 与 `experiment_id`，并支持 IPC `{ "type": "a5:shutdown" }` 正常关闭；详见 `scripts/README.md`。

## 文档索引

`f5-sh-pilot/` 下：ARCHITECTURE（状态机/事务/消息/时钟，含源码位置对照表）、DECISIONS（实验规则）、CONFIG（配置 JSON 格式）、API（鉴权、view、导出结构）、FRONTEND、RAYNEO（设备协议与守护）、TESTING（验证范围与待现场验收项）；`f5-sl-pilot/` 下：README、DECISIONS（与 SH 不同的规则）；`packages/a5-glasses/rayneo-display/BUILDING.md`。这些文档里写的 `src/`、`public/`、`rayneo-display/` 路径按上面的对照表理解。
