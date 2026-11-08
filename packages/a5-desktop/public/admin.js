// 实验员后台。原生 ES module，无构建步骤；遵守 CSP（无 inline 脚本/样式字符串、无 eval）。
// 受控实验现场直接进入后台；清理旧版本留下的后台凭据。
const LINK_STORE = 'a5-admin-links';
sessionStorage.removeItem('a5-admin-key');
history.replaceState(null, '', location.pathname);
let shareOrigin = location.origin;
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

/* ───────── 小工具 ───────── */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name.includes('-')) node.setAttribute(name, value === true ? '' : value);
    else node[name] = value;
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}
const setText = (node, value) => { const next = value ?? ''; if (node.textContent !== next) node.textContent = next; };
const setHidden = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
/** 只在签名变化时重建容器内容，避免轮询打断阅读、选择和焦点。 */
function renderOnce(node, signatureValue, build) {
  const signature = JSON.stringify(signatureValue);
  if (node.dataset.sig === signature) return false;
  node.dataset.sig = signature; node.replaceChildren(...build().filter(child => child !== null && child !== undefined && child !== false));
  return true;
}
const narrow = window.matchMedia('(max-width: 899px)');

/* ───────── 中文文案 ───────── */
const PHASES = { TUTORIAL_INTRO:'教程：工作台',TUTORIAL_UNIT1:'教程：练习单元01',TUTORIAL_UNIT2:'教程：练习单元02',TUTORIAL_NOTICE:'教程：阅读消息',TUTORIAL_CHECK:'教程：理解题',TUTORIAL_REST:'教程：休息练习', INTRO:'情景导入', CARD:'说明卡', UNIT:'主任务', COMPREHENSION:'信息识读理解题', RATINGS:'信息体验评价量表', BREAK:'组间休息', COMPLETED:'完成页', ABORTED:'结束页' };
const MESSAGE_STATUS = { NONE:'本组无消息', not_triggered:'尚未触发', awaiting_rest:'等待被试休息', t2_not_triggered:'T2未触发（未休息即提交）', scheduled:'等待发送', send_requested:'已发出，等待回执', accepted:'请求已接受', failed:'发送失败', unacknowledged:'未收到回执', unknown:'发送结果待核查' };
const MESSAGE_TONE = { NONE:'neutral', not_triggered:'neutral', awaiting_rest:'pending', t2_not_triggered:'neutral', scheduled:'pending', send_requested:'pending', accepted:'ok', failed:'bad', unacknowledged:'bad', unknown:'bad' };
const CATEGORIES = { interview:'访谈记录', observation:'任务观察', anomaly:'异常备注' };
const ACTION_DONE = { pause:'已暂停实验', resume:'已恢复实验', stop:'已提前结束会话', skip_break:'已跳过休息', remind_rest:'已向被试屏幕发送休息提醒', debug_jump:'已跳转到所选调试页面' };
const ATTENTION = { device_not_ready_at_t2:'T2送达时眼镜未就绪，未发送且不补发', previous_message_pending:'T2送达时上一条消息尚未确认，未发送且不补发', message_delivery_unknown:'消息发送结果未知', message_failed:'消息发送失败', mock_disconnected:'模拟眼镜未连接', mock_no_ack:'模拟眼镜未返回回执', device_foreground_lost:'眼镜显示端离开前台', device_window_focus_lost:'眼镜显示端失去焦点', device_draw_timeout:'眼镜正文未及时完成绘制', device_hide_draw_timeout:'眼镜清屏未及时完成绘制', device_activity_destroyed_delivery_unknown:'眼镜显示页面被关闭，结果待核查', device_process_restarted_delivery_unknown:'眼镜显示端重启，结果待核查', adapter_send_timeout_delivery_unknown:'发送超时，是否显示待核查', server_restarted_delivery_unknown:'服务重启，发送结果待核查', failed:'消息发送失败', unacknowledged:'未收到消息回执' };

