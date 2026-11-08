import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { configuration, taskSequence, standard, initial, transition, emptyAnswers, score, marker, view, summary, FIELDS } from '../src/pilot1108/model.ts';
import type { State, Action, Config } from '../src/pilot1108/model.ts';
import { feeFilled, filledState, planSelection } from '../public/pilot1108/rules.js';
import { PilotStore } from '../src/pilot1108/store.ts';
import { createPilotApp } from '../src/pilot1108/app.ts';

const rates1 = { mental: 6, integration: 5, effort: 6, relaxation: 2 };
const rates2 = { mental: 2, integration: 1, effort: 2, relaxation: 6 };
const questionnaire = { phase1: rates1, phase2: rates2 };
function setup(config: Partial<Config> = {}) { return initial('test', 'P01', configuration('P01', config), '2026-11-08T06:00:00.000Z'); }
function act(s: State, action: Action, now = s.elapsed_ms + 100) { return transition(s, action, now).state; }
function fill(s: State, answers = standard(s.trials[s.index].task)): State {
  for (const field of FIELDS) s = act(s, { type: 'input', field, value: answers[field] });
  return s;
}
function finishTrial(s: State): State {
  s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
  assert.equal(s.stage, 'transcribe');
  s = act(fill(s), { type: 'next' });
  if (s.stage === 'ratings') s = act(s, { type: 'ratings', values: questionnaire });
  return s;
}
function formalTranscription() {
  const s = finishTrial(setup({ order: 'feedback-first' }));
  return act(fill(act(s, { type: 'compute' })), { type: 'next' });
}

