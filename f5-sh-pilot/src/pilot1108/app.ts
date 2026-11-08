import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { view } from './model.ts';
import type { Config, Action } from './model.ts';
import type { PilotStore } from './store.ts';

/** 本机受信任实验员使用；不开放局域网，不加载眼镜消息服务。 */
export function createPilotApp(store: PilotStore, defaults: Partial<Config> = {}) {
  const token = randomBytes(32).toString('hex');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
        send(403, { error: '不接受跨站请求。' }); return;
      }
      if (path === '/api/health' && req.method === 'GET') { send(200, { ok: true, experiment_id: 'A5-SH-pilot-1108', actual_interruption: false }); return; }
      if (['/', '/admin', '/pilot'].includes(path) && req.method === 'GET') {
        const html = await readFile(fileURLToPath(new URL('../../public/pilot1108/index.html', import.meta.url)), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html.replace('__CSRF_TOKEN__', token)); return;
      }
      if (['/pilot.js', '/feedback.js', '/pilot.css'].includes(path) && req.method === 'GET') {
        const name = path.slice(1);
        const body = await readFile(fileURLToPath(new URL(`../../public/pilot1108/${name}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); res.end(body); return;
      }
      if (req.headers['x-pilot-token'] !== token) { send(403, { error: '请从本机首页重新打开。' }); return; }
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) { send(415, { error: '仅接受JSON请求。' }); return; }
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) { send(413, { error: '请求过大。' }); return; } }
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式无效。');
        body = parsed as Record<string, unknown>;
      }
      if (path === '/api/sessions' && req.method === 'GET') { send(200, { sessions: store.list(), defaults }); return; }
      if (path === '/api/sessions' && req.method === 'POST') {
        const input = body.config;
        if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('配置格式无效。');
        const permitted = ['feedback', 'order', 'source', 'practiceScales', 'practiceFeedback'];
        if (input && Object.keys(input).some(k => !permitted.includes(k))) throw new Error('配置包含未知字段。');
        send(201, store.create(body.participant as string, { ...defaults, ...input as Partial<Config> })); return;
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(command|export))?$/);
      if (match) {
        const [, id, op] = match;
        if (!op && req.method === 'GET') { send(200, view(store.get(id))); return; }
        if (op === 'command' && req.method === 'POST') {
          if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) throw new Error('操作格式无效。');
          send(200, store.command(id, body.command_id as string, body.revision as number, body.action as Action)); return;
        }
        if (op === 'export' && req.method === 'GET') {
          res.setHeader('Content-Disposition', `attachment; filename="sh-pilot-1108-${id}.json"`);
          send(200, store.export(id)); return;
        }
      }
      send(404, { error: '接口不存在。' });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : '请求失败。' }); }
  });
}
