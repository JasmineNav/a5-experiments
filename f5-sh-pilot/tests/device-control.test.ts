import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Engine } from '@a5/desktop/engine.ts';
import { Store } from '@a5/desktop/store.ts';
import { loadMaterial } from '@a5/desktop/tasks.ts';
import { readJson } from '@a5/desktop/preflight.ts';
import { DeviceControl } from '@a5/desktop/device-control.ts';
import { createApp } from '@a5/desktop/app.ts';
import type { GlassesAdapter, GlassesEvent, GlassesRequest, ParticipantConfig } from '@a5/desktop/contracts.ts';

/** 建立独立内存数据库和可控设备替身，避免测试触碰真实眼镜。 */
async function fixture() {
  const store = new Store(':memory:');
  let connected = true, ready = true, busy = false, sends = 0, clock = 20000, overlay = false, voiceMode = 'allow', voiceWritable = true;
  let waitHook: (() => void) | undefined;
  const calls: string[][] = [];
  const requests: GlassesRequest[] = [];
  const adapter: GlassesAdapter = {
    /** 提供可独立切换的连接、就绪和忙碌状态，模拟探测失败。 */
    getStatus: () => ({ source: 'device', connected, ready, busy, device_id: 'adb:fixture', device_info: { fixed_duration_ms: '8500,11000' }, error: connected ? undefined : 'fixture_disconnected' }),
    /** 探测与重连不替测试自动恢复连接，以验证调用方检查状态。 */
    probe: async () => {}, reconnect: async () => { calls.push(['reconnect']); },
    /** 记录发送次数和原始请求，只模拟接受而不伪造绘制事件。 */
    send: async request => {
      sends++; requests.push(request);
      return { request_id: request.request_id, device_id: request.device_id, source: 'device', status: 'accepted', t_send: new Date().toISOString(), t_ack: new Date().toISOString(), t_display: null, t_hide: null, display_time_source: 'unavailable', error: null };
    },
  };
  const engine = new Engine(store, adapter, await loadMaterial(), await readJson<ParticipantConfig>('config/participants.pilot.json'));
  const control = new DeviceControl(engine, { serial: 'fixture', packageName: 'link.ironip.a5.rayneo.localfix', now: () => clock, wait: async ms => { clock += ms; waitHook?.(); },
    /** 模拟 ADB 权限读写与前台窗口，记录操作以验证恢复边界。 */
    run: async (_file, args) => {
      calls.push(args);
      if (args.includes('appops')) {
        if (args.includes('set') && voiceWritable) voiceMode = args.at(-1)!;
        return args.includes('get') ? `SYSTEM_ALERT_WINDOW: ${voiceMode}` : '';
      }
      return args.includes('get-state') ? 'device\n' : args.includes('dumpsys') && overlay ? 'mCurrentFocus=Window com.ffalconxr.mercury.launcher\nmFocusedApp=link.ironip.a5.rayneo.localfix' : 'Starting';
    } });
  return { store, engine, control, requests, calls, onWait: (hook: () => void) => { waitHook = hook; }, sends: () => sends,
    connected: (value: boolean) => { connected = value; }, ready: (value: boolean) => { ready = value; }, busy: (value: boolean) => { busy = value; }, overlay: (value: boolean) => { overlay = value; }, advance: (ms: number) => { clock += ms; },
    voiceMode: () => voiceMode, voiceWritable: (value: boolean) => { voiceWritable = value; } };
}

