import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { configuration, taskSequence, standard, initial, transition, emptyAnswers, score, marker, view, summary, FIELDS, PRACTICE, NO_FEEDBACK, WITH_FEEDBACK } from '../src/pilot1108/model.ts';
import type { State, Action, Config } from '../src/pilot1108/model.ts';
import { feeFilled, filledState, planSelection, taskProgress } from '../public/pilot1108/rules.js';
import { PilotStore } from '../src/pilot1108/store.ts';
import { createPilotApp } from '../src/pilot1108/app.ts';

const rates1 = { mental: 6, integration: 5, effort: 6, relaxation: 2 };
const rates2 = { mental: 2, integration: 1, effort: 2, relaxation: 6 };
const questionnaire = { phase1: rates1, phase2: rates2 };
function setup(config: Partial<Config> = {}) {
  const state = initial('test', 'P01', configuration('P01', config), '2026-11-08T06:00:00.000Z');
  // 既有R2—R5用例继续验证历史快照语义；R6行为另用当前配置直接构造。
  for (const t of state.trials) {
    delete t.task.presentation; delete t.task.completionFeedback; delete t.task.submissionPage;
    delete t.task.taskProgress;
    delete t.task.taskHeader;
    if (t.task.practice) { delete t.task.scratchpad; delete t.task.requirements; delete t.task.confirmationTitle; }
  }
  return state;
}
function act(s: State, action: Action, now = s.elapsed_ms + 100) {
  // 既有计算/评分用例先按真实流程经过情景页；独立场景测试直接调用transition检查门槛。
  if (s.stage === 'scenario' && action.type === 'compute') s = transition(s, { type: 'requirements' }, now).state;
  const next = transition(s, action, now).state;
  if (next.stage === 'loading' && action.type === 'next') return transition(next, { type: 'transcribe' }, next.trials[next.index].transcription_due_ms!).state;
  return next;
}
function fill(s: State, answers = standard(s.trials[s.index].task)): State {
  for (const field of FIELDS) s = act(s, { type: 'input', field, value: answers[field] });
  return s;
}
function finishTrial(s: State): State {
  s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
  assert.equal(s.stage, 'transcribe');
  s = act(fill(s), { type: 'next' });
  if (s.stage === 'submitted' && s.trials[s.index].task.practice) s = act(s, { type: 'continue' });
  if (s.stage === 'ratings') s = act(s, { type: 'ratings', values: questionnaire });
  return s;
}
function formalTranscription() {
  const s = finishTrial(setup({ order: 'feedback-first' }));
  return act(fill(act(s, { type: 'compute' })), { type: 'next' });
}

test('1108r3：三场执行费与三个月维护费按截图逐项核算，练习仍按一次计算', async () => {
  const tasks = taskSequence(configuration('P01'));
  assert.deepEqual(tasks.map(standard), [
    { qualified: 'A、D', A: '1.50', B: '2.10', C: '1.70', D: '1.90' },
    { qualified: 'B、D', A: '17.04', B: '16.97', C: '16.99', D: '16.95' },
    { qualified: 'B、C', A: '17.12', B: '16.98', C: '16.93', D: '16.88' },
  ]);
  assert.ok(tasks.every(t => t.rows.map(r => r.plan).join('') === 'ABCD'));
  const js = await readFile(new URL('../public/pilot1108/pilot.js', import.meta.url), 'utf8');
  assert.match(js, /A、B、C、D 四个方案/); assert.match(js, /inputFields\(v.answers, \['A', 'B', 'C', 'D'\]\)/);
  assert.match(js, /\['A', 'B', 'C', 'D'\].map/); assert.deepEqual(FIELDS, ['qualified', 'A', 'B', 'C', 'D']);
});

test('1108r3：练习材料不变，正式任务背景、表头、数值与倍数一致', () => {
  const { presentation, scratchpad, confirmationTitle, requirements, taskProgress, submissionPage, taskHeader, ...practiceMaterial } = PRACTICE;
  assert.deepEqual(practiceMaterial, {
    id: 'practice', title: '展台布置方案（练习）', practice: true, feedback: false,
    maxCost: 2, maxDays: 5, minPeople: 16,
    rows: [
      { plan: 'A', base: 1.2, extra: .3, days: 4, people: 20 },
      { plan: 'B', base: 1.8, extra: .3, days: 4, people: 18 },
      { plan: 'C', base: 1.3, extra: .4, days: 4, people: 14 },
      { plan: 'D', base: 1.4, extra: .5, days: 5, people: 16 },
    ],
  });
  for (const task of [NO_FEEDBACK, WITH_FEEDBACK]) {
    assert.equal(task.extraMultiplier, 3); assert.equal(task.scratchpad, true);
    const expected = standard(task);
    for (const r of task.rows) assert.equal(expected[r.plan], ((Math.round(r.base * 100) + Math.round(r.extra * 100) * 3) / 100).toFixed(2));
  }
  assert.match(NO_FEEDBACK.requirements!.cost, /单场执行费×3/);
  assert.match(WITH_FEEDBACK.requirements!.context, /租期为3个月/);
  assert.match(WITH_FEEDBACK.requirements!.cost, /每月维护费×3/);
  assert.equal(WITH_FEEDBACK.tableHeaders![2], '设备交付时间（天）');
});