const fmtDateTime = new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const fmtTime = new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const fmtFull = new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const valid = value => value && Number.isFinite(Date.parse(value));
const when = (value, format = fmtDateTime) => valid(value) ? format.format(new Date(value)) : '—';
function duration(ms) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function ago(value) {
  if (!valid(value)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
}
const isDebug = s => !!s.is_debug;
const listName = s => isDebug(s) ? '000' : s.participant_id;
const fullName = s => isDebug(s) ? '调试测试者（000）' : `被试 ${s.participant_id}`;
function statusOf(s) {
  if (s.deleted) return { key:'deleted', label:'已删除' };
  if (s.status === 'completed') return { key:'done', label:'已完成' };
  if (s.status === 'aborted') return { key:'aborted', label:'提前结束' };
  if (s.paused) return { key:'paused', label:'已暂停' };
  if (s.phase === 'BREAK') return { key:'break', label:'休息中' };
  if (s.rest?.status === 'resting') return { key:'break', label:'U2休息中' };
  return { key:'active', label:'进行中' };
}
function position(s) {
  if (s.phase === 'INTRO') return '情景导入';
  if (s.phase === 'COMPLETED') return '已到完成页';
  if (s.phase === 'ABORTED') return '结束页';
  const what = s.phase === 'UNIT' ? `第${s.unit}单元` : PHASES[s.phase] ?? '当前页面';
  return `${s.stage_id} · ${what}`;
}
function conditionText(stage) {
  if (!stage) return '';
  if (stage.condition === 'NONE') return '本组无消息';
  const [type, timing] = stage.condition.split('-');
  const moment = { T0:'补充资料首次展示时', T1:'第2单元首次展示时', T2:'第2单元休息开始5秒后' }[timing] ?? timing;
  return `${type === 'N' ? '通知型消息' : 'AI 主动服务型消息'}，${moment}（${stage.condition} · ${stage.message_id}）`;
}
const conditionShort = stage => stage.condition === 'NONE' ? '无消息' : `${stage.condition.split('-')[0] === 'N' ? '通知' : 'AI'} · ${stage.condition.split('-')[1]}`;
const isMock = s => s.delivery_source === 'mock' || s.validation_status === 'mock_only';
function messageStepOne(s) {
  const label = MESSAGE_STATUS[s.message_status] ?? '状态待核查';
  return isMock(s) && s.message_status === 'accepted' ? '模拟请求已接受' : label;
}
function messageStepTwo(s) {
  if (s.message_status === 'NONE') return null;
  if (s.message_evidence === 'failed') return { text:'显示端报告异常，请核查', tone:'bad' };
  if (s.message_evidence === 'hidden') return { text:'双眼正文已绘制并已清屏（应用证据）', tone:'ok' };
  if (s.message_evidence === 'drawn') return { text:'双眼正文已绘制（应用证据）', tone:'ok' };
  if (s.message_status === 't2_not_triggered') return { text:'不发送、不补发', tone:'neutral' };
  const waiting = ['not_triggered', 'awaiting_rest'].includes(s.message_status);
  if (isMock(s)) return { text:waiting ? '模拟模式：不会在眼镜上显示' : '模拟模式：未连接眼镜，没有显示证据', tone:'neutral' };
  if (waiting) return { text:'尚未触发', tone:'neutral' };
  if (s.message_status === 'accepted') return { text:'尚未收到眼镜绘制证据', tone:'pending' };
  return { text:'没有显示证据', tone: MESSAGE_TONE[s.message_status] === 'bad' ? 'bad' : 'pending' };
}
function messageShort(s) {
  if (s.message_status === 'NONE') return '本组无消息';
  if (s.message_evidence === 'drawn' || s.message_evidence === 'hidden') return '消息：眼镜已绘制';
  if (s.message_evidence === 'failed') return '消息：显示端异常';
  const mockTag = isMock(s) && !['not_triggered', 'awaiting_rest', 't2_not_triggered', 'accepted'].includes(s.message_status) ? '（模拟）' : '';
  return `消息：${messageStepOne(s)}${mockTag}`;
}
function attentionLabel(value) {
  const [stage, reason] = String(value).split(':');
  return `${stage}：${ATTENTION[reason] ?? '消息异常，请查看技术记录'}`;
}
const REST_STATUS = { before_window:'未到窗口', available:'可休息', requested:'等待休息页显示', resting:'休息中', returning:'正在返回任务', rested:'已休息', not_rested:'未休息即提交' };
const REST_KIND = { available:'active', requested:'break', resting:'break', returning:'break', rested:'done', not_rested:'warn' };
function restT2Text(rest) {
  switch (rest.t2) {
    case 'awaiting_rest': return { text:'等待被试休息', tone:'pending' };
    case 'scheduled': return { text:Number.isFinite(rest.t2_due_in_ms) ? `休息后约 ${Math.max(0, Math.ceil(rest.t2_due_in_ms / 1000))} 秒发送` : '已排定，等待发送', tone:'pending' };
    case 'sent': return { text:'已发送', tone:'ok' };
    case 'not_triggered': return { text:'未触发（未休息即提交）', tone:'neutral' };
    case 'failed': return { text:'发送失败', tone:'bad' };
    default: return null;
  }
}
/** 与 content/tasks.json 的 message_duration_ms 一致；显示端未声明支持时提示更新 APK。 */
const FIXED_DURATION_MS = 11000;
function deviceInfo(status) {
  if (!status) return { short:'正在读取眼镜状态…', long:'正在读取眼镜状态。', tone:'neutral' };
  if (status.source === 'mock') return status.connected === false
    ? { short:'模拟（Mock）· 未连接', long:'当前为模拟眼镜（Mock）模式，且模拟连接已断开。仅用于软件预演，不会在眼镜上显示内容。', tone:'bad' }
    : { short:'模拟眼镜（Mock）· 仅预演', long:'当前为模拟眼镜（Mock）模式，仅用于软件预演；消息不会出现在任何眼镜上，也不会产生显示证据。', tone:'mock' };
  const id = status.device_id ?? '雷鸟眼镜';
  if (!status.connected) return { short:`${id} · 连接中断`, long:`雷鸟设备 ${id}：连接中断，请检查 USB 连接与显示端。`, tone:'bad' };
  if (!status.ready) return { short:`${id} · 显示端未就绪`, long:`雷鸟设备 ${id}：显示端未就绪，请保持眼镜应用在前台。`, tone:'pending' };
  if (!status.device_info?.fixed_duration_ms?.split(',').includes(String(FIXED_DURATION_MS))) return { short:`${id} · 显示端 APK 需更新`, long:`雷鸟设备 ${id}：显示端 ${status.device_info?.app_version ?? '未知版本'} 不支持${FIXED_DURATION_MS / 1000}秒固定时长，请安装最新显示端 APK（1.1.4 及以上）；更新前无法创建固定时长会话或发送固定时长通知。`, tone:'bad' };
  if (status.busy) return { short:`${id} · 正在展示消息`, long:`雷鸟设备 ${id}：正在展示消息。硬件呈现仍需现场验收。`, tone:'ok' };
  return { short:`${id} · 显示端就绪`, long:`雷鸟设备 ${id}：连接正常，显示端就绪。硬件呈现仍需现场验收。`, tone:'ok' };
}

/* ───────── 状态 ───────── */
let justCreatedId = null;
let config = null, debugParticipant = null, prompts = [];
let sessions = [], deletedSessions = [], adapter = null;
let deviceControl = null, deviceWorking = false, notificationDraft = null;
let selected = null, detail = null, controlling = false, offline = false, stopped = false;
const rowNodes = new Map();
const noteDrafts = new Map();
const links = new Map(Object.entries(safeJson(sessionStorage.getItem(LINK_STORE)) ?? {}));
function safeJson(value) { try { return JSON.parse(value); } catch { return null; } }
function saveLinks() { sessionStorage.setItem(LINK_STORE, JSON.stringify(Object.fromEntries(links))); }

/* ───────── 反馈 ───────── */
const toastTimers = {};
function toast(kind, message, action) {
  const box = $(`#${kind}`), button = $(`#${kind}-action`);
  clearTimeout(toastTimers[kind]);
  setText($(`#${kind}-text`), message);
  button.hidden = !action; button.onclick = null;
  if (action) { button.textContent = action.label; button.onclick = () => { hideToast(kind); action.run(); }; }
  box.hidden = false;
  if (kind === 'notice' && !action) toastTimers.notice = setTimeout(() => hideToast('notice'), 8000);
}
function hideToast(kind) { clearTimeout(toastTimers[kind]); $(`#${kind}`).hidden = true; }
function feedback(message = '', action) { hideToast('error'); if (message) toast('notice', message, action); else hideToast('notice'); }
function fail(error, action) { hideToast('notice'); toast('error', error?.message ?? String(error), action); }
for (const button of $$('[data-close]')) button.addEventListener('click', () => hideToast(button.dataset.close));

/* ───────── API ───────── */
async function api(path, data, { raw = false } = {}) {
  const response = await fetch('/api/admin/' + path, {
    method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）。`;
    try { message = (await response.json()).error ?? message; } catch { /* 非 JSON 错误 */ }
    const error = new Error(message); error.status = response.status; throw error;
  }
  return raw ? response : response.json();
}
async function download(path) {
  const response = await api(path, undefined, { raw: true });
  if (!(response.headers.get('Content-Type') ?? '').includes('zip')) throw new Error('服务端没有返回 ZIP 文件，请重试。');
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? `a5-export-${Date.now()}.zip`;
  const url = URL.createObjectURL(await response.blob()), link = el('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
async function busyButton(button, label, work) {
  const original = button.textContent; button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = label;
  try { return await work(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = original; }
}

/* ───────── 视图切换（桌面主从；手机单列切换） ───────── */
function setView(view) {
  document.body.dataset.view = view;
  $('#nav-sessions').setAttribute('aria-pressed', String(view === 'sessions'));
  $('#nav-setup').setAttribute('aria-pressed', String(view === 'setup'));
  setHidden($('#setup'), view !== 'setup');
  setHidden($('#selected'), view !== 'sessions' || !selected);
  setHidden($('#empty-state'), view !== 'sessions' || !!selected);
}
let pushedDetail = false;
function setPane(pane) {
  if (pane === 'detail' && narrow.matches && document.body.dataset.pane !== 'detail') { history.pushState({ pane: 'detail' }, '', location.pathname); pushedDetail = true; }
  document.body.dataset.pane = pane;
}
function showList() {
  if (pushedDetail && history.state?.pane === 'detail') { history.back(); return; }
  document.body.dataset.pane = 'list';
  rowNodes.get(selected)?.querySelector('button')?.focus();
}
window.addEventListener('popstate', () => { pushedDetail = false; document.body.dataset.pane = 'list'; setView('sessions'); });
$('#back').addEventListener('click', showList);
$('#nav-sessions').addEventListener('click', () => { setView('sessions'); if (narrow.matches) showList(); });
$('#nav-setup').addEventListener('click', openSetup);
$('#empty-setup').addEventListener('click', openSetup);
function openSetup() { setView('setup'); document.body.dataset.pane = 'detail'; $('#setup-title').focus(); renderSetup(); }

/* ───────── 眼镜状态 ───────── */
function renderDevice() {
  const info = offline ? { short:'无法连接本地服务，正在重试…', long:'无法连接本地服务。', tone:'bad' } : deviceInfo(adapter);
  $('#device').dataset.tone = info.tone; setText($('#device-text'), info.short); $('#device').title = info.long;
  setText($('#device-detail'), info.long);
}

const DEBUG_STATUS = { sending: '发送中', accepted: '请求已接受，等待绘制证据', drawn: '双眼已绘制，正在展示', hidden: '双眼已绘制并已消失', failed: '显示失败', unknown: '结果待核查', unacknowledged: '未收到接受回执' };
/** 根据后台快照更新操作可用性、守护状态和独立通知记录。 */
function renderDeviceControl() {
  const control = deviceControl;
  const supported = !!control?.supported;
  const blocked = deviceWorking || !!control?.working;
  const host = $('#device-host');
  host.setAttribute('aria-pressed', String(!!control?.enabled));
  setText(host, control?.enabled ? '关闭上位机守护' : '开启上位机守护');
  for (const id of ['device-open', 'device-probe', 'device-reconnect', 'device-host', 'device-scrcpy']) $(`#${id}`).disabled = !supported || blocked;
  $('#device-notify-send').disabled = !supported || blocked || !control.debug_allowed || !adapter?.ready || !adapter?.connected;
  const voiceState = { pending: '等待检查', protected: '已限制', restored: '已恢复原设置', error: '限制失败' };
  setText($('#device-host-state'), !supported ? '当前为 Mock 预演，真机控制不可用。' : `上位机守护：${control.enabled ? '已开启' : '已关闭'} · 语音助手悬浮窗：${voiceState[control.voice_guard?.state] ?? '等待检查'} · 显示应用：${control.package_name}${control.scrcpy?.running ? ' · scrcpy 已打开' : ''}`);
  setText($('#device-control-error'), control?.error ?? control?.voice_guard?.error ?? control?.scrcpy?.error ?? '');
  for(const id of ['device-list','device-bind','device-connect','device-wireless','device-doctor'])$(`#${id}`).disabled=!supported||blocked;
  const route=control?.route||'未选择',link=control?.link;
  setText($('#device-route-status'),`路由：${route} · 身份：${adapter?.device_id??'未读取'}（${control?.identity_mode??'adb'}） · Wi-Fi 锁：${adapter?.wifi_lock??'未请求'}${link?.next_retry_in_ms!=null?' · 无线重连 '+Math.ceil(link.next_retry_in_ms/1000)+' 秒后':''}${control?.host_retry_in_ms!=null?' · 应用重试 '+Math.ceil(control.host_retry_in_ms/1000)+' 秒后':''}${control?.host_stall?' · 停止原因：'+control.host_stall.reason+' '+control.host_stall.hint:''}`);
  renderOnce($('#device-doctor-results'),control?.doctor,()=> (control?.doctor?.checks??[]).map(c=>el('p',{text:`${c.status.toUpperCase()} · ${c.label}：${c.detail}${c.next?' → '+c.next:''}`})));
  setText($('#device-clock'),(control?.clock_samples??[]).map(s=>`设备 uptime ${s.device_monotonic_ms} ms · RTT ${s.rtt_ms.toFixed(1)} ms · ${s.clock_id}`).join('；')||'设备时钟：自检时采样（本次不做跨设备校准）');
  const completed=[!!control?.route,!!adapter?.connected,!!adapter?.ready,control?.debug_notifications?.some(r=>r.events?.some(e=>e.kind==='drawn'))];
  [...$('#device-steps').children].forEach((li,i)=>{li.dataset.complete=String(completed[i]);li.textContent=(completed[i]?'✓ ':'')+['选设备','连通道','打开显示端','试发验证'][i];});
  const records = control?.debug_notifications ?? [];
  const latest = records[0];
  setText($('#device-debug-result'), latest ? `最近手动通知：${DEBUG_STATUS[latest.status] ?? latest.status}${latest.error ? ' · ' + latest.error : ''}` : '尚未手动发送通知。');
  renderOnce($('#device-debug-history'), [records, control?.audit], () => [
    ...records.slice(0, 10).map(record => el('p', { class: 'device-debug-record' },
      el('strong', { text: `${when(record.created_at, fmtFull)} · ${DEBUG_STATUS[record.status] ?? record.status}` }),
      el('span', { text: record.text }), el('span', { class: 'hint', text: `${record.events.map(event => event.kind).join(' → ') || '等待设备事件'}${record.error ? ' · ' + record.error : ''}` }))),
    ...(control?.audit ?? []).slice(0, 5).map(record => el('p', { class: 'hint', text: `${when(record.timestamp_iso, fmtFull)} · ${record.action} · ${record.detail?.error ?? (record.detail?.ok === false ? '失败' : '已记录')}` })),
  ]);
}
/** 获取设备和控制状态，并同时刷新两处显示。 */
async function loadDeviceControl() {
  const data = await api('device'); adapter = data.adapter; deviceControl = data.control;
  renderDevice(); renderDeviceControl();
}
/** 操作期间禁用重复提交，成功后获取后台的最新设备状态。 */
async function deviceAction(input) {
  deviceWorking = true; renderDeviceControl();
  try { const result = await api('device/control', input); await loadDeviceControl(); return result; }
  finally { deviceWorking = false; renderDeviceControl(); }
}
async function prepAction(path,input={}){
  deviceWorking=true;renderDeviceControl();try{const result=await api('device/'+path,input);await loadDeviceControl();return result;}finally{deviceWorking=false;renderDeviceControl();}
}
$('#device-list').addEventListener('click',async()=>{try{const r=await api('device/list');$('#device-select').replaceChildren(...r.devices.map(d=>new Option(`${d.serial} · ${d.transport} · ${d.state}`,d.serial)));}catch(e){fail(e);}});
$('#device-bind').addEventListener('click',async()=>{try{await prepAction('config',{serial:$('#device-select').value,identity:$('#device-identity').value});}catch(e){fail(e);}});
$('#device-connect').addEventListener('click',async()=>{try{await prepAction('connect',{address:$('#device-ip').value});}catch(e){fail(e);}});
$('#device-wireless').addEventListener('click',async()=>{try{await prepAction('enable-wireless',{serial:$('#device-select').value||undefined});feedback('无线通道已绑定，可拔下 USB。');}catch(e){fail(e);}});
$('#device-doctor').addEventListener('click',async()=>{try{await prepAction('doctor');}catch(e){fail(e);}});
for (const [id, action] of [['device-open', 'open'], ['device-probe', 'probe'], ['device-reconnect', 'reconnect'], ['device-scrcpy', 'scrcpy']]) {
  $(`#${id}`).addEventListener('click', async () => {
    try { await deviceAction({ action }); feedback(action === 'scrcpy' ? '已请求打开眼镜左眼画面。' : '设备控制已执行，请查看最新状态。'); }
    catch (error) { fail(error); }
  });
}
$('#device-host').addEventListener('click', async () => {
  try { await deviceAction({ action: 'host', enabled: !deviceControl?.enabled }); feedback('上位机守护设置已保存。'); }
  catch (error) { fail(error); }
});
$('#device-notify-confirm').addEventListener('click', async () => {
  const record=deviceControl?.debug_notifications?.find(r=>r.display_mode==='confirm_until_ack' && !r.events?.some(e=>e.kind==='hidden'));
  if(!record)return;try{await deviceAction({action:'confirm_notify',request_id:record.request_id});}catch(error){fail(error);}
});
$('#device-notify').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#device-notify-text').value;
  if (!text.trim()) { $('#device-notify-text').focus(); return; }
  const mode = $('#device-notify-mode').value;
  if (!notificationDraft || notificationDraft.text !== text || notificationDraft.display_mode !== mode) notificationDraft = { action: 'notify', request_id: uuid(), text, display_mode:mode };
  try {
    await deviceAction(notificationDraft); notificationDraft = null;
    feedback('手动通知请求已记录。请核对双眼画面及下方绘制、消失证据。');
  } catch (error) { fail(error); }
});


/** 刷新地址列表，优先使用当前设备已访问成功的网卡，再保留手选地址。 */
async function loadNetwork() {
  const info = await api('network');
  const options = info.addresses;
  const list = $('#share-address');
  const signature = JSON.stringify(options);
  const saved = sessionStorage.getItem('a5-share-origin');
  const chosen = options.find(item => item.base_url === saved) ?? options.find(item => item.base_url === location.origin) ?? options[0];
  if (list.dataset.options !== signature) {
    list.replaceChildren(...options.map(item => new Option(`${item.address} · ${item.name}`, item.base_url)));
    if (!options.length) list.append(new Option('尚无可供其他设备连接的地址', info.local_url));
    list.dataset.options = signature;
  }
  shareOrigin = chosen?.base_url ?? info.local_url;
  list.value = shareOrigin;
  const url = shareOrigin + '/admin';
  if ($('#network-url').value !== url) { $('#network-url').value = url; $('#network-qr').src = '/api/admin/qr?text=' + encodeURIComponent(url); }
  setText($('#network-hint'), options.length ? '请选择其他设备能打开的地址；此地址也用于生成被试链接和二维码。' : info.shared ? '请先开启热点或连接局域网，再刷新地址。' : '服务当前仅监听本机，请使用默认局域网启动方式后重试。');
  renderAccess();
}
$('#share-address').addEventListener('change', () => { sessionStorage.setItem('a5-share-origin', $('#share-address').value); void loadNetwork().catch(fail); });
$('#refresh-network').addEventListener('click', () => { void loadNetwork().catch(fail); });
$('#copy-network').addEventListener('click', async () => {
  const input = $('#network-url');
  try { await navigator.clipboard.writeText(input.value); feedback('主试地址已复制。'); }
  catch { input.focus(); input.select(); if (document.execCommand('copy')) feedback('主试地址已复制。'); else feedback('地址已选中，请按 Ctrl/⌘ + C 复制。'); }
});

/* ───────── 新建会话 ───────── */
function participantStage(id) { return id === '000' ? debugParticipant : config?.participants.find(p => p.participant_id === id); }
function activeSessionOf(id) { return sessions.find(s => s.participant_id === id && s.status === 'active'); }
function renderParticipantOptions(rebuild = false) {
  const select = $('#participant');
  const entries = [];
  if (debugParticipant) entries.push(['000', `000 · ${config?.config_name ?? '调试测试者'}`]);
  for (const p of config?.participants ?? []) entries.push([p.participant_id, `${p.participant_id}${p.version_label ? ` · ${p.version_label}` : ''}`]);
  const ids = entries.map(([id]) => id).join(',');
  if (rebuild || select.dataset.ids !== ids) {
    const previous = select.value; select.replaceChildren(new Option('请选择被试', ''));
    for (const [id] of entries) select.add(new Option('', id));
    select.dataset.ids = ids; select.value = entries.some(([id]) => id === previous) ? previous : '';
  }
  for (const [id, label] of entries) {
    const option = [...select.options].find(o => o.value === id), active = activeSessionOf(id);
    const count = sessions.filter(s => s.participant_id === id).length;
    const text = `${label}${active ? '（进行中）' : count ? `（已有 ${count} 次）` : ''}`;
    if (option && option.textContent !== text) option.textContent = text;
  }
  renderCreateHint();
}
function renderCreateHint() {
  const id = $('#participant').value, p = participantStage(id), active = id && activeSessionOf(id);
  $('#start button[type=submit]').disabled = !p;
  setHidden($('#assignment-section'), !p);
  renderOnce($('#assignment'), [id, p?.stages], () => (p?.stages ?? []).map(s => el('li', {}, el('strong', { text: s.stage_id }), ` ${conditionText(s)} · ${{legacy_8500:'无声11秒',tone_8500:'提示音11秒',confirm_until_ack:'无声等待确认'}[s.display_mode ?? 'legacy_8500'] ?? '无声11秒'}`)));
  setHidden($('#participant-hint'), !active || (active.session_id === selected || active.session_id === justCreatedId));
  if (active) setText($('#participant-hint-text'), `${id === '000' ? '调试测试者' : `被试 ${id}`} 已有进行中的会话（开始于 ${when(active.started_at)}）。同一编号同时只能有一个未结束会话。`);
  $('#participant-hint-view').onclick = active ? () => select(active.session_id, { focus: true }) : null;
}
$('#participant').addEventListener('change', renderCreateHint);
$('#config-file').addEventListener('change', async () => {
  const filename = $('#config-file').value; if (!filename) return;
  const select = $('#config-file'); select.disabled = true;
  try { await api('config/select', {filename}); await loadConfig(); feedback('已切换配置；已有会话继续使用原快照。'); }
  catch (error) { fail(error); await loadConfig(); }
  finally { select.disabled = false; }
});
$('#start').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('#participant').value; if (!id) return;
  const button = $('#start button[type=submit]'); feedback();
  await busyButton(button, '正在创建…', async () => {
    try {
      const created = await api('sessions', { participant_id: id, ...($('#config-file').value ? {config_file:$('#config-file').value} : {}) });
      justCreatedId = created.session_id;
      links.set(created.session_id, created.participant_url); saveLinks();
      await refresh(); await select(created.session_id, { focus: true });
      feedback(`已为${id === '000' ? '调试测试者' : `被试 ${id}`}创建会话。请复制或打开右侧“被试入口”。`);
    } catch (error) {
      const active = activeSessionOf(id);
      if (error.status === 409 && active) fail(new Error(`${id === '000' ? '调试测试者' : `被试 ${id}`} 已有未结束的会话（开始于 ${when(active.started_at)}），不能重复创建。请继续该会话，或先结束它再新建。`), { label:'查看该会话', run: () => select(active.session_id, { focus: true }) });
      else fail(error);
    }
  });
  renderCreateHint();
});