test('1108r2：练习正文/表格/输入/选项统一四方案，三套材料逐项核算一致', async () => {
  const tasks = taskSequence(configuration('P01'));
  assert.deepEqual(tasks.map(standard), [
    { qualified: 'A、D', A: '1.50', B: '2.10', C: '1.70', D: '1.90' },
    { qualified: 'B、D', A: '17.07', B: '16.97', C: '16.99', D: '16.95' },
    { qualified: 'B、C', A: '17.12', B: '16.98', C: '16.93', D: '16.88' },
  ]);
  assert.ok(tasks.every(t => t.rows.map(r => r.plan).join('') === 'ABCD'));
  const js = await readFile(new URL('../public/pilot1108/pilot.js', import.meta.url), 'utf8');
  assert.match(js, /A、B、C、D 四个方案/); assert.match(js, /inputFields\(v.answers, \['A', 'B', 'C', 'D'\]\)/);
  assert.match(js, /\['A', 'B', 'C', 'D'\].map/); assert.deepEqual(FIELDS, ['qualified', 'A', 'B', 'C', 'D']);
});
test('1108r2：只平衡顺序，材料与条件固定配对；四人分配与显式覆盖', () => {
  assert.deepEqual(['P01', 'P02', 'P03', 'P04', 'P05'].map(p => configuration(p).order), ['no-feedback-first', 'no-feedback-first', 'feedback-first', 'feedback-first', 'no-feedback-first']);
  assert.equal(taskSequence(configuration('P01', { order: 'feedback-first' }))[1].id, 'SH01-feedback');
  assert.throws(() => configuration('tester'), /顺序/);
  assert.equal(configuration('tester', { order: 'feedback-first' }).order, 'feedback-first');
  for (const config of [{ feedback: 'message' }, { source: 'standard' }, { practiceScales: true }, { practiceFeedback: true }]) assert.throws(() => configuration('P01', config as unknown as Partial<Config>));
  const a = setup(); a.trials[0].task.rows[0].base = 99; assert.equal(setup().trials[0].task.rows[0].base, 1.2);
});
test('1108r2：练习无量表无进度，双正式任务完整闭环且每题仅一份任务后问卷', () => {
  let s = setup(); assert.equal(view(s).feedback, null);
  s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
  assert.equal(s.stage, 'transcribe'); assert.equal(view(s).feedback, null);
  s = act(fill(s), { type: 'next' }); assert.equal(s.index, 1); assert.equal(s.trials[0].scale1, null); assert.equal(s.trials[0].scale2, null);
  s = finishTrial(s); assert.equal(s.index, 2); s = finishTrial(s); assert.equal(s.stage, 'done');
  assert.deepEqual(s.trials[1].scale1, rates1); assert.deepEqual(s.trials[2].scale2, rates2);
  assert.throws(() => act(s, { type: 'next' }), /已完成/);
});
test('1108r2：计算到誊写连续进行，同一时刻结束阶段一和开始阶段二，不接受中途评分', () => {
  let s = finishTrial(setup()); s = fill(act(s, { type: 'compute' }));
  assert.throws(() => act(s, { type: 'ratings', values: questionnaire }), /不允许/);
  const result = transition(s, { type: 'next' }, 10000); s = result.state;
  assert.equal(s.stage, 'transcribe'); assert.equal(s.trials[1].step1_end_ms, 10000); assert.equal(s.trials[1].step2_start_ms, 10000);
  assert.ok(result.events.some(e => e.type === 'phase2_started')); assert.ok(result.events.every(e => e.type !== 'questionnaire_opened'));
  assert.throws(() => act(s, { type: 'ratings', values: questionnaire }), /不允许/);
});
test('1108r2：计算页返回要求保留输入与首次打开时间', () => {
  let s = act(setup(), { type: 'compute' }, 200); s = act(s, { type: 'input', field: 'A', value: '1.50' }, 300);
  s = act(s, { type: 'requirements' }, 400); s = act(s, { type: 'compute' }, 500);
  assert.equal(s.trials[0].compute.A, '1.50'); assert.equal(s.trials[0].first_compute_ms, 200);
});
test('1108r2：费用仅合法两位小数算填写，方案至少有一项有效选择；不判正误', () => {
  for (const value of ['16.97', '0.00', '1.50', ' 17.00 ']) assert.equal(feeFilled(value), true, value);
  for (const value of ['', '16.', '16', '16.9', '16.970', '-1.00', '1e2', 'NaN', 'Infinity', '16.9x']) assert.equal(feeFilled(value), false, value);
  for (const value of ['', ',', '， 、', 'E', 'ABX', '<b>A</b>']) assert.equal(planSelection(value), null, value);
  assert.deepEqual(planSelection('d，a'), ['A', 'D']);
  assert.equal(filledState({ ...emptyAnswers(), A: '999.00', qualified: 'B' }).A, true);
});
test('1108r2：T0为A两位小数完整后首次B输入，只是候选，不要求A正确', () => {
  let s = act(setup(), { type: 'compute' });
  s = act(s, { type: 'input', field: 'B', value: '2' }, 200);
  s = act(s, { type: 'input', field: 'A', value: '16.' }, 300);
  s = act(s, { type: 'input', field: 'B', value: '2.1' }, 400); assert.equal(s.trials[0].t0_ms, null);
  s = act(s, { type: 'input', field: 'A', value: '999.00' }, 500);
  const result = transition(s, { type: 'input', field: 'B', value: '2.2' }, 600);
  assert.equal(result.state.trials[0].t0_ms, 600); assert.ok(result.events.some(e => e.type === 't0_behavioral_candidate'));
  s = act(result.state, { type: 'input', field: 'B', value: '2.30' }, 700); assert.equal(s.trials[0].t0_ms, 600);
});
test('1108r2：20秒保留为次级标记，离开计算阶段仍记录上下文且不重复', () => {
  let s = act(setup(), { type: 'compute' }, 100); assert.equal(marker(s, 20099).length, 0);
  s = finishTrial(act(s, { type: 'requirements' }, 200));
  const events = marker(s, 22000); assert.equal(events[0].task_id, 'practice'); assert.equal(s.trials[0].t0_20s_ms, 20100);
  assert.equal(marker(s, 23000).length, 0);
});
test('1108r2：固定誊写本人输入，复制错误不等于客观正确，五项等权', () => {
  let s = act(setup(), { type: 'compute' }); const wrong = { qualified: 'B', A: '0.00', B: '0.00', C: '0.00', D: '0.00' };
  s = act(fill(s, wrong), { type: 'next' }); assert.deepEqual(s.trials[0].source, wrong);
  s = act(fill(s, wrong), { type: 'next' }); const result = summary(s.trials[0]);
  assert.equal(result.phase1_accuracy!.accuracy, 0); assert.equal(result.phase2_objective_accuracy!.accuracy, 0); assert.equal(result.phase2_copy_accuracy!.accuracy, 1);
  const expected = standard(s.trials[0].task); assert.equal(score({ ...expected, A: '0.00' }, expected).accuracy, .8);
});
test('1108r2：进度只在正式有反馈任务的誊写页可见，不在练习或问卷等页显示', () => {
  let s = formalTranscription(); assert.equal(view(s).feedback, 'progress');
  s = act(fill(s), { type: 'next' }); assert.equal(s.stage, 'ratings'); assert.equal(view(s).feedback, null);
  s = act(s, { type: 'ratings', values: questionnaire }); assert.equal(view(s).feedback, null);
  s = act(fill(act(s, { type: 'compute' })), { type: 'next' }); assert.equal(view(s).feedback, null);
  assert.equal(view(setup()).source, null);
});
test('1108r2：双阶段问卷同页，每阶段四项必答1—7，放松感题干按阶段改写', () => {
  let s = formalTranscription(); s = act(fill(s), { type: 'next' }); assert.equal(s.stage, 'ratings');
  assert.equal(view(s).scale_phases.length, 2); assert.ok(view(s).scale_phases.every(p => p.items.length === 4));
  assert.match(view(s).scale_phases[0].items[3].question, /计算和筛选/); assert.match(view(s).scale_phases[1].items[3].question, /记录最终答案/);
  for (const values of [{}, { phase1: rates1 }, { ...questionnaire, phase1: { ...rates1, mental: 0 } }, { ...questionnaire, phase2: { ...rates2, effort: 7.5 } }, { ...questionnaire, extra: {} }]) {
    assert.throws(() => act(s, { type: 'ratings', values } as Action), /两个阶段/);
  }
  s = act(s, { type: 'ratings', values: questionnaire }); assert.deepEqual(s.trials[1].scale1, rates1); assert.deepEqual(s.trials[1].scale2, rates2);
});
test('1108r2：阶段一含读要求，另记计算页用时；任务用时不含任务后问卷', () => {
  let s = act(setup(), { type: 'compute' }, 1000); s = act(fill(s), { type: 'next' }, 10000);
  assert.equal(s.trials[0].step2_start_ms, 10000); s = act(fill(s), { type: 'next' }, 15000);
  const v = summary(s.trials[0]); assert.equal(v.step1_ms, 10000); assert.equal(v.step2_ms, 5000); assert.equal(v.total_active_ms, 15000); assert.equal(v.task_wall_elapsed_ms, 15000); assert.equal(v.compute_from_first_open_ms, 9000);
  let formal = formalTranscription(); formal = act(fill(formal), { type: 'next' }, 20000); const before = summary(formal.trials[1]);
  formal = act(formal, { type: 'ratings', values: questionnaire }, 30000); const after = summary(formal.trials[1]);
  for (const key of ['step1_ms', 'step2_ms', 'total_active_ms', 'task_wall_elapsed_ms', 'compute_from_first_open_ms'] as const) assert.equal(after[key], before[key]);
  assert.deepEqual(after.scale1, rates1); assert.deepEqual(after.scale2, rates2);
});
test('1108r2：格式完成度日志和呈现共用规则，改成半成品或清空立即回退', () => {
  let s = formalTranscription(); let now = 5000;
  for (const [value, count] of [['16.', 0], ['16.9', 0], ['16.97', 1], ['16.9', 0], ['999.00', 1], ['', 0]] as const) {
    const r = transition(s, { type: 'input', field: 'A', value }, now += 100); s = r.state;
    const data = r.events.find(e => e.type === 'completion_feedback_state')!.data as { completed: number; means_correct: boolean };
    assert.equal(data.completed, count); assert.equal(data.means_correct, false);
  }
  s = act(fill(act(setup(), { type: 'compute' })), { type: 'next' });
  assert.ok(transition(s, { type: 'input', field: 'A', value: '1.50' }, now + 100).events.every(e => e.type !== 'completion_feedback_state'));
});
test('1108r2：五个节点按方案/A/B/C/D固定映射，不误把乱序填写变成前缀完成', async () => {
  const { feedbackMarkup } = await import(new URL('../public/pilot1108/feedback.js', import.meta.url).href);
  const blank = feedbackMarkup('progress', emptyAnswers()); assert.match(blank, /填写进度/);
  assert.equal((blank.match(/class="progress-node /g) ?? []).length, 5); assert.equal((blank.match(/node-line /g) ?? []).length, 4);
  assert.doesNotMatch(blank, /progress-node filled/); assert.match(blank, /node-label">方案/);
  const values = { ...emptyAnswers(), C: '16.97', A: '16.', qualified: ',' };
  const html = feedbackMarkup('progress', values);
  assert.match(html, /class="progress-node filled" data-node="C"/); assert.match(html, /class="progress-node " data-node="A"/);
  assert.match(html, /已填写1项，共5项/); assert.equal((html.match(/class="node-line filled"/g) ?? []).length, 3);
  assert.doesNotMatch(feedbackMarkup('progress', { ...values, C: '' }), /progress-node filled/);
  assert.equal(feedbackMarkup('registered', values), ''); assert.doesNotMatch(feedbackMarkup('progress', { ...values, qualified: '<script>' }), /<script>/);
  const css = await readFile(new URL('../public/pilot1108/pilot.css', import.meta.url), 'utf8');
  assert.match(css, /border-radius:50%/); assert.match(css, /background:#2479c9/); assert.match(css, /position:sticky/);
});
test('1108r2：无消息适配器、T1/T2仅候选，作答view不公开判分与标准答案', async () => {
  let s = fill(act(setup(), { type: 'compute' })); let r = transition(s, { type: 'next' }, 5000);
  assert.ok(r.events.some(e => e.type === 't1_candidate')); r = transition(r.state, { type: 'input', field: 'B', value: '2' }, 6000);
  assert.ok(r.events.some(e => e.type === 't2_candidate')); s = r.state;
  assert.doesNotMatch(JSON.stringify(view(s)), /standard_answers|accuracy|correct/);
  const pilot = await readFile(new URL('../src/pilot1108/server.ts', import.meta.url), 'utf8'); assert.doesNotMatch(pilot, /GlassesAdapter|@a5\/glasses/);
  const entry = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8'); assert.match(entry, /@a5\/desktop\/server.ts/);
});
test('1108r2：SQLite幂等命令、旧页拒绝与事务回滚', () => {
  let now = 0; const store = new PilotStore(':memory:', { mono: () => now, wall: () => Date.now() });
  try {
    const v = store.create('P01', {}); now = 1000; const a = { type: 'compute' } as const;
    const response = store.command(v.id, 'command-1', 0, a); assert.deepEqual(store.command(v.id, 'command-1', 0, a), response);
    assert.throws(() => store.command(v.id, 'command-1', 0, { type: 'next' }), /不同操作/); assert.throws(() => store.command(v.id, 'stale', 0, { type: 'next' }), /过期/);
    assert.throws(() => store.command(v.id, 'invalid', 1, { type: 'next' }), /填写/); assert.equal(store.get(v.id).revision, 1);
    assert.equal(store.export(v.id).events.filter(e => e.type === 'compute_opened').length, 1); assert.throws(() => store.create('P01', {}), /已有会话/);
  } finally { store.close(); }
});
test('1108r2：公共Clock隔离墙钟回拨，公共Store乐观锁及追加历史不变', () => {
  let mono = 0, wall = 100000; const store = new PilotStore(':memory:', { mono: () => mono, wall: () => wall });
  try {
    const v = store.create('P01', {}); const stale = store.shared.get(v.id)!;
    mono = 1000; wall = 10000; store.command(v.id, 'clock-1', 0, { type: 'compute' });
    mono = 1500; wall = 2000000; store.command(v.id, 'clock-2', 1, { type: 'input', field: 'A', value: '1.50' });
    mono = 2000; wall = 100; store.command(v.id, 'clock-3', 2, { type: 'input', field: 'B', value: '2' });
    assert.equal(store.get(v.id).trials[0].t0_ms, 2000); assert.throws(() => store.shared.save(stale), /版本冲突/);
    assert.deepEqual(store.shared.stateLog(v.id).map(l => l.version), [0, 1, 2, 3]);
    for (const sql of ["UPDATE session_state_log SET state='bad'", 'DELETE FROM session_state_log', 'DELETE FROM events', "UPDATE events SET data='bad'"]) assert.throws(() => store.db.exec(sql), /append-only/);
    mono = 21000; store.tick(); store.tick(); assert.equal(store.export(v.id).events.filter(e => e.type === 't0_20s_secondary').length, 1); assert.equal(store.get(v.id).revision, 3);
    assert.equal(store.export(v.id).intervention_history.length, 0);
  } finally { store.close(); }
});
test('1108r2：落盘恢复草稿、进度判定、配置和重启时钟不连续证据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-')); let now = 0; const path = join(dir, 'pilot.sqlite');
  let store = new PilotStore(path, { mono: () => now, wall: () => Date.now() });
  try {
    const v = store.create('P03', {}); now = 1000; store.command(v.id, 'c1', 0, { type: 'compute' }); now = 1500;
    store.command(v.id, 'c2', 1, { type: 'input', field: 'A', value: '1.50' }); store.close(); now = 9000;
    store = new PilotStore(path, { mono: () => now, wall: () => Date.now() });
    assert.equal(store.get(v.id).trials[0].compute.A, '1.50'); assert.equal(store.get(v.id).config.order, 'feedback-first');
    now = 10000; store.command(v.id, 'c3', 2, { type: 'input', field: 'B', value: '2' }); assert.equal(store.get(v.id).trials[0].t0_ms, 2500);
    assert.ok(store.export(v.id).events.some(e => e.type === 'server_restarted'));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
test('1108r2：旧版会话不可悄悄混入新版协议，也不改写旧状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-legacy-')); const path = join(dir, 'pilot.sqlite'); const store = new PilotStore(path);
  const v = store.create('P01', {}); const session = store.shared.get(v.id)!;
  (session.state as unknown as { schema_version: number }).schema_version = 1; store.shared.save(session); store.close();
  try { assert.throws(() => new PilotStore(path), /旧版pilot/); } finally { await rm(dir, { recursive: true, force: true }); }
});
test('1108r2：两种顺序的持久化完整会话，双阶段问卷、候选与判分均可导出', () => {
  for (const order of ['no-feedback-first', 'feedback-first'] as const) {
    let now = 0, commands = 0; const store = new PilotStore(':memory:', { mono: () => now, wall: () => 1000000 + now });
    try {
      const v = store.create('P01', { order });
      const send = (action: Action) => { now += 1000; return store.command(v.id, `full-${++commands}`, store.get(v.id).revision, action); };
      for (let trial = 0; trial < 3; trial++) {
        send({ type: 'compute' }); const expected = standard(store.get(v.id).trials[trial].task);
        for (const field of FIELDS) send({ type: 'input', field, value: expected[field] });
        assert.equal(send({ type: 'next' }).stage, 'transcribe');
        for (const field of FIELDS) send({ type: 'input', field, value: expected[field] });
        send({ type: 'next' }); if (trial) send({ type: 'ratings', values: questionnaire });
      }
      now += 30000; store.tick(); const exported = store.export(v.id); assert.equal(exported.state.stage, 'done');
      assert.equal(exported.events.filter(e => e.type === 'questionnaire_opened').length, 2); assert.equal(exported.events.filter(e => e.type === 't0_behavioral_candidate').length, 3);
      assert.equal(exported.events.filter(e => e.type === 't0_20s_secondary').length, 3);
      assert.ok(exported.trials.every(t => t.phase1_accuracy!.accuracy === 1 && t.phase2_copy_accuracy!.accuracy === 1));
      assert.ok(exported.events.filter(e => e.type === 'completion_feedback_state').every(e => e.task_id === 'SH01-feedback'));
      assert.equal(exported.state_history.length, commands + 2); assert.equal(exported.intervention_history.length, 0);
    } finally { store.close(); }
  }
});
test('1108r2：HTTP创建、逐步作答、导出、固定配置拒绝覆盖、跨站拦截及资源', async () => {
  const store = new PilotStore(':memory:'); const server = createPilotApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await (await fetch(base + '/api/health')).json() as { experiment_id: string }; assert.equal(health.experiment_id, 'A5-SH-pilot-1108');
    const html = await (await fetch(base + '/pilot')).text(); const token = html.match(/name="pilot-token" content="([a-f0-9]+)"/)![1]; const headers = { 'X-Pilot-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/sessions')).status, 403); assert.equal((await fetch(base + '/api/sessions', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const response = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ participant: 'P01' }) }); assert.equal(response.status, 201); const v = await response.json() as ReturnType<typeof view>;
    const result = await fetch(base + `/api/sessions/${v.id}/command`, { method: 'POST', headers, body: JSON.stringify({ command_id: 'http-1', revision: 0, action: { type: 'compute' } }) }); assert.equal((await result.json() as ReturnType<typeof view>).stage, 'compute');
    const exported = await fetch(base + `/api/sessions/${v.id}/export`, { headers }); assert.match(exported.headers.get('content-disposition')!, /attachment/);
    const log = await exported.json() as ReturnType<PilotStore['export']>; assert.equal(log.actual_interruption, false); assert.equal(log.state.material_version, 'sh-pilot-2026-11-08-r2');
    for (const path of ['/pilot.js', '/feedback.js', '/rules.js', '/pilot.css']) assert.equal((await fetch(base + path)).status, 200);
    for (const config of [{ unknown: true }, { source: 'standard' }, { feedback: 'message' }, { practiceFeedback: true }]) assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ participant: 'P02', config }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('1108r2：浏览器脚本移除旧配置与中途量表，新增双阶段同页表单', async () => {
  const js = await readFile(new URL('../public/pilot1108/pilot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /name="feedback"|name="source"|name="practiceScales"|name="practiceFeedback"|scale1|scale2/);
  assert.match(js, /v.scale_phases.map/); assert.match(js, /current && current.stage !== 'done' \? ''/);
});
test('1108r2：真实入口启动、健康检查、配置落盘并IPC正常退出', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-server-')); const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string'); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = fork(fileURLToPath(new URL('../src/pilot1108/server.ts', import.meta.url)), [], { env: { ...process.env, PORT: String(port), A5_PILOT_RUNTIME_DIR: dir, A5_PILOT_FEEDBACK: 'progress', A5_PILOT_SOURCE: 'participant', A5_PILOT_PRACTICE_SCALES: 'false', A5_PILOT_PRACTICE_FEEDBACK: 'false', A5_PILOT_ORDER: 'feedback-first' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; child.stdout!.on('data', b => { stdout += b; }); child.stderr!.on('data', b => { stderr += b; });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`服务启动超时：${stdout} ${stderr}`)), 5000); child.stdout!.on('data', () => { if (stdout.includes('11-08材料pilot：')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务提前退出：${code} ${stderr}`)); }); });
    const base = `http://127.0.0.1:${port}`; assert.equal((await fetch(base + '/api/health')).status, 200);
    const html = await (await fetch(base + '/')).text(); const token = html.match(/name="pilot-token" content="([a-f0-9]+)"/)![1];
    const response = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'X-Pilot-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ participant: 'P01' }) }); assert.equal(response.status, 201);
    const v = await response.json() as ReturnType<typeof view>; const exited = once(child, 'exit'); child.send({ type: 'a5:shutdown' }); const [code] = await exited; assert.equal(code, 0, stderr);
    const store = new PilotStore(join(dir, 'pilot.sqlite')); try { assert.equal(store.get(v.id).config.order, 'feedback-first'); assert.equal(store.get(v.id).schema_version, 2); assert.ok(store.export(v.id).state_history.length >= 2); } finally { store.close(); }
  } finally { if (child.exitCode === null && !child.killed) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(dir, { recursive: true, force: true }); }
});
