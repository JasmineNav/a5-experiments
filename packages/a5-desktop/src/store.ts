import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Snapshot } from './tasks.ts';

export type Phase = 'TUTORIAL_INTRO' | 'TUTORIAL_UNIT1' | 'TUTORIAL_UNIT2' | 'TUTORIAL_REST' | 'TUTORIAL_NOTICE' | 'TUTORIAL_CHECK' | 'INTRO' | 'CARD' | 'UNIT' | 'COMPREHENSION' | 'RATINGS' | 'BREAK' | 'COMPLETED' | 'ABORTED';
export interface State {
  phase: Phase; stage: number; unit: number; page_token: string;
  displayed: Record<string, boolean>; drafts: Record<string, Record<string, unknown>>;
  scratchpads?: Record<string, string>;
  reveals: Record<string, { open: boolean; requested: boolean; displayed: boolean }>;
  started_at: string; ended_at: string | null; ended_elapsed_ms: number | null; last_elapsed_ms: number;
  break_until_ms: number | null; break_completed: boolean;
  break_displayed_at?: string | null; break_displayed_elapsed_ms?: number | null;
  /** V2单元内休息：键为TUTORIAL或任务组编号，每组最多一次。 */
  rests?: Record<string, RestState>;
  rest_feedback?: Record<string, { id: string; text: string }>;
  rest_reminders?: Record<string, RestReminder[]>;
  u2_displayed_elapsed?: Record<string, number>;
  /** U1作答数量触发T0（SL）：键为任务组编号，每组最多一次；存在即表示已达到阈值。 */
  t0?: Record<string, T0State>;
  paused_at_ms: number | null; attention: string[]; status: 'active' | 'completed' | 'aborted';
  device_id?: string; delivery_source?: 'mock' | 'device';
  deleted?: { deleted_at: string; reason: string };
}
export interface T0State { key: string; threshold_event_id: string; threshold_elapsed_ms: number; due_ms: number | null; fired: boolean }
export interface RestState {
  rest_id: string; key: string; status: 'requested' | 'resting' | 'returning' | 'done';
  click_event_id: string; requested_elapsed_ms: number; after_reminder: boolean;
  started_at: string | null; started_elapsed_ms: number | null; until_ms: number | null;
  countdown_ended_elapsed_ms: number | null; returned_elapsed_ms: number | null;
  paused_ms: number; paused_during: boolean; t2_due_ms: number | null; t2_fired: boolean; end_reason?: string;
}
export interface RestReminder { id: string; text: string; sent_at: string; sent_elapsed_ms: number; displayed: boolean }
/** version 为乐观锁版本号：读取时带出，save 时校验并递增；新建会话为 0。 */
export interface Session<S = State, P = Snapshot> { id: string; token_hash: string; version?: number; state: S; snapshot: P }
/** 保存时发现会话已被他处更新：拒绝覆盖，由调用方重新读取后再处理。 */
export class StateConflictError extends Error {
  readonly session_id: string; readonly expected_version: number;
  constructor(sessionId: string, expectedVersion: number) {
    super(`会话 ${sessionId} 状态版本冲突（期望 ${expectedVersion}），已拒绝覆盖，请重新读取后重试。`);
    this.name = 'StateConflictError'; this.session_id = sessionId; this.expected_version = expectedVersion;
  }
}
export interface EventRecord {
  data_kind?: string;
  event_id: string; session_id: string; participant_id: string; stage_id: string | null; unit_id: string | null;
  condition: string | null; event_type: string; timestamp_iso: string; elapsed_ms: number;
  payload: Record<string, unknown>; content_version: string;
  is_debug?: boolean;
}
export interface Intervention {
  data_kind?: 'formal' | 'tutorial' | 'manual';
  text?: string;
  display_mode?: import('./contracts.ts').DisplayMode;
  confirmation_requested_at?: string; confirmation_elapsed_ms?: number; confirmation_status?: 'pending' | 'accepted' | 'unknown';
  session_id: string; stage_id: string; participant_id: string; message_id: string; condition: string;
  request_id: string; status: string; source: 'mock' | 'device'; duration_ms: number;
  t_event: string; event_elapsed_ms: number; t_send: string | null; t_ack: string | null; t_display: string | null; t_hide: string | null;
  device_id?: string; device_events?: import('./contracts.ts').GlassesEvent[];
  display_time_source: string; receipt: unknown; error: string | null;
}

