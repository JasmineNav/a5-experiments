import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@a5/desktop/store.ts';
import { Engine } from '@a5/desktop/engine.ts';
import { VoiceOverlayGuard } from '@a5/desktop/voice-overlay-guard.ts';
import { systemClock } from '@a5/desktop/clock.ts';
import { loadMaterial } from '@a5/desktop/tasks.ts';
import { testConfig } from './fixtures.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';

const material = await loadMaterial();
const config = await testConfig();

function fixture() {
  const time = { wall: Date.parse('2026-10-25T08:00:00Z'), mono: 1000 };
  const clock = { wall: () => time.wall, mono: () => time.mono };
  const store = new Store(':memory:'), engine = new Engine(store, new MockGlassesAdapter(), material, config, clock);
  const id = engine.create('001').session_id;
  return { store, engine, id, time };
}

test('统一时钟：已建立的会话计时只跟单调钟，墙钟跳变不影响', () => {
  const { engine, id, time } = fixture();
  const s = engine.session(id), first = engine.elapsed(s);
  time.mono += 2500; time.wall += 2500;
  assert.equal(engine.elapsed(s), first + 2500);
  time.wall += 3_600_000; // 墙钟被校时，单调钟不动。
  assert.equal(engine.elapsed(s), first + 2500);
  assert.equal(engine.clock.mono(), time.mono);
  assert.equal(engine.iso(), new Date(time.wall).toISOString());
});

test('语音悬浮窗守护的三十秒复核用单调钟，ISO 时间用墙钟', async () => {
  const { store } = fixture();
  const time = { wall: Date.parse('2026-10-25T08:00:00Z'), mono: 50 };
  const guard = new VoiceOverlayGuard(store, { serial: 'fixture', adb: 'adb', run: async () => 'android:system_alert_window: ignore', clock: { wall: () => time.wall, mono: () => time.mono }, audit: () => {} });
  assert.equal(guard.due(true), true);
  await guard.sync(true);
  assert.equal(guard.status().checked_at, '2026-10-25T08:00:00.000Z');
  time.wall += 3_600_000; assert.equal(guard.due(true), false);
  time.mono += 30000; assert.equal(guard.due(true), true);
});

test('系统时钟：墙钟为毫秒时间戳，单调钟不倒退', () => {
  assert.ok(Math.abs(systemClock.wall() - Date.now()) < 1000);
  const a = systemClock.mono(), b = systemClock.mono();
  assert.ok(b >= a);
});
