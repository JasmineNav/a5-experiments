import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { configuration, taskSequence, standard, initial, transition, emptyAnswers, score, marker, view, summary, FIELDS } from '../src/pilot1108/model.ts';
import type { State, Action, Config, Task } from '../src/pilot1108/model.ts';
import { PilotStore } from '../src/pilot1108/store.ts';
import { createPilotApp } from '../src/pilot1108/app.ts';

function setup(config: Partial<Config> = {}) { return initial('test', 'P01', configuration('P01', config), '2026-11-08T06:00:00.000Z'); }
function act(s: State, action: Action, now = s.elapsed_ms + 100) { return transition(s, action, now).state; }
function fill(s: State, answers = standard(s.trials[s.index].task)): State {
  for (const field of FIELDS) s = act(s, { type: 'input', field, value: answers[field] });
  return s;
}
const rates1 = { mental: 6, integration: 5, effort: 6 };
const rates2 = { mental: 2, integration: 1, effort: 2, relaxation: 6 };
function finishTrial(s: State): State {
  s = fill(act(s, { type: 'compute' })); s = act(s, { type: 'next' });
  if (s.stage === 'scale1') s = act(s, { type: 'ratings', values: rates1 });
  s = fill(s); s = act(s, { type: 'next' });
  if (s.stage === 'scale2') s = act(s, { type: 'ratings', values: rates2 });
  return s;
}