/* ───────── 会话列表 ───────── */
function attemptIndex(s) {
  const same = sessions.filter(x => x.participant_id === s.participant_id).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return same.length > 1 ? same.findIndex(x => x.session_id === s.session_id) + 1 : 0;
}
function createRow(id) {
  const button = el('button', { type: 'button', class: 'session-row', onclick: () => { feedback(); select(id, { focus: narrow.matches }); } });
  button.dataset.id = id;
  return el('li', {}, button);
}
function updateRow(li, s) {
  const st = statusOf(s), attempt = attemptIndex(s), button = li.firstElementChild;
  const values = [listName(s), attempt, st.key, st.label, isDebug(s), s.attention.length, position(s), when(s.started_at), messageShort(s)];
  renderOnce(button, values, () => [
    el('span', { class: 'row-top' },
      el('span', { class: 'row-name', text: listName(s) }),
      isDebug(s) ? el('span', { class: 'badge', 'data-kind': 'debug', text: '调试' }) : null,
      attempt ? el('span', { class: 'row-attempt', text: `第${attempt}次` }) : null,
      el('span', { class: 'badge', 'data-kind': st.key, text: st.label }),
      s.attention.length ? el('span', { class: 'badge', 'data-kind': 'warn', text: `${s.attention.length} 项待核查` }) : null),
    el('span', { class: 'row-position', text: position(s) }),
    el('span', { class: 'row-meta', text: `开始 ${when(s.started_at)} · ${messageShort(s)}` }),
  ]);
  button.setAttribute('aria-label', `${fullName(s)}，${st.label}，${position(s)}，开始于 ${when(s.started_at)}${attempt ? `，第${attempt}次会话` : ''}${s.attention.length ? `，${s.attention.length} 项待核查` : ''}`);
}
function markSelectedRows() {
  for (const [id, li] of rowNodes) {
    const button = li.firstElementChild;
    if (id === selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
}
function renderSessions() {
  const lists = { active: $('#active-list'), ended: $('#ended-list') }, order = { active: [], ended: [] };
  for (const s of [...sessions].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))) order[s.status === 'active' ? 'active' : 'ended'].push(s);
  const seen = new Set();
  for (const [group, list] of Object.entries(order)) {
    const ul = lists[group];
    list.forEach((s, index) => {
      seen.add(s.session_id);
      let li = rowNodes.get(s.session_id);
      if (!li) { li = createRow(s.session_id); rowNodes.set(s.session_id, li); }
      updateRow(li, s);
      const anchor = ul.children[index] ?? null;
      if (anchor !== li) { const focused = li.contains(document.activeElement); ul.insertBefore(li, anchor); if (focused) li.firstElementChild.focus(); }
    });
    setHidden($(`#group-${group}`), !list.length);
    setText($(`#${group}-title`), `${group === 'active' ? '进行中' : '已结束'}（${list.length}）`);
  }
  for (const [id, li] of rowNodes) if (!seen.has(id)) { li.remove(); rowNodes.delete(id); }
  markSelectedRows();
  setText($('#session-count'), String(sessions.length));
  setHidden($('#sessions-empty'), sessions.length > 0);
  $('#export-all').disabled = !sessions.length;
  setText($('#export-all-scope'), sessions.length
    ? `将导出本实验全部 ${sessions.length} 个未删除会话：含 000 调试、未完成、提前结束及同一编号的多次会话；不含已删除会话。`
    : '当前没有可导出的会话。');
}
// 列表内上下方向键移动焦点。
$('.list-card').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !event.target.classList?.contains('session-row')) return;
  const rows = $$('.session-row'), index = rows.indexOf(event.target), next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) { event.preventDefault(); next.focus(); }
});