test('独立测试通知：幂等、双眼事件关联、重启不重发，且不写入实验会话', async () => {
  const f = await fixture();
  try {
    const request_id = randomUUID(), input = { action: 'notify', request_id, text: '测试通知\n中文完整' };
    await f.control.action(input);
    assert.throws(() => f.engine.create('000'), /测试通知/);
    await f.control.action(input);
    assert.equal(f.sends(), 1);
    await assert.rejects(f.control.action({ ...input, text: '不同内容' }), /不同内容/);
    const event = (kind: GlassesEvent['kind']): GlassesEvent => ({ event_id: randomUUID(), request_id, device_id: 'adb:fixture', kind, device_wall_ms: 1000, device_monotonic_ms: 1000, clock_id: 'boot', error: null });
    const drawn = event('drawn'); f.engine.receiveDeviceEvent(drawn); f.engine.receiveDeviceEvent(drawn);
    f.engine.receiveDeviceEvent(event('hidden'));
    assert.equal(f.control.status().debug_notifications[0].events.length, 2);
    assert.equal(f.control.status().debug_notifications[0].status, 'hidden');
    assert.deepEqual(f.store.ids(), []);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM interventions').get()!.n, 0);
    await f.control.close();
    const restored = new DeviceControl(f.engine, { serial: 'fixture' });
    await restored.action(input);
    assert.equal(f.sends(), 1);
    await restored.close();
  } finally { await f.control.close(); f.store.close(); }
});

test('进行中会话允许手动通知并单独标记；忙碌时不抢前台、不重建USB', async () => {
  const f = await fixture();
  try {
    f.engine.create('000');
    await f.control.action({ action: 'notify', request_id: randomUUID(), text: '测试' }); await f.engine.settle();
    assert.equal(f.store.interventions(f.store.ids()[0])[0].data_kind,'manual');
    assert.equal(f.engine.presentation(f.store.ids()[0]).device_drawn_messages,0);
    f.busy(true); f.ready(false);
    f.control.tick();
    await assert.rejects(f.control.action({ action: 'open' }), /尚未展示结束/);
    await assert.rejects(f.control.action({ action: 'reconnect' }), /尚未展示结束/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends(), 1);
  } finally { await f.control.close(); f.store.close(); }
});

test('上位机守护限频恢复并固定目标应用，可关闭；不重放消息', async () => {
  const f = await fixture();
  try {
    f.ready(false); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(f.calls.some(args => args.includes('KEYCODE_WAKEUP')));
    assert.ok(f.calls.some(args => args.includes('link.ironip.a5.rayneo.localfix/link.ironip.glasses.display.MainActivity')));
    const initial = f.calls.length;
    f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, initial);
    f.advance(10001); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    // 第二次无需重复设置已经受限的权限，但仍核对并恢复前台。
    assert.equal(f.calls.filter(args => args.includes('KEYCODE_WAKEUP')).length, 2);
    await f.control.action({ action: 'host', enabled: false });
    f.advance(10001); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(args => args.includes('KEYCODE_WAKEUP')).length, 2);
    await f.control.close();
    const next = new DeviceControl(f.engine, { serial: 'fixture', enabled: false, run: async () => { throw new Error('不应执行'); } });
    next.tick(); await next.close();
    assert.equal(f.sends(), 0);
  } finally { f.store.close(); }
});

test('就绪时也预防语音悬浮窗：按包限制、持久备份，关闭守护恢复原权限', async () => {
  const f = await fixture();
  try {
    f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.voiceMode(), 'ignore');
    assert.equal(f.control.status().voice_guard.state, 'protected');
    assert.ok(f.calls.every(args => !args.includes('--uid') && !args.includes('force-stop')));
    assert.equal(f.calls.some(args => args.includes('KEYCODE_WAKEUP')), false);
    const count = f.calls.length;
    f.advance(1000); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, count);
    f.busy(true);
    await assert.rejects(f.control.action({ action: 'host', enabled: false }), /尚未展示结束/);
    assert.equal(f.voiceMode(), 'ignore');
    f.busy(false);
    await f.control.action({ action: 'host', enabled: false });
    assert.equal(f.voiceMode(), 'allow');
    assert.equal(f.control.status().voice_guard.state, 'restored');
    assert.equal(f.store.setting('device_voice_overlay_backup:fixture'), null);
    assert.equal(f.sends(), 0);
  } finally { await f.control.close(); f.store.close(); }
});

