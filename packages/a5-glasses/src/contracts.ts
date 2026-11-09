import type {Capabilities,Tone} from '@lab/glasses-display';
// 眼镜通信契约：消息请求、回执、设备事件与适配器接口。各实验分项（静态桌面、动态行走等）共用。
export type DisplayMode = 'legacy_8500' | 'tone_8500' | 'confirm_until_ack';

export interface GlassesRequest {
  request_id: string;
  session_id: string;
  participant_id: string;
  stage_id: string;
  message_id: string;
  text: string;
  /** 固定模式的目标时长（毫秒）；confirm_until_ack忽略此值，不设置自动隐藏。默认 11000，8500 保留兼容旧快照；允许值由适配器配置。 */
  duration_ms: number;
  display_mode?: DisplayMode;
  device_id?: string;
}

export interface GlassesReceipt {
  request_id: string;
  source: 'mock' | 'device';
  /** not_sent：命令确定没有写入线路（无连接、取消或过截止时间），可由调用方决定是否以新 request_id 另发；unacknowledged：可能已写入但无回执。 */
  status: 'accepted' | 'failed' | 'unacknowledged' | 'not_sent';
  t_send: string;
  t_ack: string | null;
  t_display: string | null;
  t_hide: string | null;
  display_time_source: 'mock' | 'device_reported' | 'unavailable';
  error: string | null;
  device_id?: string;
  evidence?: unknown;
}

/** 设备时钟原样保存；应用绘制证据不等于光学呈现实测。 */
export interface GlassesEvent {
  event_id: string;
  request_id: string;
  device_id: string;
  kind: 'accepted' | 'drawn' | 'hidden' | 'failed' | 'confirmed' | 'cue_started' | 'cue_failed';
  device_wall_ms: number;
  device_monotonic_ms: number;
  clock_id: string;
  error: string | null;
  display_mode?: DisplayMode;
  duration_ms?: number;
  hide_reason?: string | null;
  tone?:Tone|null; tone_start_monotonic_ms?:number|null;
}
/** 适配器在写入线路之前就确定失败时抛出：failed 为本地校验拒绝，not_sent 为无连接/取消。两者都确定没有发出，不是在途未知。 */
export class PreSendError extends Error {
  readonly delivery: 'failed' | 'not_sent';
  constructor(message: string, delivery: 'failed' | 'not_sent' = 'failed') { super(message); this.delivery = delivery; }
}
/** 统一判定发送异常的投递状态；带 delivery 标记（含基座 NotSentError）的按标记，其余视为可能已发出但未确认。 */
export function sendErrorDelivery(error: unknown): 'failed' | 'not_sent' | 'unacknowledged' {
  const d = (error as { delivery?: unknown } | null)?.delivery;
  return d === 'failed' || d === 'not_sent' ? d : 'unacknowledged';
}
export interface SendOptions { signal?: AbortSignal; deadline?: number }
export interface GlassesStatus {
  source: 'mock' | 'device'; connected: boolean;
  device_id?: string; ready?: boolean; busy?: boolean; error?: string | null;
  protocol?: string; independent_duration?: boolean; persistent_deduplication?: boolean;
  display_evidence?: string; device_info?: Record<string, string>;
  capabilities?:Capabilities; route?:string; transport?:string; identity_source?:string; wifi_lock?:string; network?:string|null;
}
export interface GlassesAdapter {
  /** 读取连接与忙碌状态的快照，不触发设备操作。 */
  getStatus(): GlassesStatus;
  /** 探测显示端；调用方需读取状态确认是否连接成功。 */
  probe?(): Promise<void>;
  setRoute?(serial:string,identity?:'adb'|'hardware'):Promise<void>;
  clockSample?():Promise<{device_monotonic_ms:number;clock_id:string}>;
  /** 设备空闲时重建传输连接；完成后仍需检查连接状态。 */
  reconnect?(): Promise<void>;
  /** 回收原请求的设备事件，不重发消息。 */
  pollEvents?(receive: (event: GlassesEvent) => void): Promise<void>;
  /** 释放设备传输资源，可异步完成。 */
  close?(): void | Promise<void>;
  /** 发送带永久去重编号的消息；接受回执不代表实际光学呈现。 */
  send(request: GlassesRequest, options?: SendOptions): Promise<GlassesReceipt>;
  confirm?(request: { request_id: string; device_id?: string }): Promise<void>;
  cancel?(request: { request_id: string; device_id?: string }): Promise<void>;
}