/* ───────── 已删除会话 ───────── */
function renderDeleted() {
  setText($('#deleted-count'), String(deletedSessions.length));
  setHidden($('#deleted-empty'), deletedSessions.length > 0);
  renderOnce($('#deleted-list'), deletedSessions.map(s => [s.session_id, s.participant_id, s.started_at, s.deleted_at, s.deletion_reason, s.status]), () => deletedSessions.map(s => {
    const button = el('button', { type: 'button', class: 'btn small', text: '恢复记录', 'aria-label': `恢复${fullName(s)}开始于 ${when(s.started_at)} 的会话记录` });
    button.addEventListener('click', () => restore(s, button));
    return el('li', { class: 'deleted-item' },
      el('div', { class: 'deleted-main' },
        el('span', { class: 'row-top' }, el('span', { class: 'row-name', text: listName(s) }), isDebug(s) ? el('span', { class: 'badge', 'data-kind': 'debug', text: '调试' }) : null, el('span', { class: 'badge', 'data-kind': 'deleted', text: '已删除' }), el('span', { class: 'row-attempt', text: s.status === 'completed' ? '原为已完成' : '原为提前结束' })),
        el('span', { class: 'row-meta', text: `开始 ${when(s.started_at)} · 删除于 ${when(s.deleted_at)}` }),
        el('span', { class: 'deleted-reason', text: `原因：${s.deletion_reason ?? '—'}` })),
      button);
  }));
}
async function restore(s, button) {
  feedback();
  await busyButton(button, '正在恢复…', async () => {
    try {
      await api(`sessions/${s.session_id}/control`, { action: 'restore', reason: '实验员从已删除会话列表恢复记录' });
      await refresh(); await select(s.session_id, { focus: true });
      feedback('记录已恢复，保持原来的结束状态，不会重新开始实验。');
    } catch (error) { fail(error); }
  }).catch(() => {});
}

