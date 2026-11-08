# 公共实验启动器

仓库根目录的macOS.command、Windows.bat及 `npm run launcher` 均运行experiment-launcher.mjs。启动器负责选择实验和管理服务，不含题目、消息模式或实验状态机。

## 现场设备配置

Windows SH/SL 的启动与重启调用 scripts/glasses-control.mjs，先打开后端和 Web，再整备 USB/无线；首次没有设备配置也不默认为 Mock。状态命令显示实际模式，只有显式选择9/mock才进入模拟。其他实验使用通用启动；静态真机环境未配置设备时仍先打开 Web 整备。

在另一台Windows主机上准备：

- 完整platform-tools放到 `.a5-local/android/platform-tools/`，优先使用其中adb.exe。
- 完整scrcpy放到 `.a5-local/scrcpy/`，可执行文件、DLL和server文件保持齐全。
- device.json 可选；显示端统一包名 `link.ironip.glasses.display`。单副已授权设备可自动保存 serial，多设备在 Web 中选择。
- 已有工具可填写 adbPath、scrcpyPath；可用 apkPath 指定本地 APK，校验值始终取发布固定值。没有本地 APK 时自动下载 Release，不需要 Android 编译程序。

工具和设备凭据不提交Git。修改路径或绑定后重启服务加载；换设备须先结束原会话。应用内守护、通知和硬件验收见 [RAYNEO.md](../f5-sh-pilot/RAYNEO.md)。SL与SH共用同一副眼镜和同一份设备配置：启动器对f5-sh-*、f5-sl-*都走设备启动链路，并向glasses-control.mjs传 `--experiment`；SL默认端口5174，不读取device.json里的port（该项只对SH生效）。同一副眼镜同一时间只能绑定一个活跃会话，SH与SL不能同时做真机会话。

## 新实验接入

启动器按名称发现根目录f5-sh-*、f5-sl-*、f5-mh-*、f5-ml-*。未配置启动方式的目录也会列出并提示缺失项。在实验package.json声明：

```json
{
  "a5": {
    "launcher": {
      "entry": "src/server.ts",
      "port": 5173,
      "health_path": "/api/health",
      "admin_path": "/admin"
    }
  }
}
```

entry相对实验目录，以当前Node版本运行。实验提供自己的start/check/doctor命令；install在仓库根目录执行npm ci。

服务约定：

- 从PORT读取端口。SH、SL默认监听0.0.0.0供局域网使用，健康检查和控制通道使用127.0.0.1；start可指定其他端口。
- 健康接口包含ok:true和对应experiment_id，通过后才报告运行中。
- A5_RUNTIME_DIR与A5_EXPORT_DIR分别指向该实验数据和导出，不与其他实验共用。
- SH直接打开/admin；其他实验如声明admin_key_file，凭据文件路径必须在实验目录内。
- 收到IPC消息 `{ "type":"a5:shutdown" }` 后停止接收、保存和关闭数据，再断开IPC；管理进程意外断开也应正常关闭。

## 生命周期与检查

每个实验由独立后台管理进程承载，退出菜单不停止服务。状态、随机控制凭据和日志位于 `.launcher/<实验>/`，不提交Git；重新打开启动器可继续管理。不会只根据持久化PID终止进程，也不会结束占用端口的无关服务。

停止使用IPC正常关闭，不以taskkill强制结束数据库。最多等待45秒，以容纳展示结束和权限恢复；超时保留诊断，不假报成功。并发启动由锁保护，异常锁30秒后可恢复。

`npm run test:launcher` 使用临时目录和独立端口，覆盖目录发现、后台/重复启动、跨菜单状态、端口冲突、遗留锁、USB启动配置、实际SH服务IPC和SQLite完整性。测试数量以命令输出为准，不写正式被试数据。Windows入口还需核对CRLF、UTF-8控制台、中文和空格路径；macOS入口可执行 `bash -n a5-experiments.command`。

APK 不需要现场编译；版本与 SHA 固定在 scripts/display-release.mjs。支持 artifacts/ 手动打包，缺少才用 gh 或带环境 token 的 HTTPS 下载私有 Release。
