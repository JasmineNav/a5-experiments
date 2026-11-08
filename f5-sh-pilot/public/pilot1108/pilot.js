import { fields, labels, escape, feedbackMarkup } from './feedback.js';
const app = document.querySelector('#app');
const save = document.querySelector('#save');
const errorBox = document.querySelector('#error');
const token = document.querySelector('meta[name="pilot-token"]').content;
let current = null, chain = Promise.resolve(), pending = 0;
function showError(message) { errorBox.hidden = false; errorBox.textContent = message; }
function clearError() { errorBox.hidden = true; errorBox.replaceChildren(); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Pilot-Token': token, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.application = true; throw error; }
  return data;
}
// 无反馈条件下不能用“已保存”等逐项状态构成额外完成反馈。
function updateSaveStatus() { save.textContent = current && current.stage !== 'done' ? '' : (pending ? '正在保存…' : ''); }
function command(action, rerender = false) {
  pending++; updateSaveStatus();
  chain = chain.then(async () => {
    // 同一窗口串行发送；丢失响应时使用相同命令编号重试，避免重复提交。
    const body = JSON.stringify({ command_id: crypto.randomUUID(), revision: current.revision, action });
    while (true) {
      try {
        current = await api(`/api/sessions/${current.id}/command`, { method: 'POST', body });
        clearError(); if (rerender) render(); break;
      } catch (error) {
        if (error.application) throw error;
        showError('保存连接中断，请保持此页。点击重试后会继续保存；刷新可能丢失尚未发送的输入。');
        await new Promise(resolve => { const button = document.createElement('button'); button.textContent = '重试保存'; button.onclick = resolve; errorBox.append(button); });
        clearError();
      }
    }
  }).catch(error => showError(error.message)).finally(() => { pending--; updateSaveStatus(); });
  return chain;
}
function go(action) {
  app.querySelectorAll('button').forEach(b => b.disabled = true);
  return command(action, true).finally(() => app.querySelectorAll('button').forEach(b => b.disabled = false));
}
function inputFields(answers, keys = fields) {
  return keys.map(f => `<label class="field">${labels[f]}${f === 'qualified' ? '' : '（万元）'}<input type="text" autocomplete="off" spellcheck="false" maxlength="100" ${f === 'qualified' ? '' : 'inputmode="decimal"'} data-field="${f}" value="${escape(answers[f])}"></label>`).join('');
}
function table(task) {
  return `<table><thead><tr><th>方案</th><th>基本报价<br>（万元）</th><th>其他费用<br>（万元）</th><th>筹备时间<br>（天）</th><th>每场接待<br>（人）</th></tr></thead><tbody>${task.rows.map(r => `<tr><td>${r.plan}</td><td>${r.base.toFixed(2)}</td><td>${r.extra.toFixed(2)}</td><td>${r.days}</td><td>${r.people}</td></tr>`).join('')}</tbody></table>`;
}
function bindInputs() {
  app.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => {
    command({ type: 'input', field: input.dataset.field, value: input.value });
    feedback();
  }));
}
function feedback() {
  const target = document.querySelector('#feedback'); if (!target) return;
  const values = Object.fromEntries([...app.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value]));
  target.innerHTML = feedbackMarkup(current.feedback, values);
}
function render() {
  const v = current, task = v.task;
  if (v.stage === 'done') {
    localStorage.removeItem('a5-pilot1108-session');
    app.innerHTML = `<h1>本次任务已完成，谢谢！</h1><section class="panel interview"><h2>主试访谈提纲</h2><ul><li>第一步算费用选方案，和第二步照着填结果，哪个更需要思考？具体是哪里？</li><li>第二步填写答案时是什么感受？为什么？</li><li>两个任务的第二步界面，你注意到哪些不同？</li><li>这些差异带来了什么不同的作答感受？</li><li>你更希望使用哪种界面，为什么？</li></ul><p class="hint">访谈由主试另行记录；页面不录音。</p><button id="download">下载系统日志 JSON</button><button id="home" class="secondary">返回主试设置</button></section>`;
    document.querySelector('#download').onclick = () => download(v.id);
    document.querySelector('#home').onclick = home; return;
  }
  const prefix = `<p class="hint">被试 ${escape(v.participant)} · ${task.practice ? '练习' : '正式任务'} · ${v.trial_number} / ${v.task_count}</p><h1>${escape(task.title)}</h1>`;
  if (v.stage === 'requirements') {
    app.innerHTML = `${prefix}<section class="panel"><h2>界面1 · 阅读任务要求</h2><p>${task.practice ? '你今天要筛选展台布置方案。' : '你今天要为活动筛选执行方案。今天13:00—13:45要和同事交接活动资料，14:00还要参加线上评审会。'}</p><p>请计算 A、B、C、D 四个方案的总费用，选出同时满足以下三项条件的所有方案：</p><ul><li>总费用 ≤ ${task.maxCost} 万元（总费用＝基本报价＋其他费用）</li><li>筹备时间 ≤ ${task.maxDays} 天</li><li>每场接待 ≥ ${task.minPeople} 人</li></ul><p class="hint">请记住比较条件。进入方案资料页后可以返回本页查看要求。</p><button id="compute">开始计算与筛选</button></section>`;
    document.querySelector('#compute').onclick = () => go({ type: 'compute' });
  } else if (v.stage === 'compute') {
    const selected = v.answers.qualified.toUpperCase();
    app.innerHTML = `${prefix}<h2>界面2 · 算费用、选方案</h2><div class="columns"><section class="panel">${table(task)}<button id="requirements" class="secondary">返回任务要求</button></section><section class="panel">${inputFields(v.answers, ['A', 'B', 'C', 'D'])}<fieldset><legend>选择符合要求的方案（可多选）</legend>${['A', 'B', 'C', 'D'].map(f => `<label class="check"><input type="checkbox" value="${f}" ${selected.includes(f) ? 'checked' : ''}>${f}</label>`).join('')}</fieldset><button id="next">下一步</button></section></div>`;
    bindInputs();
    app.querySelectorAll('[type=checkbox]').forEach(input => input.onchange = () => command({ type: 'input', field: 'qualified', value: [...app.querySelectorAll('[type=checkbox]:checked')].map(i => i.value).join('、') }));
    document.querySelector('#requirements').onclick = () => go({ type: 'requirements' });
    document.querySelector('#next').onclick = () => go({ type: 'next' });
  } else if (v.stage === 'transcribe') {
    app.innerHTML = `${prefix}<h2>界面3 · 照着结果填写并提交</h2><div class="columns"><section class="panel"><h2>刚才的结果</h2><table><thead><tr><th>项目</th><th>结果</th></tr></thead><tbody>${fields.map(f => `<tr><td>${labels[f]}</td><td>${escape(v.source[f])}${f === 'qualified' ? '' : ' 万元'}</td></tr>`).join('')}</tbody></table></section><section class="panel"><h2>确认活动执行方案</h2>${inputFields(v.answers)}<p class="hint">合格方案编号可用顿号分隔，例如 A、D。费用单位为万元。</p>${v.feedback ? '<div id="feedback" class="feedback" aria-label="登记完成反馈"></div>' : ''}<button id="next">提交最终结果</button></section></div>`;
    bindInputs(); feedback(); document.querySelector('#next').onclick = () => go({ type: 'next' });
  } else {
    const phase = v.stage === 'scale1' ? '第一步：算费用、选方案' : '第二步：照着结果填写';
    app.innerHTML = `${prefix}<h2>阶段量表 · ${phase}</h2><form id="ratings" class="panel scale"><p>请只评价刚刚完成的阶段。</p><p class="hint">心理需求、信息整合需求、努力：1完全没有；2很低；3较低；4中等；5较高；6很高；7极高。<br>放松感：1完全不放松；2只有一点点放松；3有些放松；4中等；5比较放松；6很放松；7极其放松。</p>${v.scale_items.map(item => `<fieldset><legend>${item.label}</legend><p>${item.question}</p><div class="choices">${Array.from({ length: 7 }, (_, i) => `<label><input required type="radio" name="${item.key}" value="${i + 1}">${i + 1}</label>`).join('')}</div></fieldset>`).join('')}<button type="submit">提交量表并继续</button></form>`;
    document.querySelector('#ratings').onsubmit = event => { event.preventDefault(); go({ type: 'ratings', values: Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, Number(value)])) }); };
  }
  window.scrollTo(0, 0);
}
async function download(id) {
  try {
    const data = await api(`/api/sessions/${id}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `SH-pilot-1108-${data.state.participant}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showError(error.message); }
}
async function home() {
  clearError(); save.textContent = ''; current = null;
  try {
    const data = await api('/api/sessions');
    app.innerHTML = `<div class="setup"><h1>11-08 材料 pilot · 主试设置</h1><p>练习 → 两个不同材料的 SH01 任务。本轮不发送任何打断消息。请先完成设置，再交给被试。</p><form id="create" class="panel"><label class="field">被试编号<input name="participant" type="text" required maxlength="40" pattern="[A-Za-z0-9_-]+" placeholder="P01"></label><label class="field">任务顺序<select name="order"><option value="auto">按编号平衡（1、2无反馈先；3、4有反馈先）</option><option value="no-feedback-first">无反馈 → 有反馈</option><option value="feedback-first">有反馈 → 无反馈</option></select></label><label class="field">反馈形式<select name="feedback"><option value="progress">静态分段进度条（推荐）</option><option value="registered">登记结果并标绿</option><option value="message">下方显示已完成文字</option></select></label><label class="field">誊写来源<select name="source"><option value="participant">被试刚才的输入（默认）</option><option value="standard">文档标准答案</option></select></label><p><label class="check"><input name="practiceScales" type="checkbox">练习也填写量表</label><label class="check"><input name="practiceFeedback" type="checkbox">练习也提供反馈</label></p><p class="hint">P01/P02 无反馈先，P03/P04 有反馈先；P05起重复四人分配。允许主试显式覆盖，不强制人数配额。会话创建时固定配置。</p><button type="submit">开始练习</button></form><section class="panel"><h2>已有会话</h2>${data.sessions.map(s => `<div class="session"><span>${escape(s.participant)} · ${escape(s.stage)} · ${escape(s.config.order)}</span><span><button data-resume="${s.id}" class="secondary">${s.stage === 'done' ? '查看完成页' : '恢复'}</button><button data-export="${s.id}" class="secondary">导出</button></span></div>`).join('') || '<p>暂无会话</p>'}</section></div>`;
    const form = document.querySelector('#create');
    for (const [key, value] of Object.entries(data.defaults)) if (form.elements[key]) {
      if (typeof value === 'boolean') form.elements[key].checked = value; else form.elements[key].value = value;
    }
    form.onsubmit = async event => {
      event.preventDefault(); clearError(); const button = form.querySelector('button'); button.disabled = true;
      const values = new FormData(form); const config = { feedback: values.get('feedback'), source: values.get('source'), practiceScales: values.has('practiceScales'), practiceFeedback: values.has('practiceFeedback') };
      if (values.get('order') !== 'auto') config.order = values.get('order');
      try {
        current = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ participant: values.get('participant'), config }) });
        localStorage.setItem('a5-pilot1108-session', current.id); render();
      } catch (error) { showError(error.message); button.disabled = false; }
    };
    app.querySelectorAll('[data-resume]').forEach(button => button.onclick = () => resume(button.dataset.resume));
    app.querySelectorAll('[data-export]').forEach(button => button.onclick = () => download(button.dataset.export));
  } catch (error) { showError(error.message); }
}
async function resume(id) {
  try { current = await api(`/api/sessions/${id}`); localStorage.setItem('a5-pilot1108-session', id); render(); }
  catch (error) { localStorage.removeItem('a5-pilot1108-session'); await home(); showError(error.message); }
}
const session = localStorage.getItem('a5-pilot1108-session');
if (session) await resume(session); else await home();
