import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, StateConflictError } from '@a5/desktop/store.ts';
import type { Intervention } from '@a5/desktop/store.ts';
import { Engine } from '@a5/desktop/engine.ts';
import { loadMaterial } from '@a5/desktop/tasks.ts';
import { testConfig } from './fixtures.ts';
import { MockGlassesAdapter } from '@a5/glasses/adapters/mock-glasses.ts';

const material = await loadMaterial();
const config = await testConfig();

function fixture(path = ':memory:') {
  const time = { wall: Date.parse('2026-10-25T08:00:00Z'), mono: 1000 };
  const clock = { wall: () => time.wall, mono: () => time.mono };
  const store = new Store(path), engine = new Engine(store, new MockGlassesAdapter(), material, config, clock);
  const id = engine.create('001').session_id;
  return { store, engine, id, time };
}
const message = (id: string, patch: Partial<Intervention> = {}): Intervention => ({
  session_id: id, stage_id: 'S1', participant_id: '001', message_id: 'm1', condition: 'T0', request_id: 'req-1', status: 'scheduled', source: 'mock', duration_ms: 11000,
  t_event: '2026-10-25T08:00:00.000Z', event_elapsed_ms: 5, t_send: null, t_ack: null, t_display: null, t_hide: null, display_time_source: 'none', receipt: null, error: null, ...patch });

test('会话状态乐观锁：过期副本保存时报冲突而不是静默覆盖', () => {
  const { store, id } = fixture();
  const a = store.get(id)!, b = store.get(id)!;
  const base = a.version!;
  a.state.attention.push('from-a'); store.save(a);
  assert.equal(a.version, base + 1);
  b.state.attention.push('from-b');
  assert.throws(() => store.save(b), (error: unknown) => error instanceof StateConflictError && error.session_id === id && error.expected_version === base);
  const latest = store.get(id)!;
  assert.deepEqual(latest.state.attention, ['from-a']);
  assert.equal(latest.version, base + 1);
  // 冲突后重新读取即可继续保存。
  const fresh = store.get(id)!; fresh.state.attention.push('from-b'); store.save(fresh);
  assert.deepEqual(store.get(id)!.state.attention, ['from-a', 'from-b']);
});

test('每次保存追加一条状态日志，可按版本重建；事务回滚时版本与日志一并回滚', () => {
  const { store, id } = fixture();
  const s = store.get(id)!, base = s.version!;
  s.state.attention.push('one'); store.save(s);
  s.state.attention.push('two'); store.save(s);
  const log = store.stateLog(id);
  assert.deepEqual(log.slice(-3).map(entry => entry.version), [base, base + 1, base + 2]);
  assert.deepEqual(log.at(-3)!.state.attention, []);
  assert.deepEqual(log.at(-1)!.state, store.get(id)!.state);
  const t = store.get(id)!;
  assert.throws(() => store.tx(() => { t.state.attention.push('rolled-back'); store.save(t); throw new Error('boom'); }), /boom/);
  assert.equal(store.get(id)!.version, base + 2);
  assert.equal(store.stateLog(id).length, log.length);
  assert.throws(() => store.db.prepare('UPDATE session_state_log SET state=?').run('{}'), /append-only/);
  assert.throws(() => store.db.prepare('DELETE FROM session_state_log').run(), /append-only/);
});

test('tx 可嵌套：内层 save 并入外层事务，外层失败整体回滚', () => {
  const { store, id } = fixture();
  const s = store.get(id)!, base = s.version!;
  assert.throws(() => store.tx(() => { store.tx(() => { s.state.attention.push('x'); store.save(s); }); throw new Error('outer'); }), /outer/);
  assert.equal(store.get(id)!.version, base);
  assert.deepEqual(store.get(id)!.state.attention, []);
});

test('interventions 只追加：原始发送意图保留，对外读取到最新合并结果', () => {
  const { store, id } = fixture();
  store.intervention(message(id));
  store.intervention(message(id, { status: 'send_requested', t_send: '2026-10-25T08:00:01.000Z' }));
  store.intervention(message(id, { status: 'sent', t_send: '2026-10-25T08:00:01.000Z', t_ack: '2026-10-25T08:00:02.000Z', receipt: { ok: true } }));
  const history = store.interventionHistory(id, 'S1');
  assert.deepEqual(history.map(m => m.status), ['scheduled', 'send_requested', 'sent']);
  assert.equal(history[0].t_send, null);
  assert.equal(history[0].receipt, null);
  assert.equal(store.interventions(id).length, 1);
  assert.equal(store.interventions(id)[0].status, 'sent');
  assert.equal(store.findRequest('req-1')!.status, 'sent');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM interventions').get()!.n, 1);
  assert.throws(() => store.db.prepare('UPDATE intervention_history SET data=?').run('{}'), /append-only/);
  assert.throws(() => store.db.prepare('DELETE FROM intervention_history').run(), /append-only/);
});

test('同一 request_id 不能写入其他阶段', () => {
  const { store, id } = fixture();
  store.intervention(message(id));
  assert.throws(() => store.intervention(message(id, { stage_id: 'S2' })), /request_id/);
});

test('旧库迁移：补 version 与状态日志基线，interventions 旧表保留并迁入历史', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-migrate-'));
  try {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE interventions(session_id TEXT NOT NULL REFERENCES sessions(id), stage_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,stage_id));
      CREATE UNIQUE INDEX intervention_request ON interventions(json_extract(data,'$.request_id'));`);
    old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('s-old', 'h', JSON.stringify({ attention: [], status: 'active' }), '{}');
    old.prepare('INSERT INTO interventions VALUES (?,?,?)').run('s-old', 'S1', JSON.stringify(message('s-old', { status: 'sent' })));
    old.close();
    const store = new Store(path);
    const session = store.get('s-old')!;
    assert.equal(session.version, 0);
    assert.equal(store.stateLog('s-old').length, 1);
    store.save(session);
    assert.equal(store.get('s-old')!.version, 1);
    assert.equal(store.interventions('s-old')[0].status, 'sent');
    assert.equal(store.interventionHistory('s-old', 'S1').length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM interventions_legacy').get()!.n, 1);
    store.close();
    // 重复打开幂等，不重复迁移。
    const again = new Store(path);
    assert.equal(again.interventionHistory('s-old', 'S1').length, 1);
    assert.equal(again.stateLog('s-old').length, 2);
    again.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

