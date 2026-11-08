import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PilotStore } from './store.ts';
import { createPilotApp } from './app.ts';
import { configuration } from './model.ts';
import type { Config } from './model.ts';

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT必须是1—65535的整数。');
const flag = (name: string) => {
  const value = process.env[name];
  if (value === undefined) return false;
  if (!['true', 'false'].includes(value)) throw new Error(`${name}只能为true或false。`);
  return value === 'true';
};
const defaults: Partial<Config> = {
  feedback: (process.env.A5_PILOT_FEEDBACK ?? 'progress') as Config['feedback'],
  source: (process.env.A5_PILOT_SOURCE ?? 'participant') as Config['source'],
  practiceScales: flag('A5_PILOT_PRACTICE_SCALES'), practiceFeedback: flag('A5_PILOT_PRACTICE_FEEDBACK'),
};
if (process.env.A5_PILOT_ORDER) defaults.order = process.env.A5_PILOT_ORDER as Config['order'];
configuration('P01', defaults); // 错误配置在启动阶段即失败，不静默回退。
const runtime = resolve(process.env.A5_PILOT_RUNTIME_DIR ?? join(import.meta.dirname, '../../runtime/pilot-1108'));
await mkdir(runtime, { recursive: true });
const store = new PilotStore(join(runtime, 'pilot.sqlite'));
const server = createPilotApp(store, defaults);
const ticker = setInterval(() => store.tick(), 250); ticker.unref();
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true; clearInterval(ticker);
  server.closeIdleConnections(); server.close(() => { store.close(); if (process.connected) process.disconnect?.(); });
}
server.on('error', error => { console.error('pilot启动失败：', error.message); clearInterval(ticker); store.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`11-08材料pilot：http://127.0.0.1:${port}/pilot`);
  console.log(`独立数据库：${join(runtime, 'pilot.sqlite')}；不发送任何眼镜消息。`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
process.on('message', message => { if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'a5:shutdown') shutdown(); });
if (process.connected) process.on('disconnect', shutdown);
