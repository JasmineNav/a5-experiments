import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Engine, HttpError } from './engine.ts';
import type { DisplayMode, GlassesEvent, GlassesReceipt, GlassesRequest } from './contracts.ts';
import { profile } from './profile.ts';
import { VoiceOverlayGuard } from './voice-overlay-guard.ts';
import type { Clock } from './clock.ts';

const execute = promisify(execFile);
type Runner = (file: string, args: string[]) => Promise<string>;
interface DebugRecord {
  display_mode?: DisplayMode;
  request_id: string; text: string; device_id?: string; created_at: string;
  status: string; error: string | null; receipt?: GlassesReceipt; events: GlassesEvent[];
}
/** 协调上位机恢复、独立通知与权限守护，不重放实验刺激。 */
export class DeviceControl {
  private readonly engine: Engine;
  private readonly serial: string;
  private readonly adb: string;
  private readonly packageName: string;
  private readonly run: Runner;
  /** 墙钟：与已持久化的时间戳比较或写审计时间。 */
  private readonly now: () => number;
  /** 单调钟：仅用于重试限频等间隔计时。 */
  private readonly mono: () => number;
  private readonly scrcpy: string;
  private readonly wait: (ms: number) => Promise<void>;
  private mirror?: ChildProcess;
  private mirrorError: string | null = null;
  private enabled: boolean;
  private working = false;
  private closed = false;
  private lastAttempt = -Infinity;
  private task?: Promise<unknown>;
  private readonly voiceGuard: VoiceOverlayGuard;
  private diagnostics: { last_action: string | null; last_at: string | null; error: string | null } = { last_action: null, last_at: null, error: null };

