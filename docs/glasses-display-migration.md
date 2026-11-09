# A5 共享显示端与眼镜整备迁移

## 基线与版本

Clawd 的 `95f7501`（共享 Clock）与 `4a627ef`（乐观锁/追加历史）已保留在 main；没有打开的对应 PR，main 原已包含两提交，本次将 origin/main 快进到 4a627ef。没有改写其他助手的工作树。

共享仓库 `vendor/glasses-display` 是 git submodule，固定 **v2.2.4 / 2fdafe4d32c873c639bb6d650db85bae781264ac**（APK SHA-256 `d80aaf98431a143ba117aaa814e5f44fd0b0fb5d9a0b36a2bbbf285282f50118`）。版本、tag、提交与 SHA 的唯一固定来源是仓库根目录 `display-release.json`，启动器与服务端都读它。
最初 v2.1.0 已完成并发布，之后扩大 APK 为通用能力层，所以以新增 v2.2.1 交付；不覆盖旧标签。
安装依赖前执行：

```sh
git submodule update --init --recursive
npm ci
```

根包依赖 `file:vendor/glasses-display/host`。新的真机适配器在 `packages/a5-glasses/src/adapters/shared-glasses.ts`；旧导入路径只是兼容 re-export，不再有私有 socket 客户端。
旧 Android 源目录暂保留历史来源，**当前构建、安装、协议、后续能力开发均以 submodule 的 android/ 为准**，不要继续修改旧目录。

## 分层

- 共享层：DisplayClient（状态/类型能力、固定身份、路由更换后重读身份、账本/游标续收、clockSample、wifi_lock/link_hint）、无线连接/退避/RouteMemory/doctor；高频传感器等是独立 device_events 流，不进入 A5 实验账本。
- A5 适配器：稳定对象，route 可更换，Engine 和 server 退出闭包始终引用同一实例；不重放显示请求。A5 的 `legacy_8500` → 通用 timed；`tone_8500` → timed + notification 983ms 原始音频；确认模式保持确认语义。A5 条件命名留在 A5。
- A5 DeviceControl：选择设备、配置、USB 开无线/手动 IP、双层守护、持久路由、设备互斥、权限备份搬迁、scrcpy、手动试发、doctor、退出回收。传输退避 1–30 秒，应用失败等待 10 秒/20 秒，第三次或系统遮挡进入 host_stall；手动打开重置。Clock 保留墙钟/单调钟分离。
- A5 Engine：时长/模式/通知音按 capabilities 检查，不再用旧 `fixed_duration_ms` 阻挡 v2 的 11000ms。旧显式字段仅用于历史测试/旧适配器兼容；真实 v2 客户端必须有能力声明，音调缺失不静默降级。
- WebUI：只调用 A5 HTTP 后端；不建立设备连接、不拼眼镜协议字段。选设备 → 连通道 → 打开显示端 → 试发验证；路由、身份、Wi-Fi 锁、退避倒计时、停止原因、自检结果与三次时钟样本均由后端返回。**没有跨设备时钟校准**。

## 启动与整备

真机：`A5_GLASSES_MODE=device`（兼容旧模式值）；默认身份 adb，设置 `A5_DEVICE_IDENTITY=hardware` 可选硬件身份。新的配置项 `A5_GLASSES_SERIAL`、`A5_GLASSES_PACKAGE`；旧 SERIAL 环境变量仅作兼容。已保存的后端路由优先，避免重启后旧 USB 配置盖掉已记住的无线地址。

Windows 公共菜单首次无本机配置也走真机 Web 整备入口；先开后端/管理页，不要求眼镜已连接或 ADB 已可用。Mock 必须显式选择，运行中不静默切换模式。

启动脚本保留安装逻辑，包名 `link.ironip.glasses.display`、版本取自 `display-release.json`，默认 APK `.a5-local/artifacts/glasses-display-<版本>-debug.apk`。眼镜上版本较低时先核对 SHA-256，再 `install -r`，安装后读回版本并预授相机/麦克风权限；眼镜上已是更高版本（例如别的实验先升级）时不降级、不卸载，只提示，实际 app_version 写入会话版本坐标。硬件未就绪不关后台，在 Web 继续整备。无线开启后可拔 USB；设备重启后可能需再插 USB 开启 adbd TCP。

本次固定产物：Release `v2.2.4` 的 `glasses-display-2.2.4-debug.apk`

SHA-256：`d80aaf98431a143ba117aaa814e5f44fd0b0fb5d9a0b36a2bbbf285282f50118`

## 不变量

- 默认 device_id 仍为 `adb:<serial>`，不改旧会话。可选硬件模式跨 USB/Wi-Fi 保持硬件身份。默认 adb 模式换路由会变 device_id，所以进行中会话禁止换路由；先整备再创建会话。固定硬件身份不符时拒绝绑定。
- 其他 identity 的设备事件跳过，但共享游标仍前移。相同 ledger 续收，进程重启可重新读历史并由 Store 去重，不补发刺激。
- 投递状态：`accepted` / `failed`（显示端拒绝或本地校验拒绝）/ `not_sent`（确定没有写入线路：无连接、取消、过截止时间）/ `unacknowledged`（已写入或可能已写入但无回执，含 5 秒发送超时）/ `unknown`（只用于进程重启时的在途记录）。都不自动重发；`failed`、`not_sent` 不占用显示、不阻塞下一条。
- 展示期间拒绝整备/配置/无线/doctor/前台重建；操作互斥也阻止实验启动，等待已开始的 poll/发送结束后再动设备。
- shutdown 等待回收最多 15 秒；空闲后恢复语音悬浮窗权限、关闭当前客户端、force-stop 新包。仍展示时不强杀，保留权限备份与待恢复审计。