/* ───────── 选中会话 ───────── */
function resetSessionUi(previous) {
  if (previous) noteDrafts.set(previous, { text: $('#note-text').value, category: noteCategory(), stage: $('#note-stage').value });
  $('#control').reset(); closeConfirm(); closeRecover();
  $('#events').replaceChildren(); $('#events').hidden = true; $('#details').textContent = ''; $('#tech').open = false;
  for (const node of ['#state-values', '#rest-values', '#stepper', '#message-steps', '#attention-list', '#selected-badges', '#notes', '#interventions', '#admin-debug-target', '#note-stage']) delete $(node).dataset.sig;
  delete $('#access-card').dataset.session;
  $('#note').reset();
}
async function select(id, { focus = false } = {}) {
  if (selected !== id) { const previous = selected; resetSessionUi(previous); selected = id; detail = null; restoreNoteDraft(id); }
  markSelectedRows(); setView('sessions'); setPane('detail');
  const known = sessions.find(s => s.session_id === id);
  if (known) setText($('#selected-title'), fullName(known));
  renderAccess();
  try { await loadDetail(id); } catch (error) { fail(error); }
  if (focus && selected === id) $('#selected-title').focus();
}
function deselect() {
  selected = null; detail = null; markSelectedRows(); setView(document.body.dataset.view === 'setup' ? 'setup' : 'sessions');
  if (document.body.dataset.pane === 'detail' && document.body.dataset.view !== 'setup') document.body.dataset.pane = 'list';
}
async function loadDetail(id) {
  const [data, notes] = await Promise.all([api(`sessions/${id}`), api(`sessions/${id}/notes`)]);
  if (selected !== id) return;
  if (data.summary.deleted) { deselect(); return; }
  detail = data; renderDetail(data); renderNotes(notes.notes);
}
function renderDetail(data) {
  const s = data.summary, st = statusOf(s), actions = s.available_actions, stages = data.assignment?.stages ?? [];
  const attempt = attemptIndex(s);
  setText($('#selected-title'), fullName(s));
  renderOnce($('#selected-badges'), [st, isDebug(s)], () => [el('span', { class: 'badge', 'data-kind': st.key, text: st.label }), isDebug(s) ? el('span', { class: 'badge', 'data-kind': 'debug', text: '调试' }) : null]);
  const seconds = `${(s.message_duration_ms ?? 8500) / 1000}秒`;
  const modeText = { mixed: '逐条通知模式', tone_8500: `提示音＋${seconds}`, confirm_until_ack: '无提示音＋确认后立即消失', legacy_8500: `原版无提示音${seconds}` };
  setText($('#selected-meta'), [`开始 ${when(s.started_at, fmtFull)}`, modeText[s.display_mode ?? 'legacy_8500'], attempt ? `该编号第 ${attempt} 次会话` : null, `${s.status === 'active' ? '已用时' : '总用时'} ${duration(s.elapsed_ms)}`, s.ended_at ? `结束 ${when(s.ended_at, fmtFull)}` : null, `会话 ${s.session_id.slice(0, 8)}`].filter(Boolean).join(' · '));

  // 需要核查
  setHidden($('#attention'), !s.attention.length);
  renderOnce($('#attention-list'), s.attention, () => s.attention.map(value => el('li', { text: attentionLabel(value) })));

  // 实时状态
  setText($('#state-current'), s.current_title || position(s));
  setText($('#state-updated'), `更新于 ${fmtTime.format(new Date())}`);
  const current = stages.findIndex(x => x.stage_id === s.stage_id);
  $('#stepper').style.setProperty('--n', String(Math.max(1, stages.length)));
  renderOnce($('#stepper'), [stages.map(x => x.stage_id), current, s.phase, s.status], () => stages.map((x, index) => {
    const state = s.status === 'completed' || s.phase === 'COMPLETED' || index < current || (index === current && s.phase === 'BREAK') ? 'done' : index === current && s.phase !== 'INTRO' ? (s.status === 'active' ? 'current' : 'stopped') : 'todo';
    return el('li', { 'data-state': state, 'aria-current': state === 'current' ? 'step' : null, title: conditionText(x) }, el('span', { class: 'step-bar', 'aria-hidden': 'true' }), el('span', { class: 'step-label', text: x.stage_id }));
  }));
  const facts = [['当前位置', position(s)], ['会话状态', st.label + (s.paused ? '（被试页面已锁定）' : '')]];
  if (s.total_fields > 0) facts.push(['本页作答', `已填 ${s.answered_fields} / 共 ${s.total_fields} 项`, 'progress', s.answered_fields / s.total_fields]);
  if (data.view?.reveal) facts.push(['补充资料', s.reveal_observed ? '已展示' : '尚未展示']);
  if (s.phase === 'BREAK') facts.push(['剩余休息', `${duration(s.remaining_ms)}${s.paused ? '（已暂停计时）' : ''}`]);
  if (s.device_id) facts.push(['绑定设备', s.device_id]);
  facts.push(['最近活动', `${when(s.last_event_at, fmtTime)}${valid(s.last_event_at) ? `（${ago(s.last_event_at)}）` : ''}`]);
  renderOnce($('#state-values'), facts, () => facts.flatMap(([label, value, kind, ratio]) => [
    el('dt', { text: label }),
    el('dd', {}, el('span', { text: value }), kind === 'progress' ? progressBar(ratio) : null),
  ]));

  // 本组休息（第2单元自主休息）
  const rest = s.rest && s.rest.status !== 'not_in_u2' ? s.rest : null;
  setHidden($('#rest'), !rest);
  if (rest) {
    setText($('#rest-title'), `本组休息 · ${s.stage_id}`);
    const badge = $('#rest-status');
    setText(badge, REST_STATUS[rest.status] ?? '状态待核查');
    if (REST_KIND[rest.status]) badge.dataset.kind = REST_KIND[rest.status]; else delete badge.dataset.kind;
    const restFacts = [];
    if (rest.u2_elapsed_ms !== null && rest.u2_elapsed_ms !== undefined) restFacts.push(['U2已进行', `${duration(rest.u2_elapsed_ms)}（窗口下限 ${duration(rest.window_min_ms)}）`]);
    if (['requested', 'resting', 'returning'].includes(rest.status) && rest.remaining_ms !== null && rest.remaining_ms !== undefined) restFacts.push(['休息剩余', `${duration(rest.remaining_ms)}${s.paused ? '（已暂停计时）' : ''}`]);
    if (valid(rest.rest_started_at)) restFacts.push(['休息开始', `${when(rest.rest_started_at, fmtTime)}${rest.after_reminder ? ' · 提醒后' : ''}`]);
    restFacts.push(['主试提醒', rest.reminder_count ? `已提醒 ${rest.reminder_count} 次 · 最近 ${when(rest.last_reminder_at, fmtTime)}` : '未提醒']);
    const t2 = restT2Text(rest);
    if (t2) restFacts.push(['T2消息', t2.text, t2.tone]);
    renderOnce($('#rest-values'), restFacts, () => restFacts.flatMap(([label, value, tone]) => [
      el('dt', { text: label }), el('dd', tone ? { 'data-tone': tone } : {}, el('span', { text: value })),
    ]));
  }

  // 消息
  const stage = stages.find(x => x.stage_id === s.stage_id);
  setText($('#message-title'), s.phase === 'INTRO' ? '消息（尚未进入任务组）' : `本组消息 · ${s.stage_id}`);
  const mock = isMock(s);
  $('#message-source').dataset.kind = mock ? 'mock' : 'device';
  setText($('#message-source'), mock ? '模拟（Mock）' : '真实眼镜');
  setText($('#message-condition'), stage ? conditionText(stage) : '');
  const two = messageStepTwo(s);
  const steps = s.message_status === 'NONE' ? [] : [['发送请求', messageStepOne(s), MESSAGE_TONE[s.message_status] ?? 'bad'], ['眼镜显示', two.text, two.tone]];
  setHidden($('#message-steps'), !steps.length);
  renderOnce($('#message-steps'), steps, () => steps.map(([label, value, tone]) => el('li', { 'data-tone': tone }, el('span', { class: 'step-name', text: label }), el('span', { class: 'step-value', text: value }))));

  renderControls(s, actions, data.debug_targets ?? []);
  renderAccess();
  setText($('#export-one-scope'), `只导出这一次会话（${listName(s)}${isDebug(s) ? ' 调试' : ''}，开始于 ${when(s.started_at)}），不包括同一编号的其他会话。${s.status === 'active' ? '会话仍在进行中，导出的是截至此刻的记录。' : ''}`);

  // 技术记录
  const rows = data.interventions ?? [];
  renderOnce($('#interventions'), rows.map(m => [m.stage_id, m.condition, m.status, m.source, m.t_send, m.t_ack, m.error]), () => rows.length ? rows.map(m => el('tr', {},
    el('td', { text: m.stage_id }), el('td', { text: `${m.condition} · ${m.message_id}` }),
    el('td', { text: `${MESSAGE_STATUS[m.status] ?? m.status}${m.error ? `（${m.error}）` : ''}` }),
    el('td', { text: m.source === 'mock' ? '模拟（Mock）' : '真实眼镜' }), el('td', { text: when(m.t_send, fmtTime) }), el('td', { text: when(m.t_ack, fmtTime) }))) : [el('tr', {}, el('td', { colSpan: 6, class: 'empty-cell', text: '尚无消息请求。' }))]);
  if ($('#tech').open) renderTechJson();
}
function progressBar(ratio) {
  const bar = el('span', { class: 'progress', 'aria-hidden': 'true' }, el('span', { class: 'progress-fill' }));
  bar.firstElementChild.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  return bar;
}
function renderTechJson() {
  if (!detail) return;
  const { copied_from, ...summary } = detail.summary;
  const value = JSON.stringify({ summary, assignment: detail.assignment?.stages, interventions: detail.interventions }, null, 2);
  setText($('#details'), value);
}
$('#tech').addEventListener('toggle', () => { if ($('#tech').open) renderTechJson(); });

