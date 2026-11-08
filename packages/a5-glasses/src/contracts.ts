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
  /** 固定模式的目标时长；confirm_until_ack忽略此值，不设置自动隐藏。8500保留兼容旧快照。 */
  duration_ms: 8500 | 11000;
  display_mode?: DisplayMode;
  device_id?: string;
}

export interface GlassesReceipt {
  request_id: string;
  source: 'mock' | 'device';
  status: 'accepted' | 'failed' | 'unacknowledged';
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
  send(request: GlassesRequest): Promise<GlassesReceipt>;
  confirm?(request: { request_id: string; device_id?: string }): Promise<void>;
  cancel?(request: { request_id: string; device_id?: string }): Promise<void>;
}
