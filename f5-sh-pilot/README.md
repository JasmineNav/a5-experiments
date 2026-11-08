# f5-sh-pilot

SH（静态高负荷）Pilot实验，属于 [a5-experiments](../README.md)。当前为V2：7组14个任务单元（SH01—SH07）、T0/T1/T2眼镜消息、U2内被试自主休息、理解题、评价、会话恢复和数据导出。V2规则见 [DECISIONS.md](DECISIONS.md) 及 [V2变更文档](docs/V2变更决策与PRD-2026-10-26.md)。电脑端为浏览器工作台，眼镜端为雷鸟X3 Pro Android应用。

Windows＋Chrome及USB真机应用流程已验证；外部光学计时和实际可听性仍需现场验收，不能把应用绘制事件视为被试已注意到消息。验收边界见 [TESTING.md](TESTING.md)。

## 启动与现场操作

需要Node.js 24+。仓库根目录执行 `npm ci`，双击 `a5-experiments.bat`（Windows）或 `a5-experiments.command`（macOS），选择本实验后启动并打开后台；也可执行：

```sh
npm run start --workspace=f5-sh-pilot
```

1. 打开 `http://127.0.0.1:5173/admin`，在“准备与检查”核对设备与材料。
2. 在新建会话区选择配置文件和被试编号，再创建会话、打开被试链接。000用于调试（默认覆盖全部7种条件），正式名单默认P01—P28；配置方法见 [CONFIG.md](CONFIG.md)。
3. 被试完成操作教程（工作台说明和两个练习单元，消息练习由主试在后台手动发送）后进入正式流程。主试可暂停、恢复、跳题、停止及记录备注；被试在U2且本组未休息时可点“提醒休息”（口头提醒请写入备注）；操作留痕，原因可空，删除需二次确认且可恢复。
4. 结束后导出当前会话或全部未删除会话。教程、正式数据和手动通知分别标记。

同一编号只能有一个未结束会话；同一副真机眼镜只能绑定一个活跃会话。启动器退出不停止服务，需使用stop。端口冲突可输入 `start 5174`。

## 眼镜与局域网

Windows项目已配置 `.a5-local/device.json` 时，启动器自动使用项目内ADB和USB真机；连接失败不回退Mock。未配置时默认Mock，仅供软件预演。设备接入及换机见 [RAYNEO.md](RAYNEO.md)，工具路径见 [公共启动器说明](../scripts/README.md)。

服务默认监听 `0.0.0.0`。标题栏“主试二维码”默认折叠，手机连接电脑热点或同一局域网后展开扫码；被试链接仍由主试手动打开。多网卡时选择可达地址。后台直接进入，被试接口使用各会话token；生成恢复入口会使旧链接失效，不改变进度。设置 `HOST=127.0.0.1` 可限定本机访问。

## 数据与内容维护

- 数据默认位于 `runtime/experiment.sqlite`，导出位于 `exports/`；这些目录不提交Git。备份前停止服务，复制完整runtime及所需导出。
- 测试使用独立 `A5_RUNTIME_DIR`、`A5_EXPORT_DIR` 和端口，不能复用正式数据目录。
- 内容由 `content/tasks.json`、`stimuli.json` 提供；SH06/SH07（`v2_stages`/`v2_stimuli`）和休息参数（`rest_settings`）也在 `revisions.json`。编辑 `revisions.json` 后，在本实验目录执行 `python scripts/build_task_content.py` 重建 `tasks.json` 和 `stimuli.json`，并更新内容版本。`scripts/extract_materials.py` 只从 `docs/` 的原始 Word/Excel 提取到 `content/source/` 和 `config/participants.source.json`，不生成也不覆盖 `tasks.json`、`stimuli.json`。保持字段ID与评分约束一致。
- 内容修改需重启并新建会话；配置切换只影响新会话。已有会话使用创建时快照，版本以快照和导出清单为准。

## 文档导航

| 文档 | 读者与用途 |
| --- | --- |
| [CONFIG.md](CONFIG.md) | 主试：选择、修改、导入预分配及000配置 |
| [DECISIONS.md](DECISIONS.md) | 实验负责人：当前有效的实验规则与材料依据 |
| [API.md](API.md) | 接口维护：鉴权、请求、view和导出结构 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 开发维护：状态机、事务、消息和时钟 |
| [FRONTEND.md](FRONTEND.md) | 界面维护：布局、操作与实际可见证据 |
| [RAYNEO.md](RAYNEO.md) | 现场与设备维护：接入、协议、守护及故障检查 |
| [TESTING.md](TESTING.md) | 验证：检查方法、覆盖范围与待验收项目 |

[docs/](docs/)保留原始需求及材料，不是当前操作手册；与当前规则冲突时以DECISIONS为准。

## 11-08 材料可行性 pilot（独立入口）

`npm run start:pilot --workspace=f5-sh-pilot`，默认本机5173。不会替换本README原流程，不发眼镜消息；启动、配置、日志和待确认项见 [PILOT-1108.md](PILOT-1108.md)。