test('1108r3：草稿本仅限正式计算页，不作为答案或触发T0/T2，返回要求后保留', () => {
  assert.throws(() => act(act(setup(), { type: 'compute' }), { type: 'scratchpad', value: '练习草稿' }), /不允许/);
  let s = act(finishTrial(setup()), { type: 'compute' });
  const answers = structuredClone(s.trials[1].compute);
  const result = transition(s, { type: 'scratchpad', value: 'A：13.17 + 1.29 × 3\n=17.04' }, 5000); s = result.state;
  assert.deepEqual(s.trials[1].compute, answers); assert.equal(s.trials[1].t0_ms, null); assert.equal(s.trials[1].t2_ms, null);
  assert.deepEqual(result.events.map(e => e.type), ['scratchpad_changed']);
  assert.deepEqual(result.events[0].data, { value: 'A：13.17 + 1.29 × 3\n=17.04' }); // R11起不再重复记录前值。
  s = act(s, { type: 'requirements' }); s = act(s, { type: 'compute' });
  assert.equal(view(s).scratchpad, 'A：13.17 + 1.29 × 3\n=17.04');
  assert.throws(() => act(s, { type: 'scratchpad', value: 'x'.repeat(5001) }), /5000/);
  s = act(fill(s), { type: 'next' }); assert.throws(() => act(s, { type: 'scratchpad', value: '不可改' }), /不允许/);
  assert.equal(summary(s.trials[1]).scratchpad, 'A：13.17 + 1.29 × 3\n=17.04');
  s = act(fill(s), { type: 'next' }); s = act(s, { type: 'ratings', values: questionnaire });
  assert.equal(view(s).scratchpad, '');
});

