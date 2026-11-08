# A5 共享显示端与眼镜整备迁移

## 基线与版本

Clawd 的 `95f7501`（共享 Clock）与 `4a627ef`（乐观锁/追加历史）已保留在 main；没有打开的对应 PR，main 原已包含两提交，本次将 origin/main 快进到 4a627ef。没有改写其他助手的工作树。

共享仓库 `vendor/glasses-display` 是 git submodule，固定 **v2.2.0 / 4037b73b089202e7d70cde5a8bb4715a2f9a6dd3**。
最初 v2.1.0 已完成并发布，之后扩大 APK 为通用能力层，所以以新增 v2.2.0 交付；不覆盖旧标签。
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

启动脚本保留安装逻辑，包名 `link.ironip.glasses.display`、版本 `2.2.0`，默认 APK `.a5-local/artifacts/glasses-display-2.2.0-debug.apk`。版本不一致时先核对 SHA-256，再 `install -r`，安装后读回版本；不卸载、不清账本。硬件未就绪不关后台，在 Web 继续整备。无线开启后可拔 USB；设备重启后可能需再插 USB 开启 adbd TCP。

本次构建产物：`/workspace/artifacts/glasses-display/v2.2.0/glasses-display-2.2.0-debug.apk`

SHA-256：`ee4f46b806581c1be471eaa81d1a37447d6dace961a883c4d8f0673f14a6895d`

## 不变量

- 默认 device_id 仍为 `adb:<serial>`，不改旧会话。可选硬件模式跨 USB/Wi-Fi 保持硬件身份。默认 adb 模式换路由会变 device_id，所以进行中会话禁止换路由；先整备再创建会话。固定硬件身份不符时拒绝绑定。
- 其他 identity 的设备事件跳过，但共享游标仍前移。相同 ledger 续收，进程重启可重新读历史并由 Store 去重，不补发刺激。
- 断线未收到应答保留 `unacknowledged`；进程重启在途状态是 `unknown`，不合并。
- 展示期间拒绝整备/配置/无线/doctor/前台重建；操作互斥也阻止实验启动，等待已开始的 poll/发送结束后再动设备。
- shutdown 等待回收最多 15 秒；空闲后恢复语音悬浮窗权限、关闭当前客户端、force-stop 新包。仍展示时不强杀，保留权限备份与待恢复审计。

## 验证与现场待验

完整测试命令：`npm test`（SH 129/129、SL 22/22、启动器 9/9，共 160/160）、`npm run typecheck`（全工作区通过）。新增覆盖 USB→无线、offline 修复与退避、磁盘重启路由召回、硬件身份路由切换事件恢复、跳过其他身份但推进游标、展示互斥、空闲退出 force-stop、能力与 tone 映射、应用守护停止、自检时钟样本、HTTP 整备入口。

没有实体眼镜/Windows 桌面验收。待验证：USB/adbd 切无线真实网络、断网/设备重启恢复、权限提示与语音助手读回、scrcpy 实际画面、左右眼渲染与隐藏时序、音调实际可听及电声延迟、Windows 首次/升级/无 ADB 启动流程。APK 新增传感器/相机/录音/TTS/振动等能力也仅完成编译/策略测试，运行时按实际硬件/权限报告。
