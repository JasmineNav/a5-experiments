import {createHash} from 'node:crypto';
import {DisplayClient,DeviceRejection,protocol,type ClientOptions,type DisplayEvent} from '@lab/glasses-display';
import type {GlassesAdapter,GlassesEvent,GlassesRequest,GlassesReceipt,GlassesStatus} from '../contracts.ts';
export {protocol};
/** 实验模式保留在 A5；共享层只收通用显示/音调。 */
export function displayPayload(request:GlassesRequest){return {...request,display_mode:request.display_mode==='confirm_until_ack'?'confirm_until_ack':'timed',...(request.display_mode==='tone_8500'?{tone:{preset:'notification',duration_ms:983,volume:1}}:{})};}
export class SharedGlassesAdapter implements GlassesAdapter {
  private client?:DisplayClient;
  private route:string;
  private readonly options:ClientOptions;
  private polling?:Promise<void>;
  constructor(serial:string,options:ClientOptions={}){
    if(serial&&!/^[A-Za-z0-9_.:\[\]-]{1,128}$/.test(serial))throw new Error('A5_GLASSES_SERIAL 无效。');
    this.route=serial;this.options=options;if(serial)this.client=new DisplayClient(serial,options);
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
  async send(request:GlassesRequest):Promise<GlassesReceipt>{
    const state=this.getStatus(),t_send=new Date().toISOString();
    if(request.device_id!==state.device_id)throw new Error('device_binding_mismatch');
    if(!request.text.trim()||Buffer.byteLength(request.text)>16000||![8500,11000].includes(request.duration_ms))throw new Error('device_invalid_stimulus');
    const caps=state.capabilities;
    if(!caps||!caps.commands.includes('show_text')||!caps.display_modes.includes(request.display_mode==='confirm_until_ack'?'confirm_until_ack':'timed')||request.duration_ms<caps.text_duration_ms.min||request.duration_ms>caps.text_duration_ms.max||request.display_mode==='tone_8500'&&(!caps.tone||!caps.tone_presets?.includes('notification')))throw new Error('device_capability_missing');
    let evidence:unknown;
    try{
      if(!this.client)throw new Error('device_disconnected');
      const reply=await this.client.call('show_text',displayPayload(request));evidence=reply;
      if(reply.request_id!==request.request_id)throw new Error('device_request_id_mismatch');
      if(reply.text_sha256!==createHash('sha256').update(request.text).digest('hex'))throw new Error('device_text_integrity_mismatch');
      return {request_id:request.request_id,device_id:request.device_id,source:'device',status:'accepted',t_send,t_ack:new Date().toISOString(),t_display:null,t_hide:null,display_time_source:'unavailable',error:null,evidence};
    }catch(error){const reason=error instanceof Error?error.message:String(error);return {request_id:request.request_id,device_id:request.device_id,source:'device',status:error instanceof DeviceRejection||reason==='device_text_integrity_mismatch'?'failed':'unacknowledged',t_send,t_ack:null,t_display:null,t_hide:null,display_time_source:'unavailable',error:reason,evidence:error instanceof DeviceRejection?error.evidence:evidence};}
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
