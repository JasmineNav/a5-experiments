import {grantRuntimePermissions,collapseSystemPanel,Backoff,RouteMemory,WirelessSupervisor,adbTransport,listDevices,parseAddress,resolveDeviceIdentity,connectRoute,enableWireless,runDoctor,diagnoseFocus,type DoctorReport} from '@lab/glasses-display';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Engine, HttpError } from './engine.ts';
import type { DisplayMode, GlassesEvent, GlassesReceipt, GlassesRequest } from './contracts.ts';
import { profile } from './profile.ts';
import { VoiceOverlayGuard } from './voice-overlay-guard.ts';
import type { Clock } from './clock.ts';
import { displayRelease } from '@a5/glasses/display-release.ts';
import { legacyDisplayPackages } from '@a5/glasses/legacy-display.ts';
import { sendErrorDelivery } from '@a5/glasses/contracts.ts';

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
  private serial: string;
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
  private identity:'adb'|'hardware';
  private hardwareId?:string;
  private readonly routes:RouteMemory;
  private readonly link:WirelessSupervisor;
  private readonly hostBackoff=new Backoff({baseMs:10000,maxMs:20000,maxAttempts:3});
  private hostStall:{reason:string;hint:string;attempts:number}|null=null;
  private startupRecalled=false;
  private lastDoctor:DoctorReport|null=null;
  private clockSamples:{device_monotonic_ms:number;clock_id:string;rtt_ms:number}[]=[];
  private readonly voiceGuard: VoiceOverlayGuard;
  private diagnostics: { last_action: string | null; last_at: string | null; error: string | null } = { last_action: null, last_at: null, error: null };

  /** 绑定设备、ADB 执行器和持久化记录；重启后的在途通知只标为待核查。 */
  constructor(engine: Engine, options: { serial?: string; adb?: string; packageName?: string; enabled?: boolean; run?: Runner; clock?: Clock; now?: () => number; scrcpy?: string; wait?: (ms: number) => Promise<void>; identity?:'adb'|'hardware' } = {}) {
    this.engine = engine; this.serial = options.serial ?? ''; this.adb = options.adb ?? 'adb';
    this.packageName = options.packageName ?? 'link.ironip.glasses.display';
    this.identity=options.identity??'adb';
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(this.packageName)) throw new Error('A5_RAYNEO_PACKAGE 包名无效。');
    this.run = options.run ?? (async (file, args) => (await execute(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    // 优先用注入的 clock；旧参数 now 仅作兼容，同时充当墙钟与单调钟（测试用假时钟）。
    const clock: Clock = options.clock ?? (options.now ? { wall: options.now, mono: options.now } : engine.clock);
    this.now = clock.wall; this.mono = clock.mono;
    this.routes=new RouteMemory({get:key=>engine.store.setting(key),set:(key,value)=>engine.store.setSetting(key,value)},{now:()=>new Date(this.now())});
    const epochOffset=this.now()-this.mono();
    this.link=new WirelessSupervisor({run:this.run,adb:this.adb,now:()=>this.mono()+epochOffset,sleep:options.wait??delay,audit:(action,detail)=>this.audit(action,detail)});
    this.scrcpy = options.scrcpy ?? 'scrcpy';
    this.wait = options.wait ?? delay;
    this.voiceGuard = new VoiceOverlayGuard(engine.store, { serial: this.serial, adb: this.adb, run: this.run, clock, audit: (action, detail) => this.audit(action, detail) });
    this.engine.store.db.exec('CREATE TABLE IF NOT EXISTS device_debug_requests(request_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const saved = this.engine.store.setting<boolean>('device_host_enabled');
    this.enabled = saved ?? options.enabled ?? true;
    this.startupRecalled=!engine.adapter.setRoute;
    this.hardwareId=engine.store.setting<{hardware_id?:string}>('device_route')?.hardware_id;
    for (const record of this.records()) {
      if (record.status === 'sending') { record.status = 'unknown'; record.error = '服务重启，测试通知结果待核查；不会补发。'; this.save(record); }
    }
    engine.deviceOperationsBusy=()=>this.working||this.closed;
    engine.deviceControlBusy = () => this.working || this.hasLiveDebug();
    engine.deviceDebugEvent = event => this.receive(event);
  }
  /** 只允许真实设备适配器和有效序列号执行主机操作。 */
  private supported() { return this.engine.adapter.getStatus().source === 'device'; }
  /** 按通知编号保存幂等记录，不写入实验会话。 */
  private save(record: DebugRecord) { this.engine.store.db.prepare('INSERT INTO device_debug_requests VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data').run(record.request_id, JSON.stringify(record)); }
  /** 读取最近五十条独立通知，供互斥保护与后台展示使用。 */
  private records(): DebugRecord[] { return (this.engine.store.db.prepare('SELECT data FROM device_debug_requests ORDER BY rowid DESC LIMIT 50').all() as { data: string }[]).map(row => JSON.parse(row.data)); }
  /** 记录设备操作结果，保留时间和诊断供后台核查。 */
  private audit(action: string, detail: unknown) { this.engine.store.db.prepare('INSERT INTO admin_audit(data) VALUES (?)').run(JSON.stringify({ event_type: 'device_control', action, timestamp_iso: new Date(this.now()).toISOString(), detail })); }
  /** 检查是否存在禁止独立测试通知的活跃实验会话。 */
  private activeSession() { return this.engine.store.ids().some(id => this.engine.session(id).state.status === 'active'); }
  /** 在通知结束证据到达或安全窗口过期前保护显示端。 */
  /** 确认模式只有已绘制且未消失才持续保护；未收到回执的记录只在时长窗口内保护，避免永远挡住「重连/打开」导致无法回收证据。 */
  private hasLiveDebug() { return this.records().some(record => !['failed', 'hidden', 'not_sent'].includes(record.status) && (
    record.display_mode==='confirm_until_ack' && record.events.some(e=>e.kind==='drawn') ? !record.events.some(e=>e.kind==='hidden') : this.now() - Date.parse(record.created_at) < Math.max(15000, this.debugDurationMs() + 4000))); }
  private debugDurationMs() { return this.engine.material.content.message_duration_ms; }
  /** 合并设备忙碌、调试通知和实验消息的展示保护窗口。 */
  private displayProtected() {
    if (this.engine.adapter.getStatus().busy || this.hasLiveDebug()) return true;
    return this.engine.store.ids().some(id => this.engine.store.interventions(id).some(message =>
      ['scheduled', 'send_requested'].includes(message.status) || !['failed', 'not_sent'].includes(message.status) && !!message.t_send && this.now() - Date.parse(message.t_send) < Math.max(11000, message.duration_ms) && !message.device_events?.some(event => event.kind === 'hidden')));
  }
  /** 返回后台设备控制快照，包括守护诊断、独立通知与审计。 */
  status() {
    return { supported: this.supported(), enabled: this.supported() && this.enabled, working: this.working,
      route:this.serial,identity_mode:this.identity,hardware_id:this.hardwareId??null,expected_app_version:displayRelease.version,installed_apk:this.versionEvidence(),link:this.link.status(),remembered_routes:this.routes.all(),
      host_stall:this.hostStall,host_retry_in_ms:this.hostStall||!this.hostBackoff.attempts?null:Number.isFinite(this.hostBackoff.nextAt)?Math.max(0,this.hostBackoff.nextAt-this.mono()):null,doctor:this.lastDoctor,clock_samples:this.clockSamples,
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
    const work = (async()=>{await this.engine.settle();
      if(['open','reconnect'].includes(input.action)){this.hostBackoff.reset();this.hostStall=null;}
      return this.perform(input);
    })();
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
        if(this.serial)await this.voiceGuard.sync(this.enabled);
      }
      else if(input.action==='confirm_notify') {
        const m=this.engine.store.findRequest(input.request_id??'');
        if(m?.data_kind==='manual') await this.engine.confirmMessage(m.session_id,m.request_id);
        else { const record=this.records().find(r=>r.request_id===input.request_id); if(!record || record.display_mode!=='confirm_until_ack' || !record.events.some(e=>e.kind==='drawn')) throw new HttpError(409,'没有可确认的手动通知。'); if(!this.engine.adapter.confirm) throw new HttpError(409,'设备不支持确认。');await this.engine.adapter.confirm({request_id:record.request_id,device_id:record.device_id}); }
      }
      else if (input.action === 'notify') notification = await this.notify(input);
      else if (input.action === 'scrcpy') {if(this.displayProtected())throw new HttpError(409,'眼镜消息尚未展示结束。');await this.openMirror();}
      else if (input.action === 'probe') {if(this.displayProtected())throw new HttpError(409,'眼镜消息尚未展示结束。');await this.engine.adapter.probe?.();}
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
      this.diagnostics.error = (error instanceof Error ? error.message : String(error)).replaceAll(this.serial||'\u0000', '[已绑定设备]');
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
    if(!this.serial)throw new Error('请先选设备并连接通道。');
    let state: string;
    try { state = (await this.run(this.adb, ['-s', this.serial, 'get-state'])).trim(); }
    catch { throw new Error('ADB 设备不可用：请检查 USB 数据线及眼镜调试授权。'); }
    if (state !== 'device') throw new Error('ADB 设备尚未授权或未连接。');
    await this.voiceGuard.sync(this.enabled);
    if (this.closed) return;
    await this.run(this.adb, ['-s', this.serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    if (this.closed) return;
    await this.stopLegacyDisplay();
    if (this.closed) return;
    await this.grantPermissionsOnce();
    if (this.closed) return;
    await this.measureInstalledApk();
    if (this.closed) return;
    const result = await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'start', '-n', `${this.packageName}/link.ironip.glasses.display.MainActivity`]);
    if (/Error|Exception/.test(result)) throw new Error('无法打开指定眼镜显示程序，请确认 APK 已安装。');
    if (this.closed) return;
    // 共享基座负责识别并收起覆盖显示端的系统面板（只在覆盖时广播，不按返回键）。
    const panel = await collapseSystemPanel(this.target(), { packageName: this.packageName });
    if (panel.dismissed) this.audit('system_panel_collapsed', { focus: panel.focus });
    if (this.closed) return;
    await this.engine.adapter.probe?.();
  }
  private target() { return { run: this.run, adb: this.adb, serial: this.serial }; }
  /** 旧版 A5 自带显示端若仍在运行会抢前台/屏幕，打开共享显示端前先停止；未安装时 force-stop 无副作用。 */
  private async stopLegacyDisplay() {
    for (const pkg of legacyDisplayPackages) if (pkg !== this.packageName) await this.run(this.adb, ['-s', this.serial, 'shell', 'am', 'force-stop', pkg]).catch(() => '');
  }
  private permissionsGranted = new Set<string>();
  /** 每个路由预授一次相机/麦克风权限，避免显示端首启权限框遮挡；失败只审计，不阻止打开。 */
  private async grantPermissionsOnce() {
    if (this.permissionsGranted.has(this.serial)) return;
    const result = await grantRuntimePermissions(this.target(), { packageName: this.packageName });
    if (result.ok) this.permissionsGranted.add(this.serial); else this.audit('runtime_permissions_incomplete', result.results);
  }
  private installedApk: { serial: string; sha256: string | null; error: string | null } | null = null;
  /** 记录设备上实际安装的显示端 APK SHA-256（每个路由一次），供建会话时写入版本坐标；失败只记 null，不阻止打开。 */
  private async measureInstalledApk() {
    if (this.installedApk?.serial === this.serial && this.installedApk.sha256) return;
    let sha256: string | null = null, error: string | null = null;
    try {
      const path = /package:(\S+\.apk)/.exec(await this.run(this.adb, ['-s', this.serial, 'shell', 'pm', 'path', this.packageName]))?.[1];
      if (!path) throw new Error('apk_path_unavailable');
      sha256 = /^([0-9a-f]{64})\b/.exec((await this.run(this.adb, ['-s', this.serial, 'shell', 'sha256sum', path])).trim())?.[1] ?? null;
      if (!sha256) throw new Error('apk_sha256_unavailable');
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    this.installedApk = { serial: this.serial, sha256, error };
    if (sha256 && sha256 !== displayRelease.sha256) this.audit('display_apk_not_pinned', { installed_sha256: sha256, pinned_sha256: displayRelease.sha256 });
  }
  /** 本次运行的设备侧版本证据；路由变化后旧测量不再适用。 */
  versionEvidence() {
    const apk = this.installedApk?.serial === this.serial ? this.installedApk : null;
    return { installed_apk_sha256: apk?.sha256 ?? null, installed_apk_matches_pin: apk?.sha256 ? apk.sha256 === displayRelease.sha256 : null, package_name: this.packageName };
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
    const request: GlassesRequest = { request_id: record.request_id, session_id: `device-debug:${randomUUID()}`, participant_id: 'DEVICE_DEBUG', stage_id: `${profile.stage_prefix}01`, message_id: 'DEVICE_DEBUG', text: record.text, duration_ms: mode === 'confirm_until_ack' ? 8500 : this.debugDurationMs(), display_mode:mode, device_id: state.device_id };
    try {
      const receipt = await this.engine.adapter.send(request);
      const current = JSON.parse((this.engine.store.db.prepare('SELECT data FROM device_debug_requests WHERE request_id=?').get(record.request_id) as { data: string }).data) as DebugRecord;
      current.receipt = receipt;
      if (!current.events.length || receipt.status === 'failed') { current.status = receipt.status; current.error = receipt.error; }
      this.save(current); return current;
    } catch (error) {
      // unknown 只用于服务重启；运行中异常按是否可能已发出分 failed / not_sent / unacknowledged，均不自动重发。
      record.status = sendErrorDelivery(error); record.error = `${error instanceof Error ? error.message : String(error)}；不会自动重发。`; this.save(record); return record;
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
      error: (error instanceof Error ? error.message : String(error)).replaceAll(this.serial||'\u0000', '[已绑定设备]') };
    console.error('设备控制定时任务失败：', this.diagnostics.error);
  }
  /** 按展示保护和限频规则触发权限核对或前台恢复，不重放消息。 */
  private tickGuard() {
    if(this.closed||!this.supported()||this.working||this.displayProtected())return;
    const s=this.engine.adapter.getStatus();
    if(s.connected&&s.ready){this.hostBackoff.reset();this.hostStall=null;}
    if(s.connected&&this.serial&&adbTransport(this.serial)==='wifi_tcpip'){
      this.link.healthy(this.serial);if(this.hardwareId)this.routes.remember(this.hardwareId,this.serial,s.network??null);
    }
    const needsLink=!s.connected&&adbTransport(this.serial)==='wifi_tcpip';
    if(!this.startupRecalled||needsLink){
      this.working=true;
      this.task=(async()=>{await this.engine.settle();
        if(!this.startupRecalled){this.startupRecalled=true;await this.recallRoute();}
        if(this.serial&&adbTransport(this.serial)==='wifi_tcpip'){
          if(this.engine.adapter.getStatus().connected)this.link.healthy(this.serial);
          else {const result=await this.link.heal(this.serial,this.hardwareId);if(this.enabled&&['present','connected'].includes(result)&&!this.hostStall&&this.hostBackoff.due(this.mono()))await this.recoverGuarded();}
        }
      })().catch(e=>this.reportTickError(e)).finally(()=>{this.working=false;});return;
    }
    const voiceDue=this.voiceGuard.due(this.enabled);
    if(s.connected&&s.ready||!this.enabled){
      if(!voiceDue||this.mono()-this.lastAttempt<5000)return;
      this.lastAttempt=this.mono();this.working=true;
      this.task=(async()=>{await this.engine.settle();await this.voiceGuard.sync(this.enabled);})().catch(e=>this.reportTickError(e)).finally(()=>{this.working=false;});return;
    }
    if(!this.serial||this.hostStall||!this.hostBackoff.due(this.mono()))return;
    this.lastAttempt=this.mono();this.working=true;
    this.task=(async()=>{await this.engine.settle();
      if(adbTransport(this.serial)==='wifi_tcpip'){
        const transport=(await listDevices(this.run,this.adb)).find(d=>d.serial===this.serial);
        if(transport?.state!=='device')return;
      }
      await this.recoverGuarded();
    })().catch(e=>this.reportTickError(e)).finally(()=>{this.working=false;});
  }
  private async recoverGuarded(){
      try{await this.recover();}catch(e){this.diagnostics.error=e instanceof Error?e.message:String(e);}
      const after=this.engine.adapter.getStatus();
      if(after.connected&&after.ready){this.hostBackoff.reset();this.hostStall=null;return;}
      const focus=await diagnoseFocus(this.run,this.adb,this.serial,this.packageName);
      const next=this.hostBackoff.fail(this.mono());
      if(focus.kind==='system_dialog'||next===null){this.hostStall={reason:focus.kind==='system_dialog'?'system_dialog':'host_stall',hint:'自动唤醒已停止；处理眼镜遮挡/权限或运行自检后，点击「唤醒并打开」重试。',attempts:this.hostBackoff.attempts};this.audit('host_retry_stopped',this.hostStall);}
  }
  private async exclusive<T>(work:()=>Promise<T>){
    if(this.closed||this.working)throw new HttpError(409,'眼镜控制正在执行或关闭。');
    if(!this.supported())throw new HttpError(409,'Mock 模式不执行真机整备。');
    if(this.displayProtected())throw new HttpError(409,'眼镜消息尚未展示结束，不能交错执行设备操作。');
    this.working=true;const task=(async()=>{await this.engine.settle();return work();})();this.task=task;
    try{return await task;}finally{this.working=false;}
  }
  private requireMutable(){if(this.activeSession()||this.displayProtected())throw new HttpError(409,'存在进行中会话或眼镜展示，不能切换路由。');}
  async devices(){return listDevices(this.run,this.adb);}
  async configure(input:{serial:string;identity?:'adb'|'hardware'}){return this.exclusive(()=>this.bind(input.serial,input.identity));}
  private async bind(serial:string,identity=this.identity){
    this.requireMutable();if(typeof serial!=='string'||!/^[A-Za-z0-9_.:\[\]-]{1,128}$/.test(serial)||!['adb','hardware'].includes(identity))throw new HttpError(422,'设备路由或身份模式无效。');
    if(!this.engine.adapter.setRoute)throw new HttpError(409,'适配器不支持路由配置。');
    const hardware=await resolveDeviceIdentity(this.run,this.adb,serial);
    const prior=this.serial;
    if(this.identity==='hardware'&&identity==='hardware'&&this.engine.adapter.getStatus().device_id&&this.engine.adapter.getStatus().device_id!==hardware.device_id)throw new HttpError(409,'固定硬件身份与所选路由不一致。');
    if(prior&&prior!==serial&&this.voiceGuard.hasBackup()){
      const before=this.hardwareId??(await resolveDeviceIdentity(this.run,this.adb,prior).catch(()=>null))?.device_id;
      if(before===hardware.device_id)VoiceOverlayGuard.moveBackup(this.engine.store,prior,serial);
      else {await this.voiceGuard.sync(false);if(this.voiceGuard.hasBackup())throw new HttpError(409,'原设备权限尚未恢复，不能切换到另一副眼镜。');}
    }
    await this.engine.adapter.setRoute(serial,identity);
    this.serial=serial;this.identity=identity;this.hardwareId=hardware.device_id;this.voiceGuard.rebind(serial);this.mirror?.kill();this.mirror=undefined;
    this.engine.store.setSetting('device_route',{serial,identity,hardware_id:hardware.device_id});
    this.routes.remember(hardware.device_id,serial,this.engine.adapter.getStatus().network??null);
    this.link.reset();this.hostBackoff.reset();this.hostStall=null;this.audit('configure',{route:serial,identity,device_id:this.engine.adapter.getStatus().device_id});return this.status();
  }
  async connectWireless(address:string){return this.exclusive(async()=>{
    this.requireMutable();const route=parseAddress(address);if(!route)throw new HttpError(422,'请输入有效 IPv4 地址或 IP:端口。');
    const entry=(await this.devices()).find(d=>d.serial===route);
    const result=await connectRoute(this.run,this.adb,route,{resetFirst:!!entry&&entry.state!=='device',restartOnNoRoute:true});
    if(!result.ok)throw new HttpError(503,`无线连接失败：${result.failure} ${result.output}`);
    await this.bind(route);return {control:this.status(),connected_route:route};
  });}
  async enableWirelessFromUsb(serial?:string){return this.exclusive(async()=>{
    this.requireMutable();const usb=(await this.devices()).filter(d=>d.transport==='usb'&&d.state==='device'&&(!serial||serial===d.serial));
    if(usb.length!==1)throw new HttpError(409,'请插好并选择唯一已授权 USB 眼镜。');
    const usbIdentity=await resolveDeviceIdentity(this.run,this.adb,usb[0]!.serial);
    if(this.serial===usb[0]!.serial)this.hardwareId=usbIdentity.device_id;
    const result=await enableWireless({run:this.run,adb:this.adb,sleep:this.wait},usb[0]!.serial);await this.bind(result.route);
    this.routes.remember(result.device_id??usbIdentity.device_id,result.route,result.network);
    return {control:this.status(),connected_route:result.route,unplug:true};
  });}
  private async recallRoute(){
    if(!this.engine.adapter.setRoute||this.activeSession())return;
    const saved=this.engine.store.setting<{serial:string;identity:'adb'|'hardware';hardware_id:string}>('device_route');
    if(saved?.serial===this.serial){this.hardwareId=saved.hardware_id;return;}
    if(this.serial&&(await this.devices()).some(d=>d.serial===this.serial&&d.state==='device'))return;
    const remembered=this.routes.last(),route=saved?.serial??remembered?.route;if(!route)return;
    if(adbTransport(route)==='wifi_tcpip'){const result=await connectRoute(this.run,this.adb,route,{resetFirst:true,expectedDeviceId:saved?.hardware_id??remembered?.device_id});if(!result.ok)return;}
    await this.bind(route,saved?.identity??this.identity);this.audit('route_recall',{route});
  }
  async doctor(){return this.exclusive(async()=>{
    const report=await runDoctor({run:this.run,adb:this.adb,scrcpy:this.scrcpy,route:this.serial||undefined,packageName:this.packageName,expectedVersion:displayRelease.version,expectedDeviceId:this.hardwareId,env:{adb:'A5_ADB_PATH',scrcpy:'A5_SCRCPY_PATH'}});
    await this.engine.adapter.probe?.();const s=this.engine.adapter.getStatus();
    report.checks.push({id:'display_channel',label:'显示端通道',status:s.connected&&s.ready?'ok':'fail',detail:s.error??s.device_info?.app_version??'未就绪',next:s.connected&&s.ready?null:'先连接通道，再打开显示端'});
    this.clockSamples=[];if(s.connected&&this.engine.adapter.clockSample)for(let i=0;i<3;i++){const start=this.mono();const sample=await this.engine.adapter.clockSample();this.clockSamples.push({...sample,rtt_ms:this.mono()-start});}
    if(report.checks.some(c=>c.status==='fail'))report.conclusion='fail';this.lastDoctor=report;return {...report,clock_samples:this.clockSamples};
  });}
  /** 退出时最多等待十五秒回收展示结束证据，安全后恢复原权限；故障时保留备份。 */
  async close() {
    this.closed=true;await this.task?.catch(()=>{});await this.engine.settle();this.mirror?.kill();
    if(!this.supported())return;
    for(let waited=0;this.displayProtected()&&waited<15000;waited+=250){await this.engine.adapter.pollEvents?.(e=>this.engine.receiveDeviceEvent(e)).catch(()=>{});await this.wait(250);}
    if(this.displayProtected()){this.audit('voice_overlay_restore_deferred',{ok:false,error:'关闭等待展示结束超时，原权限备份已保留。'});await this.engine.adapter.close?.();return;}
    if(this.serial){await this.voiceGuard.sync(false);await this.engine.adapter.close?.();await this.run(this.adb,['-s',this.serial,'shell','am','force-stop',this.packageName]).catch(e=>this.audit('display_close_failed',{error:String(e)}));}
  }
}