  /** 绑定设备、ADB 执行器和持久化记录；重启后的在途通知只标为待核查。 */
  constructor(engine: Engine, options: { serial?: string; adb?: string; packageName?: string; enabled?: boolean; run?: Runner; clock?: Clock; now?: () => number; scrcpy?: string; wait?: (ms: number) => Promise<void> } = {}) {
    this.engine = engine; this.serial = options.serial ?? ''; this.adb = options.adb ?? 'adb';
    this.packageName = options.packageName ?? 'link.ironip.a5.rayneo';
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(this.packageName)) throw new Error('A5_RAYNEO_PACKAGE 包名无效。');
    this.run = options.run ?? (async (file, args) => (await execute(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    // 优先用注入的 clock；旧参数 now 仅作兼容，同时充当墙钟与单调钟（测试用假时钟）。
    const clock: Clock = options.clock ?? (options.now ? { wall: options.now, mono: options.now } : engine.clock);
    this.now = clock.wall; this.mono = clock.mono;
    this.scrcpy = options.scrcpy ?? 'scrcpy';
    this.wait = options.wait ?? delay;
    this.voiceGuard = new VoiceOverlayGuard(engine.store, { serial: this.serial, adb: this.adb, run: this.run, clock, audit: (action, detail) => this.audit(action, detail) });
    this.engine.store.db.exec('CREATE TABLE IF NOT EXISTS device_debug_requests(request_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const saved = this.engine.store.setting<boolean>('device_host_enabled');
    this.enabled = saved ?? options.enabled ?? true;
    for (const record of this.records()) {
      if (record.status === 'sending') { record.status = 'unknown'; record.error = '服务重启，测试通知结果待核查；不会补发。'; this.save(record); }
    }
    engine.deviceControlBusy = () => this.working || this.hasLiveDebug();
    engine.deviceDebugEvent = event => this.receive(event);
  }
  /** 只允许真实设备适配器和有效序列号执行主机操作。 */
  private supported() { return this.engine.adapter.getStatus().source === 'device' && /^[A-Za-z0-9_.:-]{1,128}$/.test(this.serial); }
  /** 按通知编号保存幂等记录，不写入实验会话。 */
  private save(record: DebugRecord) { this.engine.store.db.prepare('INSERT INTO device_debug_requests VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data').run(record.request_id, JSON.stringify(record)); }
  /** 读取最近五十条独立通知，供互斥保护与后台展示使用。 */
  private records(): DebugRecord[] { return (this.engine.store.db.prepare('SELECT data FROM device_debug_requests ORDER BY rowid DESC LIMIT 50').all() as { data: string }[]).map(row => JSON.parse(row.data)); }
  /** 记录设备操作结果，保留时间和诊断供后台核查。 */
  private audit(action: string, detail: unknown) { this.engine.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_control', action, timestamp_iso: new Date(this.now()).toISOString(), detail })); }
  /** 检查是否存在禁止独立测试通知的活跃实验会话。 */
  private activeSession() { return this.engine.store.ids().some(id => this.engine.session(id).state.status === 'active'); }
  /** 在通知结束证据到达或安全窗口过期前保护显示端。 */
  private hasLiveDebug() { return this.records().some(record => !['failed', 'hidden'].includes(record.status) && (record.display_mode==='confirm_until_ack' ? !record.events.some(e=>e.kind==='hidden') : this.now() - Date.parse(record.created_at) < 15000)); }
  /** 合并设备忙碌、调试通知和实验消息的展示保护窗口。 */
  private displayProtected() {
    if (this.engine.adapter.getStatus().busy || this.hasLiveDebug()) return true;
    return this.engine.store.ids().some(id => this.engine.store.interventions(id).some(message =>
      ['scheduled', 'send_requested'].includes(message.status) || !!message.t_send && this.now() - Date.parse(message.t_send) < 11000 && !message.device_events?.some(event => event.kind === 'hidden')));
  }
  /** 返回后台设备控制快照，包括守护诊断、独立通知与审计。 */
  status() {
    return { supported: this.supported(), enabled: this.supported() && this.enabled, working: this.working,
      package_name: this.packageName, ...this.diagnostics, active_session: this.activeSession(), voice_guard: this.voiceGuard.status(),
      scrcpy: { running: !!this.mirror && this.mirror.exitCode === null, crop: '640:480:0:0', error: this.mirrorError },
      debug_allowed: this.supported() && !this.working && !this.hasLiveDebug() && !this.engine.adapter.getStatus().busy,
      debug_notifications: [...this.engine.store.ids().flatMap(id=>this.engine.store.interventions(id).filter(m=>m.data_kind==='manual').map(m=>({...m,events:m.device_events??[],created_at:m.t_event,status:m.device_events?.some(e=>e.kind==='hidden')?'hidden':m.status}))),...this.records()].sort((a,b)=>b.created_at.localeCompare(a.created_at)), audit: (this.engine.store.db.prepare("SELECT data FROM admin_audit WHERE json_extract(data,'$.event_type')='device_control' ORDER BY seq DESC LIMIT 30").all() as { data: string }[]).map(row => JSON.parse(row.data)) };
  }
  /** 消费绑定设备的独立通知事件，按事件编号去重并保留终态。 */
  private receive(event: GlassesEvent) {
    const row = this.engine.store.db.prepare('SELECT data FROM device_debug_requests WHERE request_id=?').get(event.request_id) as { data: string } | undefined;
    if (!row) return false;
    const record: DebugRecord = JSON.parse(row.data);
    if (record.device_id !== event.device_id) { this.audit('debug_event_rejected', '设备绑定不一致'); return true; }
    const prior = record.events.find(item => item.event_id === event.event_id);
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(event)) throw new Error('device_debug_event_conflict'); return true; }
    record.events.push(event);
    if (event.kind === 'failed' || event.kind === 'cue_failed') { record.status = 'failed'; record.error = event.error; }
    else if (record.status !== 'failed') record.status = record.events.some(item => item.kind === 'hidden') ? 'hidden' : record.events.some(item => item.kind === 'drawn') ? 'drawn' : 'accepted';
    this.save(record); return true;
  }
  /** 校验允许的操作并串行执行，关闭或展示保护期间拒绝冲突操作。 */
  async action(input: { action: string; enabled?: boolean; text?: string; request_id?: string; display_mode?: DisplayMode }) {
    if (this.closed) throw new HttpError(409, '显示控制正在关闭。');
    if (!this.supported()) throw new HttpError(409, '当前为 Mock 模式，不能执行真机控制或发送眼镜通知。');
    if (this.working) throw new HttpError(409, '另一项眼镜控制正在执行，请稍后重试。');
    if (!['host', 'probe', 'open', 'reconnect', 'notify', 'confirm_notify', 'scrcpy'].includes(input.action)) throw new HttpError(422, '不支持的眼镜控制操作。');
    if (input.action === 'host') {
      if (typeof input.enabled !== 'boolean') throw new HttpError(422, '请指定是否启用上位机守护。');
      if (this.displayProtected()) throw new HttpError(409, '眼镜消息尚未展示结束，暂不能变更系统悬浮窗保护。');
    }
    this.working = true;
    const work = this.perform(input);
    this.task = work;
    try { return await work; } finally { this.working = false; }
  }
  /** 执行一次控制操作；失败写入诊断与审计并转换为 HTTP 错误。 */
  private async perform(input: { action: string; enabled?: boolean; text?: string; request_id?: string; display_mode?: DisplayMode }) {
    this.diagnostics = { last_action: input.action, last_at: new Date(this.now()).toISOString(), error: null };
    try {
      let notification: DebugRecord | undefined;
      if (input.action === 'host') {
        this.enabled = input.enabled!; this.engine.store.setSetting('device_host_enabled', this.enabled);
        await this.voiceGuard.sync(this.enabled);
      }
      else if(input.action==='confirm_notify') {
        const m=this.engine.store.findRequest(input.request_id??'');
        if(m?.data_kind==='manual') await this.engine.confirmMessage(m.session_id,m.request_id);
        else { const record=this.records().find(r=>r.request_id===input.request_id); if(!record || record.display_mode!=='confirm_until_ack' || !record.events.some(e=>e.kind==='drawn')) throw new HttpError(409,'没有可确认的手动通知。'); if(!this.engine.adapter.confirm) throw new HttpError(409,'设备不支持确认。');await this.engine.adapter.confirm({request_id:record.request_id,device_id:record.device_id}); }
      }
      else if (input.action === 'notify') notification = await this.notify(input);
      else if (input.action === 'scrcpy') await this.openMirror();
      else if (input.action === 'probe') await this.engine.adapter.probe?.();
      else {
        if (this.displayProtected()) throw new HttpError(409, '眼镜消息尚未展示结束，暂不能重建连接或切换前台。');
        if (input.action === 'reconnect') await this.engine.adapter.reconnect?.();
        else await this.recover();
        const after = this.engine.adapter.getStatus();
        if (!this.closed && !after.connected) throw new Error(`显示端连接未恢复：${after.error ?? 'device_disconnected'}`);
      }
      this.audit(input.action, { ok: true, request_id: notification?.request_id });
      return { notification, adapter: this.engine.adapter.getStatus(), control: this.status() };
    } catch (error) {
      this.diagnostics.error = (error instanceof Error ? error.message : String(error)).replaceAll(this.serial, '[已绑定设备]');
      this.audit(input.action, { ok: false, error: this.diagnostics.error });
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, this.diagnostics.error);
    }
  }
  /** 为绑定设备打开左眼镜像，复用仍在运行的 scrcpy 进程。 */
  private async openMirror() {
    if (this.mirror && this.mirror.exitCode === null) return;
    this.mirrorError = null;
    const child = spawn(this.scrcpy, ['--serial', this.serial, '--crop', '640:480:0:0', '--no-audio', '--window-title', 'A5 眼镜画面 · 左眼 640×480'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ADB: this.adb },
    });
    this.mirror = child;
    child.stderr?.on('data', () => { /* 不把设备标识和第三方日志注入页面。 */ });
    child.on('exit', code => { if (code) this.mirrorError = 'scrcpy 已退出，请检查 USB 连接后重试。'; });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { this.mirror = undefined; this.mirrorError = '未找到或无法启动 scrcpy，请配置 A5_SCRCPY_PATH。'; reject(new HttpError(503, this.mirrorError)); });
    });
  }
  /** 核对 ADB、恢复前台并探测显示端；各异步步骤之间检查关闭状态。 */
  private async recover() {
    let state: string;
    try { state = (await this.run(this.adb, ['-s', this.serial, 'get-state'])).trim(); }
    catch { throw new Error('ADB 设备不可用：请检查 USB 数据线及眼镜调试授权。'); }
    if (state !== 'device') throw new Error('ADB 设备尚未授权或未连接。');
    await this.voiceGuard.sync(this.enabled);
    if (this.closed) return;
    await this.run(this.adb, ['-s', this.serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    if (this.closed) return;
    await this.run(this.adb, ['-s', this.serial, 'shell', 'cmd', 'statusbar', 'collapse']).catch(() => {});
    if (this.closed) return;
    const result = await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'start', '-n', `${this.packageName}/link.ironip.a5.rayneo.MainActivity`]);
    if (/Error|Exception/.test(result)) throw new Error('无法打开指定眼镜显示程序，请确认 APK 已安装。');
    if (this.closed) return;
    const window = await this.run(this.adb, ['-s', this.serial, 'shell', 'dumpsys', 'window']).catch(() => '');
    const focus = window.split(/\r?\n/).find(line => line.includes('mCurrentFocus=')) ?? '';
    const focusedApp = window.split(/\r?\n/).find(line => line.includes('mFocusedApp=')) ?? '';
    // 仅收起覆盖本显示应用的厂商系统面板，不在正常显示页发返回导致应用退出。
    if (!this.closed && focusedApp.includes(this.packageName) && focus.includes('com.ffalconxr.mercury.launcher')) {
      await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']);
    }
    if (this.closed) return;
    await this.engine.adapter.probe?.();
  }
  /** 以请求编号去重发送独立通知，未知结果保留记录且不自动重发。 */
  private async notify(input: { text?: string; request_id?: string; display_mode?: DisplayMode }) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 500) throw new HttpError(422, '请填写 1—500 字的测试通知。');
    if (typeof input.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.request_id)) throw new HttpError(422, '测试通知必须带有效的 request_id。');
    const row = this.engine.store.db.prepare('SELECT data FROM device_debug_requests WHERE request_id=?').get(input.request_id) as { data: string } | undefined;
    if (row) {
      const prior: DebugRecord = JSON.parse(row.data);
      if (prior.text !== input.text || (prior.display_mode??'legacy_8500') !== (input.display_mode??'legacy_8500')) throw new HttpError(409, '同一通知编号不能绑定不同内容。');
      return prior;
    }
    const mode=input.display_mode??'legacy_8500';
    if(!['legacy_8500','tone_8500','confirm_until_ack'].includes(mode)) throw new HttpError(422,'通知模态无效。');
    const sessionId=this.engine.store.ids().find(id=>{const s=this.engine.session(id);return s.state.status==='active' && s.state.device_id===this.engine.adapter.getStatus().device_id;});
    if(sessionId) { const m=this.engine.manualNotification(sessionId,input.request_id!,input.text!,mode); return {...m,receipt:m.receipt as GlassesReceipt|undefined,text:m.text!,created_at:m.t_event,events:m.device_events??[]}; }
    if (this.hasLiveDebug()) throw new HttpError(409, '上一条测试通知尚未展示结束。');
    const state = this.engine.adapter.getStatus();
    if (!state.connected || !state.ready || state.busy) throw new HttpError(409, '显示端未就绪，请先点击“唤醒并打开显示端”。');
    this.engine.requireFixedDuration(mode);
    const record: DebugRecord = { request_id: input.request_id, text: input.text, device_id: state.device_id, created_at: new Date(this.now()).toISOString(), display_mode:mode,status: 'sending', error: null, events: [] };
    this.save(record);
    const request: GlassesRequest = { request_id: record.request_id, session_id: `device-debug:${randomUUID()}`, participant_id: 'DEVICE_DEBUG', stage_id: `${profile.stage_prefix}01`, message_id: 'DEVICE_DEBUG', text: record.text, duration_ms: mode === 'confirm_until_ack' ? 8500 : 11000, display_mode:mode, device_id: state.device_id };
    try {
      const receipt = await this.engine.adapter.send(request);
      const current = JSON.parse((this.engine.store.db.prepare('SELECT data FROM device_debug_requests WHERE request_id=?').get(record.request_id) as { data: string }).data) as DebugRecord;
      current.receipt = receipt;
      if (!current.events.length || receipt.status === 'failed') { current.status = receipt.status; current.error = receipt.error; }
      this.save(current); return current;
    } catch {
      record.status = 'unknown'; record.error = '测试通知发送结果待核查，不会自动重发。'; this.save(record); return record;
    }
  }
  /** 隔离定时入口的同步异常；即使数据库不可读也让服务继续处理实验。 */
  tick() {
    try {
      this.tickGuard();
    } catch (error) {
      this.reportTickError(error);
    }
  }
  /** 不依赖数据库审计记录定时任务错误，供同步与异步异常共用。 */
  private reportTickError(error: unknown) {
    this.diagnostics = { last_action: 'tick', last_at: new Date(this.now()).toISOString(),
      error: (error instanceof Error ? error.message : String(error)).replaceAll(this.serial, '[已绑定设备]') };
    console.error('设备控制定时任务失败：', this.diagnostics.error);
  }
  /** 按展示保护和限频规则触发权限核对或前台恢复，不重放消息。 */
  private tickGuard() {
    if (this.closed || !this.supported() || this.working || this.displayProtected()) return;
    const voiceDue = this.voiceGuard.due(this.enabled);
    if (!this.enabled && !voiceDue) return;
    const state = this.engine.adapter.getStatus();
    if (state.connected && state.ready || !this.enabled) {
      if (!voiceDue || this.mono() - this.lastAttempt < 5000) return;
      this.lastAttempt = this.mono(); this.working = true;
      this.task = this.voiceGuard.sync(this.enabled).catch(error => this.reportTickError(error)).finally(() => { this.working = false; });
      return;
    }
    if (this.mono() - this.lastAttempt < 5000) return;
    this.lastAttempt = this.mono();
    void this.action({ action: 'open' }).catch(() => { /* 具体错误已写入控制诊断与审计，下一次限频恢复。 */ });
  }
  /** 退出时最多等待十五秒回收展示结束证据，安全后恢复原权限；故障时保留备份。 */
  async close() {
    this.closed = true; await this.task?.catch(() => {}); this.mirror?.kill();
    if (!this.supported() || !this.voiceGuard.hasBackup()) return;
    // 服务定时器已停止，只回收设备状态和事件，不推进实验或重发刺激。
    for (let waited = 0; this.displayProtected() && waited < 15000; waited += 250) {
      this.engine.pollDevice();
      await this.wait(250);
    }
    if (this.displayProtected()) {
      this.audit('voice_overlay_restore_deferred', { ok: false, error: '关闭等待展示结束超时，原权限备份已保留。' });
      return;
    }
    await this.voiceGuard.sync(false);
  }
}
