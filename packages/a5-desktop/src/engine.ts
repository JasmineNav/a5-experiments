import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store } from './store.ts';
import type { EventRecord, Intervention, Session, Phase, T0State } from './store.ts';
import { hash, InputError, itemResults, normalize, score } from './tasks.ts';
import type { DataTable, Field, Snapshot, Unit } from './tasks.ts';
import type { Condition, DisplayMode, GlassesAdapter, GlassesEvent, GlassesReceipt, Participant, ParticipantConfig } from './contracts.ts';
import { PreSendError, sendErrorDelivery } from '@a5/glasses/contracts.ts';
import { profile, stageIds } from './profile.ts';
import { validateConfig } from './config.ts';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface Command {
  command_id: string; page_token: string; action: string; answer?: Record<string, unknown>; open?: boolean;
  text?: string; target?: string; reminder_id?: string;
  client?: { timestamp_iso?: string; monotonic_ms?: number; time_origin_ms?: number; visibility_state?: string; user_agent?: string };
}
export type Material = Omit<Snapshot, 'participant' | 'config_hash' | 'content_hash'>;

/** 固定的 000 调试配置（V2分配表V1列，覆盖全部7种条件），不随正式被试预分配或后台导入变化。 */
const DEBUG_CONDITIONS: [Condition, string | null][] = [['N-T0', 'N01'], ['N-T1', 'N02'], ['A-T0', 'A03'], ['A-T1', 'A04'], ['N-T2', 'N05'], ['A-T2', 'A06'], ['NONE', null]];
const DEBUG_PARTICIPANT: Participant = {
  participant_id: '000', version_label: 'V1', debug: true, copied_from: '001',
  stages: stageIds.map((stage_id, i) => ({ stage_id, condition: DEBUG_CONDITIONS[i][0], message_id: DEBUG_CONDITIONS[i][1] })),
};
type Timing = 'T0' | 'T1' | 'T2';
/** 适配器发送上限；超时后中止尚未写入的调用，已写入的按 unacknowledged，不补发。 */
export const SEND_TIMEOUT_MS = 5000, SEND_ABORT_GRACE_MS = 250, SEND_TIMEOUT = 'adapter_send_timeout_unacknowledged';
/** 确定没有显示的投递结果：不占用显示，也不阻塞下一条。 */
const NOT_DISPLAYED = ['failed', 'not_sent'];
const ACTIVE_REST = ['requested', 'resting'];