test('权限限制必须读回验证；失败保留备份，进程恢复不会用受限值覆盖原权限', async () => {
  const f = await fixture();
  try {
    f.voiceWritable(false);
    await f.control.action({ action: 'host', enabled: true });
    assert.equal(f.control.status().voice_guard.state, 'error');
    assert.match(f.control.status().voice_guard.error!, /未生效/);
    assert.deepEqual(f.store.setting('device_voice_overlay_backup:fixture'), { mode: 'allow' });
    f.voiceWritable(true);
    await f.control.action({ action: 'host', enabled: true });
    assert.equal(f.voiceMode(), 'ignore');
    // 模拟被终止后遗留的限制；新控制器复用持久备份，而不是将 ignore 备份为原权限。
    const resumedCalls: string[][] = [];
    const resumed = new DeviceControl(f.engine, { serial: 'fixture', run: async (_file, args) => {
      resumedCalls.push(args);
      return args.includes('get') ? 'SYSTEM_ALERT_WINDOW: ignore' : '';
    } });
    await resumed.action({ action: 'host', enabled: true });
    assert.deepEqual(f.store.setting('device_voice_overlay_backup:fixture'), { mode: 'allow' });
    // 验证进程关闭也尝试恢复，设备未执行时不能误删备份。
    await resumed.close();
    assert.ok(resumedCalls.some(args => args.includes('set') && args.at(-1) === 'allow'));
    assert.deepEqual(f.store.setting('device_voice_overlay_backup:fixture'), { mode: 'allow' });
  } finally { await f.control.close(); f.store.close(); }
});

test('设备控制API直接进入，拒绝未知操作和不合法通知', async () => {
  const f = await fixture();
  const server = createApp(f.engine, '', f.control);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    /** 向临时服务器发送真实 HTTP 请求，覆盖鉴权和响应码。 */
    const post = (body: object, authorized = true) => fetch(`http://127.0.0.1:${port}/api/admin/device/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer secret' } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'open' }, false)).status, 200);
    assert.equal((await post({ action: 'shell', text: 'arbitrary' })).status, 422);
    assert.equal((await post({ action: 'notify', request_id: randomUUID(), text: '' })).status, 422);
    assert.equal((await post({ action: 'host', enabled: false })).status, 200);
    assert.equal(f.control.status().enabled, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.control.close(); f.store.close(); }
});

test('只收起覆盖显示应用的系统面板；正常显示时不发送返回键或清屏', async () => {
  const f = await fixture();
  try {
    await f.control.action({ action: 'open' });
    assert.equal(f.calls.some(args => args.includes('android.intent.action.CLOSE_SYSTEM_DIALOGS')), false);
    f.overlay(true);
    await f.control.action({ action: 'open' });
    assert.equal(f.calls.filter(args => args.includes('android.intent.action.CLOSE_SYSTEM_DIALOGS')).length, 1);
    assert.equal(f.calls.some(args => args.includes('KEYCODE_BACK') || args.includes('force-stop')), false);
  } finally { await f.control.close(); f.store.close(); }
});

test('重连或唤醒后仍断线时 API 返回503，诊断与审计记录失败；恢复后才记录成功', async () => {
  const f = await fixture();
  const server = createApp(f.engine, '', f.control);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const action of ['reconnect', 'open']) {
      f.connected(false);
      /** 复用同一操作请求，对比连接失败和恢复后的接口结果。 */
      const post = () => fetch(`http://127.0.0.1:${port}/api/admin/device/control`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }, body: JSON.stringify({ action }) });
      const response = await post();
      assert.equal(response.status, 503);
      assert.match(await response.text(), /显示端连接未恢复/);
      assert.match(f.control.status().error!, /\[已绑定设备\]_disconnected/);
      assert.equal(f.control.status().error!.includes('fixture'), false);
      const failed = f.control.status().audit[0];
      assert.equal(failed.action, action);
      assert.equal(failed.detail.ok, false);
      f.connected(true);
      assert.equal((await post()).status, 200);
      assert.equal(f.control.status().error, null);
      assert.equal(f.control.status().audit[0].detail.ok, true);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.control.close(); f.store.close(); }
});

