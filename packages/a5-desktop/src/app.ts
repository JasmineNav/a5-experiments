import { createServer } from 'node:http';
import qrcode from 'qrcode-generator';
import { lanAddresses } from '../../../scripts/network.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine, HttpError } from './engine.ts';
import { exportData } from './export.ts';
import { InputError } from './tasks.ts';
import { preflight } from './preflight.ts';
import { profile, stageIds } from './profile.ts';
import { ConfigFiles } from './config-files.ts';
import type { DeviceControl } from './device-control.ts';

/** 被试端与后台页随公共包提供；与实验分项目录无关。 */
const publicRoot = resolve(import.meta.dirname, '../public');

export async function body(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用application/json请求。');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw new HttpError(413, '请求超过1MB。'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'JSON格式无效。'); }
}
const bearer = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer /, '') ?? '';
/** 建立实验与后台 HTTP 路由；后台直接进入，被试请求仍按会话标识绑定。 */
export function createApp(engine: Engine, exportRoot: string, deviceControl?: DeviceControl, configDirectory = join(exportRoot, 'configurations')) {
  const configFiles = new ConfigFiles(configDirectory, engine.material.stimuli);
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  const clock = engine.clock;
  // 在线判定是间隔计时，用单调钟；last_seen_at 仅供展示，用墙钟。
  const connections = new Map<string, { seen_mono: number; seen_wall: number }>();
  const connection = (id: string) => {
    const client = connections.get(id);
    return { connected: !!client && clock.mono() - client.seen_mono < 10000, last_seen_at: client ? new Date(client.seen_wall).toISOString() : null };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'); const path = url.pathname; const method = request.method;
      if (method === 'GET' && ['/', '/admin', '/experiment', '/app.css', '/desktop.css', '/admin.js', '/experiment.js', '/favicon.svg', '/favicon-admin.svg', '/favicon.ico'].includes(path)) {
        const files: Record<string, string> = { '/': 'admin.html', '/admin': 'admin.html', '/experiment': 'experiment.html', '/app.css': 'app.css', '/desktop.css': 'desktop.css', '/admin.js': 'admin.js', '/experiment.js': 'experiment.js', '/favicon.svg': 'favicon.svg', '/favicon-admin.svg': 'favicon-admin.svg', '/favicon.ico': 'favicon.svg' };
        const name = files[path]; const mime = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/css';
        response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); response.end(name.endsWith('.html') ? (await readFile(join(publicRoot, name), 'utf8')).replaceAll('{{EXPERIMENT_ID}}', profile.experiment_id).replaceAll('{{STAGE_RANGE}}', `${stageIds[0]}—${stageIds.at(-1)}`).replaceAll('{{STAGE_EXAMPLE}}', stageIds[2]).replaceAll('{{STAGE_PREFIX}}', profile.stage_prefix) : await readFile(join(publicRoot, name))); return;
      }
      if (method === 'GET' && path === '/api/health') { json(response, { ok: true, repository: 'a5-experiments', experiment_id: profile.experiment_id, phase: 'core', mock_only: engine.adapter.getStatus().source === 'mock', real_presentation_verified: false, adapter: engine.adapter.getStatus() }); return; }
      if (path.startsWith('/api/admin/') || path === '/api/preflight') {
        if (method === 'GET' && path === '/api/admin/network') {
          const port = request.socket.localPort!;
          const binding = server.address();
          const shared = typeof binding === 'object' && binding && !['127.0.0.1', '::1'].includes(binding.address);
          json(response, { addresses: shared ? lanAddresses(port) : [], local_url: `http://127.0.0.1:${port}`, shared }); return;
        }
        if (method === 'GET' && path === '/api/admin/qr') {
          const text = url.searchParams.get('text') ?? '';
          if (text.length > 1500 || !/^https?:\/\//.test(text)) throw new HttpError(422, '二维码网址无效。');
          const code = qrcode(0, 'M'); code.addData(text); code.make();
          response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }); response.end(code.createSvgTag({ scalable: true, margin: 4 })); return;
        }
        if (method === 'GET' && ['/api/preflight', '/api/admin/preflight'].includes(path)) { json(response, { ...await preflight(), adapter: engine.adapter.getStatus() }); return; }
        if (method === 'GET' && path === '/api/admin/device') { json(response, { adapter: engine.adapter.getStatus(), audit: engine.store.deviceAudit(), control: deviceControl?.status() ?? null }); return; }
        if (method === 'POST' && path === '/api/admin/device/control') {
          if (!deviceControl) throw new HttpError(409, '当前服务未配置眼镜控制。');
          json(response, await deviceControl.action(await body(request))); return;
        }
        if (path.startsWith('/api/admin/device/')) {
          if(!deviceControl)throw new HttpError(409,'当前服务未配置眼镜控制。');
          if(method==='GET'&&path==='/api/admin/device/list'){json(response,{devices:await deviceControl.devices()});return;}
          if(method==='POST'&&path==='/api/admin/device/config'){json(response,await deviceControl.configure(await body(request)));return;}
          if(method==='POST'&&path==='/api/admin/device/connect'){const input=await body(request);json(response,await deviceControl.connectWireless(input.address));return;}
          if(method==='POST'&&path==='/api/admin/device/enable-wireless'){const input=await body(request);json(response,await deviceControl.enableWirelessFromUsb(input.serial));return;}
          if(method==='POST'&&path==='/api/admin/device/doctor'){await body(request);json(response,await deviceControl.doctor());return;}
        }
        if (method === 'GET' && path === '/api/admin/config') { json(response, { files: await configFiles.list(), selected_file: engine.store.setting('selected_config_file') ?? null, config: engine.config(), debug_participant: engine.debugParticipant(), adapter: engine.adapter.getStatus(), interview_prompts: engine.material.content.interview_prompts }); return; }
        if (method === 'POST' && path === '/api/admin/config') {
          const input = await body(request); const saved = await configFiles.save(input.config ?? input, input.filename);
          engine.importConfig(saved.config); engine.store.setSetting('selected_config_file', saved.filename);
          json(response, saved); return;
        }
        if (method === 'POST' && path === '/api/admin/config/select') {
          const input = await body(request); const config = await configFiles.read(input.filename);
          engine.importConfig(config); engine.store.setSetting('selected_config_file', input.filename);
          json(response, {config, selected_file:input.filename}); return;
        }
        if (method === 'GET' && path === '/api/admin/sessions') { json(response, { adapter: engine.adapter.getStatus(), sessions: engine.store.ids().map(id => ({ ...engine.summary(id), connection: connection(id) })), deleted_sessions: engine.store.deletedIds().map(id => engine.summary(id)) }); return; }
        if (method === 'POST' && path === '/api/admin/sessions') {
          const input = await body(request); if (typeof input.participant_id !== 'string') throw new HttpError(422, '请选择被试。');
          if (input.config_file !== undefined) { const config = await configFiles.read(input.config_file); engine.importConfig(config); engine.store.setSetting('selected_config_file', input.config_file); }
          const created = engine.create(input.participant_id, { tutorial_enabled: true, config_file: input.config_file ?? engine.store.setting('selected_config_file') ?? null, user_agent: request.headers['user-agent'] ?? null, ...(input.display_mode !== undefined ? { display_mode: input.display_mode } : {}) });
          const participant_url = `/experiment#session=${created.session_id}&token=${created.token}`;
          engine.store.setSetting(`participant_entry:${created.session_id}`, participant_url);
          json(response, { ...created, participant_url }, 201); return;
        }
        const sessionPath = /^\/api\/admin\/sessions\/([a-f0-9-]+)(?:\/(events|notes|control|access))?$/.exec(path);
        if (sessionPath) {
          const [, id, resource] = sessionPath;
          if (method === 'GET' && !resource) { json(response, { summary: engine.summary(id), connection: connection(id), participant_url: engine.store.setting<string>(`participant_entry:${id}`) ?? null, debug_targets: engine.debugTargets(engine.session(id)).map(({ id, label }) => ({ id, label })), view: engine.view(id), assignment: engine.session(id).snapshot.participant, interventions: engine.store.interventions(id) }); return; }
          if (method === 'GET' && resource === 'events') { json(response, { events: engine.store.events(id) }); return; }
          if (method === 'GET' && resource === 'notes') { json(response, { notes: engine.store.events(id).filter(e => e.event_type === 'note_saved') }); return; }
          if (method === 'POST' && resource === 'notes') { const input = await body(request); engine.note(id, input.category, input.text, input.stage_id ?? null); json(response, { saved: true }); return; }
          if (method === 'POST' && resource === 'control') {
            const input = await body(request); if (typeof input.reason !== 'string') throw new HttpError(422, '请填写干预原因。');
            engine.adminAction(id, input.action, input.reason, input.target); json(response, engine.summary(id)); return;
          }
          if (method === 'POST' && resource === 'access') { engine.session(id); const token = engine.rotateToken(id); const participant_url = `/experiment#session=${id}&token=${token}`; engine.store.setSetting(`participant_entry:${id}`, participant_url); json(response, { participant_url }); return; }
        }
        if (method === 'GET' && path === '/api/admin/export') {
          const id = url.searchParams.get('session_id'); const ids = id ? [engine.session(id).id] : engine.store.ids();
          if (!ids.length) throw new HttpError(422, '当前没有可导出的会话。');
          const result = await exportData(engine, ids, exportRoot);
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="a5-${result.export_id}.zip"` }); response.end(result.bytes); return;
        }
      }
      const participantPath = /^\/api\/participant\/sessions\/([a-f0-9-]+)(?:\/(commands|read-notice-click|confirm-message|assets\/image\d+\.png))?$/.exec(path);
      if (participantPath) {
        const [, id, resource] = participantPath; engine.authenticate(id, bearer(request));
        connections.set(id, { seen_mono: clock.mono(), seen_wall: clock.wall() });
        if (method === 'GET' && !resource) { json(response, engine.view(id)); return; }
        if(method==='POST' && resource==='read-notice-click') {json(response,await engine.readNoticeClick(id,await body(request)));return;}
        if (method === 'POST' && resource === 'confirm-message') {
          const input = await body(request);
          if (typeof input.request_id !== 'string') throw new HttpError(422, '缺少确认消息编号。');
          json(response, await engine.confirmMessage(id, input.request_id, input.client ?? null)); return;
        }
        if (method === 'POST' && resource === 'commands') { json(response, engine.command(id, await body(request))); return; }
        if (method === 'GET' && resource?.startsWith('assets/')) {
          const name = resource.slice(7), view = engine.view(id);
          if (![...view.assets, ...(view.reveal?.assets ?? [])].some(a => a.id === name)) throw new HttpError(403, '此资料不属于当前可见任务。');
          const asset = engine.session(id).snapshot.assets[name]; response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(Buffer.from(asset.base64, 'base64')); return;
        }
      }
      json(response, { error: '接口或请求方法不存在。' }, 404);
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof InputError;
      if (!expected) console.error('服务错误：', error);
      if (!response.headersSent) json(response, { error: expected ? error.message : '本地服务发生错误，请联系实验员查看终端。', request_id: randomUUID() }, expected ? error.status : 500);
      else response.end();
    }
  });
  return server;
}