export class Engine {
  private confirmations = new Map<string, Promise<unknown>>();
  private mode(s: Session): DisplayMode { return this.assignment(s).display_mode ?? s.snapshot.display_mode ?? 'legacy_8500'; }
  private messageMode(s: Session, m: Intervention): DisplayMode { return m.display_mode ?? s.snapshot.participant.stages.find(a => a.stage_id === m.stage_id)?.display_mode ?? s.snapshot.display_mode ?? 'legacy_8500'; }
  private sessionModes(s: Session): DisplayMode[] { return [...new Set(s.snapshot.participant.stages.filter(a => a.condition !== 'NONE').map(a => a.display_mode ?? s.snapshot.display_mode ?? 'legacy_8500'))]; }
  private pendingConfirmation(s: Session) {
    return this.store.interventions(s.id).find(m => this.messageMode(s, m) === 'confirm_until_ack' && m.status !== 'not_sent' && (m.source === 'device'
      ? !m.device_events?.some(e => e.kind === 'hidden')
      : m.confirmation_status !== 'accepted'));
  }
  /** 真机必须声明支持当前固定时长；旧版显示端（如1.1.3）只接受8500，发送后会被拒绝且不重发。 */
  requireFixedDuration(mode: DisplayMode, durationMs = this.material.content.message_duration_ms) {
    const device = this.adapter.getStatus();
    if(device.source!=='device')return;
    const caps=device.capabilities;
    if(caps){
      const wanted=mode==='confirm_until_ack'?'confirm_until_ack':'timed';
      if(!caps.commands.includes('show_text')||!caps.display_modes.includes(wanted)||durationMs<caps.text_duration_ms.min||durationMs>caps.text_duration_ms.max)throw new HttpError(409,'显示端能力不支持当前模式或时长，请更新共享显示端 APK。');
      if(mode==='tone_8500'&&(!caps.tone||!caps.tone_presets?.includes('notification')))throw new HttpError(409,'显示端缺少通知音能力，不能静默降级为无声。');
      return;
    }
    // 历史显式能力保留给旧快照/测试适配器，v2 真机客户端不走此兼容分支。
    if(mode==='confirm_until_ack'||device.device_info?.fixed_duration_ms?.split(',').includes(String(durationMs)))return;
    throw new HttpError(409,`当前眼镜显示端（${device.device_info?.app_version??'未知版本'}）不支持${durationMs/1000}秒固定时长，请更新显示端 APK。`);
  }
  private requirePreviousMessageFinished(s: Session) {
    if (this.store.interventions(s.id).some(m => m.data_kind === 'manual' && m.display_mode !== 'confirm_until_ack' && !NOT_DISPLAYED.includes(m.status) && (m.source === 'device' ? !m.device_events?.some(e => e.kind === 'hidden') : !!m.t_send && this.wallNow()-Date.parse(m.t_send)<m.duration_ms))) throw new HttpError(409, '手动通知仍在显示，请等待后再触发下一条。');
    if (this.pendingConfirmation(s)) throw new HttpError(409, '请先确认上一条眼镜消息，并等待眼镜消失回执，再触发下一条消息。');
  }
  private deviceUnavailable(s: Session) {
    const target = this.adapter.getStatus();
    return this.deliverySource(s) === 'device' && (this.deviceOperationsBusy?.() || !target.connected || !target.ready || target.busy || target.device_id !== s.state.device_id);
  }
  private guardTrigger(s: Session, timing: 'T0' | 'T1') {
    if(this.deviceOperationsBusy?.())throw new HttpError(409,'眼镜整备正在执行，请等待完成。');
    if (this.assignment(s).condition.endsWith(timing) && !this.store.interventions(s.id).some(m => m.stage_id === this.assignment(s).stage_id)) {
      this.requirePreviousMessageFinished(s);
      if (this.deviceUnavailable(s)) throw new HttpError(409,'眼镜未就绪或正在展示，当前触发操作未执行。请恢复眼镜后重试；不会补发旧消息。');
    }
  }
  private cancelOnEnd(id: string) {
    const s = this.session(id);
    if (s.state.status === 'active') return;
    for (const message of this.store.interventions(id).filter(m => this.messageMode(s, m) === 'confirm_until_ack' && m.device_events?.some(e => e.kind === 'drawn') && !m.device_events.some(e => e.kind === 'hidden'))) {
      const target = this.adapter.getStatus();
      if (target.source !== message.source || target.device_id !== message.device_id) continue;
      const task = Promise.resolve().then(() => {
        if (!this.adapter.cancel) throw new Error('cancellation_unsupported');
        return this.adapter.cancel({ request_id: message.request_id, device_id: message.device_id });
      }).catch(() => {
        const current = this.session(id); current.state.attention.push(`${message.stage_id}:cancellation_unknown`); this.store.save(current);
      });
      this.pending.add(task); void task.finally(() => this.pending.delete(task));
    }
  }
  /** 每次按钮点击先持久化，包括空点、未绘制和重复点击；网络重试不重复计数。 */
  async readNoticeClick(id: string, input: {click_id?:unknown;page_token?:unknown;client?:unknown;visible_request_id?:unknown}) {
    if(typeof input.click_id!=='string' || !/^[a-f0-9-]{36}$/.test(input.click_id)) throw new HttpError(422,'点击编号无效。');
    if(input.page_token!==undefined && (typeof input.page_token!=='string' || input.page_token.length>160)) throw new HttpError(422,'页面编号无效。');
    if(JSON.stringify(input).length>12000) throw new HttpError(422,'点击记录过长。');
    const s=this.session(id);this.requireAvailable(s);
    const key=`notice-click:${id}:${input.click_id}`, fingerprint=hash(input);
    let decision: {fingerprint:string;request_id:string|null;pending_request_id:string|null;disposition:string;event_id:string};
    this.store.tx(()=>{
      const prior=this.store.setting<typeof decision>(key);
      if(prior){if(prior.fingerprint!==fingerprint)throw new HttpError(409,'同一点击编号不能用于不同数据。');decision=prior;return;}
      const m=this.pendingConfirmation(s);
      const disposition=s.state.status!=='active'?'ignored_session_ended':s.state.paused_at_ms!==null?'ignored_paused':!m?'ignored_no_pending':m.status==='failed'?'ignored_failed':m.confirmation_status==='accepted'||m.device_events?.some(e=>e.kind==='confirmed')?'ignored_already_confirmed':m.status!=='accepted'||m.source==='device'&&!m.device_events?.some(e=>e.kind==='drawn')?'ignored_not_drawn':'confirmation_requested';
      const requestId=disposition==='confirmation_requested'?m!.request_id:null;
      const event=this.log(s,'notice_read_clicked',{click_id:input.click_id,client:input.client??null,page_token:input.page_token??null,page_token_matches:input.page_token===s.state.page_token,phase:s.state.phase,current_stage_id:this.assignment(s).stage_id,current_unit_id:s.state.phase==='UNIT'?this.unit(s).unit_id:null,visible_request_id:input.visible_request_id??null,pending_request_id:m?.request_id??null,confirmation_request_id:requestId,disposition,semantics:'button_click_not_attention_onset'},m?{stage_id:m.stage_id,unit_id:null,condition:m.condition}:undefined);
      decision={fingerprint,request_id:requestId,pending_request_id:m?.request_id??null,disposition,event_id:event.event_id};
      this.store.setSetting(key,decision);this.store.save(s);
    });
    if(decision!.request_id)await this.confirmMessage(id,decision!.request_id,input.client??null);
    const {fingerprint:_,...click}=decision!;
    return {view:this.view(id),click};
  }
  async confirmMessage(id: string, requestId: string, client: unknown = null) {
    const s = this.session(id); this.requireAvailable(s);
    if (s.state.status !== 'active' || s.state.paused_at_ms !== null) throw new HttpError(409, '当前会话不可确认消息。');
    const message = this.store.findRequest(requestId);
    if (!message || message.session_id !== id) throw new HttpError(404, '此消息不属于当前会话。');
    if (this.messageMode(s, message) !== 'confirm_until_ack') throw new HttpError(409, '此消息不需要确认。');
    if (message.device_events?.some(e => e.kind === 'confirmed' || e.kind === 'hidden')) return this.view(id);
    if (message.status === 'failed' || (message.source === 'device' && !message.device_events?.some(e => e.kind === 'drawn')) || message.status !== 'accepted') throw new HttpError(409, '消息尚未成功绘制，不能确认。');
    const target = this.adapter.getStatus();
    if (target.source !== message.source || message.device_id && target.device_id !== message.device_id || !this.adapter.confirm) throw new HttpError(409, '确认设备不可用或绑定不一致。');
    const prior = this.confirmations.get(requestId); if (prior) { await prior; return this.view(id); }
    if (!message.confirmation_requested_at) this.store.tx(() => {
      message.confirmation_requested_at = this.iso(); message.confirmation_elapsed_ms = this.elapsed(s);
      message.confirmation_status = 'pending'; this.store.intervention(message);
      this.log(s, 'message_user_confirmed', { request_id: requestId, client, semantics: 'explicit_confirmation_not_attention_onset' }, { stage_id: message.stage_id, unit_id: null, condition: message.condition }); this.store.save(s);
    });
    let timer: ReturnType<typeof setTimeout>;
    const confirmation = Promise.resolve().then(() => this.adapter.confirm!({ request_id: requestId, device_id: message.device_id }));
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('confirmation_timeout')), 5000); });
    const task = Promise.race([confirmation, deadline]).then(() => {
      const latest = this.store.findRequest(requestId)!; latest.confirmation_status = 'accepted'; this.store.intervention(latest);
    }).catch(error => {
      const latest = this.store.findRequest(requestId)!; latest.confirmation_status = latest.device_events?.some(e => e.kind === 'confirmed') ? 'accepted' : 'unknown'; this.store.intervention(latest);
      throw new HttpError(503, '确认结果待核查，请重试同一条确认；不会重新发送消息或重置已开始的计时。');
    });
    this.confirmations.set(requestId, task);
    // 退出也要等待确认意图落盘；失败不阻止统一关闭流程。
    const settling = task.catch(() => {}); this.pending.add(settling);
    try { await task; } finally { clearTimeout(timer!); this.confirmations.delete(requestId); this.pending.delete(settling); }
    return this.view(id);
  }
  /** 由设备控制器提供互斥状态，阻止在控制或独立通知期间创建会话。 */
  deviceControlBusy?: () => boolean;
  deviceOperationsBusy?: () => boolean;
  /** 优先消费独立通知事件；返回 true 时不写入实验消息记录。 */
  deviceDebugEvent?: (event: GlassesEvent) => boolean;
  readonly store: Store;
  readonly adapter: GlassesAdapter;
  readonly material: Material;
  /** 服务启动时注入：返回本次运行的版本坐标，建会话时写入快照与 session_created。 */
  runVersions?: () => Record<string, unknown>;
  /** 注入的统一时间源；设备控制与 HTTP 层共用，测试可整体替换。 */
  readonly clock: Clock;
  private readonly wallNow: () => number;
  private readonly monoNow: () => number;
  private readonly clocks = new Map<string, { base: number; origin: number }>();
  private readonly pending = new Set<Promise<void>>();

  constructor(store: Store, adapter: GlassesAdapter, material: Material, initialConfig: ParticipantConfig, clock: Clock = systemClock) {
    this.store = store; this.adapter = adapter; this.material = material; this.clock = clock;
    this.wallNow = clock.wall; this.monoNow = clock.mono;
    if (!store.setting('participants')) this.importConfig(initialConfig);
    for (const id of store.allIds()) {
      const session = this.session(id);
      this.store.tx(() => {
        if (session.state.status === 'active') this.log(session, 'server_restarted', { clock_source: 'max(persisted_elapsed,wall_since_start)', downtime_included: true });
        for (const message of this.store.interventions(id)) if (['scheduled', 'send_requested'].includes(message.status)) {
          message.status = 'unknown'; message.error = 'server_restarted_delivery_unknown'; this.store.intervention(message);
          session.state.attention.push(`${message.stage_id}:message_delivery_unknown`);
          this.log(session, 'message_failed', { request_id: message.request_id, reason: message.error, retry: false }, { stage_id: message.stage_id, unit_id: null, condition: message.condition });
        }
        this.store.save(session);
      });
    }
  }

  config(): ParticipantConfig { return this.store.setting<ParticipantConfig>('participants')!; }
  debugParticipant(): Participant { return structuredClone(this.config().debug_participant ?? DEBUG_PARTICIPANT); }
  isDebug(s: Session) { return s.snapshot.participant.participant_id === '000' && s.snapshot.participant.debug === true && s.snapshot.participant.copied_from === '001'; }
  importConfig(input: unknown) {
    const errors = validateConfig(input, this.material.stimuli);
    if (errors.length) throw new HttpError(422, errors.join('\n'));
    this.store.tx(() => {
      this.store.setSetting('participants', input);
      this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'config_imported', timestamp_iso: this.iso(), config_hash: hash(input) }));
    });
    return this.config();
  }
  iso() { return new Date(this.wallNow()).toISOString(); }
  session(id: string) { const s = this.store.get(id); if (!s) throw new HttpError(404, '会话不存在。'); return s; }
  private requireAvailable(s: Session) { if (s.state.deleted) throw new HttpError(410, '此会话记录已删除，请先在后台恢复记录。'); }
  authenticate(id: string, token: string) {
    const session = this.session(id);
    const candidate = hash(token);
    if (!token || !timingSafeEqual(Buffer.from(candidate), Buffer.from(session.token_hash))) throw new HttpError(401, '被试访问凭据无效。');
    this.requireAvailable(session);
    return session;
  }
  elapsed(s: Session) {
    let clock = this.clocks.get(s.id);
    if (!clock) {
      clock = { base: Math.max(s.state.last_elapsed_ms, this.wallNow() - Date.parse(s.state.started_at), 0), origin: this.monoNow() };
      this.clocks.set(s.id, clock);
    }
    return Math.max(s.state.last_elapsed_ms, Math.floor(clock.base + this.monoNow() - clock.origin));
  }
  log(s: Session, type: string, payload: Record<string, unknown> = {}, context?: { stage_id?: string; unit_id?: string | null; condition?: string }) {
    const stage = s.snapshot.content.stages[s.state.stage];
    const assignment = s.snapshot.participant.stages.find(a => a.stage_id === stage?.stage_id);
    const practice = this.practiceUnit(s);
    const elapsed = this.elapsed(s); s.state.last_elapsed_ms = elapsed;
    const event: EventRecord = {
      event_id: randomUUID(), session_id: s.id, participant_id: s.snapshot.participant.participant_id,
      stage_id: context?.stage_id ?? (practice ? 'TUTORIAL' : s.state.phase === 'INTRO' ? null : stage?.stage_id ?? null),
      unit_id: context?.unit_id === undefined ? (practice ? practice.unit_id : s.state.phase === 'UNIT' ? stage.units[s.state.unit].unit_id : null) : context.unit_id,
      condition: context?.condition ?? (practice ? 'TUTORIAL' : s.state.phase === 'INTRO' ? null : assignment?.condition ?? null),
      data_kind: context?.stage_id?.startsWith('MANUAL_') ? 'manual' : context?.stage_id === 'TUTORIAL' || s.state.phase.startsWith('TUTORIAL') ? 'tutorial' : 'formal',
      event_type: type, timestamp_iso: this.iso(), elapsed_ms: elapsed, payload, content_version: s.snapshot.content.content_version, is_debug: this.isDebug(s),
    };
    this.store.event(event); return event;
  }
  /** 在设备空闲且编号没有活跃会话时，固定材料快照并创建实验会话。 */
  create(participantId: string, metadata: Record<string, unknown> = {}) {
    const mode = metadata.display_mode ?? 'legacy_8500';
    if (!['legacy_8500', 'tone_8500', 'confirm_until_ack'].includes(String(mode))) throw new HttpError(422, '消息呈现策略无效。');
    if (this.deviceControlBusy?.()) throw new HttpError(409, '眼镜正在执行控制或测试通知，请等待完成后再创建会话。');
    const participant = participantId === '000' ? this.debugParticipant() : this.config().participants.find(p => p.participant_id === participantId);
    if (!participant) throw new HttpError(404, '被试不在当前已导入配置中。');
    if (this.store.ids().some(id => { const s = this.session(id); return s.snapshot.participant.participant_id === participantId && s.state.status === 'active'; })) throw new HttpError(409, '该被试已有未结束会话，请恢复已有会话。');
    const device = this.adapter.getStatus();
    if (device.source === 'device') {
      if (!device.capabilities && participant.stages.some(a => a.condition !== 'NONE' && (a.display_mode ?? mode) !== 'legacy_8500' && !device.device_info?.display_modes?.split(',').includes(String(a.display_mode ?? mode)))) throw new HttpError(409, '当前眼镜应用不支持所选策略，请先更新显示端 APK。');
      for (const a of participant.stages) if (a.condition !== 'NONE') this.requireFixedDuration((a.display_mode ?? mode) as DisplayMode);
      if (!device.connected || !device.ready || device.busy || !device.device_id) throw new HttpError(409, '眼镜尚未就绪，请检查 USB、授权和显示端前台状态。');
      if (this.store.ids().some(id => { const existing = this.session(id); return existing.state.status === 'active' && existing.state.device_id === device.device_id; })) throw new HttpError(409, '此眼镜已绑定一个进行中的会话，请先结束该会话。');
    }
    const token = randomBytes(32).toString('hex');
    const run_versions = { ...(this.runVersions?.() ?? {}), delivery_source: device.source, app_version: device.device_info?.app_version ?? null };
    const snapshot: Snapshot = structuredClone({ ...this.material, display_mode: mode as DisplayMode, participant, config_hash: hash(participant), content_hash: hash(this.material), run_versions });
    const s: Session = { id: randomUUID(), token_hash: hash(token), snapshot, state: {
      phase: metadata.tutorial_enabled ? 'TUTORIAL_INTRO' : 'INTRO', stage: 0, unit: 0, page_token: randomUUID(), displayed: {}, drafts: {}, reveals: {},
      started_at: this.iso(), ended_at: null, ended_elapsed_ms: null, last_elapsed_ms: 0, break_until_ms: null, break_completed: false,
      paused_at_ms: null, attention: [], status: 'active', scratchpads: {}, delivery_source: device.source, ...(device.source === 'device' ? { device_id: device.device_id } : {}),
    } };
    this.clocks.set(s.id, { base: 0, origin: this.monoNow() });
    this.store.tx(() => {
      this.store.create(s);
      this.log(s, 'session_created', { config_hash: snapshot.config_hash, content_hash: snapshot.content_hash, stimulus_version: snapshot.stimulus_version, adapter: this.adapter.getStatus(), run_versions, metadata, is_debug: this.isDebug(s), copied_from: participant.copied_from ?? null });
      this.store.save(s);
    });
    return { session_id: s.id, token, view: this.view(s.id) };
  }
  rotateToken(id: string) {
    const token = randomBytes(32).toString('hex');
    this.store.tx(() => {
      const s = this.session(id);
      this.requireAvailable(s);
      this.store.db.prepare('UPDATE sessions SET token_hash=? WHERE id=?').run(hash(token), id);
      this.log(s, 'admin_intervention', { action: 'participant_token_rotated' }); this.store.save(s);
    });
    return token;
  }
  unit(s: Session): Unit { return s.snapshot.content.stages[s.state.stage].units[s.state.unit]; }
  /** 练习单元（2026-10-30起的快照）：TUTORIAL_UNIT1/2 对应 content.practice.units[0/1]；旧快照没有。 */
  practiceUnit(s: Session): Unit | undefined {
    const index = s.state.phase === 'TUTORIAL_UNIT1' ? 0 : s.state.phase === 'TUTORIAL_UNIT2' ? 1 : -1;
    return index < 0 ? undefined : s.snapshot.content.practice?.units[index];
  }
  /** 当前页面所属的任务单元：正式任务页或练习单元页。 */
  private pageUnit(s: Session): Unit | undefined { return this.practiceUnit(s) ?? (s.state.phase === 'UNIT' ? this.unit(s) : undefined); }
  assignment(s: Session) { return s.snapshot.participant.stages.find(a => a.stage_id === s.snapshot.content.stages[s.state.stage].stage_id)!; }
  stimulus(s: Session) {
    const a = this.assignment(s); const stimulus = s.snapshot.stimuli.find(m => m.stage_id === a.stage_id && m.message_id === a.message_id);
    if (!stimulus) throw new HttpError(409, '当前配置缺少刺激或理解题。'); return stimulus;
  }
  fields(s: Session): Field[] {
    if (s.state.phase === 'UNIT') return this.unit(s).fields;
    const practice = this.practiceUnit(s);
    if (practice) return practice.fields;
    if (s.state.phase === 'TUTORIAL_CHECK') return [{id:'answer',label:'练习会议安排在哪个会议室？',type:'single',required:true,options:[{value:'A',label:'一号会议室'},{value:'B',label:'二号会议室'},{value:'C',label:'三号会议室'}]}];
    if (s.state.phase === 'COMPREHENSION') {
      const page = s.snapshot.content.survey_pages?.comprehension;
      return [...(page ? [page.notice_field] : []), { id: 'answer', label: `${page ? '第2题：' : ''}${this.stimulus(s).question}`, type: 'single' as const, required: true, options: this.stimulus(s).options.map(o => ({ value: o.id, label: `${o.id} ${o.text}` })) }];
    }
    if (s.state.phase === 'RATINGS') return s.snapshot.content.ratings.map((r, index) => ({ id: r.id,
      label: r.min_label && r.max_label ? `${index + 1}. ${r.label} ${r.min}分（${r.min_label}） ${r.max}分（${r.max_label}）` : r.label,
      type: 'single', required: true, options: Array.from({ length: r.max - r.min + 1 }, (_, i) => ({ value: String(i + r.min), label: String(i + r.min) })) }));
    return [];
  }
  draftKey(s: Session) { return `${s.state.stage}:${s.state.phase}:${s.state.unit}`; }
  transition(s: Session, phase: Phase) { s.state.phase = phase; s.state.page_token = randomUUID(); }
  debugTargets(s: Session) {
    const targets: { id: string; label: string; phase: Phase; stage: number; unit: number }[] = [{ id: 'INTRO', label: '情景导入', phase: 'INTRO', stage: 0, unit: 0 }];
    const tutorial: typeof targets = [{id:'TUTORIAL_INTRO',label:'工作台、草稿本与时间',phase:'TUTORIAL_INTRO',stage:0,unit:0}];
    if (s.snapshot.content.practice) {
      s.snapshot.content.practice.units.forEach((unit, i) => tutorial.push({ id: `TUTORIAL_UNIT${i + 1}`, label: unit.title, phase: i === 0 ? 'TUTORIAL_UNIT1' : 'TUTORIAL_UNIT2', stage: 0, unit: 0 }));
      if (s.snapshot.content.tutorial_notice_after_practice && this.sessionModes(s).includes('confirm_until_ack')) tutorial.push(
        {id:'TUTORIAL_NOTICE',label:'阅读并确认练习消息',phase:'TUTORIAL_NOTICE',stage:0,unit:0},
        {id:'TUTORIAL_CHECK',label:'消息理解题',phase:'TUTORIAL_CHECK',stage:0,unit:0});
    }
    else {
      // 旧快照：休息练习页与消息练习仍按原流程。
      if(s.snapshot.content.in_unit_rest) tutorial.push({id:'TUTORIAL_REST',label:'第二单元中的休息',phase:'TUTORIAL_REST',stage:0,unit:0});
      if(this.sessionModes(s).includes('confirm_until_ack')) tutorial.push(
        {id:'TUTORIAL_NOTICE',label:'阅读并确认练习消息',phase:'TUTORIAL_NOTICE',stage:0,unit:0},
        {id:'TUTORIAL_CHECK',label:'消息理解题',phase:'TUTORIAL_CHECK',stage:0,unit:0});
    }
    targets.unshift(...tutorial.map((t, i) => ({ ...t, label: `教程${i + 1}：${t.label}` })));
    for (const [index, stage] of s.snapshot.content.stages.entries()) {
      targets.push({ id: `${stage.stage_id}_CARD`, label: `${stage.stage_id} 说明卡`, phase: 'CARD', stage: index, unit: 0 });
      stage.units.forEach((unit, n) => targets.push({ id: unit.unit_id, label: `${stage.stage_id} ${unit.title}`, phase: 'UNIT', stage: index, unit: n }));
      if (s.snapshot.participant.stages.find(a => a.stage_id === stage.stage_id)?.condition !== 'NONE') {
        targets.push({ id: `${stage.stage_id}_COMPREHENSION`, label: `${stage.stage_id} ${s.snapshot.content.survey_pages?.comprehension.title ?? '眼镜中的关键信息获取题'}`, phase: 'COMPREHENSION', stage: index, unit: 1 });
        targets.push({ id: `${stage.stage_id}_RATINGS`, label: `${stage.stage_id} ${s.snapshot.content.survey_pages?.ratings.title ?? '眼镜消息体验评价'}`, phase: 'RATINGS', stage: index, unit: 1 });
      }
      if (!s.snapshot.content.in_unit_rest && index < s.snapshot.content.stages.length - 1) targets.push({ id: `${stage.stage_id}_BREAK`, label: `${stage.stage_id} 休息`, phase: 'BREAK', stage: index, unit: 1 });
    }
    targets.push({ id: 'COMPLETED', label: '完成页', phase: 'COMPLETED', stage: s.snapshot.content.stages.length - 1, unit: 1 });
    return targets;
  }
  private jump(s: Session, targetId: unknown, actor: 'admin' | 'participant', reason: string) {
    if (actor === 'participant' && !this.isDebug(s)) throw new HttpError(403, '只有调试测试者000可以自由跳转。');
    const target = this.debugTargets(s).find(t => t.id === targetId);
    if (!target) throw new HttpError(422, '调试跳转目标无效。');
    this.log(s, 'debug_jump', { from_phase: s.state.phase, from_stage: s.state.stage, from_unit: s.state.unit, target: target.id, actor, reason, is_debug: this.isDebug(s) });
    this.interruptRests(s, 'debug_jump');
    for (const [k, p] of Object.entries(s.state.t0 ?? {})) if (!p.fired) delete s.state.t0![k];
    s.state.stage = target.stage; s.state.unit = target.unit; s.state.paused_at_ms = null;
    s.state.status = target.phase === 'COMPLETED' ? 'completed' : 'active';
    s.state.ended_at = target.phase === 'COMPLETED' ? this.iso() : null;
    s.state.ended_elapsed_ms = target.phase === 'COMPLETED' ? this.elapsed(s) : null;
    s.state.break_until_ms = null; s.state.break_completed = false;
    s.state.break_displayed_at = null; s.state.break_displayed_elapsed_ms = null;
    this.transition(s, target.phase);
    if (target.phase === 'BREAK') {
      this.prepareBreak(s, true);
    }
  }
  private prepareBreak(s: Session, sourceDebugJump = false) {
    s.state.break_until_ms = null; s.state.break_completed = false;
    s.state.break_displayed_at = null; s.state.break_displayed_elapsed_ms = null;
    // 旧快照沿用原计时起点；新配置等待休息页可见回执。
    if (!s.snapshot.content.break_start_on_display) {
      s.state.break_until_ms = this.elapsed(s) + this.breakMs(s);
      this.log(s, 'break_started', { duration_ms: this.breakMs(s), until_elapsed_ms: s.state.break_until_ms, break_id: s.state.page_token, source_debug_jump: sourceDebugJump });
    }
  }
  private completeBreak(s: Session) {
    if (s.state.break_completed || s.state.break_until_ms === null || this.elapsed(s) < s.state.break_until_ms) return;
    s.state.break_completed = true;
    const endedAt = s.state.break_displayed_at && s.state.break_displayed_elapsed_ms != null
      ? new Date(Date.parse(s.state.break_displayed_at) + s.state.break_until_ms - s.state.break_displayed_elapsed_ms).toISOString() : null;
    this.log(s, 'break_completed', { break_id: s.state.page_token, countdown_ended_at: endedAt, countdown_ended_elapsed_ms: s.state.break_until_ms });
  }
  private breakMs(s: Session) { return s.snapshot.content.break_ms ?? 30000; }
  private actualRest(s: Session, at = this.elapsed(s)) {
    return s.state.break_displayed_elapsed_ms == null ? null : Math.max(0, at - s.state.break_displayed_elapsed_ms);
  }
  private nextAfterBreak(s: Session) {
    s.state.stage++; s.state.unit = 0; s.state.break_until_ms = null;
    s.state.break_displayed_at = null; s.state.break_displayed_elapsed_ms = null;
    this.transition(s, 'CARD');
  }
  private skipBreak(s: Session, actor: 'admin' | 'participant', reason: string) {
    if (s.state.phase !== 'BREAK' || s.state.paused_at_ms !== null || s.state.status !== 'active') throw new HttpError(409, '当前不是可跳过的休息状态。');
    if (s.snapshot.content.allow_break_skip === false) throw new HttpError(409, '此会话协议未开放跳过休息。');
    this.completeBreak(s);
    const remaining = s.state.break_until_ms === null ? this.breakMs(s) : Math.max(0, s.state.break_until_ms - this.elapsed(s));
    this.log(s, 'break_skipped', { break_id: s.state.page_token, actor, reason, remaining_ms: remaining, actual_rest_ms: this.actualRest(s), planned_rest_ms: this.breakMs(s) });
    this.nextAfterBreak(s);
  }
  stageEnd(s: Session) {
    this.log(s, 'stage_completed');
    if (s.state.stage === s.snapshot.content.stages.length - 1) {
      this.transition(s, 'COMPLETED'); s.state.status = 'completed'; s.state.ended_at = this.iso(); s.state.ended_elapsed_ms = this.elapsed(s);
      this.log(s, 'session_completed', { ...this.presentation(s.id), attention_count: s.state.attention.length });
    } else if (s.snapshot.content.in_unit_rest) {
      // V2取消组间休息：问卷（或NONE/T2未触发组的U2）提交后直接进入下一组说明卡。
      s.state.stage++; s.state.unit = 0; this.transition(s, 'CARD');
    } else {
      this.transition(s, 'BREAK'); this.prepareBreak(s);
    }
  }
  tick(id: string) {
    const s = this.session(id);
    if (s.state.status !== 'active' || s.state.paused_at_ms !== null) return;
    const now = this.elapsed(s);
    const t0Due = Object.values(s.state.t0 ?? {}).filter(p => !p.fired && p.due_ms !== null && now >= p.due_ms);
    if (t0Due.length) {
      this.store.tx(() => { for (const p of t0Due) this.fireT0(s, p); this.store.save(s); });
      this.dispatch(id);
    }
    const resting = Object.values(s.state.rests ?? {}).filter(r => r.status === 'resting' && ((r.t2_due_ms !== null && !r.t2_fired && now >= r.t2_due_ms) || now >= r.until_ms!));
    if (resting.length) {
      this.store.tx(() => {
        for (const r of resting) {
          if (r.t2_due_ms !== null && !r.t2_fired && now >= r.t2_due_ms) this.fireT2(s, r);
          if (now >= r.until_ms!) { r.status = 'returning'; r.countdown_ended_elapsed_ms = r.until_ms; this.log(s, 'rest_countdown_ended', { rest_id: r.rest_id, rest_key: r.key, countdown_ended_elapsed_ms: r.until_ms }); }
        }
        this.store.save(s);
      });
      this.dispatch(id);
    }
    if (s.state.phase !== 'BREAK' || s.state.break_completed || s.state.break_until_ms === null || now < s.state.break_until_ms) return;
    this.store.tx(() => { this.completeBreak(s); this.store.save(s); });
  }

  /* ───── V2：第二单元内被试自主休息与T2 ───── */
  private restKey(s: Session): string | null {
    if (!s.snapshot.content.in_unit_rest || s.state.status !== 'active') return null;
    if (s.state.phase === 'TUTORIAL_REST') return 'TUTORIAL';
    if (s.state.phase === 'TUTORIAL_UNIT2' && s.snapshot.content.practice) return 'PRACTICE';
    return s.state.phase === 'UNIT' && s.state.unit === 1 ? s.snapshot.content.stages[s.state.stage].stage_id : null;
  }
  private restDuration(s: Session, key: string) { const c = s.snapshot.content.in_unit_rest!; return key === 'TUTORIAL' ? c.tutorial_duration_ms : key === 'PRACTICE' ? c.practice_duration_ms! : c.duration_ms; }
  private restWindow(s: Session, key: string) { const c = s.snapshot.content.in_unit_rest!; return key === 'TUTORIAL' ? 0 : key === 'PRACTICE' ? c.practice_window_min_ms! : c.window_min_ms_by_stage?.[key] ?? c.window_min_ms; }
  private u2Elapsed(s: Session, key: string, at = this.elapsed(s)) { const shown = s.state.u2_displayed_elapsed?.[key]; return shown === undefined ? null : Math.max(0, at - shown); }
  private activeRest(s: Session) { const key = this.restKey(s); const r = key ? s.state.rests?.[key] : undefined; return r && ACTIVE_REST.includes(r.status) ? r : undefined; }
  private requireNotResting(s: Session) { if (this.activeRest(s)) throw new HttpError(409, '正在休息，休息结束后会自动回到任务。'); }
  /** 休息计时依赖服务端轮询；另设精确定时器，使T2尽量贴近休息开始后的计划时刻。 */
  private wake(id: string, delay: number) {
    const timer = setTimeout(() => { try { this.tick(id); } catch { /* 服务关闭后忽略，由轮询兜底 */ } }, Math.max(0, delay) + 5);
    timer.unref?.();
  }
  private fireT2(s: Session, r: import('./store.ts').RestState) {
    r.t2_fired = true;
    const a = s.snapshot.participant.stages.find(x => x.stage_id === r.key);
    if (!a || !a.condition.endsWith('T2') || this.store.interventions(s.id).some(m => m.stage_id === a.stage_id)) return;
    const now = this.elapsed(s);
    const due = this.log(s, 'rest_t2_due', { rest_id: r.rest_id, planned_elapsed_ms: r.t2_due_ms, delay_ms: s.snapshot.content.in_unit_rest!.t2_delay_ms, actual_delay_ms: now - r.started_elapsed_ms! }, { stage_id: a.stage_id, unit_id: `${a.stage_id}_U2`, condition: a.condition });
    let blocked: string | null = null;
    try { this.requirePreviousMessageFinished(s); } catch { blocked = 'previous_message_pending'; }
    if (!blocked && this.deviceUnavailable(s)) blocked = 'device_not_ready_at_t2';
    if (!blocked) { this.schedule(s, due, 'T2'); return; }
    // 第5秒时眼镜不可用：不覆盖、不排队、不补发，记录失败原因；与“T2未触发”区分。
    this.recordDeferredFailure(s, a, due, blocked, 'T2', `${a.stage_id}_U2`, { rest_id: r.rest_id });
  }
  private recordDeferredFailure(s: Session, a: Participant['stages'][number], due: EventRecord, blocked: string, timing: Timing, unitId: string, extra: Record<string, unknown>) {
    const message: Intervention = { session_id: s.id, participant_id: s.snapshot.participant.participant_id, stage_id: a.stage_id, message_id: a.message_id!, condition: a.condition,
      device_id: s.state.device_id, device_events: [], request_id: randomUUID(), status: 'failed', source: this.deliverySource(s), duration_ms: this.mode(s) === 'confirm_until_ack' ? 8500 : s.snapshot.content.message_duration_ms,
      display_mode: this.mode(s), t_event: due.timestamp_iso, event_elapsed_ms: due.elapsed_ms, t_send: null, t_ack: null, t_display: null, t_hide: null,
      display_time_source: 'unavailable', receipt: null, error: blocked };
    this.store.intervention(message); s.state.attention.push(`${a.stage_id}:${blocked}`);
    this.log(s, 'message_failed', { request_id: message.request_id, reason: blocked, retry: false, timing, trigger_event_id: due.event_id, ...extra }, { stage_id: a.stage_id, unit_id: unitId, condition: a.condition });
  }
  /** SL的T0：U1非空作答项首次达到阈值（失去焦点）后delay_ms送达；到点时眼镜不可用则只记失败，不补发。 */
  private fireT0(s: Session, p: T0State) {
    p.fired = true;
    const a = s.snapshot.participant.stages.find(x => x.stage_id === p.key), cfg = s.snapshot.content.t0_trigger;
    if (!a || !cfg || !a.condition.endsWith('T0') || this.store.interventions(s.id).some(m => m.stage_id === a.stage_id)) return;
    const now = this.elapsed(s);
    const due = this.log(s, 't0_due', { planned_elapsed_ms: p.due_ms, delay_ms: cfg.delay_ms, actual_delay_ms: now - p.threshold_elapsed_ms, threshold_event_id: p.threshold_event_id }, { stage_id: a.stage_id, unit_id: `${a.stage_id}_U1`, condition: a.condition });
    let blocked: string | null = null;
    if (this.assignment(s).stage_id !== a.stage_id) blocked = 'stage_changed_before_t0';
    else { try { this.requirePreviousMessageFinished(s); } catch { blocked = 'previous_message_pending'; } }
    if (!blocked && this.deviceUnavailable(s)) blocked = 'device_not_ready_at_t0';
    if (!blocked) { this.schedule(s, due, 'T0'); return; }
    this.recordDeferredFailure(s, a, due, blocked, 'T0', `${a.stage_id}_U1`, { threshold_event_id: p.threshold_event_id });
  }
  /** U1作答项失去焦点：保存草稿，并在非空作答项数量首次达到阈值时记录并排定T0（之后清空或修改不重算）。 */
  private answersBlur(s: Session, command: Command, client: unknown) {
    const cfg = s.snapshot.content.t0_trigger, state = s.state;
    if (!cfg || state.phase !== 'UNIT' || state.unit !== 0) throw new HttpError(409, '当前页面没有此操作。');
    const raw = command.answer;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 20000) throw new HttpError(422, '答案格式无效。');
    const fields = this.fields(s);
    if (Object.keys(raw).some(k => !fields.some(f => f.id === k))) throw new HttpError(422, '答案包含不属于本题的字段。');
    const key = this.draftKey(s);
    if (JSON.stringify(state.drafts[key]) !== JSON.stringify(raw)) { state.drafts[key] = raw; this.log(s, 'answer_changed', { raw_answer: raw, client }); }
    const stageId = this.assignment(s).stage_id;
    if (state.t0?.[stageId]) return;
    const filled = fields.filter(f => Array.isArray(raw[f.id]) ? (raw[f.id] as unknown[]).length > 0 : raw[f.id] !== undefined && raw[f.id] !== null && String(raw[f.id]).trim() !== '');
    if (filled.length < cfg.min_answers) return;
    const event = this.log(s, 'answers_threshold_reached', { answered_fields: filled.length, field_ids: filled.map(f => f.id), min_answers: cfg.min_answers, trigger: 'blur', client, semantics: 'nonempty_fields_first_reached_threshold_on_blur' });
    const triggers = this.assignment(s).condition.endsWith('T0');
    const entry: T0State = { key: stageId, threshold_event_id: event.event_id, threshold_elapsed_ms: event.elapsed_ms, due_ms: triggers ? event.elapsed_ms + cfg.delay_ms : null, fired: !triggers };
    (state.t0 ??= {})[stageId] = entry;
    if (triggers) { this.log(s, 't0_planned', { planned_elapsed_ms: entry.due_ms, delay_ms: cfg.delay_ms, message_id: this.assignment(s).message_id, threshold_event_id: event.event_id }); this.wake(s.id, cfg.delay_ms); }
  }
  private interruptRests(s: Session, reason: string) {
    for (const r of Object.values(s.state.rests ?? {})) if (r.status !== 'done') {
      r.status = 'done'; r.end_reason = reason;
      this.log(s, 'rest_interrupted', { rest_id: r.rest_id, rest_key: r.key, reason, started_elapsed_ms: r.started_elapsed_ms });
    }
  }
  private restClick(s: Session, client: unknown) {
    const key = this.restKey(s);
    if (!key) throw new HttpError(409, '当前页面没有休息功能。');
    const c = s.snapshot.content.in_unit_rest!, prior = s.state.rests?.[key], reminders = s.state.rest_reminders?.[key] ?? [];
    const u2 = this.u2Elapsed(s, key), windowMs = this.restWindow(s, key);
    const disposition = prior ? (prior.status === 'done' ? 'already_rested' : 'already_resting') : key !== 'TUTORIAL' && (u2 === null || u2 < windowMs) ? 'too_early' : 'rest_requested';
    const restId = disposition === 'rest_requested' ? randomUUID() : prior?.rest_id ?? null;
    const event = this.log(s, 'rest_clicked', { rest_key: key, rest_id: restId, disposition, u2_elapsed_ms: u2, window_min_ms: windowMs, window_open: key === 'TUTORIAL' || (u2 !== null && u2 >= windowMs), reminder_count: reminders.length, client });
    const text = disposition === 'too_early' ? c.early_click_text : disposition === 'already_rested' ? c.already_rested_text : null;
    if (text) (s.state.rest_feedback ??= {})[key] = { id: event.event_id, text };
    if (disposition === 'rest_requested') (s.state.rests ??= {})[key] = { rest_id: restId!, key, status: 'requested', click_event_id: event.event_id, requested_elapsed_ms: event.elapsed_ms, after_reminder: reminders.length > 0,
      started_at: null, started_elapsed_ms: null, until_ms: null, countdown_ended_elapsed_ms: null, returned_elapsed_ms: null, paused_ms: 0, paused_during: false, t2_due_ms: null, t2_fired: false };
  }
  /** 休息页实际可见才算休息开始；记录作答进度与答案快照，T2组排定送达时刻。 */
  private restDisplayed(s: Session, client: { visibility_state?: string }) {
    const key = this.restKey(s), r = key ? s.state.rests?.[key] : undefined;
    if (!key || !r) throw new HttpError(409, '当前没有待开始的休息。');
    if (client.visibility_state !== 'visible') throw new HttpError(422, '只有实际可见页面才能报告休息开始。');
    if (r.status !== 'requested') return;
    const c = s.snapshot.content.in_unit_rest!, fields = this.fields(s), draft = s.state.drafts[this.draftKey(s)] ?? {};
    const answered = fields.filter(f => Array.isArray(draft[f.id]) ? (draft[f.id] as unknown[]).length > 0 : draft[f.id] !== undefined && draft[f.id] !== null && String(draft[f.id]).trim() !== '').length;
    const a = key === 'TUTORIAL' ? undefined : s.snapshot.participant.stages.find(x => x.stage_id === key);
    const t2 = !!a?.condition.endsWith('T2') && !this.store.interventions(s.id).some(m => m.stage_id === key);
    const started = this.log(s, 'rest_started', { rest_id: r.rest_id, rest_key: key, client, click_event_id: r.click_event_id, duration_ms: this.restDuration(s, key), after_reminder: r.after_reminder,
      reminder_count: (s.state.rest_reminders?.[key] ?? []).length, answered_fields: answered, total_fields: fields.length, answer_snapshot: draft,
      scratchpad_length: (s.state.scratchpads?.[key === 'TUTORIAL' ? 'TUTORIAL' : `${key}_U2`] ?? '').length, u2_elapsed_ms: this.u2Elapsed(s, key), window_min_ms: this.restWindow(s, key) });
    r.status = 'resting'; r.started_at = started.timestamp_iso; r.started_elapsed_ms = started.elapsed_ms; r.until_ms = started.elapsed_ms + this.restDuration(s, key);
    if (t2) { r.t2_due_ms = started.elapsed_ms + c.t2_delay_ms; this.log(s, 'rest_t2_planned', { rest_id: r.rest_id, planned_elapsed_ms: r.t2_due_ms, delay_ms: c.t2_delay_ms, message_id: a!.message_id }); this.wake(s.id, c.t2_delay_ms); }
    this.wake(s.id, this.restDuration(s, key));
  }
  private restReturned(s: Session, client: unknown) {
    const key = this.restKey(s), r = key ? s.state.rests?.[key] : undefined;
    if (!r || r.status !== 'returning') return;
    const now = this.elapsed(s);
    const event = this.log(s, 'rest_ended', { rest_id: r.rest_id, rest_key: key, client, started_elapsed_ms: r.started_elapsed_ms, countdown_ended_elapsed_ms: r.countdown_ended_elapsed_ms,
      actual_rest_ms: now - r.started_elapsed_ms!, planned_rest_ms: this.restDuration(s, key!), paused_ms: r.paused_ms, paused_during: r.paused_during });
    r.status = 'done'; r.returned_elapsed_ms = event.elapsed_ms;
  }
  private restView(s: Session) {
    const key = this.restKey(s), c = s.snapshot.content.in_unit_rest;
    if (!key || !c) return null;
    const r = s.state.rests?.[key], duration = this.restDuration(s, key), now = s.state.paused_at_ms ?? this.elapsed(s);
    const reminder = (s.state.rest_reminders?.[key] ?? []).at(-1);
    return { key, button_label: c.button_label, state: (r?.status ?? 'idle') as string, title: c.rest_title, paragraphs: c.rest_paragraphs, show_countdown: c.show_countdown,
      duration_ms: duration, remaining_ms: r?.status === 'resting' ? Math.max(0, r.until_ms! - now) : !r ? duration : r.status === 'requested' ? duration : 0,
      countdown_started: r?.status === 'resting', feedback: s.state.rest_feedback?.[key] ?? null,
      reminder: reminder ? { id: reminder.id, text: reminder.text, display_ms: c.reminder_display_ms, displayed: reminder.displayed } : null };
  }
  private restSummary(s: Session) {
    const c = s.snapshot.content.in_unit_rest;
    if (!c || s.state.phase.startsWith('TUTORIAL') || ['INTRO', 'COMPLETED', 'ABORTED'].includes(s.state.phase)) return null;
    const stageId = s.snapshot.content.stages[s.state.stage].stage_id, r = s.state.rests?.[stageId], reminders = s.state.rest_reminders?.[stageId] ?? [];
    const now = s.state.paused_at_ms ?? this.elapsed(s), inU2 = s.state.phase === 'UNIT' && s.state.unit === 1, afterU2 = ['COMPREHENSION', 'RATINGS'].includes(s.state.phase);
    const u2 = inU2 ? this.u2Elapsed(s, stageId, now) : null, windowMs = this.restWindow(s, stageId);
    const status = inU2 ? (r ? (r.status === 'done' ? 'rested' : r.status) : u2 === null || u2 < windowMs ? 'before_window' : 'available') : afterU2 ? (r ? 'rested' : 'not_rested') : 'not_in_u2';
    const a = this.assignment(s), message = this.store.interventions(s.id).find(m => m.stage_id === stageId);
    const t2 = !a.condition.endsWith('T2') ? null : message ? (NOT_DISPLAYED.includes(message.status) ? message.status : 'sent') : r?.status === 'resting' && r.t2_due_ms !== null ? 'scheduled' : afterU2 ? 'not_triggered' : 'awaiting_rest';
    return { status, u2_elapsed_ms: u2, window_min_ms: windowMs, remaining_ms: r?.status === 'resting' ? Math.max(0, r.until_ms! - now) : null,
      reminder_count: reminders.length, last_reminder_at: reminders.at(-1)?.sent_at ?? null, after_reminder: r?.after_reminder ?? false, rest_started_at: r?.started_at ?? null,
      t2, t2_due_in_ms: t2 === 'scheduled' ? Math.max(0, r!.t2_due_ms! - now) : null };
  }
  view(id: string) {
    this.tick(id);
    const s = this.session(id), state = s.state, content = s.snapshot.content;
    const waiting = this.pendingConfirmation(s);
    const base = { session_id: id, phase: state.phase as string, page_token: state.page_token, stage_number: state.stage + 1, stage_count: content.stages.length,
      title: '', paragraphs: [] as string[], fields: [] as Field[], assets: [] as { id: string; label: string }[], answer: {} as Record<string, unknown>,
      reveal: null as null | { button_label: string; open: boolean; observed: boolean; paragraphs: string[]; assets: { id: string; label: string }[]; tables: DataTable[] },
      tables: [] as DataTable[], scratchpad: null as null | { label: string; placeholder: string; max_length: number; text: string },
      is_debug: this.isDebug(s), debug_targets: this.isDebug(s) ? this.debugTargets(s).map(t => ({ id: t.id, label: t.label })) : [],
      display_mode: this.mode(s), confirmation_enabled: this.sessionModes(s).includes('confirm_until_ack') || waiting?.display_mode === 'confirm_until_ack', message_confirmation: waiting ? {
        request_id: waiting.request_id, stage_id: waiting.stage_id, source: waiting.source,
        can_confirm: waiting.status === 'accepted' && (waiting.source === 'mock' || !!waiting.device_events?.some(e => e.kind === 'drawn')) && !waiting.device_events?.some(e => e.kind === 'confirmed') && waiting.confirmation_status !== 'accepted',
        status: waiting.status === 'failed' ? 'failed' : waiting.confirmation_status ?? 'waiting',
        confirmed: waiting.confirmation_status === 'accepted' || !!waiting.device_events?.some(e => e.kind === 'confirmed'),
      } : null,
      remaining_ms: 0, break_countdown_started: false, can_continue: true, can_skip_break: false,
      // 当前任务组说明卡中的情景时间，被试端在任务栏固定显示；旧快照无此字段时为null。
      report_answer_blur: state.phase === 'UNIT' && state.unit === 0 && !!content.t0_trigger && !state.t0?.[content.stages[state.stage].stage_id],
      tutorial: state.phase.startsWith('TUTORIAL'), scene_time: content.stages[state.stage]?.scene_time ?? null, rest: this.restView(s) };
    if (state.paused_at_ms !== null) return { ...base, phase: 'PAUSED', title: '实验已暂停，请等待实验员。', can_continue: false };
    if (state.phase.startsWith('TUTORIAL') && !this.practiceUnit(s)) {
      const restCopy = content.in_unit_rest;
      base.title = state.phase === 'TUTORIAL_INTRO' ? '操作练习：认识工作台' : state.phase === 'TUTORIAL_REST' ? '操作练习：休息一次' : state.phase === 'TUTORIAL_NOTICE' ? '操作练习：阅读消息' : '操作练习：回答问题';
      base.paragraphs = state.phase === 'TUTORIAL_INTRO' ? [base.confirmation_enabled ? '右上角“已阅读消息”用于读完眼镜消息后确认，“草稿本”可以记录思路。请试着打开草稿本。' : '右上角“草稿本”可以记录思路。请试着打开草稿本。', content.practice ? '右下角显示当前任务的情境时间；进入不同任务情境时，时间会更新。接下来有两个练习单元，帮你熟悉任务的操作。准备好后点击下一步。' : '右下角显示当前任务的情境时间；进入不同任务情境时，时间会更新。准备好后点击下一步。']
        : state.phase === 'TUTORIAL_REST' && restCopy ? [`每组任务的第二单元中，右上角会有“${restCopy.button_label}”按钮。点击后进入休息页，任务内容会暂时遮住，约${restCopy.duration_ms / 1000}秒后自动回到任务，已填写的答案和草稿都会保留。`, `注意：${restCopy.instruction}每组只能休息一次。`, `现在请点击右上角“${restCopy.button_label}”试一次（练习时休息较短），回到这里后点击下一步。`]
        : state.phase === 'TUTORIAL_NOTICE' ? ['请阅读眼镜上的练习消息。读完后点击右上角“已阅读消息”，再点击下一步。'] : ['请根据刚才的眼镜消息回答问题。答对后进入实验说明。'];
      base.scratchpad = {label:'草稿本',placeholder:'在这里记录你的思考...',max_length:5000,text:state.scratchpads?.TUTORIAL ?? ''};
    } else if (state.phase === 'INTRO') Object.assign(base, content.intro);
    else if (state.phase === 'CARD') { base.title = content.stages[state.stage].title; base.paragraphs = [content.stages[state.stage].card]; }
    else if (state.phase === 'UNIT' || this.practiceUnit(s)) {
      const unit = this.pageUnit(s)!; base.title = unit.title; base.paragraphs = unit.paragraphs; base.assets = (unit.assets ?? []).map(a => ({ id: a.id, label: a.label })); base.tables = unit.tables ?? [];
      if (unit.scratchpad) base.scratchpad = { ...unit.scratchpad, text: state.scratchpads?.[unit.unit_id] ?? '' };
      const reveal = state.reveals[unit.unit_id];
      if (unit.reveal) base.reveal = { button_label: unit.reveal.button_label, open: reveal?.open ?? false, observed: reveal?.displayed ?? false,
        paragraphs: reveal?.open ? unit.reveal.paragraphs : [], assets: reveal?.open ? (unit.reveal.assets ?? []).map(a => ({ id: a.id, label: a.label })) : [], tables: reveal?.open ? unit.reveal.tables ?? [] : [] };
    } else if (state.phase === 'COMPREHENSION') {
      base.title = content.survey_pages?.comprehension.title ?? '眼镜中的关键信息获取题';
      base.paragraphs = content.survey_pages?.comprehension.paragraphs ?? [];
    } else if (state.phase === 'RATINGS') {
      base.title = content.survey_pages?.ratings.title ?? '眼镜消息体验评价';
      base.paragraphs = content.survey_pages?.ratings.paragraphs ?? [];
    }
    else if (state.phase === 'BREAK') {
      base.title = '休息'; base.break_countdown_started = state.break_until_ms !== null;
      base.remaining_ms = state.break_until_ms === null ? this.breakMs(s) : Math.max(0, state.break_until_ms - this.elapsed(s));
      base.can_continue = base.break_countdown_started && base.remaining_ms === 0;
      base.can_skip_break = s.snapshot.content.allow_break_skip !== false;
    }
    else if (state.phase === 'COMPLETED') { base.title = '实验完成'; base.paragraphs = [content.completion_text]; }
    else base.title = '实验已结束，请联系实验员。';
    base.fields = this.fields(s); base.answer = state.drafts[this.draftKey(s)] ?? {};
    return base;
  }
  private schedule(s: Session, event: EventRecord, timing: Timing) {
    const a = this.assignment(s);
    if (a.condition === 'NONE' || !a.condition.endsWith(timing) || this.store.interventions(s.id).some(m => m.stage_id === a.stage_id)) return;
    this.requirePreviousMessageFinished(s);
    const message: Intervention = { session_id: s.id, participant_id: s.snapshot.participant.participant_id, stage_id: a.stage_id, message_id: a.message_id!, condition: a.condition,
      device_id: s.state.device_id, device_events: [], request_id: randomUUID(), status: 'scheduled', source: this.deliverySource(s), duration_ms: this.mode(s) === 'confirm_until_ack' ? 8500 : s.snapshot.content.message_duration_ms,
      display_mode: this.mode(s),
      t_event: event.timestamp_iso, event_elapsed_ms: event.elapsed_ms, t_send: null, t_ack: null, t_display: null, t_hide: null,
      display_time_source: 'unavailable', receipt: null, error: null };
    this.store.intervention(message);
    this.log(s, 'message_scheduled', { request_id: message.request_id, trigger_event_id: event.event_id, timing, duration_ms: message.duration_ms });
  }
  private scheduleAuxiliary(s: Session, stage: string, text: string, mode: DisplayMode, kind: 'tutorial' | 'manual', requestId: string) {
    const m: Intervention = {session_id:s.id,participant_id:s.snapshot.participant.participant_id,stage_id:stage,message_id:stage,condition:kind.toUpperCase(),data_kind:kind,text,display_mode:mode,request_id:requestId,status:'scheduled',source:this.deliverySource(s),duration_ms:mode === 'confirm_until_ack' ? 8500 : s.snapshot.content.message_duration_ms,device_id:s.state.device_id,device_events:[],t_event:this.iso(),event_elapsed_ms:this.elapsed(s),t_send:null,t_ack:null,t_display:null,t_hide:null,display_time_source:'unavailable',receipt:null,error:null};
    this.store.intervention(m); this.log(s,kind+'_notification_scheduled',{request_id:requestId,text,display_mode:mode},{stage_id:stage,unit_id:null,condition:kind.toUpperCase()});
    return m;
  }
  manualNotification(id: string, requestId: string, text: string, mode: DisplayMode) {
    const prior=this.store.findRequest(requestId);
    if(prior) { if(prior.session_id!==id || prior.text!==text || prior.display_mode!==mode || prior.data_kind!=='manual') throw new HttpError(409,'同一通知编号内容或模式不一致。'); return prior; }
    const s=this.session(id); this.requireAvailable(s);
    if(s.state.status!=='active') throw new HttpError(409,'当前会话已结束。');
    const device=this.adapter.getStatus();
    if(!device.connected || !device.ready) throw new HttpError(409,'眼镜尚未连接或显示端未就绪。');
    this.requireFixedDuration(mode, s.snapshot.content.message_duration_ms);
    if(device.busy || this.store.interventions(id).some(m=>['scheduled','send_requested'].includes(m.status))) throw new HttpError(409,'眼镜正在显示消息，请等待结束后手动发送；不会覆盖或排队。');
    this.requirePreviousMessageFinished(s);
    if(!device.capabilities && mode!=='legacy_8500' && !device.device_info?.display_modes?.split(',').includes(mode)) throw new HttpError(409,'眼镜不支持所选模态。');
    this.store.tx(()=>{this.scheduleAuxiliary(s,'MANUAL_'+requestId,text,mode,'manual',requestId);this.store.save(s);});
    this.dispatch(id);return this.store.findRequest(requestId)!;
  }
  private dispatch(id: string) {
    for (const message of this.store.interventions(id).filter(m => m.status === 'scheduled')) {
      const s = this.session(id); const stimulus = message.text ? {text:message.text, stage_id:`${profile.stage_prefix}01`, message_id:message.message_id} : s.snapshot.stimuli.find(m => m.stage_id === message.stage_id && m.message_id === message.message_id)!;
      const context = { stage_id: message.stage_id, unit_id: null, condition: message.condition };
      this.store.tx(() => {
        message.status = 'send_requested'; message.t_send = this.iso(); this.store.intervention(message);
        this.log(s, 'message_send_requested', { request_id: message.request_id, message_id: message.message_id, duration_ms: message.duration_ms, source: message.source }, context); this.store.save(s);
      });
      // 已先持久化发送意图；网络调用绝不阻塞主任务响应，不在恢复后自动重发。
      // 5 秒上限：到点先中止仍未写入线路的调用（适配器回 not_sent），再给适配器短暂收尾；仍无结果按已发出未确认（unacknowledged）记录。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      const sending = Promise.resolve().then(() => {
        const target = this.adapter.getStatus();
        if (target.source !== message.source || (message.source === 'device' && target.device_id !== message.device_id)) throw new PreSendError('adapter_mode_or_device_mismatch');
        return this.adapter.send({ session_id: id, participant_id: message.participant_id, stage_id: stimulus.stage_id, message_id: stimulus.message_id,
        request_id: message.request_id, text: stimulus.text, device_id: message.device_id, duration_ms: message.duration_ms, ...(message.display_mode && message.display_mode !== 'legacy_8500' ? { display_mode: message.display_mode } : {}) }, { signal: abort.signal });
      });
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); timer = setTimeout(() => reject(new Error(SEND_TIMEOUT)), SEND_ABORT_GRACE_MS); }, SEND_TIMEOUT_MS); });
      const task = Promise.race([sending, deadline]).then(receipt => {
        if (receipt.request_id !== message.request_id || receipt.source !== message.source || (message.device_id && receipt.device_id !== message.device_id)) throw new Error('adapter_receipt_identity_mismatch');
        this.store.tx(() => {
          const current = this.session(id);
          // 轮询事件可能先到；始终合并数据库中的最新记录。
          Object.assign(message, this.store.findRequest(message.request_id));
          const deviceFailed = message.device_events?.some(e => e.kind === 'failed' || e.kind === 'cue_failed');
          Object.assign(message, { status: deviceFailed || receipt.status === 'failed' ? 'failed' : message.device_events?.length ? 'accepted' : receipt.status, source: receipt.source, t_ack: receipt.t_ack, t_display: receipt.t_display, t_hide: receipt.t_hide,
            display_time_source: receipt.display_time_source, receipt, error: receipt.status === 'failed' ? receipt.error : deviceFailed ? message.error : message.device_events?.length ? null : receipt.error });
          this.store.intervention(message);
          this.log(current, receipt.status === 'accepted' ? 'message_send_accepted' : 'message_failed', { request_id: message.request_id, receipt, delivery: receipt.status, retry: false }, context);
          if (receipt.t_display) this.log(current, 'message_display_confirmed', { request_id: message.request_id, t_display: receipt.t_display, source: receipt.source }, context);
          if (receipt.t_hide) this.log(current, 'message_hidden', { request_id: message.request_id, t_hide: receipt.t_hide, source: receipt.source }, context);
          if (receipt.status !== 'accepted') current.state.attention.push(`${message.stage_id}:${receipt.error ?? receipt.status}`);
          this.store.save(current);
        });
      }).catch(error => {
        this.store.tx(() => {
          const current = this.session(id); Object.assign(message, this.store.findRequest(message.request_id));
          if (message.device_events?.length) { this.log(current, 'message_transport_error', { request_id: message.request_id, reason: String(error) }, context); this.store.save(current); return; }
          // unknown 只留给进程重启恢复；运行中的异常按是否可能已写入线路区分 failed / not_sent / unacknowledged。
          const delivery = message.source === 'device' ? sendErrorDelivery(error) : 'failed';
          message.status = delivery; message.error = error instanceof Error ? error.message : String(error);
          this.store.intervention(message); current.state.attention.push(`${message.stage_id}:${delivery === 'unacknowledged' ? 'unacknowledged' : delivery === 'not_sent' ? 'message_not_sent' : 'message_failed'}`);
          this.log(current, 'message_failed', { request_id: message.request_id, reason: message.error, delivery, retry: false }, context); this.store.save(current);
        });
      });
      const tracked = task.finally(() => { if (timer) clearTimeout(timer); });
      this.pending.add(tracked); void tracked.then(() => this.pending.delete(tracked), () => this.pending.delete(tracked));
    }
  }
  async settle() { await Promise.all([...this.pending]); }

  /** 分阶段事件按原 request_id 落盘，允许来自已结束或软删除会话。 */
  receiveDeviceEvent(event: GlassesEvent) {
    if (this.deviceDebugEvent?.(event)) return;
    this.store.tx(() => {
      const prior = this.store.db.prepare('SELECT data FROM device_events WHERE event_id=?').get(event.event_id) as { data: string } | undefined;
      if (prior) { if (prior.data !== JSON.stringify(event)) throw new Error('device_event_id_conflict'); return; }
      const message = this.store.findRequest(event.request_id);
      const rejection = !message ? 'unknown_request' : message.source !== 'device' || message.device_id !== event.device_id ? 'device_binding_mismatch' : null;
      this.store.db.prepare('INSERT INTO device_events VALUES (?,?)').run(event.event_id, JSON.stringify(event));
      if (rejection) {
        this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_event_rejected', reason: rejection, event, received_at: this.iso() })); return;
      }
      if (!message) return;
      const current = this.session(message.session_id);
      const m = message;
      m.device_events = [...(m.device_events ?? []), event];
      if (event.kind === 'confirmed') m.confirmation_status = 'accepted';
      if (event.kind === 'failed' || event.kind === 'cue_failed') { m.status = 'failed'; m.error = event.error ?? 'device_failed'; current.state.attention.push(`${m.stage_id}:${m.error}`); }
      else if (!m.device_events.some(e => e.kind === 'failed' || e.kind === 'cue_failed') && (m.receipt as GlassesReceipt | null)?.status !== 'failed') { m.status = 'accepted'; m.error = null; }
      // Android wall/uptime 尚未与服务器同步，不写入跨设备 ISO 时间字段。
      this.store.intervention(m);
      this.log(current, `message_device_${event.kind}`, { request_id: m.request_id, evidence: event, received_at: this.iso(), clock_synchronization: 'unavailable' },
        { stage_id: m.stage_id, unit_id: null, condition: m.condition });
      this.store.save(current);
    });
  }
  pollDevice() {
    if(this.deviceOperationsBusy?.())return;
    if (!this.adapter.pollEvents) return;
    const task = this.adapter.pollEvents(event => this.receiveDeviceEvent(event)).then(() => {
      const status = this.adapter.getStatus();
      const previous = this.store.setting('device_status');
      if (JSON.stringify(status) !== JSON.stringify(previous)) {
        this.store.tx(() => {
          this.store.setSetting('device_status', status);
          this.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_status_changed', timestamp_iso: this.iso(), status }));
        });
      }
    });
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
  }
  private deliverySource(s: Session): 'mock' | 'device' {
    const created = this.store.events(s.id).find(e => e.event_type === 'session_created')?.payload.adapter as { source?: 'mock' | 'device' } | undefined;
    return s.state.delivery_source ?? (s.state.device_id ? 'device' : created?.source ?? 'mock');
  }
  presentation(id: string) {
    const s = this.session(id), messages = this.store.interventions(id).filter(m => !m.data_kind || m.data_kind === 'formal');
    const expected = s.snapshot.participant.stages.filter(a => a.condition !== 'NONE').length;
    const drawn = messages.filter(m => m.source === 'device' && m.device_events?.some(e => e.kind === 'drawn')).length;
    return { delivery_source: this.deliverySource(s),
      validation_status: s.state.device_id || messages.some(m => m.source === 'device') ? 'hardware_validation_pending' : 'mock_only',
      real_presentation_verified: false, expected_messages: expected, device_drawn_messages: drawn,
      application_presentation_complete: messages.length === expected && drawn === expected && messages.every(m => m.status === 'accepted' && m.device_events?.some(e => e.kind === 'hidden') && (m.display_mode !== 'tone_8500' || m.device_events.some(e => e.kind === 'cue_started')) && (m.display_mode !== 'confirm_until_ack' || !!m.confirmation_requested_at && m.device_events.some(e => e.kind === 'confirmed'))) };
  }

  /** 练习单元的作答与提交：记录答案与对错，不设对错门槛、不判分入正式数据、不触发消息；练习单元02须先完成一次练习休息。 */
  private practiceSubmit(s: Session, command: Command, client: unknown): Error | undefined {
    const state = s.state, unit = this.practiceUnit(s)!;
    this.requireNotResting(s);
    const raw = command.answer;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 20000) throw new HttpError(422, '答案格式无效。');
    const fields = this.fields(s);
    if (Object.keys(raw).some(k => !fields.some(f => f.id === k))) throw new HttpError(422, '答案包含不属于本题的字段。');
    const key = this.draftKey(s);
    if (JSON.stringify(state.drafts[key]) !== JSON.stringify(raw)) { state.drafts[key] = raw; this.log(s, 'answer_changed', { raw_answer: raw, client }); }
    if (command.action !== 'submit') return undefined;
    this.log(s, 'submit_clicked', { raw_answer: raw, client });
    try {
      const normalized = normalize(fields, raw);
      if (unit.reveal && !state.reveals[unit.unit_id]?.displayed) throw new InputError('请按题目要求先查看补充资料，再提交答案。');
      if (state.phase === 'TUTORIAL_UNIT2' && !['returning', 'done'].includes(state.rests?.PRACTICE?.status ?? '')) {
        throw new InputError(`请先点击右上角的“${s.snapshot.content.in_unit_rest!.button_label}”按钮练习一次休息，回到任务后再提交。`);
      }
      this.log(s, 'tutorial_answer_submitted', { unit_id: unit.unit_id, raw_answer: raw, normalized_answer: normalized, score: score(unit, normalized), ...(unit.scoring.type === 'items' ? { item_results: itemResults(unit, normalized) } : {}), client });
      if (state.phase === 'TUTORIAL_UNIT1') this.transition(s, 'TUTORIAL_UNIT2');
      else {
        if (state.rests?.PRACTICE?.status === 'returning') this.restReturned(s, { source: 'practice_submitted_before_return_report' });
        if (s.snapshot.content.tutorial_notice_after_practice && this.sessionModes(s).includes('confirm_until_ack')) this.transition(s, 'TUTORIAL_NOTICE');
        else { this.log(s, 'tutorial_completed', { practice: true }); this.transition(s, 'INTRO'); }
      }
      return undefined;
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      this.log(s, 'submission_rejected', { reason: error.message });
      return error;
    }
  }
  command(id: string, command: Command) {
    if (!command || typeof command.command_id !== 'string' || command.command_id.length > 100 || !command.command_id || typeof command.action !== 'string') throw new HttpError(400, '操作必须包含有效command_id和action。');
    this.requireAvailable(this.session(id));
    const fingerprint = hash(command); let rejected: Error | undefined;
    this.store.tx(() => {
      const prior = this.store.command(id, command.command_id);
      if (prior) { if (prior !== fingerprint) throw new HttpError(409, '同一command_id不能用于不同操作。'); return; }
      const s = this.session(id), state = s.state;
      if (command.page_token !== state.page_token) throw new HttpError(409, '页面已变化，请刷新当前任务。');
      if (state.paused_at_ms !== null && command.action !== 'jump') throw new HttpError(409, '实验已暂停。');
      const client = command.client ?? {};
      if (JSON.stringify(client).length > 4000) throw new HttpError(400, '客户端时间信息过长。');
      if (command.action === 'jump') {
        this.jump(s, command.target, 'participant', '调试测试者主动跳题');
      } else if (command.action === 'resume' || command.action === 'blur') {
        this.log(s, command.action === 'resume' ? 'app_resumed' : 'app_blurred', { client, page_token: state.page_token });
      } else if (command.action === 'displayed') {
        if (client.visibility_state !== 'visible') throw new HttpError(422, '只有实际可见页面才能报告显示事件。');
        if (!state.displayed[state.page_token]) {
          state.displayed[state.page_token] = true;
          const eventName = { TUTORIAL_INTRO:'tutorial_intro_displayed', TUTORIAL_UNIT1:'tutorial_unit_displayed', TUTORIAL_UNIT2:'tutorial_unit_displayed', TUTORIAL_REST:'tutorial_rest_displayed', TUTORIAL_NOTICE:'tutorial_notice_displayed', TUTORIAL_CHECK:'tutorial_check_displayed', INTRO: 'intro_displayed', CARD: 'card_displayed', UNIT: 'unit_displayed', COMPREHENSION: 'comprehension_displayed', RATINGS: 'ratings_displayed', BREAK: 'break_displayed', COMPLETED: 'completion_displayed', ABORTED: 'termination_displayed' }[state.phase];
          const displayed = this.log(s, eventName, { client, page_token: state.page_token });
          if (state.phase === 'BREAK') {
            state.break_displayed_at = displayed.timestamp_iso; state.break_displayed_elapsed_ms = displayed.elapsed_ms;
            if (state.break_until_ms === null) {
              state.break_until_ms = displayed.elapsed_ms + this.breakMs(s);
              this.log(s, 'break_started', { break_id: state.page_token, duration_ms: this.breakMs(s), until_elapsed_ms: state.break_until_ms, displayed_event_id: displayed.event_id });
            }
          }
          if (state.phase === 'TUTORIAL_NOTICE' && !this.store.interventions(id).some(m=>m.stage_id==='TUTORIAL')) {this.requirePreviousMessageFinished(s); this.scheduleAuxiliary(s, 'TUTORIAL', '练习会议安排在二号会议室。', this.mode(s), 'tutorial', randomUUID());}
          if (state.phase === 'TUTORIAL_UNIT2') (state.u2_displayed_elapsed ??= {}).PRACTICE ??= displayed.elapsed_ms;
          if (state.phase === 'UNIT' && state.unit === 1) {
            const u2 = this.log(s, 'u2_displayed', { client });
            (state.u2_displayed_elapsed ??= {})[this.assignment(s).stage_id] ??= u2.elapsed_ms;
            this.schedule(s, u2, 'T1');
          }
        }
      } else {
        if (!state.displayed[state.page_token]) throw new HttpError(409, '当前页面尚未报告实际可见。');
        if (command.action === 'rest_click') this.restClick(s, client);
        else if (command.action === 'answers_blur') this.answersBlur(s, command, client);
        else if (command.action === 'rest_displayed') this.restDisplayed(s, client);
        else if (command.action === 'rest_return_displayed') this.restReturned(s, client);
        else if (command.action === 'rest_reminder_displayed') {
          const key = this.restKey(s), reminder = key ? s.state.rest_reminders?.[key]?.find(r => r.id === command.reminder_id) : undefined;
          if (!reminder) throw new HttpError(409, '提醒不属于当前页面。');
          if (!reminder.displayed) { reminder.displayed = true; this.log(s, 'rest_reminder_displayed', { reminder_id: reminder.id, text: reminder.text, client }); }
        } else if (this.practiceUnit(s) && ['submit', 'draft'].includes(command.action)) {
          rejected = this.practiceSubmit(s, command, client);
        } else if (state.phase.startsWith('TUTORIAL') && ['continue','submit','draft'].includes(command.action)) {
          this.requireNotResting(s);
          if (state.phase === 'TUTORIAL_CHECK') {
            const raw = command.answer ?? {}; state.drafts[this.draftKey(s)] = raw;
            if (command.action === 'submit') {
              const correct = raw.answer === 'B'; this.log(s,'tutorial_answer_submitted',{raw_answer:raw,correct,client});
              if (!correct) rejected = new HttpError(422,'答案不正确，请回想练习消息后再试。');
              else { this.log(s,'tutorial_completed'); this.transition(s,'INTRO'); }
            }
          } else if (command.action !== 'draft') {
            const notice = this.sessionModes(s).includes('confirm_until_ack');
            if (state.phase === 'TUTORIAL_INTRO' && s.snapshot.content.practice) { this.log(s,'tutorial_intro_continue'); this.transition(s,'TUTORIAL_UNIT1'); }
            else if (state.phase === 'TUTORIAL_INTRO' && s.snapshot.content.in_unit_rest) { this.log(s,'tutorial_intro_continue'); this.transition(s,'TUTORIAL_REST'); }
            else if (state.phase === 'TUTORIAL_INTRO' || state.phase === 'TUTORIAL_REST') {
              if (state.phase === 'TUTORIAL_REST') {
                if (!['returning','done'].includes(state.rests?.TUTORIAL?.status ?? '')) throw new HttpError(422, '请先点击右上角按钮练习一次休息，回到本页后再继续。');
                this.log(s,'tutorial_rest_continue');
              } else this.log(s,'tutorial_intro_continue');
              if (!notice) this.log(s,'tutorial_completed',{tools_only:true});
              this.transition(s, notice ? 'TUTORIAL_NOTICE' : 'INTRO');
            }
            else {
              const m=this.store.interventions(id).find(m=>m.stage_id==='TUTORIAL');
              if (!m || (this.messageMode(s,m)==='confirm_until_ack' && !m.confirmation_requested_at) || (m.source==='device' ? !m.device_events?.some(e=>e.kind==='hidden') : this.messageMode(s,m)==='confirm_until_ack' ? m.confirmation_status!=='accepted' : !m.t_send || this.wallNow()-Date.parse(m.t_send)<m.duration_ms)) throw new HttpError(409,'请先阅读并确认练习消息，等眼镜上的消息消失后再继续。');
              this.log(s,'tutorial_notice_continue'); this.transition(s,'TUTORIAL_CHECK');
            }
          }
        } else if (command.action === 'reveal') {
          this.requireNotResting(s);
          const unit = this.pageUnit(s);
          if (!unit?.reveal || typeof command.open !== 'boolean') throw new HttpError(409, '当前任务没有此操作。');
          const reveal = state.reveals[unit.unit_id] ?? { open: false, requested: false, displayed: false };
          if (command.open && !reveal.displayed && !this.practiceUnit(s)) this.guardTrigger(s, 'T0');
          reveal.open = command.open; reveal.requested ||= command.open; state.reveals[unit.unit_id] = reveal;
          this.log(s, 'reveal_clicked', { open: command.open, client });
        } else if (command.action === 'reveal_displayed') {
          const unit = this.pageUnit(s);
          if (!unit) throw new HttpError(409, '当前不是任务页。');
          const reveal = state.reveals[unit.unit_id];
          if (!reveal?.open || !reveal.requested || client.visibility_state !== 'visible') throw new HttpError(409, '补充资料尚未展开或不可见。');
          // 练习单元不触发E标记，也不排定消息。
          if (!reveal.displayed) { reveal.displayed = true; if (this.practiceUnit(s)) this.log(s, 'reveal_displayed', { client }); else this.schedule(s, this.log(s, 'reveal_displayed', { client, marker: 'E' }), 'T0'); }
        } else if (command.action === 'scratchpad') {
          this.requireNotResting(s);
          const unit = this.pageUnit(s);
          if (!state.phase.startsWith('TUTORIAL') && !unit?.scratchpad) throw new HttpError(409, '当前单元没有草稿本。');
          const options = unit?.scratchpad ?? {max_length:5000};
          const scratchKey = unit ? unit.unit_id : 'TUTORIAL';
          if (typeof command.text !== 'string' || command.text.length > options.max_length) throw new HttpError(422, '草稿本格式或长度无效。');
          state.scratchpads ??= {};
          if (state.scratchpads[scratchKey] !== command.text) {
            state.scratchpads[scratchKey] = command.text;
            this.log(s, 'scratchpad_changed', { text: command.text, client, not_scored: true });
          }
        } else if (command.action === 'skip_break') {
          this.skipBreak(s, 'participant', '被试主动跳过休息');
        } else if (command.action === 'draft' || command.action === 'submit') {
          if (!['UNIT', 'COMPREHENSION', 'RATINGS'].includes(state.phase)) throw new HttpError(409, '当前页面不可提交答案。');
          this.requireNotResting(s);
          const raw = command.answer;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 20000) throw new HttpError(422, '答案格式无效。');
          const fields = this.fields(s);
          if (Object.keys(raw).some(k => !fields.some(f => f.id === k))) throw new HttpError(422, '答案包含不属于本题的字段。');
          const key = this.draftKey(s);
          if (JSON.stringify(state.drafts[key]) !== JSON.stringify(raw)) { state.drafts[key] = raw; this.log(s, 'answer_changed', { raw_answer: raw, client }); }
          if (command.action === 'submit') {
            this.log(s, 'submit_clicked', { raw_answer: raw, client });
            try {
              const normalized = normalize(fields, raw);
              if (state.phase === 'UNIT' && this.unit(s).reveal && !state.reveals[this.unit(s).unit_id]?.displayed) throw new InputError('请按题目要求先查看补充资料，再提交答案。');
              if (state.phase === 'UNIT') {
                if (state.unit === 0) this.guardTrigger(s, 'T1');
                const unit = this.unit(s); const value = score(unit, normalized);
                this.log(s, 'submission_recorded', { raw_answer: raw, normalized_answer: normalized });
                const items = itemResults(unit, normalized);
                this.log(s, 'unit_scored', items ? { score: value, max_score: unit.fields.length, item_results: items } : { score: value });
                if (profile.f_candidate_unit && unit.unit_id === profile.f_candidate_unit && !this.store.events(id).some(e => e.event_type === 'F_candidate')) this.log(s, 'F_candidate', { semantics: 'first_submission', criterion_version: 'user-2026-10-18', score: value, complete: true });
                if (state.unit === 0) { this.log(s, 'unit_transition_started', { from: unit.unit_id, to: unit.unit_id.replace('U1', 'U2') }); state.unit = 1; this.transition(s, 'UNIT'); }
                else {
                  const a = this.assignment(s), restKey = a.stage_id;
                  if (state.rests?.[restKey]?.status === 'returning') this.restReturned(s, { source: 'u2_submitted_before_return_report' });
                  if (s.snapshot.content.in_unit_rest && !state.rests?.[restKey]) this.log(s, 'rest_not_taken', { reminder_count: (state.rest_reminders?.[restKey] ?? []).length, u2_elapsed_ms: this.u2Elapsed(s, restKey), window_min_ms: this.restWindow(s, restKey) });
                  // T2未休息即提交：不补发（提交是系统断点），跳过理解题与量表，按缺失处理；与发送失败分开记录。
                  const t2Missing = a.condition.endsWith('T2') && !this.store.interventions(id).some(m => m.stage_id === a.stage_id);
                  if (t2Missing) this.log(s, 't2_not_triggered', { message_id: a.message_id, rest_taken: !!state.rests?.[restKey], semantics: 'no_rest_before_u2_submit_no_resend' });
                  if (a.condition === 'NONE' || t2Missing) {
                    const reason = t2Missing ? 't2_not_triggered' : 'no_message', messageId = t2Missing ? a.message_id : null;
                    this.log(s, 'comprehension_skipped', { reason, message_id: messageId });
                    this.log(s, 'ratings_skipped', { reason, message_id: messageId });
                    this.stageEnd(s);
                  } else this.transition(s, 'COMPREHENSION');
                }
              } else if (state.phase === 'COMPREHENSION') {
                this.log(s, 'comprehension_submitted', { ...(normalized.message_notice === undefined ? {} : { message_notice: normalized.message_notice }), answer: normalized.answer, correct: normalized.answer === this.stimulus(s).correct_option, message_id: this.stimulus(s).message_id });
                if (s.snapshot.content.survey_pages?.ratings.skip_if_not_noticed && normalized.message_notice === 'not_noticed') {
                  this.log(s, 'ratings_skipped', { reason: 'not_noticed', message_notice: normalized.message_notice, message_id: this.stimulus(s).message_id });
                  this.stageEnd(s);
                } else this.transition(s, 'RATINGS');
              } else {
                this.log(s, 'ratings_submitted', { ratings: Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, Number(v)])), message_id: this.stimulus(s).message_id }); this.stageEnd(s);
              }
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
              this.log(s, 'submission_rejected', { reason: error.message }); rejected = error;
            }
          }
        } else if (command.action === 'continue') {
          if (state.phase === 'INTRO') { this.log(s, 'intro_continue'); this.transition(s, 'CARD'); }
          else if (state.phase === 'CARD') { this.log(s, 'card_continue'); state.unit = 0; this.transition(s, 'UNIT'); }
          else if (state.phase === 'BREAK') {
            if (state.break_until_ms === null || this.elapsed(s) < state.break_until_ms) throw new HttpError(422, `休息尚未满${this.breakMs(s) / 1000}秒。`);
            this.completeBreak(s);
            this.log(s, 'continue_clicked', { break_id: state.page_token, client, actual_rest_ms: this.actualRest(s) });
            this.nextAfterBreak(s);
          } else throw new HttpError(409, '当前页面没有继续操作。');
        } else throw new HttpError(400, '未知操作。');
      }
      if (!rejected) this.store.acceptCommand(id, command.command_id, fingerprint);
      this.store.save(s);
    });
    this.dispatch(id);
    this.cancelOnEnd(id);
    if (rejected) throw rejected;
    return this.view(id);
  }

  adminAction(id: string, action: string, reason: string, target?: string) {
    if (typeof reason !== 'string' || reason.length > 4000) throw new HttpError(422, '操作原因长度无效。');
    this.store.tx(() => {
      const s = this.session(id);
      if (action === 'restore') {
        if (!s.state.deleted) throw new HttpError(409, '此会话未删除，无需恢复。');
        const deletion = s.state.deleted; delete s.state.deleted;
        this.log(s, 'session_restored', { reason, deletion, restored_status: s.state.status }); this.store.save(s); return;
      }
      if (action === 'delete' && s.state.deleted) return;
      this.requireAvailable(s);
      if (action === 'delete') {
        if (s.state.status === 'active') throw new HttpError(409, '会话仍在进行中，请先结束会话，再删除记录。');
        s.state.deleted = { deleted_at: this.iso(), reason };
        this.log(s, 'session_deleted', { reason, recoverable: true, status: s.state.status }); this.store.save(s); return;
      }
      if (action === 'debug_jump') {
        this.jump(s, target, 'admin', reason);
        this.log(s, 'admin_intervention', { action, reason, target, is_debug: this.isDebug(s) }); this.store.save(s); return;
      }
      if (s.state.status !== 'active') throw new HttpError(409, '会话已结束。');
      const elapsed = this.elapsed(s);
      if (action === 'skip_break') this.skipBreak(s, 'admin', reason);
      else if (action === 'remind_rest') {
        // 只由主试判断并点击；固定提醒语显示在被试电脑上，不发到眼镜。之后的休息自动标为“提醒后”。
        const key = this.restKey(s);
        if (!key || key === 'TUTORIAL' || key === 'PRACTICE' || s.state.paused_at_ms !== null || s.state.rests?.[key]) throw new HttpError(409, '只有被试处于第二单元且本组尚未休息时才能提醒休息。');
        const c = s.snapshot.content.in_unit_rest!, reminder = { id: randomUUID(), text: c.reminder_text, sent_at: this.iso(), sent_elapsed_ms: elapsed, displayed: false };
        ((s.state.rest_reminders ??= {})[key] ??= []).push(reminder);
        this.log(s, 'rest_reminder_sent', { reminder_id: reminder.id, text: reminder.text, reason, u2_elapsed_ms: this.u2Elapsed(s, key, elapsed), display_ms: c.reminder_display_ms, reminder_index: s.state.rest_reminders[key].length });
      }
      else if (action === 'pause' && s.state.paused_at_ms === null) {
        s.state.paused_at_ms = elapsed;
        for (const r of Object.values(s.state.rests ?? {})) if (ACTIVE_REST.includes(r.status)) r.paused_during = true;
      }
      else if (action === 'resume' && s.state.paused_at_ms !== null) {
        const paused = elapsed - s.state.paused_at_ms;
        if (s.state.break_until_ms !== null) s.state.break_until_ms += paused;
        // 人工暂停冻结休息倒计时与T2计划送达时刻。
        for (const r of Object.values(s.state.rests ?? {})) if (r.status === 'resting') {
          r.until_ms! += paused; r.paused_ms += paused;
          if (r.t2_due_ms !== null && !r.t2_fired) { r.t2_due_ms += paused; this.wake(id, r.t2_due_ms - elapsed); }
          this.wake(id, r.until_ms! - elapsed);
        }
        for (const p of Object.values(s.state.t0 ?? {})) if (!p.fired && p.due_ms !== null) { p.due_ms += paused; this.wake(id, p.due_ms - elapsed); }
        s.state.paused_at_ms = null;
      } else if (action === 'stop') {
        this.interruptRests(s, 'session_stopped');
        s.state.paused_at_ms = null; s.state.status = 'aborted'; s.state.ended_at = this.iso(); s.state.ended_elapsed_ms = elapsed; this.transition(s, 'ABORTED');
      } else throw new HttpError(409, '当前状态不支持该操作。');
      this.log(s, 'admin_intervention', { action, reason }); this.store.save(s);
    });
    this.cancelOnEnd(id);
  }
  note(id: string, category: string, text: string, stageId: string | null) {
    this.requireAvailable(this.session(id));
    if (!['interview', 'observation', 'anomaly'].includes(category) || typeof text !== 'string' || text.length > 50000) throw new HttpError(422, '备注类型或长度不合法。');
    if (stageId !== null && !this.session(id).snapshot.content.stages.some(s => s.stage_id === stageId)) throw new HttpError(422, '备注任务组非法。');
    this.store.tx(() => { const s = this.session(id); this.log(s, 'note_saved', { note_id: randomUUID(), category, text, stage_id: stageId }); this.store.save(s); });
  }
  summary(id: string) {
    this.tick(id); const s = this.session(id);
    const fields = this.fields(s), draft = s.state.drafts[this.draftKey(s)] ?? {};
    const answered = fields.filter(f => Array.isArray(draft[f.id]) ? (draft[f.id] as unknown[]).length > 0 : draft[f.id] !== undefined && draft[f.id] !== null && String(draft[f.id]).trim() !== '').length;
    const lastEvent = this.store.events(id).at(-1);
    const actions: string[] = [];
    if (s.state.deleted) actions.push('restore');
    else if (s.state.status === 'active') {
      actions.push(s.state.paused_at_ms === null ? 'pause' : 'resume', 'stop');
      if (s.state.phase === 'BREAK' && s.state.paused_at_ms === null && s.snapshot.content.allow_break_skip !== false) actions.push('skip_break');
      const key = this.restKey(s);
      if (key && key !== 'TUTORIAL' && key !== 'PRACTICE' && s.state.paused_at_ms === null && !s.state.rests?.[key]) actions.push('remind_rest');
    }
    else actions.push('delete');
    if (!s.state.deleted) actions.push('debug_jump');
    const message = this.store.interventions(id).find(m => m.stage_id === this.assignment(s).stage_id);
    const rest = this.restSummary(s);
    const t2Status = !message && this.assignment(s).condition.endsWith('T2') ? (rest?.t2 === 'not_triggered' ? 't2_not_triggered' : 'awaiting_rest') : null;
    return { session_id: id, display_mode: this.sessionModes(s).length === 1 ? this.sessionModes(s)[0] : 'mixed', message_duration_ms: s.snapshot.content.message_duration_ms, participant_id: s.snapshot.participant.participant_id, version_label: s.snapshot.participant.version_label,
      is_debug: this.isDebug(s), copied_from: s.snapshot.participant.copied_from ?? null, current_title: this.view(id).title,
      deleted: !!s.state.deleted, deleted_at: s.state.deleted?.deleted_at ?? null, deletion_reason: s.state.deleted?.reason ?? null,
      answered_fields: answered, total_fields: fields.length, reveal_observed: this.pageUnit(s) ? s.state.reveals[this.pageUnit(s)!.unit_id]?.displayed ?? false : null,
      available_actions: actions, last_event_type: lastEvent?.event_type ?? null, last_event_at: lastEvent?.timestamp_iso ?? null, message_status: message?.status ?? t2Status ?? (this.assignment(s).condition === 'NONE' ? 'NONE' : 'not_triggered'), rest,
      phase: s.state.phase, stage_id: s.snapshot.content.stages[s.state.stage].stage_id, unit: s.state.unit + 1, status: s.state.status, paused: s.state.paused_at_ms !== null,
      started_at: s.state.started_at, ended_at: s.state.ended_at, elapsed_ms: s.state.ended_elapsed_ms ?? this.elapsed(s), remaining_ms: s.state.phase === 'BREAK' ? (s.state.break_until_ms === null ? this.breakMs(s) : Math.max(0, s.state.break_until_ms - (s.state.paused_at_ms ?? this.elapsed(s)))) : null,
      content_version: s.snapshot.content.content_version, config_hash: s.snapshot.config_hash, attention: s.state.attention,
      device_id: s.state.device_id ?? null, adapter: this.adapter.getStatus(),
      message_evidence: message?.device_events?.some(e => e.kind === 'failed') ? 'failed' : message?.device_events?.some(e => e.kind === 'hidden') ? 'hidden' : message?.device_events?.some(e => e.kind === 'drawn') ? 'drawn' : null,
      ...this.presentation(id) };
  }
}
