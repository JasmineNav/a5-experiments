import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { configuration, initial, marker, summary, transition, view, SCALE_ITEMS } from './model.ts';
import type { Action, Config, Event, State } from './model.ts';

export class PilotStore {
  readonly db: DatabaseSync;
  private clocks = new Map<string, { base: number; offset: number }>();
  private mono: () => number;
  private wall: () => string;
  constructor(path: string, mono = () => performance.now(), wall = () => new Date().toISOString()) {
    this.mono = mono; this.wall = wall; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, participant TEXT UNIQUE NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), received_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'事件只允许追加'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'事件只允许追加'); END;`);
    for (const row of this.db.prepare('SELECT id,state FROM sessions').all()) {
      const state = JSON.parse(String(row.state)) as State;
      this.clocks.set(state.id, { base: this.mono(), offset: state.elapsed_ms });
      if (state.stage !== 'done') this.append(state.id, [{ type: 'server_restarted', elapsed_ms: state.elapsed_ms,
        task_id: state.trials[state.index].task.id, data: { timing_discontinuity: true, downtime_excluded: true, last_checkpoint_ms: state.elapsed_ms } }]);
    }
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private append(id: string, events: Event[]) {
    const insert = this.db.prepare('INSERT INTO events(session_id,received_at,body) VALUES (?,?,?)');
    for (const event of events) insert.run(id, this.wall(), JSON.stringify(event));
  }
  private save(state: State) { this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify(state), state.id); }
  private now(id: string) { const clock = this.clocks.get(id)!; return Math.max(0, this.mono() - clock.base + clock.offset); }
  get(id: string): State {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('找不到会话。');
    return JSON.parse(String(row.state)) as State;
  }
  list() {
    return this.db.prepare('SELECT id,participant,state FROM sessions ORDER BY rowid DESC').all().map(row => {
      const s = JSON.parse(String(row.state)) as State;
      return { id: s.id, participant: s.participant, stage: s.stage, created_at: s.created_at, config: s.config };
    });
  }
  create(participant: string, input: Partial<Config>) {
    if (typeof participant !== 'string') throw new Error('请填写被试编号。');
    if (this.db.prepare('SELECT id FROM sessions WHERE participant=?').get(participant)) throw new Error('此编号已有会话，请恢复会话；重测请使用新编号。');
    const config = configuration(participant, input); const id = randomUUID();
    const state = initial(id, participant, config, this.wall());
    this.atomic(() => {
      this.db.prepare('INSERT INTO sessions(id,participant,state) VALUES (?,?,?)').run(id, participant, JSON.stringify(state));
      this.append(id, [{ type: 'session_created', elapsed_ms: 0, task_id: state.trials[0].task.id,
        data: { config, material_version: state.material_version, actual_interruption: false } }]);
    });
    this.clocks.set(id, { base: this.mono(), offset: 0 });
    return view(state);
  }
  command(id: string, commandId: string, revision: number, action: Action) {
    if (typeof commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(commandId)) throw new Error('命令编号无效。');
    const fingerprint = JSON.stringify({ revision, action });
    return this.atomic(() => {
      const duplicate = this.db.prepare('SELECT fingerprint,response FROM commands WHERE session_id=? AND id=?').get(id, commandId);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new Error('命令编号已用于不同操作。');
        return JSON.parse(String(duplicate.response)) as ReturnType<typeof view>;
      }
      const previous = this.get(id);
      if (revision !== previous.revision) throw new Error('页面已过期，请刷新后继续（请勿同时打开多个作答窗口）。');
      const result = transition(previous, action, this.now(id));
      this.save(result.state); this.append(id, result.events);
      const response = view(result.state);
      this.db.prepare('INSERT INTO commands(session_id,id,fingerprint,response) VALUES (?,?,?,?)').run(id, commandId, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  tick() {
    for (const { id } of this.list()) {
      const state = this.get(id); const now = this.now(id);
      // 完成后仅等待尚未到达的20s标记，不继续延长会话计时。
      const pending = state.trials.some(t => t.first_compute_ms !== null && t.t0_20s_ms === null);
      if (state.stage === 'done' && !pending) continue;
      const events = marker(state, now); state.elapsed_ms = now;
      this.atomic(() => { this.save(state); this.append(id, events); });
    }
  }
  export(id: string) {
    const state = this.get(id);
    const events = this.db.prepare('SELECT seq,received_at,body FROM events WHERE session_id=? ORDER BY seq').all(id)
      .map(r => ({ seq: Number(r.seq), server_received_at: String(r.received_at), ...JSON.parse(String(r.body)) }));
    return { exported_at: this.wall(), clock: '服务器单调时钟毫秒；重启停机时间不计入，server_restarted标记不连续；received_at为带时区墙钟',
      actual_interruption: false, scales: SCALE_ITEMS, state, trials: state.trials.map(summary), events };
  }
  close() { this.tick(); this.db.close(); }
}