test('1108r3：草稿本幂等保存、持久化恢复及导出，不影响评分与下一步必答', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-notes-')); const path = join(dir, 'pilot.sqlite');
  let now = 0; const clock = { mono: () => now, wall: () => 100000 + now };
  let store = new PilotStore(path, clock); const created = store.create('P01', {});
  let commands = 0;
  const send = (action: Action) => store.command(created.id, `notes-${++commands}`, store.get(created.id).revision, action);
  try {
    send({ type: 'compute' }); for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    send({ type: 'next' }); for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    send({ type: 'next' }); send({ type: 'continue' }); send({ type: 'requirements' }); send({ type: 'compute' });
    const revision = store.get(created.id).revision, action = { type: 'scratchpad', value: '<b>13.17＋1.29×3</b>\n17.04' } as const;
    const saved = store.command(created.id, 'notes-save', revision, action);
    assert.deepEqual(store.command(created.id, 'notes-save', revision, action), saved);
    store.close(); store = new PilotStore(path, clock);
    assert.equal(view(store.get(created.id)).scratchpad, action.value);
    for (const field of FIELDS) send({ type: 'input', field, value: standard(NO_FEEDBACK)[field] });
    send({ type: 'next' }); now += 2000; send({ type: 'transcribe' });
    for (const field of FIELDS) send({ type: 'input', field, value: standard(NO_FEEDBACK)[field] });
    send({ type: 'next' });
    const log = store.export(created.id);
    assert.equal(log.events.filter(e => e.type === 'scratchpad_changed').length, 1);
    assert.equal(log.trials[1].scratchpad, action.value); assert.equal(log.trials[1].phase1_accuracy!.accuracy, 1);
    assert.equal(log.trials[1].phase2_copy_accuracy!.accuracy, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('1108r3：旧快照未声明倍数与草稿时仍按旧公式计分，不替换历史材料', () => {
  const oldTask = { ...NO_FEEDBACK, rows: [
    { plan: 'A' as const, base: 14.68, extra: 2.39, days: 9, people: 28 },
    ...NO_FEEDBACK.rows.slice(1),
  ] };
  delete oldTask.extraMultiplier; delete oldTask.scratchpad; delete oldTask.requirements; delete oldTask.tableHeaders; delete oldTask.scenarioPage; delete oldTask.transcriptionDelayMs;
  assert.equal(standard(oldTask).A, '17.07');
  let s = finishTrial(setup()); s.material_version = 'sh-pilot-2026-11-08-r2'; s.trials[1].task = oldTask; s.stage = 'requirements';
  s = act(s, { type: 'compute' }); assert.equal(view(s).task.extraMultiplier, undefined);
  assert.equal(Object.hasOwn(view(s), 'scratchpad'), false);
  assert.throws(() => act(s, { type: 'scratchpad', value: '旧会话不引入新功能' }), /不允许/);
});
test('1108r11：计算页最多45%，点下一步进入加载/转录才到50%点亮「完成筛选」；R8—R10旧快照保留10%计法', () => {
  const answers = emptyAnswers();
  answers.D = '999.00'; assert.equal(taskProgress('compute', answers, 'substeps-v2').value, 9);
  Object.assign(answers, { A: '0.00', B: '1.50', C: '0.00', qualified: 'B' });
  assert.equal(taskProgress('compute', answers, 'substeps-v2').value, 45);
  assert.equal(taskProgress('requirements', answers, 'substeps-v2').value, 45);
  assert.ok(taskProgress('compute', answers, 'substeps-v2').value < 50);
  assert.equal(taskProgress('loading', emptyAnswers(), 'substeps-v2').value, 50);
  assert.equal(taskProgress('transcribe', emptyAnswers(), 'substeps-v2').value, 50);
  assert.equal(taskProgress('transcribe', answers, 'substeps-v2').value, 50 + 5 * 50 / 6);
  assert.equal(taskProgress('submitted', answers, 'substeps-v2').value, 100);
  assert.equal(taskProgress('compute', answers, 'substeps-v2').mode, 'substeps-v2');
  assert.equal(taskProgress('compute', answers).value, 50); assert.equal(taskProgress('compute', answers).mode, 'substeps-v1');
});

test('1108r11：浏览器草稿本防抖保存，下一步、返回要求、回设置页、切后台和离开页面前补存', async () => {
  const js = await readFile(new URL('../public/pilot1108/pilot.js', import.meta.url), 'utf8');
  assert.match(js, /SCRATCHPAD_DEBOUNCE_MS = 500/);
  assert.doesNotMatch(js, /addEventListener\('input', \(\) => command\(\{ type: 'scratchpad'/);
  assert.match(js, /setTimeout\(flushScratchpad, SCRATCHPAD_DEBOUNCE_MS\)/);
  assert.match(js, /function go\(action\) \{\n  flushScratchpad\(\);/); // 下一步与返回要求均经 go()。
  assert.match(js, /visibilityState === 'hidden'\) flushScratchpad\(\)/);
  assert.match(js, /'pagehide', \(\) => flushScratchpad\(\{ leaving: true \}\)/);
  assert.match(js, /keepalive: true/);
  assert.match(js, /保存完成，再回设置页；不删除、结束或重置会话。\n  flushScratchpad\(\);/);
  assert.equal(js.match(/bindScratchpad\(\);/g)!.length, 2); // 两套计算页渲染共用同一机制。
});

test('1108r11：含previous的旧草稿事件仍可导出读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-oldnotes-')); const path = join(dir, 'pilot.sqlite');
  let store = new PilotStore(path); const created = store.create('P01', {});
  try {
    store.shared.event({ event_id: 'old-notes', session_id: created.id, participant_id: 'P01', stage_id: 'SH01-feedback', unit_id: 'compute',
      condition: 'task-progress', event_type: 'scratchpad_changed', elapsed_ms: 1, timestamp_iso: '2026-11-09T06:00:00.000Z',
      payload: { previous: '旧', value: '旧草稿' }, content_version: 'sh-pilot-2026-11-09-r10', data_kind: 'pilot1108' });
    store.close(); store = new PilotStore(path);
    const old = store.export(created.id).events.find(e => e.type === 'scratchpad_changed')!;
    assert.deepEqual(old.data, { previous: '旧', value: '旧草稿' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('1108r2：只平衡顺序，材料与条件固定配对；四人分配与显式覆盖', () => {
  assert.deepEqual(['P01', 'P02', 'P03', 'P04', 'P05'].map(p => configuration(p).order), ['no-feedback-first', 'no-feedback-first', 'feedback-first', 'feedback-first', 'no-feedback-first']);
  assert.equal(taskSequence(configuration('P01', { order: 'feedback-first' }))[1].id, 'SH01-feedback');
  assert.throws(() => configuration('tester'), /顺序/);
  assert.equal(configuration('tester', { order: 'feedback-first' }).order, 'feedback-first');
  for (const config of [{ feedback: 'message' }, { source: 'standard' }, { practiceScales: true }, { practiceFeedback: true }]) assert.throws(() => configuration('P01', config as unknown as Partial<Config>));
  const a = setup(); a.trials[0].task.rows[0].base = 99; assert.equal(setup().trials[0].task.rows[0].base, 1.2);
});

test('1108r4：两个正式任务先情景后要求，不允许跳过情景直接计算，练习不增加页面', () => {
  for (const order of ['no-feedback-first', 'feedback-first'] as const) {
    assert.equal(setup({ order }).stage, 'requirements');
    let s = finishTrial(setup({ order }));
    for (let trial = 1; trial <= 2; trial++) {
      assert.equal(s.stage, 'scenario'); assert.equal(s.trials[trial].requirements_started_ms, null);
      assert.throws(() => transition(s, { type: 'compute' }, s.elapsed_ms + 100), /不允许/);
      const start = s.trials[trial].started_ms;
      const result = transition(s, { type: 'requirements' }, start + 2500); s = result.state;
      assert.equal(s.stage, 'requirements'); assert.equal(result.events[0].type, 'requirements_opened');
      assert.equal(result.events[0].task_id, s.trials[trial].task.id);
      assert.equal(summary(s.trials[trial]).scenario_reading_ms, 2500);
      s = act(s, { type: 'compute' }); s = act(s, { type: 'requirements' });
      assert.equal(s.trials[trial].requirements_started_ms, start + 2500);
      s = finishTrial(s);
    }
    assert.equal(s.stage, 'done');
  }
});

test('1108r4：软删除保留事件/快照/作答，拒绝旧页写入，允许重用编号并保护恢复冲突', () => {
  let now = 0; const store = new PilotStore(':memory:', { mono: () => now, wall: () => 100000 + now });
  try {
    const v = store.create('P01', {}); store.command(v.id, 'before-delete', 0, { type: 'compute' });
    store.command(v.id, 'draft-answer', 1, { type: 'input', field: 'A', value: '1.50' });
    const snapshot = JSON.stringify(store.shared.get(v.id)!.snapshot), events = store.export(v.id).events;
    now = 1000; store.delete(v.id); store.delete(v.id);
    assert.equal(store.list().length, 0); assert.equal(store.list(true).length, 1);
    assert.equal(store.export(v.id).events.filter(e => e.type === 'session_deleted').length, 1);
    assert.deepEqual(store.export(v.id).events.slice(0, events.length), events);
    assert.equal(JSON.stringify(store.shared.get(v.id)!.snapshot), snapshot);
    assert.throws(() => store.get(v.id), /已删除/);
    assert.throws(() => store.command(v.id, 'before-delete', 0, { type: 'compute' }), /已删除/);
    const replacement = store.create('P01', {});
    assert.throws(() => store.restore(v.id), /另一条/);
    store.delete(replacement.id); now = 50000; store.restore(v.id);
    assert.equal(store.get(v.id).trials[0].compute.A, '1.50'); assert.equal(store.get(v.id).elapsed_ms, 1000);
    now = 51000; store.tick(); assert.equal(store.get(v.id).elapsed_ms, 2000);
    assert.equal(store.list().length, 1); assert.equal(store.list(true).length, 1);
    assert.equal(store.export(v.id).events.filter(e => e.type === 'session_restored').length, 1);
    assert.throws(() => store.db.exec('DELETE FROM events'), /append-only/);
  } finally { store.close(); }
});

test('1108r4：首页删除和恢复HTTP接口需令牌，删除记录仍能导出', async () => {
  const store = new PilotStore(':memory:'); const v = store.create('P01', {}); const server = createPilotApp(store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const html = await (await fetch(base + '/admin')).text(); const token = html.match(/name="pilot-token" content="([a-f0-9]+)"/)![1];
    const headers = { 'X-Pilot-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/sessions/' + v.id, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(base + '/api/sessions/' + v.id, { method: 'DELETE', headers })).status, 200);
    const list = await (await fetch(base + '/api/sessions', { headers })).json() as { sessions: unknown[]; deleted_sessions: unknown[] };
    assert.equal(list.sessions.length, 0); assert.equal(list.deleted_sessions.length, 1);
    assert.equal((await fetch(base + '/api/sessions/' + v.id + '/export', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/sessions/' + v.id + '/restore', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(store.get(v.id).participant, 'P01');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
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
test('1108r2：旧快照计算到誊写连续进行，同一时刻结束阶段一和开始阶段二，不接受中途评分', () => {
  let s = finishTrial(setup()); s = fill(act(s, { type: 'compute' }));
  delete s.trials[1].task.transcriptionDelayMs;
  assert.throws(() => act(s, { type: 'ratings', values: questionnaire }), /不允许/);
  const result = transition(s, { type: 'next' }, 10000); s = result.state;
  assert.equal(s.stage, 'transcribe'); assert.equal(s.trials[1].step1_end_ms, 10000); assert.equal(s.trials[1].step2_start_ms, 10000);
  assert.ok(result.events.some(e => e.type === 'phase2_started')); assert.ok(result.events.every(e => e.type !== 'questionnaire_opened'));
  assert.throws(() => act(s, { type: 'ratings', values: questionnaire }), /不允许/);
});

test('1108r5：计算提交后只等待2秒，服务器拒绝提前进入，等待不计入两阶段操作用时', () => {
  let s = finishTrial(setup()); s = fill(act(s, { type: 'compute' }));
  const submitted = transition(s, { type: 'next' }, 10000); s = submitted.state;
  assert.equal(s.stage, 'loading'); assert.equal(s.trials[1].step1_end_ms, 10000); assert.equal(s.trials[1].step2_start_ms, null);
  assert.equal(view(s).loading_remaining_ms, 2000);
  assert.equal(submitted.events.some(e => e.type === 'phase2_started'), false);
  assert.throws(() => transition(s, { type: 'transcribe' }, 11999), /尚未结束/);
  assert.throws(() => transition(s, { type: 'input', field: 'A', value: '17.04' }, 11000), /不允许/);
  const shown = transition(s, { type: 'transcribe' }, 12000); s = shown.state;
  assert.equal(s.stage, 'transcribe'); assert.equal(s.trials[1].step2_start_ms, 12000);
  assert.ok(shown.events.some(e => e.type === 'transcription_loading_finished'));
  s = act(fill(s), { type: 'next' }, 15000); const result = summary(s.trials[1]);
  assert.equal(result.step2_ms, 3000); assert.equal(result.loading_actual_ms, 2000);
  assert.equal(result.task_wall_elapsed_ms! - result.total_active_ms!, 2000);
  assert.throws(() => transition(s, { type: 'transcribe' }, 16000), /不允许/);
});

test('1108r5：加载中刷新/重启可续接，不重交答案，不重复追加计算提交事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-1108-loading-')); const path = join(dir, 'pilot.sqlite');
  let now = 0; const clock = { mono: () => now, wall: () => 100000 + now };
  let store = new PilotStore(path, clock); const created = store.create('P01', {}); let commands = 0;
  const send = (action: Action) => store.command(created.id, `loading-${++commands}`, store.get(created.id).revision, action);
  try {
    send({ type: 'compute' }); for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    send({ type: 'next' }); for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    send({ type: 'next' }); send({ type: 'continue' }); send({ type: 'requirements' }); send({ type: 'compute' });
    for (const field of FIELDS) send({ type: 'input', field, value: standard(NO_FEEDBACK)[field] });
    now = 1000; const loaded = send({ type: 'next' }); assert.equal(loaded.stage, 'loading');
    now = 1500; store.tick(); assert.equal(view(store.get(created.id)).loading_remaining_ms, 1500);
    store.close(); now = 10000; store = new PilotStore(path, clock);
    assert.equal(store.get(created.id).stage, 'loading'); assert.throws(() => send({ type: 'transcribe' }), /尚未结束/);
    now = 11500; assert.equal(send({ type: 'transcribe' }).stage, 'transcribe');
    assert.equal(store.export(created.id).events.filter(e => e.type === 'phase1_submitted' && e.task_id === NO_FEEDBACK.id).length, 1);
    assert.equal(store.export(created.id).trials[1].loading_actual_ms, 2000);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('1108r6：两个正式材料都无填写反馈，提交后只进入成功状态，继续才打开问卷', () => {
  for (const order of ['no-feedback-first', 'feedback-first'] as const) {
    let s = initial('current', 'P01', configuration('P01', { order }), '2026-11-08T06:00:00Z');
    assert.equal(s.trials[0].task.feedback, false);
    s = finishTrial(s);
    for (let trial = 1; trial <= 2; trial++) {
      assert.equal(s.trials[trial].task.presentation, 'cards');
      assert.equal(s.trials[trial].task.completionFeedback, false);
      s = act(fill(act(s, { type: 'compute' })), { type: 'next' });
      assert.equal(view(s).feedback, null);
      const input = transition(s, { type: 'input', field: 'A', value: '1.50' }, s.elapsed_ms + 100);
      assert.equal(input.events.some(e => e.type === 'completion_feedback_state'), false); s = fill(input.state);
      const submitted = transition(s, { type: 'next' }, s.elapsed_ms + 100); s = submitted.state;
      assert.equal(s.stage, 'submitted'); assert.equal(view(s).source, null); assert.equal(view(s).feedback, null);
      assert.equal(submitted.events.some(e => e.type === 'questionnaire_opened'), false);
      const time = summary(s.trials[trial]);
      assert.throws(() => transition(s, { type: 'requirements' }, s.elapsed_ms + 100), /不允许/);
      assert.throws(() => transition(s, { type: 'input', field: 'B', value: '0.00' }, s.elapsed_ms + 100), /不允许/);
      const continued = transition(s, { type: 'continue' }, s.elapsed_ms + 10000); s = continued.state;
      assert.equal(s.stage, 'ratings'); assert.ok(continued.events.some(e => e.type === 'questionnaire_opened'));
      assert.equal(summary(s.trials[trial]).step2_ms, time.step2_ms);
      assert.equal(summary(s.trials[trial]).total_active_ms, time.total_active_ms);
      assert.equal(summary(s.trials[trial]).completion_feedback_enabled, false);
      s = act(s, { type: 'ratings', values: questionnaire });
    }
    assert.equal(s.stage, 'done');
  }
});

test('1108r8：三节点按格式子步骤推进，乱序、修改、清空和最终提交边界正确', () => {
  const answers = emptyAnswers();
  assert.equal(taskProgress('compute', answers).value, 0);
  for (const value of ['1', '1.', '1.0', '1.000', '-1.00', 'Infinity']) {
    answers.D = value; assert.equal(taskProgress('compute', answers).value, 0);
  }
  answers.D = '999.00'; assert.equal(taskProgress('compute', answers).value, 10); // 错答案仍计格式完整。
  answers.D = '0.00'; assert.equal(taskProgress('compute', answers).value, 10);
  answers.B = '1.50'; assert.equal(taskProgress('compute', answers).value, 20);
  answers.D = ''; assert.equal(taskProgress('compute', answers).value, 10);
  answers.qualified = 'E'; assert.equal(taskProgress('compute', answers).value, 10);
  answers.qualified = 'B、B'; assert.equal(taskProgress('compute', answers).value, 20);
  Object.assign(answers, { A: '0.00', C: '0.00', D: '0.00' }); assert.equal(taskProgress('compute', answers).value, 50);
  assert.equal(taskProgress('loading', emptyAnswers()).value, 50);
  assert.equal(taskProgress('transcribe', emptyAnswers()).value, 50);
  for (let i = 0; i <= 5; i++) {
    const partial = emptyAnswers(); for (const field of FIELDS.slice(0, i)) partial[field] = answers[field];
    assert.equal(taskProgress('transcribe', partial).value, 50 + i * 50 / 6);
  }
  assert.ok(taskProgress('transcribe', answers).value < 100);
  assert.equal(taskProgress('submitted', answers).value, 100);
  assert.equal(taskProgress('ratings', answers).value, 100);
  assert.equal(taskProgress('scenario', answers).value, 0);
});

test('1108r9：每人一个有进度和一个无进度，恢复原配对与条件顺序，两个条件均正常完成', () => {
  for (let participant = 1; participant <= 8; participant++) {
    const id = `P0${participant}`, config = configuration(id);
    let s = initial(id, id, config, '2026-11-09T06:00:00Z');
    const expected = (participant - 1) % 4 < 2 ? ['none', 'substeps-v2'] : ['substeps-v2', 'none'];
    assert.deepEqual(s.trials.slice(1).map(t => t.task.taskProgress), expected);
    assert.equal(s.trials.find(t => t.task.id === 'SH01-no-feedback')!.task.taskProgress, 'none');
    assert.equal(s.trials.find(t => t.task.id === 'SH01-feedback')!.task.taskProgress, 'substeps-v2');
    assert.equal(s.trials[0].task.taskProgress, 'none'); assert.equal(s.trials[0].task.taskHeader, 'hidden');
    s = finishTrial(s);
    for (let trial = 1; trial <= 2; trial++) {
      const enabled = s.trials[trial].task.taskProgress !== 'none';
      s = act(s, { type: 'compute' });
      assert.equal(view(s).task_progress?.value ?? null, enabled ? 0 : null);
      const edited = transition(s, { type: 'input', field: 'D', value: '999.00' }, s.elapsed_ms + 100); s = edited.state;
      assert.equal(edited.events.some(e => e.type === 'task_progress_state'), enabled);
      assert.equal(view(s).task_progress?.value ?? null, enabled ? 9 : null);
      s = fill(s); assert.equal(view(s).task_progress?.value ?? null, enabled ? 45 : null); // 未点下一步前不到「完成筛选」节点。
      s = act(s, { type: 'next' }); assert.equal(s.stage, 'transcribe');
      assert.equal(view(s).task_progress?.value ?? null, enabled ? 50 : null);
      const transcribed = transition(s, { type: 'input', field: 'A', value: '999.00' }, s.elapsed_ms + 100); s = transcribed.state;
      assert.equal(transcribed.events.some(e => e.type === 'task_progress_state'), enabled);
      s = act(fill(s), { type: 'next' }); assert.equal(s.stage, 'submitted');
      assert.equal(view(s).task_progress?.value ?? null, enabled ? 100 : null);
      assert.equal(summary(s.trials[trial]).task_progress_mode, enabled ? 'substeps-v2' : 'none');
      s = act(s, { type: 'continue' }); s = act(s, { type: 'ratings', values: questionnaire });
    }
    assert.equal(s.stage, 'done');
  }
  const r8 = initial('r8', 'P01', configuration('P01'), '2026-11-09T06:00:00Z');
  r8.material_version = 'sh-pilot-2026-11-09-r8';
  for (const trial of r8.trials) trial.task.taskProgress = 'substeps-v1';
  const before = JSON.stringify(r8.trials.map(t => t.task));
  const restored = finishTrial(r8);
  assert.equal(JSON.stringify(restored.trials.map(t => t.task)), before);
  assert.equal(view(restored).task_progress!.value, 0); // R8历史会话仍为双进度，不改写历史。
});

test('1108r8：服务端进度持久化、命令去重与回退留痕，旧快照不补加进度或成功页', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a5-progress-')), path = join(dir, 'pilot.sqlite');
  let store = new PilotStore(path), count = 0;
  let created = store.create('P01', {});
  // 明确构造曾有练习进度的R8历史快照，继续验证其持久化和去重，不改变当前练习规则。
  const historical = store.shared.get(created.id)!;
  historical.state.material_version = 'sh-pilot-2026-11-09-r8';
  historical.snapshot.material_version = historical.state.material_version;
  for (const task of [...historical.state.trials.map(t => t.task), ...historical.snapshot.tasks]) {
    task.taskProgress = 'substeps-v1'; delete task.taskHeader;
  }
  store.shared.save(historical); created = view(store.get(created.id));
  const send = (action: Action) => store.command(created.id, `progress-${++count}`, store.get(created.id).revision, action);
  try {
    assert.equal(created.task_progress!.value, 0); send({ type: 'compute' });
    assert.equal(send({ type: 'input', field: 'D', value: '999.00' }).task_progress!.value, 10);
    const revision = store.get(created.id).revision;
    const response = store.command(created.id, 'dedup-progress', revision, { type: 'input', field: 'A', value: '1.50' });
    assert.equal(response.task_progress!.value, 20);
    assert.deepEqual(store.command(created.id, 'dedup-progress', revision, { type: 'input', field: 'A', value: '1.50' }), response);
    assert.equal(send({ type: 'input', field: 'A', value: '9.99' }).task_progress!.value, 20);
    assert.equal(send({ type: 'input', field: 'D', value: '' }).task_progress!.value, 10);
    assert.equal(send({ type: 'requirements' }).task_progress!.value, 10);
    store.close(); store = new PilotStore(path);
    assert.equal(view(store.get(created.id)).task_progress!.value, 10);
    const events = store.export(created.id).events.filter(e => e.type === 'task_progress_state');
    assert.deepEqual(events.map(e => e.data.value), [10, 20, 10]);
    assert.ok(events.every(e => e.condition === 'task-progress' && e.data.means_correct === false && e.data_kind === 'pilot1108-practice'));
    assert.equal(store.export(created.id).trials[0].task_progress_mode, 'substeps-v1');
    let legacy = initial('r7', 'P03', configuration('P03'), '2026-11-08T06:00:00Z');
    legacy.material_version = 'sh-pilot-2026-11-08-r7';
    for (const t of legacy.trials) delete t.task.taskProgress;
    delete legacy.trials[0].task.submissionPage;
    const snapshot = JSON.stringify(legacy.trials.map(t => t.task));
    assert.equal(Object.hasOwn(view(legacy), 'task_progress'), false);
    legacy = finishTrial(legacy); assert.equal(legacy.stage, 'scenario');
    assert.equal(JSON.stringify(legacy.trials.map(t => t.task)), snapshot);
    assert.equal(Object.hasOwn(view(legacy), 'task_progress'), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('1108r8：练习同步卡片和草稿本，保留材料公式、无等待无问卷，成功页继续进入正式题', () => {
  const store = new PilotStore(':memory:'); const v = store.create('P01', {}); let count = 0;
  const send = (action: Action) => store.command(v.id, `practice-cards-${++count}`, store.get(v.id).revision, action);
  try {
    assert.equal(v.task.presentation, 'cards'); assert.equal(v.stage, 'requirements');
    assert.equal(v.task.scenarioPage, undefined); assert.equal(v.task.transcriptionDelayMs, undefined);
    assert.deepEqual(standard(v.task), { qualified: 'A、D', A: '1.50', B: '2.10', C: '1.70', D: '1.90' });
    send({ type: 'compute' }); send({ type: 'scratchpad', value: 'A：1.20 + 0.30 = 1.50' });
    send({ type: 'requirements' }); assert.equal(send({ type: 'compute' }).scratchpad, 'A：1.20 + 0.30 = 1.50');
    for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    assert.equal(send({ type: 'next' }).stage, 'transcribe');
    for (const field of FIELDS) send({ type: 'input', field, value: standard(PRACTICE)[field] });
    const success = send({ type: 'next' }); assert.equal(success.stage, 'submitted'); assert.equal(success.task_progress, null);
    assert.equal(send({ type: 'continue' }).stage, 'scenario');
    const log = store.export(v.id), practiceEvents = log.events.filter(e => e.task_id === 'practice');
    assert.ok(practiceEvents.every(e => e.data_kind === 'pilot1108-practice'));
    assert.equal(practiceEvents.filter(e => e.type === 'scratchpad_changed').length, 1);
    assert.equal(practiceEvents.some(e => e.type === 'task_progress_state'), false);
    assert.ok(practiceEvents.every(e => e.condition === 'no-feedback'));
    assert.equal(practiceEvents.filter(e => e.type === 'submission_success_opened').length, 1);
    assert.equal(practiceEvents.some(e => ['transcription_loading_started', 'questionnaire_opened'].includes(e.type)), false);
    assert.equal(log.trials[0].scratchpad, 'A：1.20 + 0.30 = 1.50');
    assert.equal(log.trials[0].phase1_accuracy!.accuracy, 1); assert.equal(log.trials[0].phase2_copy_accuracy!.accuracy, 1);
  } finally { store.close(); }
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
        if (store.get(v.id).stage === 'scenario') send({ type: 'requirements' });
        send({ type: 'compute' }); const expected = standard(store.get(v.id).trials[trial].task);
        for (const field of FIELDS) send({ type: 'input', field, value: expected[field] });
        const submitted = send({ type: 'next' });
        if (trial) { assert.equal(submitted.stage, 'loading'); now += 2000; assert.equal(send({ type: 'transcribe' }).stage, 'transcribe'); }
        else assert.equal(submitted.stage, 'transcribe');
        for (const field of FIELDS) send({ type: 'input', field, value: expected[field] });
        send({ type: 'next' }); assert.equal(store.get(v.id).stage, 'submitted'); send({ type: 'continue' }); if (trial) send({ type: 'ratings', values: questionnaire });
      }
      now += 30000; store.tick(); const exported = store.export(v.id); assert.equal(exported.state.stage, 'done');
      assert.equal(exported.events.filter(e => e.type === 'questionnaire_opened').length, 2); assert.equal(exported.events.filter(e => e.type === 't0_behavioral_candidate').length, 3);
      assert.equal(exported.events.filter(e => e.type === 't0_20s_secondary').length, 3);
      assert.ok(exported.trials.every(t => t.phase1_accuracy!.accuracy === 1 && t.phase2_copy_accuracy!.accuracy === 1));
      assert.deepEqual(exported.trials.slice(1).map(t => t.task_progress_mode).sort(), ['none', 'substeps-v2']);
      assert.equal(exported.events.some(e => e.type === 'task_progress_state' && e.task_id === NO_FEEDBACK.id), false);
      assert.ok(exported.events.filter(e => e.task_id === NO_FEEDBACK.id).every(e => e.condition === 'no-feedback'));
      assert.ok(exported.events.filter(e => e.task_id === WITH_FEEDBACK.id).every(e => e.condition === 'task-progress'));
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
    const log = await exported.json() as ReturnType<PilotStore['export']>; assert.equal(log.actual_interruption, false); assert.equal(log.state.material_version, 'sh-pilot-2026-11-09-r11');
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
