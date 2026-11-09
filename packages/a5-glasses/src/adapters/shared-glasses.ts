import {createHash} from 'node:crypto';
import {DisplayClient,DeviceRejection,NotSentError,protocol,type ClientOptions,type DisplayEvent} from '@lab/glasses-display';
import {PreSendError} from '../contracts.ts';
import type {GlassesAdapter,GlassesEvent,GlassesRequest,GlassesReceipt,GlassesStatus,SendOptions} from '../contracts.ts';
export {protocol};
/** 默认允许的固定时长：11000 为当前实验值，8500 兼容旧快照与 confirm_until_ack 的协议占位值。 */
export const defaultDisplayDurationsMs:readonly number[]=Object.freeze([8500,11000]);
export interface SharedAdapterOptions extends ClientOptions {
  /** 发送前允许的固定时长（毫秒）。不传用默认值；仍须落在显示端声明的 text_duration_ms 范围内。 */
  durationsMs?:readonly number[];
}
/** 实验模式保留在 A5；共享层只收通用显示/音调。 */
export function displayPayload(request:GlassesRequest){return {...request,display_mode:request.display_mode==='confirm_until_ack'?'confirm_until_ack':'timed',...(request.display_mode==='tone_8500'?{tone:{preset:'notification',duration_ms:983,volume:1}}:{})};}
export class SharedGlassesAdapter implements GlassesAdapter {
  private client?:DisplayClient;
  private route:string;
  private readonly options:ClientOptions;
  readonly durationsMs:readonly number[];
  private polling?:Promise<void>;
  constructor(serial:string,options:SharedAdapterOptions={}){
    if(serial&&!/^[A-Za-z0-9_.:\[\]-]{1,128}$/.test(serial))throw new Error('A5_GLASSES_SERIAL 无效。');
    const {durationsMs,...client}=options;
    if(durationsMs!==undefined&&(!durationsMs.length||durationsMs.some(v=>!Number.isInteger(v)||v<=0)))throw new Error('显示时长配置必须是正整数毫秒列表。');
    this.durationsMs=Object.freeze([...(durationsMs??defaultDisplayDurationsMs)]);
    this.route=serial;this.options=client;if(serial)this.client=new DisplayClient(serial,client);
  }
  getStatus():GlassesStatus{return this.client?.getStatus()??{source:'device',connected:false,ready:false,route:this.route,error:'device_serial_missing',protocol};}
  async probe(){await this.client?.probe();}
  async reconnect(){await this.polling;await this.client?.reconnect();}
  /** 对象身份不变，Engine 与服务退出始终持有同一适配器；共享客户端保留账本游标。 */
  async setRoute(serial:string,identity:'adb'|'hardware'=this.options.identity??'adb'){
    await this.polling;
    if(this.client&&identity===(this.options.identity??'adb'))await this.client.setRoute(serial);
    else {await this.client?.close();this.options.identity=identity;this.client=new DisplayClient(serial,this.options);await this.client.probe();}
    this.route=serial;
  }
  async clockSample(){if(!this.client)throw new Error('device_serial_missing');return this.client.clockSample();}
  /** 本地校验失败抛 PreSendError（确定未发出）；写入线路后的结果都以回执返回，绝不重发。 */
  async send(request:GlassesRequest,options:SendOptions={}):Promise<GlassesReceipt>{
    const state=this.getStatus(),t_send=new Date().toISOString();
    if(request.device_id!==state.device_id)throw new PreSendError('device_binding_mismatch');
    if(!request.text.trim()||Buffer.byteLength(request.text)>16000||!this.durationsMs.includes(request.duration_ms))throw new PreSendError('device_invalid_stimulus');
    const caps=state.capabilities;
    if(!caps||!caps.commands.includes('show_text')||!caps.display_modes.includes(request.display_mode==='confirm_until_ack'?'confirm_until_ack':'timed')||request.duration_ms<caps.text_duration_ms.min||request.duration_ms>caps.text_duration_ms.max||request.display_mode==='tone_8500'&&(!caps.tone||!caps.tone_presets?.includes('notification')))throw new PreSendError('device_capability_missing');
    let evidence:unknown;
    const receipt=(status:GlassesReceipt['status'],error:string|null,extra:Partial<GlassesReceipt>={}):GlassesReceipt=>({request_id:request.request_id,device_id:request.device_id,source:'device',status,t_send,t_ack:null,t_display:null,t_hide:null,display_time_source:'unavailable',error,evidence,...extra});
    try{
      if(!this.client)throw new NotSentError('device_disconnected');
      const reply=await this.client.call('show_text',displayPayload(request),options);evidence=reply;
      if(reply.request_id!==request.request_id)throw new Error('device_request_id_mismatch');
      if(reply.text_sha256!==createHash('sha256').update(request.text).digest('hex'))throw new Error('device_text_integrity_mismatch');
      return receipt('accepted',null,{t_ack:new Date().toISOString()});
    }catch(error){
      const reason=error instanceof Error?error.message:String(error);
      if(error instanceof NotSentError)return receipt('not_sent',reason);
      if(error instanceof DeviceRejection)return receipt('failed',reason,{evidence:error.evidence});
      return receipt(reason==='device_text_integrity_mismatch'?'failed':'unacknowledged',reason);
    }
  }
  private async control(command:string,request:{request_id:string;device_id?:string}){
    if(request.device_id!==this.getStatus().device_id)throw new Error('device_binding_mismatch');
    if(!this.client)throw new Error('device_disconnected');const reply=await this.client.call(command,request);
    if(reply.request_id!==request.request_id)throw new Error(`device_${command}_identity_mismatch`);
  }
  confirm(request:{request_id:string;device_id?:string}){return this.control('confirm',request);}
  cancel(request:{request_id:string;device_id?:string}){return this.control('cancel',request);}
  async pollEvents(receive:(event:GlassesEvent)=>void){
    if(this.polling)return this.polling;
    this.polling=(async()=>{await this.client?.pollEvents((e:DisplayEvent)=>receive((e.display_mode==='timed'||e.display_mode==='timed_confirmable'?{...e,display_mode:e.tone?'tone_8500':'legacy_8500'}:e) as unknown as GlassesEvent));})();
    try{await this.polling;}finally{this.polling=undefined;}
  }
  async close(){await this.client?.close();await this.polling;}
}