## 验证与现场待验

完整测试命令：`npm test`（SH 129/129、SL 22/22、启动器 9/9，共 160/160）、`npm run typecheck`（全工作区通过）。新增覆盖 USB→无线、offline 修复与退避、磁盘重启路由召回、硬件身份路由切换事件恢复、跳过其他身份但推进游标、展示互斥、空闲退出 force-stop、能力与 tone 映射、应用守护停止、自检时钟样本、HTTP 整备入口。

没有实体眼镜/Windows 桌面验收。待验证：USB/adbd 切无线真实网络、断网/设备重启恢复、权限提示与语音助手读回、scrcpy 实际画面、左右眼渲染与隐藏时序、音调实际可听及电声延迟、Windows 首次/升级/无 ADB 启动流程。APK 新增传感器/相机/录音/TTS/振动等能力也仅完成编译/策略测试，运行时按实际硬件/权限报告。

最终固定 2.2.1：2.2.0 通用能力增量后的正确性修补（keep-awake/兼容锁、亮度恢复、相机初始化清理）；旧标签全部保留。

## 运行端只下载 APK

运行端不需要 Android/JDK/Gradle。`scripts/glasses-control.mjs` 经 `scripts/display-release.mjs` 读取 `display-release.json`：先查 `.a5-local/device.json` 的 `apkPath`（绝对路径或相对仓库根目录；配置了但文件不存在会直接报错），再查仓库 `artifacts/glasses-display-<版本>-debug.apk`，再用 `.a5-local/artifacts/` 缓存；均无文件才下载 Release。已有文件校验错误直接停止，不用下载替换来绕过。

下载优先使用已登录的 `gh release download`，否则用匿名 HTTPS 的 GitHub Release API（基座仓库公开，无需登录或 token）。下载后及安装前都按已固定 SHA 校验，不从远端 SHA256SUMS 动态信任新值。子模块用普通 `git submodule update --init --recursive` 即可。

离线/打包运行可手动把 APK 放进仓库 `artifacts/`，并随程序包带上已初始化的 `vendor/glasses-display/host`。这样运行机器既不用下载，也不用编译。把 APK 直接提交进公开 A5 确实更简单，但会让该二进制公开，并增加每次版本升级的仓库体积；本次没有擅自这样做。

## 升级到 v2.2.4（A5 与 A1 固定同一版本）

- 固定值集中到根目录 `display-release.json`（tag、版本、基座提交、APK SHA-256）；`scripts/display-release.mjs`、`packages/a5-glasses/src/display-release.ts`、后台期望版本与 doctor 都从这里读，测试核对它与已检出 submodule 的提交及 host 版本一致。A1 固定同一 v2.2.4 后，同一副眼镜轮流做两个实验不会再出现降级安装失败。
- 投递状态接入 2.2.4：无连接/取消/过截止时间 → `not_sent`；本地校验（设备绑定、时长、能力）→ `failed`；5 秒发送上限到点先中止尚未写入的调用，再留 250ms 收尾，仍无结果按 `unacknowledged`（错误 `adapter_send_timeout_unacknowledged`），不再记为 `unknown`。`unknown` 只留给服务重启。全程不补发。
- 整备改用基座的 `grantRuntimePermissions`（每个路由预授一次相机/麦克风，启动器安装后也执行）与 `collapseSystemPanel`（替换 A5 内写死的系统面板包名与 CLOSE_SYSTEM_DIALOGS 判断）。打开共享显示端前先 `force-stop` 迁移前的旧 A5 显示端（`packages/a5-glasses/src/legacy-display.ts` 的兼容包名）。
- 每次会话在快照 `run_versions` 与 `session_created` 事件固定：实验提交（及是否有未提交改动）、基座 tag/固定提交/实际检出提交、固定 APK SHA-256、设备上实际安装 APK 的 SHA-256（打开显示端时用 `pm path` + `sha256sum` 测得，不符时写审计 `display_apk_not_pinned`）与 app_version。导出 sessions 表新增对应列。没有 git 可执行文件时直接读 `.git`。
- 启动器：Windows 之外 macOS（及 Linux）也走真机链路；ADB 按平台查找（macOS 含 `~/Library/Android/sdk`、Homebrew），浏览器按平台打开。`a5-experiments.command` 也会优先用仓库内 `.a5-local/android/platform-tools/adb`。
- 显示时长：适配器发送前允许值不再写死，由服务端按 `content/tasks.json` 的 `message_duration_ms`（加 8500 兼容值）传入，也可用 `A5_DISPLAY_DURATIONS_MS=逗号分隔毫秒` 覆盖；默认仍是 8500/11000。启动检查改为接受 1000—60000 的整数。
- 保护窗口修正：确认模式测试通知只有已绘制且未消失时才持续保护，未收到回执的记录只在时长窗口内保护（以前会永久挡住「重连/打开」，反而收不回证据）；`failed`/`not_sent` 不再占用保护窗口；实验消息窗口按消息时长取 max(11000, duration)。后台设备提示改按 `capabilities.text_duration_ms` 判断，不再因 2.x 没有旧 `fixed_duration_ms` 字段而误报「APK 需更新」。

未在真机验证：权限预授在眼镜固件上的实际结果、旧显示端停止后的前台切换、已装 APK SHA 测量命令在眼镜上的可用性、macOS 启动器的完整真机流程、断线时 not_sent 与在途 unacknowledged 的真实网络表现。
