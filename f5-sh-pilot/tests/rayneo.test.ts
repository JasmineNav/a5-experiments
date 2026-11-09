import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import {displayPayload, SharedGlassesAdapter} from '@a5/glasses/adapters/shared-glasses.ts';
import { PreSendError } from '@a5/glasses/contracts.ts';
import { displayRelease } from '@a5/glasses/display-release.ts';
import { RayNeoGlassesAdapter, rayneoProtocol } from '@a5/glasses/adapters/rayneo-glasses.ts';
import type { GlassesEvent, GlassesRequest, ParticipantConfig, GlassesAdapter } from '@a5/desktop/contracts.ts';
import { Engine } from '@a5/desktop/engine.ts';
import { Store } from '@a5/desktop/store.ts';
import { loadMaterial } from '@a5/desktop/tasks.ts';
import { readJson } from '@a5/desktop/preflight.ts';
import { testConfig } from './fixtures.ts';
import { exportData } from '@a5/desktop/export.ts';

// 使用真实 TCP 帧测试电脑协议；此服务不替代 Android 或光学验收。
async function bridge(identity:'adb'|'hardware'='adb') {
  const requests = new Map<string, GlassesRequest>(), events: { seq: number; event: GlassesEvent }[] = [];
  const commands: string[] = [], adbCalls: string[][] = [], sockets = new Set<Socket>();
  let corruptHash = false, replyIdMismatch = false, rejectShows = false, hold = false;
  const held: (() => void)[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const req = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); commands.push(req.command);
        let value: Record<string, unknown> = {};
        if (req.command === 'status') value = { ready: true, busy: false, ledger_id: 'test-ledger', capabilities:{commands:['show_text','confirm','cancel'],display_modes:['timed','confirm_until_ack'],text_duration_ms:{min:1000,max:60000},tone:true,tone_presets:['notification']}, device_info: { fixed_duration_ms: '8500,11000' } };
        else if (req.command === 'events') value = { ledger_id: 'test-ledger', events: events.filter(e => e.seq > req.payload.after) };
        else if (req.command === 'show_text') {
          const request = req.payload as GlassesRequest;
          const previous = requests.get(request.request_id);
          if (rejectShows) value = { ok: false, error: 'device_text_does_not_fit' };
          else if (previous && JSON.stringify(previous) !== JSON.stringify(request)) value = { ok: false, error: 'request_id_content_conflict' };
          else { requests.set(request.request_id, request); value = { request_id: replyIdMismatch ? 'wrong-id' : request.request_id, deduplicated: !!previous, text_sha256: corruptHash ? 'wrong-hash' : createHash('sha256').update(request.text, 'utf8').digest('hex') }; }
        }
        const reply = () => {
          const frame = Buffer.from(JSON.stringify({ protocol: rayneoProtocol, id: req.id, ok: true, ...value }) + '\n');
          // 将 UTF-8 字节拆开，检查解码器能处理跨 TCP 分片。
          socket.write(frame.subarray(0, 13)); socket.write(frame.subarray(13));
        };
        if (req.command === 'show_text' && hold) held.push(reply); else reply();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const run = async (_file: string, args: string[]) => { adbCalls.push(args); return args.includes('tcp:0') ? `${port}\n` : args.includes('getprop')?'HW123456':''; };
  const adapter = new RayNeoGlassesAdapter('test-usb', { run,identity }); await adapter.probe();
  const emit = (request: GlassesRequest, kind: GlassesEvent['kind'], extra: Partial<GlassesEvent> = {}) => {
    const event: GlassesEvent = { event_id: randomUUID(), request_id: request.request_id, device_id:identity==='hardware'?'glasses:HW123456':'adb:test-usb', kind,
      device_wall_ms: 1000, device_monotonic_ms: events.length * 100 + 20, clock_id: 'android_uptime_ms:boot-2', error: null, ...extra };
    events.push({ seq: events.length + 1, event }); return event;
  };
  return { adapter, run, requests, commands, adbCalls, events, emit,
    hold: () => { hold = true; }, release: () => { hold = false; for (const reply of held.splice(0)) reply(); },
    corruptHash: () => { corruptHash = true; }, reject: () => { rejectShows = true; }, mismatch: () => { replyIdMismatch = true; },
    disconnect: () => { for (const socket of sockets) socket.destroy(); },
    async close() { await adapter.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const request = (): GlassesRequest => ({ request_id: randomUUID(), session_id: randomUUID(), participant_id: '000', stage_id: 'SH01', message_id: 'N01',
  text: '通知：“线上方案评审会”\n调整为13:30开始。🙂 \\ $() `test`', duration_ms: 8500, device_id: 'adb:test-usb' });

test('USB协议原样传输两种固定策略的11000ms及设备隐藏原因，不改写绘制和隐藏时间', async () => {
  const b = await bridge();
  try {
    for (const display_mode of ['legacy_8500', 'tone_8500'] as const) {
      const req: GlassesRequest = { ...request(), duration_ms: 11000, display_mode };
      assert.equal((await b.adapter.send(req)).status, 'accepted');
      assert.equal(b.requests.get(req.request_id)!.duration_ms, 11000);
      assert.equal(b.requests.get(req.request_id)!.display_mode, 'timed');
      const drawn = b.emit(req, 'drawn', { device_wall_ms: 9000, device_monotonic_ms: 4000 });
      const hidden = b.emit(req, 'hidden', { device_wall_ms: 20016, device_monotonic_ms: 15016, hide_reason: 'auto_timeout', display_mode, duration_ms: 11000 });
      const events: GlassesEvent[] = [];
      await b.adapter.pollEvents(event => events.push(event));
      assert.deepEqual(events.filter(e => e.request_id === req.request_id), [drawn, hidden]);
    }
  } finally { await b.close(); }
});

const visible = { visibility_state: 'visible', monotonic_ms: 10, time_origin_ms: 1000, timestamp_iso: '2026-10-19T00:00:00.000Z' };
async function fixture(adapter: GlassesAdapter, db = ':memory:') {
  const store = new Store(db), material = await loadMaterial(), config = await testConfig();
  const engine = new Engine(store, adapter, material, config);
  const created = engine.create('000');
  const send = (action: string, extra = {}) => engine.command(created.session_id, { command_id: randomUUID(), page_token: engine.view(created.session_id).page_token, action, client: visible, ...extra });
  const trigger = () => { engine.adminAction(created.session_id, 'debug_jump', '测试触发', 'SH01_U1'); send('displayed'); send('reveal', { open: true }); send('reveal_displayed'); };
  return { store, engine, created, send, trigger, material, config };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail('未观察到预期协议请求');
}

test('USB协议：中文换行原样传输、接受不等于绘制、永久幂等语义、无逐消息ADB及清屏命令', async () => {
  const b = await bridge();
  try {
    const r = request(), receipt = await b.adapter.send(r);
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.t_display, null); assert.equal(receipt.t_hide, null);
    assert.deepEqual(b.requests.get(r.request_id), displayPayload(r)); assert.equal(b.adbCalls.length, 1);
    assert.equal((await b.adapter.send(r)).status, 'accepted'); assert.equal(b.requests.size, 1);
    assert.equal((await b.adapter.send({ ...r, text: '不同正文' })).error, 'request_id_content_conflict');
    b.emit(r, 'drawn'); b.emit(r, 'hidden'); const received: GlassesEvent[] = [];
    await b.adapter.pollEvents(e => received.push(e)); await b.adapter.pollEvents(e => received.push(e));
    assert.equal(received.length, 2); assert.equal(b.adbCalls.length, 1);
    await assert.rejects(b.adapter.send({ ...r, device_id: 'adb:other' }), /binding_mismatch/);
    assert.ok(b.commands.every(c => ['show_text', 'status', 'events'].includes(c)));
    assert.ok(b.adbCalls[0].includes('localabstract:glasses-display-v2')); assert.deepEqual(b.adbCalls[0].slice(0, 2), ['-s', 'test-usb']);
  } finally { await b.close(); }
});

test('协议异常、容量拒绝和断线都显式留错；重连仅回收事件，不冲刷刺激', async () => {
  const b = await bridge();
  try {
    b.mismatch(); const r = request(); assert.equal((await b.adapter.send(r)).error, 'device_request_id_mismatch');
    b.reject(); const rejected = await b.adapter.send(request()); assert.equal(rejected.error, 'device_text_does_not_fit'); assert.equal(rejected.status, 'failed');
    const shows = b.commands.filter(c => c === 'show_text').length;
    b.disconnect(); await until(() => !b.adapter.getStatus().connected);
    // 2.2.4 起无存活连接立即拒绝，命令确定未写入线路：not_sent，而不是在途未确认。
    const offline = await b.adapter.send(request()); assert.equal(offline.status, 'not_sent'); assert.equal(offline.error, 'device_disconnected');
    await b.adapter.pollEvents(() => {});
    assert.equal(b.adapter.getStatus().connected, true);
    assert.equal(b.commands.filter(c => c === 'show_text').length, shows);
    assert.throws(() => new RayNeoGlassesAdapter('bad serial'), /SERIAL/);
  } finally { await b.close(); }
});

test('设备会话绑定、快照正文、慢回执并行切题及结束/删除后的乱序重复事件均落到原任务组', async () => {
  const b = await bridge(); const f = await fixture(b.adapter); const dir = await mkdtemp(join(tmpdir(), 'a5-rayneo-export-'));
  try {
    assert.throws(() => f.engine.create('001'), /已绑定/);
    const originalText = f.engine.session(f.created.session_id).snapshot.stimuli.find(s => s.message_id === 'N01' && s.stage_id === 'SH01')!.text;
    f.material.stimuli.find(s => s.message_id === 'N01' && s.stage_id === 'SH01')!.text = '不应进入旧会话的新正文';
    b.hold(); f.trigger(); await until(() => b.requests.size === 1);
    const r = [...b.requests.values()][0]; assert.equal(r.text, originalText);
    assert.equal(f.send('submit', { answer: { plans: ['A'] } }).phase, 'UNIT');
    f.engine.adminAction(f.created.session_id, 'debug_jump', '切换任务组', 'SH03_U2');
    f.engine.adminAction(f.created.session_id, 'stop', '结束测试'); f.engine.adminAction(f.created.session_id, 'delete', '测试删除');
    const hidden = b.emit(r, 'hidden'); b.emit(r, 'drawn'); b.emit(r, 'accepted');
    await b.adapter.pollEvents(e => f.engine.receiveDeviceEvent(e));
    f.engine.receiveDeviceEvent(hidden); // 重复回调幂等。
    b.release(); await f.engine.settle();
    const message = f.store.interventions(f.created.session_id)[0];
    assert.equal(message.stage_id, 'SH01'); assert.equal(message.device_events!.length, 3); assert.equal(message.status, 'accepted');
    assert.equal(message.t_display, null); assert.equal(message.t_hide, null); assert.equal(message.device_id, 'adb:test-usb');
    const evidence = f.store.events(f.created.session_id).filter(e => e.event_type.startsWith('message_device_'));
    assert.equal(evidence.length, 3); assert.ok(evidence.every(e => e.stage_id === 'SH01' && e.unit_id === null));
    assert.equal(f.engine.summary(f.created.session_id).real_presentation_verified, false);
    f.engine.adminAction(f.created.session_id, 'restore', '核对导出');
    const output = await exportData(f.engine, [f.created.session_id], dir), files = unzipSync(output.bytes);
    assert.match(strFromU8(files['interventions.csv']), /device_events/); assert.match(strFromU8(files['events.jsonl']), /android_uptime_ms/);
    assert.match(JSON.parse(strFromU8(files['manifest.json'])).presentation, /未同步/);
    const ackRow = strFromU8(files['interventions.csv']); assert.ok(ackRow.includes('adb:test-usb'));
  } finally { b.release(); await f.engine.settle(); f.store.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
});

test('设备失败先于接受回执时不被覆盖；未知请求、错设备和同事件ID不同内容被隔离', async () => {
  const b = await bridge(), f = await fixture(b.adapter);
  try {
    b.hold(); f.trigger(); await until(() => b.requests.size === 1); const r = [...b.requests.values()][0];
    const failed = b.emit(r, 'failed', { error: 'device_foreground_lost' });
    f.engine.receiveDeviceEvent(failed); b.release(); await f.engine.settle();
    assert.equal(f.store.interventions(f.created.session_id)[0].status, 'failed');
    assert.equal(f.store.interventions(f.created.session_id)[0].error, 'device_foreground_lost');
    f.engine.receiveDeviceEvent({ ...failed, event_id: randomUUID(), request_id: 'unknown' });
    f.engine.receiveDeviceEvent({ ...failed, event_id: randomUUID(), device_id: 'adb:other' });
    assert.equal(f.store.interventions(f.created.session_id)[0].device_events!.length, 1);
    assert.throws(() => f.engine.receiveDeviceEvent({ ...failed, error: 'different' }), /event_id_conflict/);
    const audits = f.store.db.prepare('SELECT data FROM admin_audit').all() as { data: string }[];
    assert.equal(audits.filter(a => a.data.includes('device_event_rejected')).length, 2);
  } finally { b.release(); await f.engine.settle(); f.store.close(); await b.close(); }
});

test('已删除会话未决发送重启也标未知；重读历史事件可恢复证据但不重发', async () => {
  const b = await bridge(), f = await fixture(b.adapter);
  try {
    f.trigger(); await f.engine.settle(); const r = [...b.requests.values()][0];
    f.engine.adminAction(f.created.session_id, 'stop', '停止'); f.engine.adminAction(f.created.session_id, 'delete', '删除');
    const message = f.store.interventions(f.created.session_id)[0]; message.status = 'send_requested'; f.store.intervention(message);
    const engine = new Engine(f.store, b.adapter, f.material, f.config);
    assert.equal(f.store.interventions(f.created.session_id)[0].status, 'unknown');
    assert.equal(b.requests.size, 1);
    b.emit(r, 'drawn'); b.emit(r, 'hidden'); await b.adapter.pollEvents(e => engine.receiveDeviceEvent(e));
    const eventCount = f.store.events(f.created.session_id).length;
    const restored = new RayNeoGlassesAdapter('test-usb', { run: b.run });
    await b.adapter.close();
    try { await restored.pollEvents(e => engine.receiveDeviceEvent(e)); assert.equal(f.store.events(f.created.session_id).length, eventCount); }
    finally { await restored.close(); }
    assert.equal(f.store.interventions(f.created.session_id)[0].status, 'accepted');
    assert.equal(b.commands.filter(c => c === 'show_text').length, 1);
  } finally { await f.engine.settle(); f.store.close(); await b.close(); }
});

test('没有结束的适配器Promise有5秒上限，不阻塞主任务与正常停止', async () => {
  const adapter: GlassesAdapter = { getStatus: () => ({ source: 'device', connected: true, ready: true, device_id: 'adb:test-usb', device_info: { fixed_duration_ms: '8500,11000' } }), send: () => new Promise(() => {}) };
  const f = await fixture(adapter);
  try {
    f.trigger(); assert.equal(f.send('submit', { answer: { plans: ['A'] } }).phase, 'UNIT');
    await f.engine.settle();
    const m = f.store.interventions(f.created.session_id)[0];
    // unknown 只留给进程重启；运行中超时视为可能已发出、未确认。
    assert.equal(m.status, 'unacknowledged'); assert.equal(m.error, 'adapter_send_timeout_unacknowledged');
  } finally { f.store.close(); }
});

test('恢复真实会话时若运行模式改变，拒绝刺激派发，不暗中回退Mock', async () => {
  const b = await bridge(), f = await fixture(b.adapter); let mockCalls = 0;
  try {
    const mock: GlassesAdapter = { getStatus: () => ({ source: 'mock', connected: true }), send: async () => { mockCalls++; throw new Error('不应调用'); } };
    const engine = new Engine(f.store, mock, f.material, f.config);
    engine.adminAction(f.created.session_id, 'debug_jump', '检查模式隔离', 'SH01_U1');
    const send = (action: string, extra = {}) => engine.command(f.created.session_id, { command_id: randomUUID(), page_token: engine.view(f.created.session_id).page_token, action, client: visible, ...extra });
    send('displayed'); assert.throws(() => send('reveal', { open: true }), /眼镜未就绪/); await engine.settle();
    assert.equal(mockCalls, 0); assert.equal(f.store.interventions(f.created.session_id).length, 0);
    assert.equal(engine.view(f.created.session_id).reveal?.open, false);
  } finally { f.store.close(); await b.close(); }
});


test('真实RPC在3秒内结束等待，超时不重发，迟到应答不改变接受语义且后续事件可回收', async () => {
  const b = await bridge();
  try {
    b.hold(); const r = request(), receipt = await b.adapter.send(r);
    assert.equal(receipt.status, 'unacknowledged'); assert.equal(receipt.error, 'device_reply_timeout_delivery_unknown');
    assert.equal(b.commands.filter(c => c === 'show_text').length, 1);
    b.release(); b.emit(r, 'drawn'); b.emit(r, 'hidden');
    const evidence: GlassesEvent[] = []; await b.adapter.pollEvents(e => evidence.push(e));
    assert.equal(evidence.length, 2); assert.equal(b.commands.filter(c => c === 'show_text').length, 1);
  } finally { b.release(); await b.close(); }
});


test('正文哈希不一致为明确故障，保留错误应答，后来的绘制证据不能掩盖正文异常', async () => {
  const b = await bridge(), f = await fixture(b.adapter);
  try {
    b.corruptHash(); f.trigger(); await f.engine.settle();
    const m = f.store.interventions(f.created.session_id)[0], r = [...b.requests.values()][0];
    assert.equal(m.status, 'failed'); assert.equal(m.error, 'device_text_integrity_mismatch');
    assert.equal((m.receipt as { evidence: { text_sha256: string } }).evidence.text_sha256, 'wrong-hash');
    b.emit(r, 'drawn'); b.emit(r, 'hidden'); await b.adapter.pollEvents(e => f.engine.receiveDeviceEvent(e));
    assert.equal(f.store.interventions(f.created.session_id)[0].status, 'failed');
  } finally { await f.engine.settle(); f.store.close(); await b.close(); }
});

test('共享客户端切换同硬件路由保留事件游标，其他 identity 事件跳过但前移游标',async()=>{
 const b=await bridge('hardware');try{
   const req={...request(),device_id:'glasses:HW123456'};assert.equal((await b.adapter.send(req)).status,'accepted');
   const first=b.emit(req,'drawn');const received:GlassesEvent[]=[];await b.adapter.pollEvents(e=>received.push(e));
   await b.adapter.setRoute('192.168.1.9:5555','hardware');
   b.emit(req,'accepted',{device_id:'adb:some-other-route'});const hidden=b.emit(req,'hidden');
   await b.adapter.pollEvents(e=>received.push(e));await b.adapter.pollEvents(e=>received.push(e));
   assert.deepEqual(received,[first,hidden]);assert.equal(b.adapter.getStatus().device_id,'glasses:HW123456');assert.equal(b.commands.filter(c=>c==='show_text').length,1);
 }finally{await b.close();}
});


test('2.2.4 投递状态：发送前取消为 not_sent 且不写入线路；写入后取消为 unacknowledged，均不重发', async () => {
  const b = await bridge();
  try {
    const shows = () => b.commands.filter(c => c === 'show_text').length;
    const cancelled = new AbortController(); cancelled.abort();
    const before = await b.adapter.send(request(), { signal: cancelled.signal });
    assert.equal(before.status, 'not_sent'); assert.equal(shows(), 0);
    const expired = await b.adapter.send(request(), { deadline: Date.now() - 1 });
    assert.equal(expired.status, 'not_sent'); assert.equal(shows(), 0);
    b.hold(); const late = new AbortController(), r = request();
    const pending = b.adapter.send(r, { signal: late.signal }); await until(() => b.requests.has(r.request_id));
    late.abort(); const after = await pending;
    assert.equal(after.status, 'unacknowledged'); assert.equal(after.error, 'device_call_aborted_after_send');
    b.release(); await delay(20); assert.equal(shows(), 1);
  } finally { b.release(); await b.close(); }
});

test('发送前本地校验抛 PreSendError(failed)；允许时长可配置，默认仍为 8500/11000', async () => {
  const b = await bridge();
  try {
    await assert.rejects(b.adapter.send({ ...request(), duration_ms: 9000 }), (e: unknown) => e instanceof PreSendError && e.delivery === 'failed' && e.message === 'device_invalid_stimulus');
    assert.equal(b.commands.filter(c => c === 'show_text').length, 0);
    const custom = new SharedGlassesAdapter('test-usb', { run: b.run, durationsMs: [9000] });
    try { await custom.probe(); assert.equal((await custom.send({ ...request(), duration_ms: 9000 })).status, 'accepted'); await assert.rejects(custom.send({ ...request(), duration_ms: 11000 }), /device_invalid_stimulus/); }
    finally { await custom.close(); }
    assert.throws(() => new SharedGlassesAdapter('test-usb', { run: b.run, durationsMs: [0] }), /正整数/);
  } finally { await b.close(); }
});

test('Engine：not_sent 与发送前失败如实记录、不补发、不占用显示；session_created 固定版本坐标', async () => {
  let mode: 'not_sent' | 'failed' = 'not_sent', calls = 0;
  const adapter: GlassesAdapter = { getStatus: () => ({ source: 'device', connected: true, ready: true, device_id: 'adb:test-usb', device_info: { fixed_duration_ms: '8500,11000', app_version: displayRelease.version } }),
    send: async () => { calls++; throw new PreSendError(mode === 'not_sent' ? 'device_disconnected' : 'device_capability_missing', mode); } };
  const store = new Store(':memory:'), engine = new Engine(store, adapter, await loadMaterial(), await testConfig());
  engine.runVersions = () => ({ experiment_commit: 'abc123', display_base_tag: displayRelease.tag, display_apk_sha256_pinned: displayRelease.sha256 });
  try {
    const created = engine.create('000'), id = created.session_id;
    const s = store.get(id)!; assert.equal(s.snapshot.run_versions?.experiment_commit, 'abc123'); assert.equal(s.snapshot.run_versions?.app_version, displayRelease.version);
    assert.equal((store.events(id).find(e => e.event_type === 'session_created')!.payload.run_versions as { display_base_tag: string }).display_base_tag, displayRelease.tag);
    const firstId = randomUUID(); engine.manualNotification(id, firstId, '第一条', 'legacy_8500'); await engine.settle();
    const first = store.findRequest(firstId)!;
    assert.equal(first.status, 'not_sent'); assert.equal(first.error, 'device_disconnected');
    assert.ok(store.get(id)!.state.attention.some(a => a.endsWith(':message_not_sent')));
    // 确定未显示的消息不阻塞下一条手动通知，也不会被自动补发。
    mode = 'failed'; const secondId = randomUUID(); engine.manualNotification(id, secondId, '第二条', 'legacy_8500'); await engine.settle();
    assert.equal(store.findRequest(secondId)!.status, 'failed'); assert.equal(store.findRequest(firstId)!.status, 'not_sent'); assert.equal(calls, 2);
    await engine.settle(); assert.equal(calls, 2);
  } finally { await engine.settle(); store.close(); }
});