/* ───────── 干预 ───────── */
function renderControls(s, actions, targets) {
  const active = s.status === 'active';
  for (const button of $$('#regular-actions button')) { const allowed = actions.includes(button.value); setHidden(button, !allowed); button.disabled = controlling || !allowed; }
  setHidden($('#regular-actions'), !$$('#regular-actions button').some(b => !b.hidden));
  const pauseButton = $('#regular-actions [value=pause]'), skip = $('#regular-actions [value=skip_break]');
  setHidden($('#remind-help'), !actions.includes('remind_rest'));
  if (skip) skip.classList.toggle('primary', actions.includes('skip_break'));
  pauseButton.classList.toggle('primary', !actions.includes('skip_break'));
  setText($('#control-help'), active
    ? `所有干预都会连同原因写入记录。${s.paused ? '实验已暂停，被试页面被锁定，恢复后从原页面继续。' : s.phase === 'BREAK' ? '被试正在组间休息，可在必要时跳过休息。' : actions.includes('remind_rest') ? '被试尚未休息时可提醒休息；提醒后发生的休息会自动标为“提醒后”，如另有口头提醒请写入备注。' : ''}`
    : `会话${statusOf(s).label}，无需常规干预。${actions.includes('delete') ? '如需整理记录，可在下方删除这一次会话（可恢复）。' : ''}`);
  // 调试跳转
  setHidden($('#admin-debug'), !actions.includes('debug_jump'));
  const select = $('#admin-debug-target'), previous = select.value;
  renderOnce(select, targets.map(t => [t.id, t.label]), () => targets.map(t => new Option(t.label, t.id)));
  if (targets.some(t => t.id === previous)) select.value = previous;
  $('#admin-debug [value=debug_jump]').disabled = controlling || !actions.includes('debug_jump');
  // 危险操作
  for (const button of $$('[data-confirm]')) { const allowed = actions.includes(button.dataset.confirm); setHidden(button, !allowed); button.disabled = controlling || !allowed; }
  setHidden($('#danger'), !actions.includes('delete'));
  setText($('#danger-help'), actions.includes('stop') ? '提前结束后，被试页面显示结束页，无法继续实验；记录会保留。进行中的会话需先结束才能删除。' : actions.includes('delete') ? '删除只针对这一次会话，不影响同一编号的其他会话；删除后可在“已删除会话”中恢复。' : '');
  const pending = $('#confirm-yes').value;
  if (pending && !actions.includes(pending)) closeConfirm();
  setHidden($('#reason-wrap'), !actions.some(a => a !== 'restore'));
}
$('#reason').addEventListener('input', () => $('#reason').removeAttribute('aria-invalid'));
// 原因框内按回车不触发任何干预，避免误操作。
$('#reason').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
for (const button of $$('[data-confirm]')) button.addEventListener('click', () => {
  if (!detail) return;
  const s = detail.summary, action = button.dataset.confirm;
  setText($('#confirm-text'), action === 'stop'
    ? `确认提前结束${fullName(s)}的这次会话？被试页面将显示结束页，无法继续实验。此操作不可撤销，已有记录会保留。`
    : `确认删除${fullName(s)}开始于 ${when(s.started_at)} 的这一次会话记录？删除后不在会话列表和“导出全部”中，可随时在“已删除会话”中恢复。`);
  $('#confirm-yes').value = action;
  $('#confirm-yes').textContent = action === 'stop' ? '确认提前结束' : '确认删除记录';
  $('#confirm').hidden = false; $('#confirm-no').focus();
});
function closeConfirm() { $('#confirm').hidden = true; $('#confirm-yes').value = ''; }
$('#confirm-no').addEventListener('click', () => { closeConfirm(); $('#danger [data-confirm]:not([hidden])')?.focus(); });
$('#control').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter, action = button?.value;
  if (!action || controlling || !detail) return;
  controlling = true; button.disabled = true; feedback();
  const id = selected, s = detail.summary;
  try {
    await api(`sessions/${id}/control`, { action, reason: $('#reason').value, ...(action === 'debug_jump' ? { target: $('#admin-debug-target').value } : {}) });
    $('#reason').value = ''; closeConfirm();
    if (action === 'delete') {
      if (selected === id) { deselect(); showList(); }
      $('#deleted-section').open = true;
      feedback(`${fullName(s)}的这一次会话已移至“已删除会话”，不再进入全部导出，可随时恢复。`, { label: '撤销删除', run: () => restore(s, $('#notice-action')) });
    } else feedback(`${ACTION_DONE[action]}，操作已记录。`);
  } catch (error) { fail(error); }
  finally { controlling = false; $('#confirm-yes').disabled = false; await refresh().catch(pollFailed); }
});