test('定时入口的同步读取异常被隔离，修复后仍可继续控制', async t => {
  const f = await fixture();
  const log = t.mock.method(console, 'error', () => {});
  try {
    const ids = t.mock.method(f.store, 'ids', () => { throw new Error('fixture read failed'); });
    assert.doesNotThrow(() => f.control.tick());
    ids.mock.restore();
    assert.equal(log.mock.callCount(), 1);
    assert.equal(f.control.status().last_action, 'tick');
    assert.match(f.control.status().error!, /read failed/);
    await f.control.action({ action: 'probe' });
    assert.equal(f.control.status().error, null);
  } finally { await f.control.close(); f.store.close(); }
});

test('损坏的权限备份进入守护诊断和审计，并按五秒间隔重试', async () => {
  const f = await fixture();
  try {
    await f.control.action({ action: 'host', enabled: false });
    f.store.db.prepare('INSERT INTO settings VALUES (?,?)').run('device_voice_overlay_backup:fixture', '{invalid');
    f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.control.status().voice_guard.state, 'error');
    assert.equal(f.control.status().audit[0].action, 'voice_overlay');
    assert.equal(f.control.status().audit[0].detail.ok, false);
    const count = f.control.status().audit.length;
    f.advance(1000); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.control.status().audit.length, count);
    f.advance(4001); f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.control.status().audit.length, count + 1);
    assert.equal(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get('device_voice_overlay_backup:fixture')!.value, '{invalid');
    f.store.setSetting('device_voice_overlay_backup:fixture', null);
    f.advance(5001); assert.doesNotThrow(() => f.control.tick());
  } finally { await f.control.close(); f.store.close(); }
});

test('权限审计写入失败的异步拒绝被捕获，释放工作锁并保留诊断', async t => {
  const f = await fixture();
  const log = t.mock.method(console, 'error', () => {});
  try {
    f.store.db.exec("CREATE TRIGGER reject_device_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(FAIL, 'fixture audit unavailable'); END");
    f.control.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    f.store.db.exec('DROP TRIGGER reject_device_audit');
    assert.equal(log.mock.callCount(), 1);
    assert.equal(f.control.status().working, false);
    assert.equal(f.control.status().last_action, 'tick');
    assert.match(f.control.status().error!, /audit unavailable/);
    assert.deepEqual(f.store.setting('device_voice_overlay_backup:fixture'), { mode: 'allow' });
    await f.control.action({ action: 'host', enabled: false });
    assert.equal(f.voiceMode(), 'allow');
    assert.equal(f.control.status().error, null);
  } finally { f.store.db.exec('DROP TRIGGER IF EXISTS reject_device_audit'); await f.control.close(); f.store.close(); }
});


test('退出期间等待展示结束证据后恢复原权限，等待中不改权限或重发刺激', async () => {
  const f = await fixture();
  try {
    await f.control.action({ action: 'host', enabled: true });
    f.busy(true);
    let waits = 0;
    f.engine.adapter.pollEvents = async () => { f.busy(false); };
    f.onWait(() => { waits++; assert.equal(f.voiceMode(), 'ignore'); });
    await f.control.close();
    assert.equal(waits, 1);
    assert.equal(f.voiceMode(), 'allow');
    assert.equal(f.store.setting('device_voice_overlay_backup:fixture'), null);
    assert.equal(f.sends(), 0);
  } finally { await f.control.close(); await f.engine.settle(); f.store.close(); }
});

test('退出等待展示最多十五秒，设备持续忙碌时保留原权限备份并记录待恢复', async () => {
  const f = await fixture();
  try {
    await f.control.action({ action: 'host', enabled: true });
    f.busy(true);
    let waits = 0; f.onWait(() => { waits++; });
    await f.control.close();
    assert.equal(waits, 60);
    assert.equal(f.voiceMode(), 'ignore');
    assert.deepEqual(f.store.setting('device_voice_overlay_backup:fixture'), { mode: 'allow' });
    assert.equal(f.control.status().audit[0].action, 'voice_overlay_restore_deferred');
    assert.equal(f.sends(), 0);
  } finally { f.busy(false); await f.control.close(); f.store.close(); }
});
