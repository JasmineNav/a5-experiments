import { randomUUID } from 'node:crypto';
import { Store } from '@a5/desktop/store.ts';
import { systemClock } from '@a5/desktop/clock.ts';
import type { Clock } from '@a5/desktop/clock.ts';
import { configuration, initial, marker, summary, transition, view, SCALE_ITEMS } from './model.ts';
import type { Action, Config, Event, State, Task } from './model.ts';

interface PilotSnapshot { material_version: string; config: Config; tasks: Task[] }
/** 复用公共 Store 的事务、乐观锁、状态日志、只追加事件和命令指纹；数据库仍独立隔离。 */
export class PilotStore {
  readonly shared: Store<State, PilotSnapshot>;
  readonly db: Store['db'];
  private clocks = new Map<string, { base: number; offset: number }>();
  private clock: Clock;
  constructor(path: string, clock: Clock = systemClock) {
    this.clock = clock; this.shared = new Store<State, PilotSnapshot>(path); this.db = this.shared.db;
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pilot_participant ON sessions(json_extract(state,'$.participant'));
      CREATE TABLE IF NOT EXISTS pilot_command_responses(session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_id,command_id));
      CREATE TRIGGER IF NOT EXISTS pilot_responses_no_update BEFORE UPDATE ON pilot_command_responses BEGIN SELECT RAISE(ABORT,'pilot响应只允许追加'); END;
      CREATE TRIGGER IF NOT EXISTS pilot_responses_no_delete BEFORE DELETE ON pilot_command_responses BEGIN SELECT RAISE(ABORT,'pilot响应只允许追加'); END;`);
    for (const id of this.shared.ids()) {
      const state = this.get(id);
      this.clocks.set(id, { base: this.clock.mono(), offset: state.elapsed_ms });
      if (state.stage !== 'done') this.append(state, [{ type: 'server_restarted', elapsed_ms: state.elapsed_ms,
        task_id: state.trials[state.index].task.id, data: { timing_discontinuity: true, downtime_excluded: true, last_checkpoint_ms: state.elapsed_ms } }]);
    }
  }
  private wall() { return new Date(this.clock.wall()).toISOString(); }
  private append(state: State, events: Event[]) {
    for (const event of events) this.shared.event({ event_id: randomUUID(), session_id: state.id,
      participant_id: state.participant, stage_id: event.task_id, unit_id: event.stage ?? null,
      condition: state.trials.find(t => t.task.id === event.task_id)?.task.feedback ? state.config.feedback : 'no-feedback',
      event_type: event.type, elapsed_ms: event.elapsed_ms, timestamp_iso: this.wall(),
      payload: event.data as Record<string, unknown>, content_version: state.material_version,
      data_kind: event.task_id === 'practice' ? 'pilot1108-practice' : 'pilot1108' });
  }
  private now(id: string, last: number) { const clock = this.clocks.get(id)!; return Math.max(last, this.clock.mono() - clock.base + clock.offset); }
  get(id: string): State {
    const session = this.shared.get(id);
    if (!session) throw new Error('找不到会话。');
    return session.state;
  }
  list() {
    return this.shared.ids().reverse().map(id => {
      const s = this.get(id);
      return { id, participant: s.participant, stage: s.stage, created_at: s.created_at, config: s.config };
    });
  }
  create(participant: string, input: Partial<Config>) {
    if (typeof participant !== 'string') throw new Error('请填写被试编号。');
    const config = configuration(participant, input); const id = randomUUID();
    const state = initial(id, participant, config, this.wall());
    this.shared.tx(() => {
      if (this.list().some(s => s.participant === participant)) throw new Error('此编号已有会话，请恢复会话；重测请使用新编号。');
      this.shared.create({ id, token_hash: '', state,
        snapshot: { material_version: state.material_version, config: structuredClone(config), tasks: state.trials.map(t => structuredClone(t.task)) } });
      this.append(state, [{ type: 'session_created', elapsed_ms: 0, task_id: state.trials[0].task.id,
        data: { config, material_version: state.material_version, actual_interruption: false } }]);
    });
    this.clocks.set(id, { base: this.clock.mono(), offset: 0 });
    return view(state);
  }
  command(id: string, commandId: string, revision: number, action: Action) {
    if (typeof commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(commandId)) throw new Error('命令编号无效。');
    const fingerprint = JSON.stringify({ revision, action });
    return this.shared.tx(() => {
      const duplicate = this.shared.command(id, commandId);
      if (duplicate) {
        if (duplicate !== fingerprint) throw new Error('命令编号已用于不同操作。');
        const cached = this.db.prepare('SELECT response FROM pilot_command_responses WHERE session_id=? AND command_id=?').get(id, commandId)!;
        return JSON.parse(String(cached.response)) as ReturnType<typeof view>;
      }
      const session = this.shared.get(id);
      if (!session) throw new Error('找不到会话。');
      if (revision !== session.state.revision) throw new Error('页面已过期，请刷新后继续（请勿同时打开多个作答窗口）。');
      const result = transition(session.state, action, this.now(id, session.state.elapsed_ms));
      session.state = result.state; this.shared.save(session); this.append(result.state, result.events);
      const response = view(result.state);
      this.shared.acceptCommand(id, commandId, fingerprint);
      this.db.prepare('INSERT INTO pilot_command_responses(session_id,command_id,response) VALUES (?,?,?)').run(id, commandId, JSON.stringify(response));
      return response;
    });
  }
  tick() {
    for (const id of this.shared.ids()) this.shared.tx(() => {
      const session = this.shared.get(id)!; const state = session.state; const now = this.now(id, state.elapsed_ms);
      // 完成后仅等待尚未到达的20s标记，不继续延长会话计时。
      const pending = state.trials.some(t => t.first_compute_ms !== null && t.t0_20s_ms === null);
      if (state.stage === 'done' && !pending) return;
      const events = marker(state, now); state.elapsed_ms = now;
      this.shared.save(session); this.append(state, events);
    });
  }
  export(id: string) {
    const state = this.get(id);
    const events = this.shared.events(id).map(e => ({ ...e, type: e.event_type, task_id: e.stage_id, data: e.payload, server_received_at: e.timestamp_iso }));
    return { exported_at: this.wall(), clock: '公共Clock单调时钟毫秒；重启停机时间不计入，server_restarted标记不连续；received_at为带时区墙钟',
      actual_interruption: false, scales: SCALE_ITEMS, state, trials: state.trials.map(summary), events,
      state_history: this.shared.stateLog(id), intervention_history: this.shared.interventions(id) };
  }
  close() { this.tick(); this.shared.close(); }
}