/* ───────── 被试入口 ───────── */
function renderAccess() {
  const card = $('#access-card');
  if (detail?.participant_url && selected === detail.summary.session_id) { links.set(selected, detail.participant_url); saveLinks(); }
  const savedUrl = selected ? links.get(selected) ?? '' : '';
  const seen = detail?.connection;
  setText($('#participant-connection'), seen?.connected ? '被试页面已连接' : seen?.last_seen_at ? `被试页面暂未连接 · 最近在线 ${when(seen.last_seen_at, fmtFull)}` : '等待被试打开此会话页面');
  const ended = detail?.summary.session_id === selected && detail.summary.status !== 'active';
  setHidden($('#access-ended'), !ended);
  const url = savedUrl ? new URL(savedUrl, shareOrigin).href : '';
  if (card.dataset.session === selected && card.dataset.url === url) return;
  card.dataset.session = selected ?? ''; card.dataset.url = url;
  closeRecover();
  setHidden($('#access-link'), !url); setHidden($('#access-empty'), !!url);
  $('#access-url').value = url;
  $('#access-qr').src = url ? '/api/admin/qr?text=' + encodeURIComponent(url) : '';
  $('#access-qr').hidden = !url;
  $('#open-link').href = savedUrl || '/experiment';
  setText($('#recover'), url ? '重新生成入口…' : '生成恢复入口…');
  setText($('#copy-link'), '复制链接');
}
$('#access-url').addEventListener('focus', () => $('#access-url').select());
$('#copy-link').addEventListener('click', async () => {
  const value = $('#access-url').value; if (!value) return;
  try { await navigator.clipboard.writeText(value); }
  catch { $('#access-url').focus(); $('#access-url').select(); if (!document.execCommand('copy')) { fail(new Error('浏览器不允许自动复制，链接已选中，请按 Ctrl/⌘ + C 复制。')); return; } }
  setText($('#copy-link'), '已复制 ✓');
  feedback('被试链接已复制。请在被试电脑的浏览器中打开；每个链接只对应这一次会话。');
  setTimeout(() => setText($('#copy-link'), '复制链接'), 2500);
});
function closeRecover() { $('#recover-confirm').hidden = true; }
$('#recover').addEventListener('click', () => { $('#recover-confirm').hidden = false; $('#recover-no').focus(); });
$('#recover-no').addEventListener('click', () => { closeRecover(); $('#recover').focus(); });
$('#recover-yes').addEventListener('click', async () => {
  const id = selected; feedback();
  await busyButton($('#recover-yes'), '正在生成…', async () => {
    try {
      const result = await api(`sessions/${id}/access`, {});
      links.set(id, result.participant_url); saveLinks();
      if (selected === id) { renderAccess(); $('#copy-link').focus(); feedback('新入口已生成，旧入口已失效。请用新链接重新打开被试页面。'); }
    } catch (error) { fail(error); }
  });
});

/* ───────── 访谈与备注 ───────── */
const noteCategory = () => $('#note input[name=category]:checked')?.value ?? 'interview';
function restoreNoteDraft(id) {
  const draft = noteDrafts.get(id); if (!draft) return;
  $('#note-text').value = draft.text;
  const radio = $(`#note input[value=${draft.category}]`); if (radio) radio.checked = true;
  $('#note-stage').dataset.pending = draft.stage;
}
function renderNotes(notes) {
  const stages = detail?.assignment?.stages ?? [];
  const stageSelect = $('#note-stage');
  if (renderOnce(stageSelect, stages.map(x => x.stage_id), () => [new Option('全实验', ''), ...stages.map(x => new Option(x.stage_id, x.stage_id))])) {
    const wanted = stageSelect.dataset.pending ?? (detail && detail.summary.phase !== 'INTRO' && detail.summary.status === 'active' ? detail.summary.stage_id : '');
    stageSelect.value = stages.some(x => x.stage_id === wanted) ? wanted : ''; delete stageSelect.dataset.pending;
    $('#prompts-section').open = detail?.summary.status !== 'active';
  }
  setText($('#notes-count'), String(notes.length));
  setHidden($('#notes-empty'), notes.length > 0);
  renderOnce($('#notes'), notes.map(n => n.event_id ?? n.timestamp_iso), () => [...notes].reverse().map(note => el('li', { class: 'note', 'data-category': note.payload.category },
    el('p', { class: 'note-meta' }, el('span', { class: 'tag', 'data-kind': note.payload.category, text: CATEGORIES[note.payload.category] ?? '备注' }), note.payload.stage_id ? el('span', { text: note.payload.stage_id }) : el('span', { text: '全实验' }), el('time', { dateTime: note.timestamp_iso, text: when(note.timestamp_iso, fmtFull) })),
    el('p', { class: 'note-text', text: note.payload.text }))));
}
function renderPrompts() { renderOnce($('#prompts'), prompts, () => prompts.map(text => el('li', { text }))); }
$('#note-text').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#note').requestSubmit(); } });
$('#note').addEventListener('submit', async event => {
  event.preventDefault();
  const id = selected, text = $('#note-text').value;
  if (!text.trim()) { $('#note-text').focus(); fail(new Error('请先填写记录内容。')); return; }
  const button = event.submitter ?? $('#note button[type=submit]'); feedback();
  await busyButton(button, '正在保存…', async () => {
    try {
      await api(`sessions/${id}/notes`, { category: noteCategory(), stage_id: $('#note-stage').value || null, text });
      if (selected === id) { $('#note-text').value = ''; noteDrafts.delete(id); feedback(`${CATEGORIES[noteCategory()]}已保存。`); await loadDetail(id); }
    } catch (error) { fail(error); }
  });
});

