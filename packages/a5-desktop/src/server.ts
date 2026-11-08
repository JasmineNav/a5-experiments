import { mkdir } from 'node:fs/promises';
import { lanAddresses } from '../../../scripts/network.mjs';
import { join, resolve } from 'node:path';
import { Store } from './store.ts';
import { Engine } from './engine.ts';
import { createApp } from './app.ts';
import { loadMaterial } from './tasks.ts';
import {SharedGlassesAdapter} from '@a5/glasses/adapters/shared-glasses.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';
import { DeviceControl } from './device-control.ts';
import { preflight } from './preflight.ts';
import { experimentRoot, readJson } from './profile.ts';
import type { GlassesAdapter, ParticipantConfig } from './contracts.ts';

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT必须是1至65535之间的整数。');
const checked = await preflight();
if (!checked.startup_ok) throw new Error(`启动检查失败：${[...checked.pilot_errors, ...checked.material_errors].join('；')}`);
const runtime = resolve(process.env.A5_RUNTIME_DIR ?? join(experimentRoot, 'runtime'));
await mkdir(runtime, { recursive: true });
const store = new Store(join(runtime, 'experiment.sqlite'));
const mode = process.env.A5_GLASSES_MODE ?? 'mock';
if (!['mock','device','rayneo'].includes(mode))throw new Error('A5_GLASSES_MODE 只能是 mock 或 device（兼容旧值）。');
const remembered=store.setting<{serial:string;identity:'adb'|'hardware'}>('device_route');
const serial=remembered?.serial??process.env.A5_GLASSES_SERIAL??process.env.A5_RAYNEO_SERIAL??'';
const identity=remembered?.identity??(process.env.A5_DEVICE_IDENTITY==='hardware'?'hardware':'adb');
const adapter:GlassesAdapter=mode==='mock'?new MockGlassesAdapter():new SharedGlassesAdapter(serial,{adb:process.env.A5_ADB_PATH,identity});
const engine = new Engine(store, adapter, await loadMaterial(), await readJson<ParticipantConfig>('config/participants.pilot.json'));
const deviceControl = new DeviceControl(engine, { serial,identity, adb: process.env.A5_ADB_PATH,
  packageName:process.env.A5_GLASSES_PACKAGE, enabled: process.env.A5_RAYNEO_HOST_MODE !== 'off', scrcpy: process.env.A5_SCRCPY_PATH });
const server = createApp(engine, resolve(process.env.A5_EXPORT_DIR ?? join(experimentRoot, 'exports')), deviceControl, join(experimentRoot, 'config/notifications'));
engine.pollDevice();
/** 每秒回收设备事件、执行已隔离异常的控制任务并推进实验。 */
const ticker = setInterval(() => { engine.pollDevice(); deviceControl.tick(); for (const id of store.ids()) engine.tick(id); }, 1000); ticker.unref();
server.on('error', error => { console.error('服务启动失败：', error.message); clearInterval(ticker); void deviceControl.close().then(() => adapter.close?.()).then(() => engine.settle()).finally(() => store.close()); process.exitCode = 1; });
server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`实验员后台：http://127.0.0.1:${port}/admin`);
  if ((process.env.HOST ?? '0.0.0.0') === '0.0.0.0') for (const item of lanAddresses(port)) console.log(`其他设备（${item.name}）：${item.base_url}/admin`);
  console.log(`数据库：${join(runtime, 'experiment.sqlite')}`);
  console.log(mode === 'mock' ? '当前为 Mock 预演模式，不能用于真实消息呈现实验。' : `当前为共享显示端真机模式，设备：${adapter.getStatus().device_id ?? '尚未配置序列号'}；硬件呈现仍需现场验收。`);
});
let stopping = false;
/** 先停止定时任务并等待设备控制退出，再正常关闭连接与数据库。 */
const shutdown = () => {
  if (stopping) return; stopping = true; clearInterval(ticker);
  const closing = deviceControl.close().then(() => adapter.close?.());
  server.closeIdleConnections();
  server.close(() => { void closing.then(() => engine.settle()).finally(() => { store.close(); if (process.connected) process.disconnect?.(); }); });
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'a5:shutdown') shutdown();
});
// 管理进程意外退出时正常落盘并关闭，避免遗留无主服务。
if (process.connected) process.on('disconnect', shutdown);