test('1108：逐项核算练习和两套SH01的金额、条件与标准答案', () => {
  const tasks = taskSequence(configuration('P01'));
  assert.deepEqual(tasks.map(standard), [
    { qualified: 'A、D', A: '1.50', B: '2.10', C: '1.70', D: '1.90' },
    { qualified: 'B、D', A: '17.07', B: '16.97', C: '16.99', D: '16.95' },
    { qualified: 'B、C', A: '17.12', B: '16.98', C: '16.93', D: '16.88' },
  ]);
  assert.ok(tasks.every(t => t.rows.length === 4));
});
test('1108：四人顺序平衡、显式覆盖、配置校验及快照隔离', () => {
  assert.deepEqual(['P01', 'P02', 'P03', 'P04', 'P05'].map(p => configuration(p).order), ['no-feedback-first', 'no-feedback-first', 'feedback-first', 'feedback-first', 'no-feedback-first']);
  assert.equal(taskSequence(configuration('P01', { order: 'feedback-first' }))[1].id, 'SH01-feedback');
  assert.throws(() => configuration('tester'), /顺序/);
  assert.equal(configuration('tester', { order: 'feedback-first' }).order, 'feedback-first');
  for (const invalid of [{ feedback: 'bad' }, { order: 'bad' }, { source: 'bad' }, { practiceScales: 'true' }]) assert.throws(() => configuration('P01', invalid as Partial<Config>));
  const a = setup(); a.trials[0].task.rows[0].base = 99;
  assert.equal(setup().trials[0].task.rows[0].base, 1.2);
});
test('1108：完整练习＋双任务闭环，默认练习无量表无反馈，阶段量表维度正确', () => {
  let s = setup(); assert.equal(s.trials[0].task.feedback, false);
  s = finishTrial(s); assert.equal(s.index, 1); assert.equal(s.trials[0].scale1, null);
  s = finishTrial(s); assert.equal(s.index, 2);
  s = finishTrial(s); assert.equal(s.stage, 'done');
  assert.deepEqual(s.trials[1].scale1, rates1); assert.deepEqual(s.trials[2].scale2, rates2);
  assert.equal(s.trials[1].task.feedback, false); assert.equal(s.trials[2].task.feedback, true);
  assert.throws(() => act(s, { type: 'next' }), /已完成/);
});
test('1108：练习量表和反馈可以分别开启', () => {
  const s = setup({ practiceScales: true, practiceFeedback: true, feedback: 'registered' });
  assert.equal(view(s).feedback, 'registered');
  const done = finishTrial(s);
  assert.deepEqual(done.trials[0].scale1, rates1); assert.deepEqual(done.trials[0].scale2, rates2);
});
test('1108：要求和计算页面可往返，草稿保留，首次打开时刻不重置', () => {
  let s = act(setup(), { type: 'compute' }, 200);
  s = act(s, { type: 'input', field: 'A', value: '1.5' }, 300);
  s = act(s, { type: 'requirements' }, 400); s = act(s, { type: 'compute' }, 500);
  assert.equal(s.trials[0].compute.A, '1.5'); assert.equal(s.trials[0].first_compute_ms, 200);
});
test('1108：T0行为代理为A有效后首次B输入，只记一次，不要求答案正确', () => {
  let s = act(setup(), { type: 'compute' });
  let r = transition(s, { type: 'input', field: 'B', value: '2' }, 200); assert.equal(r.state.trials[0].t0_ms, null);
  s = act(r.state, { type: 'input', field: 'A', value: 'abc' }, 300);
  s = act(s, { type: 'input', field: 'B', value: '2.1' }, 400); assert.equal(s.trials[0].t0_ms, null);
  s = act(s, { type: 'input', field: 'A', value: '0' }, 500);
  r = transition(s, { type: 'input', field: 'B', value: '2.2' }, 600);
  assert.equal(r.state.trials[0].t0_ms, 600);
  assert.ok(r.events.some(e => e.type === 't0_behavioral_candidate'));
  s = act(r.state, { type: 'input', field: 'B', value: '2.3' }, 700); assert.equal(s.trials[0].t0_ms, 600);
});
test('1108：20秒次级标记按首次打开计算，任务提前结束或换阶段仍可记录', () => {
  let s = act(setup(), { type: 'compute' }, 100);
  assert.equal(marker(s, 20099).length, 0);
  s = finishTrial(s.stage === 'compute' ? act(s, { type: 'requirements' }, 200) : s);
  assert.equal(s.index, 1);
  const events = marker(s, 22000);
  assert.equal(events[0].task_id, 'practice'); assert.equal(s.trials[0].t0_20s_ms, 20100);
  assert.equal(marker(s, 23000).length, 0);
});
test('1108：誊写来源默认被试输入，可选标准答案；两种正确率分开', () => {
  let s = act(setup(), { type: 'compute' });
  const wrong = { qualified: 'B', A: '0', B: '0', C: '0', D: '0' };
  s = act(fill(s, wrong), { type: 'next' }); assert.deepEqual(s.trials[0].source, wrong);
  s = act(fill(s, wrong), { type: 'next' });
  const result = summary(s.trials[0]);
  assert.equal(result.phase1_accuracy!.accuracy, 0); assert.equal(result.phase2_objective_accuracy!.accuracy, 0); assert.equal(result.phase2_copy_accuracy!.accuracy, 1);
  let canonical = act(setup({ source: 'standard' }), { type: 'compute' });
  canonical = act(fill(canonical, wrong), { type: 'next' });
  assert.deepEqual(canonical.trials[0].source, standard(canonical.trials[0].task));
});
test('1108：公开视图没有标准答案、判分或未到阶段的誊写来源', () => {
  const s = act(setup(), { type: 'compute' }); const v = JSON.stringify(view(s));
  assert.doesNotMatch(v, /standard_answers|accuracy|correct|scale1|t0_ms/); assert.equal(view(s).source, null);
});
test('1108：费用、方案输入规范；错误但格式完整的答案不阻止提交', () => {
  let s = act(setup(), { type: 'compute' });
  assert.throws(() => act(s, { type: 'next' }), /填写/);
  assert.throws(() => act(s, { type: 'input', field: 'X', value: 'a' } as unknown as Action), /字段/);
  s = fill(s, { qualified: 'C', A: '0', B: '0', C: '0', D: '0' });
  assert.equal(act(s, { type: 'next' }).stage, 'transcribe');
  const expected = standard(s.trials[0].task);
  assert.equal(score({ ...expected, qualified: 'd，a', A: '1.5' }, expected).accuracy, 1);
  assert.equal(score({ ...expected, qualified: 'ABCDX' }, expected).correct, 4);
});
test('1108：阶段量表必答1—7；第一阶段不提问誊写放松感', () => {
  let s = setup({ practiceScales: true }); s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
  assert.equal(s.stage, 'scale1'); assert.equal(view(s).scale_items.length, 3);
  for (const values of [{}, { ...rates1, mental: 0 }, { ...rates1, effort: 7.5 }, { ...rates1, effort: 8 }, { ...rates1, relaxation: 2 }]) assert.throws(() => act(s, { type: 'ratings', values }));
  s = act(s, { type: 'ratings', values: rates1 }); s = act(fill(s), { type: 'next' });
  assert.equal(s.stage, 'scale2'); assert.equal(view(s).scale_items.length, 4);
  assert.throws(() => act(s, { type: 'ratings', values: rates1 }));
});
test('1108：两阶段用时、总操作用时与量表耗时严格区分', () => {
  let s = act(setup({ practiceScales: true }), { type: 'compute' }, 1000);
  s = act(fill(s), { type: 'next' }, 10000);
  s = act(s, { type: 'ratings', values: rates1 }, 20000);
  s = act(fill(s), { type: 'next' }, 25000);
  const v = summary(s.trials[0]);
  assert.equal(v.step1_ms, 10000); assert.equal(v.step2_ms, 5000); assert.equal(v.total_active_ms, 15000); assert.equal(v.task_wall_elapsed_ms, 25000); assert.equal(v.compute_from_first_open_ms, 9000);
});
test('1108：反馈日志只表示填写，清空回退；无反馈组完全不发完成反馈事件', () => {
  let s = setup({ practiceFeedback: true }); s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
  let r = transition(s, { type: 'input', field: 'A', value: '999' }, 3000);
  let data = r.events.find(e => e.type === 'completion_feedback_state')!.data as { completed: number; means_correct: boolean };
  assert.equal(data.completed, 1); assert.equal(data.means_correct, false);
  r = transition(r.state, { type: 'input', field: 'A', value: '' }, 3100);
  data = r.events.find(e => e.type === 'completion_feedback_state')!.data as typeof data; assert.equal(data.completed, 0);
  s = act(fill(act(setup(), { type: 'compute' })), { type: 'next' });
  assert.ok(transition(s, { type: 'input', field: 'A', value: '1' }, 3000).events.every(e => e.type !== 'completion_feedback_state'));
});
test('1108：T1和T2只记录候选事件，本轮所有事件不发送消息', () => {
  let s = act(setup(), { type: 'compute' }); s = fill(s);
  let r = transition(s, { type: 'next' }, 5000); assert.ok(r.events.some(e => e.type === 't1_candidate'));
  r = transition(r.state, { type: 'input', field: 'B', value: '2' }, 6000); assert.ok(r.events.some(e => e.type === 't2_candidate'));
  r = transition(r.state, { type: 'input', field: 'B', value: '2.1' }, 6100); assert.ok(r.events.every(e => e.type !== 't2_candidate'));
});
test('1108：SQLite命令幂等、旧页拒绝、失败回滚、事件不可更改', () => {
  let now = 0; const store = new PilotStore(':memory:', () => now);
  try {
    const v = store.create('P01', {}); now = 1000;
    const a = { type: 'compute' } as const;
    const response = store.command(v.id, 'command-1', 0, a);
    assert.deepEqual(store.command(v.id, 'command-1', 0, a), response);
    assert.throws(() => store.command(v.id, 'command-1', 0, { type: 'next' }), /不同操作/);
    assert.throws(() => store.command(v.id, 'stale', 0, { type: 'next' }), /过期/);
    assert.throws(() => store.command(v.id, 'invalid', 1, { type: 'next' }), /填写/);
    assert.equal(store.get(v.id).revision, 1);
    assert.equal(store.export(v.id).events.filter(e => e.type === 'compute_opened').length, 1);
    assert.throws(() => store.db.exec("UPDATE events SET received_at='bad'"), /事件只允许追加/);
    assert.throws(() => store.db.exec('DELETE FROM events'), /事件只允许追加/);
    assert.throws(() => store.create('P01', {}), /已有会话/);
  } finally { store.close(); }
});
test('1108：落盘恢复包含草稿、配置、时刻和重启不连续证据，不重发事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-')); let now = 0;
  const path = join(dir, 'pilot.sqlite'); let store = new PilotStore(path, () => now);
  try {
    const v = store.create('P03', { feedback: 'message' }); now = 1000;
    store.command(v.id, 'c1', 0, { type: 'compute' }); now = 1500;
    store.command(v.id, 'c2', 1, { type: 'input', field: 'A', value: '1.50' });
    store.close(); now = 9000; store = new PilotStore(path, () => now);
    assert.equal(store.get(v.id).trials[0].compute.A, '1.50'); assert.equal(store.get(v.id).config.order, 'feedback-first');
    now = 10000; store.command(v.id, 'c3', 2, { type: 'input', field: 'B', value: '2' });
    assert.equal(store.get(v.id).trials[0].t0_ms, 2500);
    const events = store.export(v.id).events;
    assert.ok(events.some(e => e.type === 'server_restarted')); assert.equal(events.filter(e => e.type === 'compute_opened').length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
test('1108：三种实际反馈HTML、错误数值不判分、清空回退及HTML转义', async () => {
  const { feedbackMarkup } = await import(new URL('../public/pilot1108/feedback.js', import.meta.url).href);
  const a = { ...emptyAnswers(), A: '999', qualified: '<img onerror=alert(1)>' };
  const bar = feedbackMarkup('progress', a);
  assert.match(bar, /aria-valuenow="2"/); assert.equal((bar.match(/segment filled/g) ?? []).length, 2);
  assert.match(feedbackMarkup('progress', emptyAnswers()), /aria-valuenow="0"/);
  const green = feedbackMarkup('registered', a);
  assert.match(green, /&lt;img/); assert.doesNotMatch(green, /<img/); assert.match(green, /✓ A方案总费用：999/);
  assert.match(feedbackMarkup('message', a), /A方案总费用已完成/);
  assert.doesNotMatch(feedbackMarkup('message', emptyAnswers()), /A方案总费用已完成/);
  assert.match(bar, /不表示答案正确/);
});
test('1108：HTTP创建、逐步作答、导出、跨站拦截、页面及静态资源', async () => {
  const store = new PilotStore(':memory:'); const server = createPilotApp(store, { feedback: 'registered' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await (await fetch(base + '/api/health')).json() as { experiment_id: string }; assert.equal(health.experiment_id, 'A5-SH-pilot-1108');
    const html = await (await fetch(base + '/pilot')).text(); const token = html.match(/name="pilot-token" content="([a-f0-9]+)"/)![1];
    const headers = { 'X-Pilot-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/sessions')).status, 403);
    assert.equal((await fetch(base + '/api/sessions', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const response = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ participant: 'P01' }) });
    assert.equal(response.status, 201); const v = await response.json() as ReturnType<typeof view>;
    assert.equal(store.get(v.id).config.feedback, 'registered');
    const result = await fetch(base + `/api/sessions/${v.id}/command`, { method: 'POST', headers, body: JSON.stringify({ command_id: 'http-1', revision: 0, action: { type: 'compute' } }) });
    assert.equal((await result.json() as ReturnType<typeof view>).stage, 'compute');
    const exported = await fetch(base + `/api/sessions/${v.id}/export`, { headers });
    assert.match(exported.headers.get('content-disposition')!, /attachment/);
    const log = await exported.json() as ReturnType<PilotStore['export']>; assert.equal(log.actual_interruption, false); assert.equal(log.state.material_version, 'sh-pilot-2026-11-08'); assert.ok(log.events.every((e: { server_received_at: string }) => e.server_received_at.endsWith('Z')));
    for (const path of ['/pilot.js', '/feedback.js', '/pilot.css']) assert.equal((await fetch(base + path)).status, 200);
    assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ participant: 'P02', config: { unknown: true } }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('1108：独立模式不加载适配器，不改变原启动入口；无逐项保存提示干扰', async () => {
  const entry = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(entry, /@a5\/desktop\/server.ts/);
  const pilot = await readFile(new URL('../src/pilot1108/server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(pilot, /GlassesAdapter|@a5\/glasses|@a5\/desktop/);
  const js = await readFile(new URL('../public/pilot1108/pilot.js', import.meta.url), 'utf8');
  assert.match(js, /current && current.stage !== 'done' \? ''/);
});