/* ───────── 导出 ───────── */
$('#export-all').addEventListener('click', async () => {
  feedback(); const count = sessions.length;
  await busyButton($('#export-all'), '正在生成 ZIP…', async () => {
    try { const name = await download('export'); feedback(`已导出全部 ${count} 个未删除会话：${name}（服务端 exports 目录也保存了一份）。`); } catch (error) { fail(error); }
  });
  $('#export-all').disabled = !sessions.length;
});
$('#export-one').addEventListener('click', async () => {
  const id = selected; if (!id) return; feedback();
  await busyButton($('#export-one'), '正在生成 ZIP…', async () => {
    try { const name = await download(`export?session_id=${encodeURIComponent(id)}`); feedback(`已导出当前这一次会话：${name}。`); } catch (error) { fail(error); }
  });
});

/* ───────── 技术记录：完整事件日志 ───────── */
$('#logs').addEventListener('click', async () => {
  const id = selected; feedback();
  await busyButton($('#logs'), '正在读取…', async () => {
    try {
      const { events } = await api(`sessions/${id}/events`);
      if (selected !== id) return;
      const millis = value => valid(value) ? `${fmtTime.format(new Date(value))}.${String(new Date(value).getMilliseconds()).padStart(3, '0')}` : '—';
      setText($('#events'), events.map(e => `${millis(e.timestamp_iso)}  ${e.event_type}${e.stage_id ? `  ${e.stage_id}${e.unit_id ? `/${e.unit_id}` : ''}` : ''}\n    ${JSON.stringify(e.payload)}`).join('\n') || '暂无事件。');
      $('#events').hidden = false; feedback(`已读取 ${events.length} 条事件。`);
    } catch (error) { fail(error); }
  });
});

/* ───────── 准备与检查 ───────── */
function renderSetup() {
  renderDevice();
  const participants = config?.participants ?? [], stageIds = [...new Set(participants.flatMap(p => p.stages.map(s => s.stage_id)))];
  setText($('#config-count'), `${participants.length} 位`);
  renderOnce($('#config-head'), stageIds, () => [el('tr', {}, el('th', { scope: 'col', text: '编号' }), el('th', { scope: 'col', text: '版本' }), ...stageIds.map(id => el('th', { scope: 'col', text: id })), el('th', { scope: 'col', text: '会话' }))]);
  renderOnce($('#config-body'), [participants, sessions.map(s => [s.participant_id, s.status])], () => participants.map(p => {
    const count = sessions.filter(s => s.participant_id === p.participant_id).length, active = activeSessionOf(p.participant_id);
    return el('tr', {}, el('th', { scope: 'row', text: p.participant_id }), el('td', { text: p.version_label ?? '—' }),
      ...stageIds.map(id => { const stage = p.stages.find(s => s.stage_id === id); return el('td', { title: stage ? conditionText(stage) : '' }, stage ? el('span', { class: 'cond', 'data-kind': stage.condition === 'NONE' ? 'none' : stage.condition[0] }, conditionShort(stage), stage.condition !== 'NONE' ? el('small', { text: stage.message_id }) : null) : '—'); }),
      el('td', { text: active ? '进行中' : count ? `${count} 次` : '—' }));
  }));
}
$('#preflight').addEventListener('click', async () => {
  feedback();
  await busyButton($('#preflight'), '正在检查…', async () => {
    try {
      const c = await api('preflight'); adapter = c.adapter; renderDevice();
      const errors = [...c.material_errors, ...c.pilot_errors.map(e => `默认配置：${e}`), ...c.source_config_errors.map(e => `源配置：${e}`)];
      const item = (tone, text) => el('li', { 'data-tone': tone }, el('span', { class: 'check-icon', 'aria-hidden': 'true', text: tone === 'ok' ? '✓' : tone === 'bad' ? '!' : 'i' }), el('span', { text }));
      $('#check-result').replaceChildren(
        el('p', { class: 'check-time hint', text: `检查于 ${fmtTime.format(new Date())} · 内容版本 ${c.content_version} · 刺激版本 ${c.stimulus_version}` }),
        el('ul', { class: 'checklist' },
          item(c.startup_ok ? 'ok' : 'bad', c.startup_ok ? '软件启动检查通过' : '软件启动检查未通过'),
          item(c.material_errors.length ? 'bad' : 'ok', `材料：文本表格 ${c.materials.text_tables} 张，消息材料 ${c.materials.sh_stimuli} 条；材料错误 ${c.material_errors.length} 项`),
          item(c.pilot_errors.length ? 'bad' : 'ok', `默认配置（${c.pilot_participants.length} 位被试）错误 ${c.pilot_errors.length} 项`),
          c.source_config_note ? item('info', c.source_config_note) : item(c.source_config_errors.length ? 'bad' : 'ok', `源配置错误 ${c.source_config_errors.length} 项`),
          ...errors.map(e => item('bad', e)),
          item(deviceInfo(c.adapter).tone === 'ok' ? 'ok' : 'info', deviceInfo(c.adapter).long),
          item(c.pilot_ready ? 'ok' : 'info', c.pilot_ready ? '具备正式实验条件。' : '现场硬件呈现及计时尚待验收。')),
        c.remaining?.length ? el('details', { class: 'disclosure' }, el('summary', { text: `尚待完成的事项（${c.remaining.length}）` }), el('ul', { class: 'plain-list' }, c.remaining.map(r => el('li', { text: r })))) : null);
    } catch (error) { fail(error); }
  });
});
$('#config-download').addEventListener('click', () => {
  if (!config) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }));
  const link = el('a', { href: url, download: 'participants.json' });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
$('#import').addEventListener('submit', async event => {
  event.preventDefault(); feedback();
  const file = $('#config').files[0];
  if (!file) { $('#config').focus(); fail(new Error('请先选择配置文件（JSON）。')); return; }
  await busyButton(event.submitter ?? $('#import button'), '正在校验…', async () => {
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { fail(new Error('所选文件不是有效的 JSON。')); return; }
    try { await api('config', {config:parsed, filename:file.name}); await loadConfig(); $('#import').reset(); feedback('配置已保存到配置文件夹并导入。已开始的会话继续使用原配置。'); }
    catch (error) { fail(new Error(`配置未导入：${error.message}`)); }
  });
});

/* ───────── 加载与轮询 ───────── */
async function loadConfig() {
  const data = await api('config');
  const fileSelect = $('#config-file');
  fileSelect.replaceChildren(new Option('当前已导入配置', ''));
  for (const file of data.files ?? []) { const option = new Option(`${file.label}${file.valid ? '' : '（配置无效）'}`, file.filename); option.disabled = !file.valid; option.title = file.error ?? file.filename; fileSelect.add(option); }
  fileSelect.value = data.selected_file ?? '';
  config = data.config; debugParticipant = data.debug_participant; adapter = data.adapter; prompts = data.interview_prompts ?? [];
  renderDevice(); renderParticipantOptions(true); renderPrompts(); renderSetup();
}
/** 同步会话列表与当前视图；设置页同时更新设备控制状态。 */
async function refresh() {
  const data = await api('sessions');
  await loadNetwork();
  adapter = data.adapter; sessions = data.sessions; deletedSessions = data.deleted_sessions ?? [];
  if (offline) { offline = false; }
  renderDevice(); renderSessions(); renderDeleted(); renderParticipantOptions();
  if (document.body.dataset.view === 'setup') { renderSetup(); await loadDeviceControl(); }
  if (selected) await loadDetail(selected);
}
function pollFailed(error) {
  if (error?.status === 401) { stopped = true; fail(error); return; }
  if (!offline) { offline = true; renderDevice(); }
}
let polling = false;
async function poll() {
  if (polling || stopped || document.hidden) return;
  polling = true;
  try { await refresh(); } catch (error) { pollFailed(error); } finally { polling = false; }
}
$('#network-card').open = false;
setView('sessions');
try { await loadNetwork(); await loadConfig(); await refresh(); await loadDeviceControl(); } catch (error) { fail(error); }
setInterval(poll, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
