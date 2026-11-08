/** 11-08 材料可行性 pilot；不加载正式 SH 状态机或眼镜适配器。 */
export const PLANS = ['A', 'B', 'C', 'D'] as const;
export const FIELDS = ['qualified', ...PLANS] as const;
export type Field = typeof FIELDS[number];
export type Answers = Record<Field, string>;
export type Feedback = 'registered' | 'progress' | 'message';
export type Order = 'no-feedback-first' | 'feedback-first';
export interface Config {
  feedback: Feedback; order: Order; source: 'participant' | 'standard';
  practiceScales: boolean; practiceFeedback: boolean;
}
export interface Task {
  id: string; title: string; practice: boolean; feedback: boolean;
  maxCost: number; maxDays: number; minPeople: number;
  rows: { plan: typeof PLANS[number]; base: number; extra: number; days: number; people: number }[];
}
const rows = (values: number[][]): Task['rows'] => values.map((v, i) => ({ plan: PLANS[i], base: v[0], extra: v[1], days: v[2], people: v[3] }));
export const PRACTICE: Task = {
  id: 'practice', title: '展台布置方案（练习）', practice: true, feedback: false,
  maxCost: 2, maxDays: 5, minPeople: 16,
  rows: rows([[1.2, .3, 4, 20], [1.8, .3, 4, 18], [1.3, .4, 4, 14], [1.4, .5, 5, 16]]),
};
export const NO_FEEDBACK: Task = {
  id: 'SH01-no-feedback', title: '筛选活动执行方案', practice: false, feedback: false,
  maxCost: 17, maxDays: 10, minPeople: 24,
  rows: rows([[14.68, 2.39, 9, 28], [13.72, 3.25, 10, 24], [15.73, 1.26, 8, 22], [14.21, 2.74, 10, 30]]),
};
export const WITH_FEEDBACK: Task = {
  ...NO_FEEDBACK, id: 'SH01-feedback', feedback: true,
  rows: rows([[15.24, 1.88, 9, 28], [12.87, 4.11, 10, 24], [13.08, 3.85, 10, 30], [14.15, 2.73, 8, 22]]),
};
export function configuration(participant: string, input: Partial<Config> = {}): Config {
  const n = Number(participant.match(/(\d+)$/)?.[1]);
  // 四人一组：前两位无反馈先，后两位有反馈先；没有编号时必须显式指定。
  const order = input.order ?? (n > 0 ? ((n - 1) % 4 < 2 ? 'no-feedback-first' : 'feedback-first') : undefined);
  const config = { feedback: 'progress', source: 'participant', practiceScales: false, practiceFeedback: false, ...input, order };
  if (!['registered', 'progress', 'message'].includes(config.feedback!) || !['participant', 'standard'].includes(config.source!) ||
      !['no-feedback-first', 'feedback-first'].includes(config.order!) || typeof config.practiceScales !== 'boolean' || typeof config.practiceFeedback !== 'boolean') {
    throw new Error('反馈类型、顺序或练习配置无效；无数字编号时请显式指定顺序。');
  }
  return config as Config;
}
export function taskSequence(config: Config): Task[] {
  const formal = config.order === 'feedback-first' ? [WITH_FEEDBACK, NO_FEEDBACK] : [NO_FEEDBACK, WITH_FEEDBACK];
  return structuredClone([{ ...PRACTICE, feedback: config.practiceFeedback }, ...formal]);
}
export function standard(task: Task): Answers {
  const costs = Object.fromEntries(task.rows.map(r => [r.plan, ((Math.round(r.base * 100) + Math.round(r.extra * 100)) / 100).toFixed(2)]));
  return { ...costs, qualified: task.rows.filter(r => Number(costs[r.plan]) <= task.maxCost && r.days <= task.maxDays && r.people >= task.minPeople).map(r => r.plan).join('、') } as Answers;
}
export const emptyAnswers = (): Answers => ({ qualified: '', A: '', B: '', C: '', D: '' });
export function numeric(value: string): boolean { return /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && Number.isFinite(Number(value)); }
export function qualified(value: string): string[] | null {
  const text = value.trim().toUpperCase();
  if (!/^[ABCD\s,，、;；]+$/.test(text)) return null;
  return [...new Set(text.replace(/[^ABCD]/g, '').split(''))].sort();
}
export function complete(answers: Answers): boolean { return FIELDS.every(f => f === 'qualified' ? qualified(answers[f]) !== null : numeric(answers[f])); }
export function score(actual: Answers, expected: Answers) {
  const fields = Object.fromEntries(FIELDS.map(f => [f, f === 'qualified'
    ? qualified(actual[f]) !== null && JSON.stringify(qualified(actual[f])) === JSON.stringify(qualified(expected[f]))
    : numeric(actual[f]) && numeric(expected[f]) && Math.abs(Number(actual[f]) - Number(expected[f])) < .000001]));
  return { fields, correct: Object.values(fields).filter(Boolean).length, denominator: FIELDS.length,
    accuracy: Object.values(fields).filter(Boolean).length / FIELDS.length };
}
export type Stage = 'requirements' | 'compute' | 'scale1' | 'transcribe' | 'scale2' | 'done';
export type Ratings = Record<string, number>;
export const SCALE_ITEMS = [
  { key: 'mental', label: '心理需求', question: '完成这一阶段，您需要花多大程度的心力来思考和处理信息？' },
  { key: 'integration', label: '信息整合需求', question: '在这一阶段，您需要综合多项信息才能作出判断的程度有多高？' },
  { key: 'effort', label: '需要付出的努力', question: '为完成这一阶段，您实际投入的努力程度有多高？' },
  { key: 'relaxation', label: '放松感', question: '回想刚刚在记录最终答案的过程中，您心里有多放松？' },
];
export interface Trial {
  task: Task; compute: Answers; transcription: Answers; source: Answers | null;
  started_ms: number; first_compute_ms: number | null; step1_end_ms: number | null;
  step2_start_ms: number | null; step2_end_ms: number | null;
  t0_ms: number | null; t0_20s_ms: number | null; t1_ms: number | null; t2_ms: number | null;
  scale1: Ratings | null; scale2: Ratings | null;
}
export interface State {
  schema_version: 1; material_version: 'sh-pilot-2026-11-08'; id: string; participant: string; config: Config;
  trials: Trial[]; index: number; stage: Stage; revision: number; elapsed_ms: number; created_at: string;
}
export type Action = { type: 'compute' | 'requirements' | 'next' } |
  { type: 'input'; field: Field; value: string } | { type: 'ratings'; values: Ratings };