/** 状态/快照类型可扩展；默认类型及正式 SH/SL 的运行行为保持不变。 */
export class Store<S = State, P = Snapshot> {
  readonly db: DatabaseSync;
  private readonly snapshots = new Map<string, P>();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS session_state_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, state TEXT NOT NULL, UNIQUE(session_id,version));
      CREATE TRIGGER IF NOT EXISTS session_state_log_no_update BEFORE UPDATE ON session_state_log BEGIN SELECT RAISE(ABORT,'session state log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS session_state_log_no_delete BEFORE DELETE ON session_state_log BEGIN SELECT RAISE(ABORT,'session state log is append-only'); END;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
      CREATE TABLE IF NOT EXISTS commands(session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session_id,command_id));
      CREATE TABLE IF NOT EXISTS device_events(event_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS device_events_no_update BEFORE UPDATE ON device_events BEGIN SELECT RAISE(ABORT,'device events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS device_events_no_delete BEFORE DELETE ON device_events BEGIN SELECT RAISE(ABORT,'device events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;`);
    this.migrate();
  }
  /** 兼容旧库：补 sessions.version 与状态日志基线；interventions 旧表改名保留，数据迁入只追加历史表。 */
  private migrate() {
    this.tx(() => {
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      if (!columns.some(c => c.name === 'version')) this.db.exec('ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
      // 旧库会话没有历史：以当前状态作为基线，之后每次保存都追加。
      this.db.exec('INSERT OR IGNORE INTO session_state_log(session_id,version,state) SELECT id,version,state FROM sessions');
      this.db.exec(`CREATE TABLE IF NOT EXISTS intervention_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), stage_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS intervention_history_stage ON intervention_history(session_id,stage_id,seq);
        CREATE INDEX IF NOT EXISTS intervention_history_request ON intervention_history(request_id,seq);
        CREATE TRIGGER IF NOT EXISTS intervention_history_no_update BEFORE UPDATE ON intervention_history BEGIN SELECT RAISE(ABORT,'intervention history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS intervention_history_no_delete BEFORE DELETE ON intervention_history BEGIN SELECT RAISE(ABORT,'intervention history is append-only'); END;`);
      const legacy = this.db.prepare("SELECT type FROM sqlite_master WHERE name='interventions'").get() as { type: string } | undefined;
      if (legacy?.type === 'table') {
        this.db.exec(`ALTER TABLE interventions RENAME TO interventions_legacy;
          INSERT INTO intervention_history(session_id,stage_id,request_id,data) SELECT session_id,stage_id,json_extract(data,'$.request_id'),data FROM interventions_legacy ORDER BY rowid;`);
      }
      // 视图取每个阶段最新一条，对外与旧表同形（session_id, stage_id, data）。
      this.db.exec(`CREATE VIEW IF NOT EXISTS interventions AS SELECT h.session_id AS session_id, h.stage_id AS stage_id, h.data AS data FROM intervention_history h
        WHERE h.seq=(SELECT MAX(seq) FROM intervention_history WHERE session_id=h.session_id AND stage_id=h.stage_id)`);
    });
  }
  private txDepth = 0;
  /** 事务可嵌套：内层直接并入外层，回滚由最外层负责。 */
  tx<T>(action: () => T): T {
    if (this.txDepth > 0) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.txDepth = 1;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.txDepth = 0; }
  }
  create(session: Session<S, P>) {
    this.tx(() => {
      const state = JSON.stringify(session.state);
      this.db.prepare('INSERT INTO sessions(id,token_hash,state,snapshot,version) VALUES (?,?,?,?,0)').run(session.id, session.token_hash, state, JSON.stringify(session.snapshot));
      this.db.prepare('INSERT INTO session_state_log(session_id,version,state) VALUES (?,0,?)').run(session.id, state);
    });
    session.version = 0;
    this.snapshots.set(session.id, session.snapshot);
  }
  get(id: string): Session<S, P> | undefined {
    const row = this.db.prepare('SELECT id,token_hash,state,version FROM sessions WHERE id=?').get(id) as { id: string; token_hash: string; state: string; version: number } | undefined;
    if (!row) return;
    let snapshot = this.snapshots.get(id);
    if (!snapshot) { const stored = this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id) as { snapshot: string }; snapshot = JSON.parse(stored.snapshot) as P; this.snapshots.set(id, snapshot); }
    return { id: row.id, token_hash: row.token_hash, version: row.version, state: JSON.parse(row.state), snapshot };
  }
  ids() { return (this.db.prepare("SELECT id FROM sessions WHERE json_extract(state,'$.deleted') IS NULL ORDER BY rowid").all() as { id: string }[]).map(r => r.id); }
  allIds() { return (this.db.prepare('SELECT id FROM sessions ORDER BY rowid').all() as { id: string }[]).map(r => r.id); }
  findRequest(requestId: string) {
    const row = this.db.prepare("SELECT data FROM interventions WHERE json_extract(data,'$.request_id')=?").get(requestId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Intervention : undefined;
  }
  deletedIds() { return (this.db.prepare("SELECT id FROM sessions WHERE json_extract(state,'$.deleted') IS NOT NULL ORDER BY rowid").all() as { id: string }[]).map(r => r.id); }
  /** 乐观锁保存：版本不符抛 StateConflictError，不静默覆盖；成功后在同一事务追加状态日志并推进 session.version。 */
  save(session: Session<S, P>) {
    const expected = session.version ?? 0, state = JSON.stringify(session.state);
    this.tx(() => {
      const result = this.db.prepare('UPDATE sessions SET state=?, version=version+1 WHERE id=? AND version=?').run(state, session.id, expected);
      if (Number(result.changes) !== 1) throw new StateConflictError(session.id, expected);
      this.db.prepare('INSERT INTO session_state_log(session_id,version,state) VALUES (?,?,?)').run(session.id, expected + 1, state);
    });
    session.version = expected + 1;
  }
  /** 会话状态变更历史（含基线版本），按版本升序，供重建与审计。 */
  stateLog(id: string): { version: number; state: S }[] {
    return (this.db.prepare('SELECT version,state FROM session_state_log WHERE session_id=? ORDER BY version').all(id) as { version: number; state: string }[]).map(r => ({ version: r.version, state: JSON.parse(r.state) }));
  }
  event(event: EventRecord) { this.db.prepare('INSERT INTO events(event_id,session_id,data) VALUES (?,?,?)').run(event.event_id, event.session_id, JSON.stringify(event)); }
  events(id: string): EventRecord[] { return (this.db.prepare('SELECT data FROM events WHERE session_id=? ORDER BY seq').all(id) as { data: string }[]).map(r => JSON.parse(r.data)); }
  command(id: string, commandId: string) { return (this.db.prepare('SELECT fingerprint FROM commands WHERE session_id=? AND command_id=?').get(id, commandId) as { fingerprint: string } | undefined)?.fingerprint; }
  acceptCommand(id: string, commandId: string, fingerprint: string) { this.db.prepare('INSERT INTO commands VALUES (?,?,?)').run(id, commandId, fingerprint); }
  interventions(id: string): Intervention[] { return (this.db.prepare('SELECT data FROM interventions WHERE session_id=? ORDER BY stage_id').all(id) as { data: string }[]).map(r => JSON.parse(r.data)); }
  /** 只追加：每次写入新增一条历史，interventions 视图取最新；同一 request_id 不得出现在其他阶段。 */
  intervention(value: Intervention) {
    const owner = this.db.prepare('SELECT session_id,stage_id FROM intervention_history WHERE request_id=? ORDER BY seq LIMIT 1').get(value.request_id) as { session_id: string; stage_id: string } | undefined;
    if (owner && (owner.session_id !== value.session_id || owner.stage_id !== value.stage_id)) throw new Error(`request_id ${value.request_id} 已属于其他阶段，拒绝写入。`);
    this.db.prepare('INSERT INTO intervention_history(session_id,stage_id,request_id,data) VALUES (?,?,?,?)').run(value.session_id, value.stage_id, value.request_id, JSON.stringify(value));
  }
  /** 某阶段全部历史记录（首条为原始发送意图），按写入顺序。 */
  interventionHistory(id: string, stageId: string): Intervention[] {
    return (this.db.prepare('SELECT data FROM intervention_history WHERE session_id=? AND stage_id=? ORDER BY seq').all(id, stageId) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  deviceAudit() {
    return (this.db.prepare("SELECT data FROM admin_audit WHERE json_extract(data,'$.event_type') IN ('device_status_changed','device_event_rejected') ORDER BY seq DESC LIMIT 100").all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  setting<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : undefined; }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close() { this.db.close(); }
}