export interface Event { type: string; elapsed_ms: number; task_id: string; stage?: Stage; data: unknown }
export function initial(id: string, participant: string, config: Config, at: string): State {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(participant)) throw new Error('被试编号仅允许1—40位字母、数字、下划线或连字符。');
  return { schema_version: 1, material_version: 'sh-pilot-2026-11-08', id, participant, config, created_at: at,
    index: 0, stage: 'requirements', revision: 0, elapsed_ms: 0,
    trials: taskSequence(config).map(task => ({ task, compute: emptyAnswers(), transcription: emptyAnswers(), source: null,
      started_ms: 0, first_compute_ms: null, step1_end_ms: null, step2_start_ms: null, step2_end_ms: null,
      t0_ms: null, t0_20s_ms: null, t1_ms: null, t2_ms: null, scale1: null, scale2: null })) };
}
export function marker(state: State, now: number): Event[] {
  const events: Event[] = [];
  for (const [index, t] of state.trials.entries()) {
    if (t.first_compute_ms === null || t.t0_20s_ms !== null || now < t.first_compute_ms + 20000) continue;
    t.t0_20s_ms = t.first_compute_ms + 20000;
    events.push({ type: 't0_20s_secondary', elapsed_ms: now, task_id: t.task.id,
      data: { candidate_elapsed_ms: t.t0_20s_ms, observed_elapsed_ms: now,
        stage_at_observation: index === state.index ? state.stage : 'trial_finished', actual_interruption: false } });
  }
  return events;
}
export function transition(previous: State, action: Action, now: number): { state: State; events: Event[] } {
  const state = structuredClone(previous);
  if (state.stage === 'done') throw new Error('会话已完成。');
  const t = state.trials[state.index];
  const events = marker(state, now);
  const emit = (type: string, data: unknown = {}) => events.push({ type, elapsed_ms: now, task_id: t.task.id, stage: state.stage, data });
  const scales = !t.task.practice || state.config.practiceScales;
  const startTranscription = () => { state.stage = 'transcribe'; t.step2_start_ms = now; emit('phase2_started'); };
  if (action.type === 'compute' && state.stage === 'requirements') {
    state.stage = 'compute'; t.first_compute_ms ??= now; emit('compute_opened');
  } else if (action.type === 'requirements' && state.stage === 'compute') {
    state.stage = 'requirements'; emit('requirements_revisited');
  } else if (action.type === 'input' && ['compute', 'transcribe'].includes(state.stage)) {
    if (!FIELDS.includes(action.field) || typeof action.value !== 'string' || action.value.length > 100) throw new Error('输入字段或长度无效。');
    const answers = state.stage === 'compute' ? t.compute : t.transcription;
    const before = answers[action.field]; answers[action.field] = action.value;
    emit('input_changed', { phase: state.stage, field: action.field, previous: before, value: action.value });
    if (state.stage === 'compute' && action.field === 'B' && action.value.trim() && numeric(t.compute.A) && t.t0_ms === null) {
      t.t0_ms = now; emit('t0_behavioral_candidate', { rule: 'first_B_input_after_numeric_A', a_value: t.compute.A, b_value: action.value, actual_interruption: false });
    }
    if (state.stage === 'transcribe' && action.field === 'B' && action.value.trim() && t.t2_ms === null) {
      t.t2_ms = now; emit('t2_candidate', { rule: 'first_B_transcription_input', actual_interruption: false });
    }
    if (state.stage === 'transcribe' && t.task.feedback) emit('completion_feedback_state', { feedback: state.config.feedback,
      filled: Object.fromEntries(FIELDS.map(f => [f, Boolean(answers[f].trim())])), completed: FIELDS.filter(f => answers[f].trim()).length,
      means_correct: false });
  } else if (action.type === 'next' && state.stage === 'compute') {
    if (!complete(t.compute)) throw new Error('请填写四项费用（最多两位小数）及合格方案编号，再进入下一步。');
    t.step1_end_ms = now; t.t1_ms = now;
    t.source = state.config.source === 'participant' ? structuredClone(t.compute) : standard(t.task);
    emit('phase1_submitted', { participant_answers: t.compute, standard_answers: standard(t.task), source: t.source, source_mode: state.config.source, score: score(t.compute, standard(t.task)) });
    emit('t1_candidate', { rule: 'phase1_next_clicked', actual_interruption: false });
    if (scales) state.stage = 'scale1'; else startTranscription();
  } else if (action.type === 'next' && state.stage === 'transcribe') {
    if (!complete(t.transcription)) throw new Error('请填写全部登记结果（费用最多两位小数，方案编号可用顿号分隔）。');
    t.step2_end_ms = now;
    emit('phase2_submitted', { answers: t.transcription, objective_score: score(t.transcription, standard(t.task)), copy_score: score(t.transcription, t.source!) });
    if (scales) state.stage = 'scale2'; else finish();
  } else if (action.type === 'ratings' && ['scale1', 'scale2'].includes(state.stage)) {
    const keys = SCALE_ITEMS.slice(0, state.stage === 'scale1' ? 3 : 4).map(i => i.key);
    if (!action.values || typeof action.values !== 'object' || Object.keys(action.values).length !== keys.length || keys.some(k => !Number.isInteger(action.values[k]) || action.values[k] < 1 || action.values[k] > 7)) throw new Error('请完成本阶段全部1—7分量表。');
    if (state.stage === 'scale1') { t.scale1 = action.values; emit('phase1_ratings', action.values); startTranscription(); }
    else { t.scale2 = action.values; emit('phase2_ratings', action.values); finish(); }
  } else throw new Error('当前页面不允许此操作。');
  function finish() {
    emit('trial_finished', summary(t));
    if (state.index === state.trials.length - 1) { state.stage = 'done'; emit('session_finished'); }
    else { state.index++; state.stage = 'requirements'; state.trials[state.index].started_ms = now; }
  }
  state.elapsed_ms = now; state.revision++;
  return { state, events };
}
export function summary(t: Trial) {
  const step1_ms = t.step1_end_ms === null ? null : t.step1_end_ms - t.started_ms;
  const step2_ms = t.step2_end_ms === null || t.step2_start_ms === null ? null : t.step2_end_ms - t.step2_start_ms;
  return { task_id: t.task.id, feedback: t.task.feedback, step1_ms, step2_ms,
    compute_from_first_open_ms: t.step1_end_ms === null || t.first_compute_ms === null ? null : t.step1_end_ms - t.first_compute_ms,
    total_active_ms: step1_ms === null || step2_ms === null ? null : step1_ms + step2_ms,
    task_wall_elapsed_ms: t.step2_end_ms === null ? null : t.step2_end_ms - t.started_ms,
    phase1_accuracy: t.step1_end_ms === null ? null : score(t.compute, standard(t.task)),
    phase2_objective_accuracy: t.step2_end_ms === null ? null : score(t.transcription, standard(t.task)),
    phase2_copy_accuracy: t.step2_end_ms === null || !t.source ? null : score(t.transcription, t.source),
    t0_candidate_ms: t.t0_ms, t0_20s_candidate_ms: t.t0_20s_ms, t1_candidate_ms: t.t1_ms, t2_candidate_ms: t.t2_ms,
    scale1: t.scale1, scale2: t.scale2 };
}
/** 公开视图不泄露标准答案/正确率；界面3只返回配置所指定的誊写来源。 */
export function view(state: State) {
  const t = state.trials[state.index];
  return { id: state.id, participant: state.participant, stage: state.stage, revision: state.revision,
    trial_number: state.index + 1, task_count: state.trials.length, task: t.task,
    feedback: t.task.feedback ? state.config.feedback : null,
    answers: state.stage === 'transcribe' ? t.transcription : t.compute,
    source: state.stage === 'transcribe' ? t.source : null,
    scale_items: state.stage === 'scale1' ? SCALE_ITEMS.slice(0, 3) : SCALE_ITEMS };
}
