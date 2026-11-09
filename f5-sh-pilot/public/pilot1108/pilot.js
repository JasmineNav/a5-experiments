import { fields, labels, escape, feedbackMarkup } from './feedback.js';
import { taskProgress } from './rules.js';
const app = document.querySelector('#app');
const save = document.querySelector('#save');
const errorBox = document.querySelector('#error');
const homeEntry = document.querySelector('#home-entry');
const token = document.querySelector('meta[name="pilot-token"]').content;
let current = null, chain = Promise.resolve(), pending = 0, loadingTimer = null;
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
  app.querySelectorAll('button,input,select,textarea').forEach(b => b.disabled = true);
  return command(action, true).finally(() => app.querySelectorAll('button,input,select,textarea').forEach(b => b.disabled = false));
}
function inputFields(answers, keys = fields, compact = false) {
  return keys.map(f => `<label class="field">${compact && f !== 'qualified' ? `${f}方案` : `${labels[f]}${f === 'qualified' ? '' : '（万元）'}`}<input type="text" autocomplete="off" spellcheck="false" maxlength="100" ${f === 'qualified' ? '' : 'inputmode="decimal"'} data-field="${f}" value="${escape(answers[f])}"></label>`).join('');
}
function taskConditions(task) {
  const requirements = task.requirements;
  const conditions = requirements ? [requirements.cost, requirements.time, requirements.capacity] : [`总费用 ≤ ${task.maxCost} 万元（总费用＝基本报价＋其他费用）`, `筹备时间 ≤ ${task.maxDays} 天`, `每场接待 ≥ ${task.minPeople} 人`];
  return task.practice ? conditions : conditions.map(text => text.replaceAll('不超过', '≤').replaceAll('不少于', '≥'));
}
function table(task) {
  const headers = task.tableHeaders ?? ['基本报价（万元）', '其他费用（万元）', '筹备时间（天）', '每场接待（人）'];
  return `<table><thead><tr><th>方案</th>${headers.map(h => `<th>${escape(h).replace('（', '<br>（')}</th>`).join('')}</tr></thead><tbody>${task.rows.map(r => `<tr><td>${r.plan}</td><td>${r.base.toFixed(2)}</td><td>${r.extra.toFixed(2)}</td><td>${r.days}</td><td>${r.people}</td></tr>`).join('')}</tbody></table>`;
}
function taskHero(v) {
  if (v.task.taskHeader === 'hidden') return '';
  if (v.task.taskProgress === 'substeps-v1') return taskProgressMarkup(v.stage, v.answers);
  if (v.task.taskProgress === 'none') return '<div class="task-progress task-progress-space" aria-hidden="true"><svg viewBox="0 0 600 68"></svg></div>';
  const phases = { scenario: '情景引入', requirements: '任务要求', compute: '计算与筛选', loading: '页面切换', transcribe: '结果提交', submitted: '已提交', ratings: '任务后问卷' };
  const topic = v.task.practice ? '练习任务' : v.task.title.includes('设备租赁') ? '展厅筹备' : '活动筹备';
  return `<section class="task-hero"><div><p class="task-topic">${topic}</p><h1>${escape(v.task.title)}</h1><p class="task-meta">被试 ${escape(v.participant)} · ${v.task.practice ? '练习' : '正式任务'} · ${v.trial_number} / ${v.task_count}</p></div><span class="task-phase">${phases[v.stage] ?? ''}</span></section>`;
}
function taskProgressMarkup(stage, answers) {
  const progress = taskProgress(stage, answers), percent = Math.round(progress.value * 100) / 100;
  const nodes = ['开始任务', '完成筛选', '提交完成'];
  return `<section id="task-progress" class="task-progress" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}%，${progress.submitted ? '提交完成' : progress.value >= 50 ? '完成筛选，正在提交' : '计算与筛选'}"><svg viewBox="0 0 600 68" aria-hidden="true"><path class="task-progress-track" d="M50 16H550"/><path class="task-progress-fill" d="M50 16H550" pathLength="100" stroke-dasharray="${progress.value} 100"/>${nodes.map((label, i) => `<g class="task-progress-node${progress.value >= i * 50 ? ' reached' : ''}"><circle cx="${50 + i * 250}" cy="16" r="6"/><text x="${50 + i * 250}" y="52" text-anchor="middle">${label}</text></g>`).join('')}</svg></section>`;
}
function updateTaskProgress() {
  const target = document.querySelector('#task-progress');
  if (!target || current?.task.taskProgress !== 'substeps-v1') return;
  const answers = { ...current.answers };
  app.querySelectorAll('[data-field]').forEach(input => { answers[input.dataset.field] = input.value; });
  if (current.stage === 'compute') answers.qualified = [...app.querySelectorAll('[type=checkbox]:checked')].map(input => input.value).join('、');
  // 只替换顶部进度，保留正在编辑的输入框及光标；取当前字段状态，不累加点击次数。
  target.outerHTML = taskProgressMarkup(current.stage, answers);
}
function conditionDetails(task) {
  const conditions = taskConditions(task), split = conditions[0].indexOf('（');
  return { conditions: [split < 0 ? conditions[0] : conditions[0].slice(0, split), ...conditions.slice(1)],
    formula: split < 0 ? '' : conditions[0].slice(split + 1).replace(/）$/, '') };
}
function conditionCard(task, compact = false) {
  const details = conditionDetails(task);
  return `<div ${compact ? 'id="calculation-conditions"' : ''} class="task-conditions ${compact ? 'compact-conditions' : ''}">${compact ? '' : '<h3>筛选条件</h3>'}<ul>${details.conditions.map(text => `<li>${escape(text)}</li>`).join('')}</ul>${compact && details.formula ? `<p class="task-formula">${escape(details.formula)}</p>` : ''}</div>`;
}
function calculationTable(task, answers) {
  const headers = task.tableHeaders ?? ['基本报价（万元）', '其他费用（万元）', '筹备时间（天）', '每场接待（人）'];
  return `<div class="calculation-table-scroll"><table class="calculation-table"><thead><tr><th scope="col">方案</th>${headers.map(h => `<th scope="col">${escape(h)}</th>`).join('')}<th scope="col">总费用（万元）</th></tr></thead><tbody>${task.rows.map(r => `<tr><th scope="row">${r.plan}</th><td>${r.base.toFixed(2)}</td><td>${r.extra.toFixed(2)}</td><td>${r.days}</td><td>${r.people}</td><td><input type="text" autocomplete="off" spellcheck="false" inputmode="decimal" maxlength="100" data-field="${r.plan}" aria-label="${r.plan}方案总费用（万元）" value="${escape(answers[r.plan])}"></td></tr>`).join('')}</tbody></table></div>`;
}
function sourceTable(source) {
  return `<table class="source-table"><thead><tr><th scope="col">项目</th><th scope="col">结果</th></tr></thead><tbody>${fields.map(f => `<tr><th scope="row">${labels[f]}</th><td>${escape(source[f])}${f === 'qualified' ? '' : ' 万元'}</td></tr>`).join('')}</tbody></table>`;
}
function bindCalculationControls() {
  bindInputs();
  const notebook = document.querySelector('#scratchpad');
  if (notebook) notebook.addEventListener('input', () => command({ type: 'scratchpad', value: notebook.value }));
  app.querySelectorAll('[type=checkbox]').forEach(input => input.onchange = () => {
    command({ type: 'input', field: 'qualified', value: [...app.querySelectorAll('[type=checkbox]:checked')].map(i => i.value).join('、') });
    updateTaskProgress();
  });
  document.querySelector('#requirements').onclick = () => go({ type: 'requirements' });
  document.querySelector('#next').onclick = () => go({ type: 'next' });
}
/** 快照声明的卡片界面：R6正式任务、R7起包括练习；旧快照继续原呈现。 */
function renderCards(v) {
  const task = v.task, hero = taskHero(v);
  if (v.stage === 'scenario') {
    app.innerHTML = `${hero}<section class="task-card"><h2>情景引入</h2><p class="task-intro">${escape(task.requirements.context)}</p><div class="task-actions end"><button id="scenario-next">下一步：阅读任务要求</button></div></section>`;
    document.querySelector('#scenario-next').onclick = () => go({ type: 'requirements' });
  } else if (v.stage === 'requirements') {
    const { formula } = conditionDetails(task);
    app.innerHTML = `${hero}<section class="task-card"><h2>查看任务要求</h2><p class="task-intro">${escape(task.requirements.premise)}</p>${conditionCard(task)}<p class="standalone-formula">${escape(formula)}</p><p>请计算A、B、C、D四个方案的总费用，并选出所有符合条件的方案。费用保留两位小数。</p><div class="task-actions end"><button id="compute">开始计算</button></div></section>`;
    document.querySelector('#compute').onclick = () => go({ type: 'compute' });
  } else if (v.stage === 'compute') {
    const selected = v.answers.qualified.toUpperCase();
    app.innerHTML = `${hero}<section class="task-card calculation-card"><h2>计算费用并筛选方案</h2>${conditionCard(task, true)}<div class="task-compute-grid"><section class="task-subcard"><h3>方案资料与计算记录</h3>${calculationTable(task, v.answers)}<fieldset class="plan-choices"><legend>符合条件的方案（可多选）</legend>${['A', 'B', 'C', 'D'].map(f => `<label class="check"><input type="checkbox" value="${f}" ${selected.includes(f) ? 'checked' : ''}><span>${f}</span></label>`).join('')}</fieldset><div class="task-actions"><button id="requirements" class="link-button">返回任务要求</button><button id="next">下一步</button></div></section><section class="task-subcard task-notebook" aria-labelledby="scratchpad-title"><h3 id="scratchpad-title">草稿本</h3><textarea id="scratchpad" aria-label="草稿本" rows="12" maxlength="5000" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" writingsuggestions="false">${escape(v.scratchpad)}</textarea></section></div></section>`;
    bindCalculationControls();
  } else if (v.stage === 'loading') {
    app.innerHTML = `${hero}<section id="transcription-loading" class="task-card loading-panel" role="status" aria-label="加载中" aria-busy="true"><span class="loading-spinner" aria-hidden="true"></span></section>`;
    loadingTimer = setTimeout(() => go({ type: 'transcribe' }), v.loading_remaining_ms ?? 2000);
  } else if (v.stage === 'transcribe') {
    const submitTitle = (task.confirmationTitle ?? '确认活动执行方案').replace(/^确认(?!并提交)/, '确认并提交');
    app.innerHTML = `${hero}<div class="task-submit-grid"><section class="task-card task-submit-form"><h2>${escape(submitTitle)}</h2><p class="task-intro">请根据计算结果填写下方表单。</p>${inputFields(v.answers, ['qualified'])}<h3>各方案总费用（万元）</h3><p class="hint">保留两位小数</p>${inputFields(v.answers, ['A', 'B', 'C', 'D'], true)}<div class="task-actions"><button id="next">提交结果</button></div></section><section class="task-card task-source"><h2>方案筛选结果</h2>${sourceTable(v.source)}</section></div>`;
    bindInputs(); document.querySelector('#next').onclick = () => go({ type: 'next' });
  } else if (v.stage === 'submitted') {
    app.innerHTML = `${hero}<section id="submission-success" class="task-card submission-success"><svg class="success-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="#e7f3fa"/><path d="m19 32 9 9 18-19" fill="none" stroke="#1476a5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><h2>已提交</h2><button id="continue">继续</button></section>`;
    document.querySelector('#continue').onclick = () => go({ type: 'continue' });
  } else return false;
  window.scrollTo(0, 0); return true;
}
function bindInputs() {
  app.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => {
    command({ type: 'input', field: input.dataset.field, value: input.value });
    feedback();
    updateTaskProgress();
  }));
}
function feedback() {
  const target = document.querySelector('#feedback'); if (!target) return;
  const values = Object.fromEntries([...app.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value]));
  target.innerHTML = feedbackMarkup(current.feedback, values);
}
function render() {
  clearTimeout(loadingTimer);
  homeEntry.hidden = false;
  history.replaceState(null, '', '/pilot');
  const v = current, task = v.task;
  const modern = task.presentation === 'cards' && v.stage !== 'done';
  document.body.classList.toggle('modern-page', modern);
  if (v.stage === 'done') {
    localStorage.removeItem('a5-pilot1108-session');
    app.innerHTML = `<h1>本次任务已完成，谢谢！</h1><section class="panel interview"><h2>主试访谈提纲</h2><ul><li>第一步算费用选方案，和第二步照着填结果，哪个更需要思考？具体是哪里？</li><li>第二步填写答案时是什么感受？为什么？</li><li>两个任务的第二步界面，你注意到哪些不同？</li><li>这些差异带来了什么不同的作答感受？</li><li>你更希望使用哪种界面，为什么？</li></ul><p class="hint">访谈由主试另行记录；页面不录音。</p><button id="download">下载系统日志 JSON</button><button id="home" class="secondary">返回主试设置</button></section>`;
    document.querySelector('#download').onclick = () => download(v.id);
    document.querySelector('#home').onclick = home; return;
  }
  if (modern && renderCards(v)) return;
  const prefix = modern ? taskHero(v) : `<p class="hint">被试 ${escape(v.participant)} · ${task.practice ? '练习' : '正式任务'} · ${v.trial_number} / ${v.task_count}</p><h1>${escape(task.title)}</h1>`;
  if (v.stage === 'scenario') {
    app.innerHTML = `${prefix}<section class="panel"><h2>情景引入</h2><p>${escape(task.requirements.context)}</p><button id="scenario-next">下一步：阅读任务要求</button></section>`;
    document.querySelector('#scenario-next').onclick = () => go({ type: 'requirements' });
  } else if (v.stage === 'requirements') {
    const requirements = task.requirements;
    const context = requirements?.context ?? (task.practice ? '你今天要筛选展台布置方案。' : '你今天要为活动筛选执行方案。今天13:00—13:45要和同事交接活动资料，14:00还要参加线上评审会。');
    const conditions = taskConditions(task);
    app.innerHTML = `${prefix}<section class="panel"><h2>界面1 · 阅读任务要求</h2>${task.scenarioPage ? '' : `<p>${escape(context)}</p>`}${requirements ? `<p>${escape(requirements.premise)}</p>` : ''}<p>请计算 A、B、C、D 四个方案的总费用，选出同时满足以下三项条件的所有方案：</p><ul>${conditions.map(text => `<li>${escape(text)}</li>`).join('')}</ul><p class="hint">${task.practice ? '请记住比较条件。进入方案资料页后可以返回本页查看要求。' : '筛选条件也会显示在计算页，可随时查看。'}</p><button id="compute">开始计算与筛选</button></section>`;
    document.querySelector('#compute').onclick = () => go({ type: 'compute' });
  } else if (v.stage === 'compute') {
    const selected = v.answers.qualified.toUpperCase();
    const scratchpad = !task.practice && task.scratchpad ? `<section class="panel scratchpad-panel" aria-labelledby="scratchpad-title"><h2 id="scratchpad-title">草稿本</h2><label for="scratchpad" class="hint">可以在这里输入文字、记录数字，草稿不计入答案。</label><textarea id="scratchpad" rows="5" maxlength="5000" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" writingsuggestions="false">${escape(v.scratchpad)}</textarea></section>` : '';
    const materials = `<section class="panel">${table(task)}<button id="requirements" class="secondary">返回任务要求</button></section>`;
    const conditions = task.practice ? '' : `<section id="calculation-conditions" class="panel calculation-conditions" aria-labelledby="calculation-conditions-title"><h3 id="calculation-conditions-title">筛选条件</h3><ul>${taskConditions(task).map(text => `<li>${escape(text)}</li>`).join('')}</ul></section>`;
    app.innerHTML = `${prefix}<h2>界面2 · 算费用、选方案</h2>${conditions}<div class="columns">${scratchpad ? `<div class="materials-column">${materials}${scratchpad}</div>` : materials}<section class="panel">${inputFields(v.answers, ['A', 'B', 'C', 'D'])}<p class="hint">费用请保留两位小数，例如练习题填1.50。</p><fieldset><legend>选择符合要求的方案（可多选）</legend>${['A', 'B', 'C', 'D'].map(f => `<label class="check"><input type="checkbox" value="${f}" ${selected.includes(f) ? 'checked' : ''}>${f}</label>`).join('')}</fieldset><button id="next">下一步</button></section></div>`;
    bindInputs();
    const notebook = document.querySelector('#scratchpad');
    if (notebook) notebook.addEventListener('input', () => command({ type: 'scratchpad', value: notebook.value }));
    app.querySelectorAll('[type=checkbox]').forEach(input => input.onchange = () => command({ type: 'input', field: 'qualified', value: [...app.querySelectorAll('[type=checkbox]:checked')].map(i => i.value).join('、') }));
    document.querySelector('#requirements').onclick = () => go({ type: 'requirements' });
    document.querySelector('#next').onclick = () => go({ type: 'next' });
  } else if (v.stage === 'loading') {
    app.innerHTML = `${prefix}<section id="transcription-loading" class="panel loading-panel" role="status" aria-label="加载中" aria-busy="true"><span class="loading-spinner" aria-hidden="true"></span></section>`;
    loadingTimer = setTimeout(() => go({ type: 'transcribe' }), v.loading_remaining_ms ?? 2000);
  } else if (v.stage === 'transcribe') {
    const originalTitle = task.confirmationTitle ?? '确认活动执行方案';
    const submitTitle = task.practice ? originalTitle : originalTitle.replace(/^确认(?!并提交)/, '确认并提交');
    app.innerHTML = `${prefix}<h2>界面3 · ${task.practice ? '照着结果填写并提交' : escape(submitTitle)}</h2><div class="columns"><section class="panel"><h2>${task.practice ? '刚才的结果' : '方案筛选结果'}</h2><table><thead><tr><th>项目</th><th>结果</th></tr></thead><tbody>${fields.map(f => `<tr><td>${labels[f]}</td><td>${escape(v.source[f])}${f === 'qualified' ? '' : ' 万元'}</td></tr>`).join('')}</tbody></table></section><section class="panel"><h2>${escape(submitTitle)}</h2>${v.feedback ? '<div id="feedback" class="feedback" aria-label="填写进度"></div>' : ''}${inputFields(v.answers)}<p class="hint">合格方案编号可用顿号分隔，例如 A、D。费用单位为万元，请填写两位小数，例如16.97；16.不计为填写完成。</p><button id="next">提交最终结果</button></section></div>`;
    bindInputs(); feedback(); document.querySelector('#next').onclick = () => go({ type: 'next' });
  } else {
    app.innerHTML = `${prefix}<h2>任务后问卷 · 分别回顾两个阶段</h2><form id="ratings" class="panel scale"><p>计算与誊写已全部完成。请分别回顾两个阶段，各评价四项。</p><p class="hint">心理需求、信息整合需求、努力：1完全没有；2很低；3较低；4中等；5较高；6很高；7极高。<br>放松感：1完全不放松；2只有一点点放松；3有些放松；4中等；5比较放松；6很放松；7极其放松。</p>${v.scale_phases.map(phase => `<section class="phase-ratings"><h2>${phase.label}</h2>${phase.items.map(item => `<fieldset><legend>${item.label}</legend><p>${item.question}</p><div class="choices">${Array.from({ length: 7 }, (_, i) => `<label><input required type="radio" name="${phase.key}.${item.key}" value="${i + 1}">${i + 1}</label>`).join('')}</div></fieldset>`).join('')}</section>`).join('')}<button type="submit">提交两个阶段的评价并继续</button></form>`;
    document.querySelector('#ratings').onsubmit = event => {
      event.preventDefault(); const values = { phase1: {}, phase2: {} };
      for (const [name, value] of new FormData(event.currentTarget)) { const [phase, key] = name.split('.'); values[phase][key] = Number(value); }
      go({ type: 'ratings', values });
    };
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
function sessionRows(sessions, deleted = false) {
  return sessions.map(s => `<div class="session"><span>${escape(s.participant)} · ${escape(s.stage)} · ${escape(s.config.order)}</span><span>${deleted ? `<button data-restore="${s.id}" class="secondary">恢复记录</button>` : `<button data-resume="${s.id}" class="secondary">${s.stage === 'done' ? '查看完成页' : '恢复'}</button>`}<button data-export="${s.id}" class="secondary">导出</button>${deleted ? '' : `<button data-delete="${s.id}" data-participant="${escape(s.participant)}" class="danger">删除</button>`}</span></div>`).join('');
}
async function changeRecord(button, id, action) {
  button.disabled = true;
  try {
    await api(`/api/sessions/${id}${action === 'restore' ? '/restore' : ''}`, action === 'restore' ? { method: 'POST', body: '{}' } : { method: 'DELETE' });
    if (action === 'delete' && localStorage.getItem('a5-pilot1108-session') === id) localStorage.removeItem('a5-pilot1108-session');
    await home();
  } catch (error) { showError(error.message); button.disabled = false; }
}
async function home() {
  document.body.classList.remove('modern-page');
  clearTimeout(loadingTimer);
  homeEntry.hidden = true;
  history.replaceState(null, '', '/admin');
  clearError(); save.textContent = ''; current = null;
  try {
    const data = await api('/api/sessions');
    app.innerHTML = `<div class="setup"><h1>11-08 材料 pilot · 主试设置</h1><p>练习 → 两个不同材料的 SH01 任务。本轮不发送任何打断消息。请先完成设置，再交给被试。</p><form id="create" class="panel"><label class="field">被试编号<input name="participant" type="text" required maxlength="40" pattern="[A-Za-z0-9_\\-]+" placeholder="P01"></label><label class="field">条件顺序<select name="order"><option value="auto">按编号平衡（1、2无进度先；3、4有进度先）</option><option value="no-feedback-first">无进度（活动执行）→ 有进度（设备租赁）</option><option value="feedback-first">有进度（设备租赁）→ 无进度（活动执行）</option></select></label><p>每位被试完成一次无进度任务（活动执行）和一次有进度任务（设备租赁）。有进度条件使用三节点任务进度；均誊写本人的计算结果，提交后显示完成图标。练习不显示进度条。</p><p class="hint">P01/P02 无进度先，P03/P04 有进度先；P05起重复四人分配。材料与条件固定配对。允许主试显式覆盖，不强制人数配额。会话创建时固定配置。</p><button type="submit">开始练习</button></form><section class="panel"><h2>已有会话</h2>${sessionRows(data.sessions) || '<p>暂无会话</p>'}</section><details id="deleted-records" class="panel"><summary>已删除记录（${(data.deleted_sessions ?? []).length}）</summary><p class="hint">删除的记录可恢复或导出。同一编号一次只能保留一条未删除记录。</p>${sessionRows(data.deleted_sessions ?? [], true) || '<p>暂无已删除记录</p>'}</details></div>`;
    const form = document.querySelector('#create');
    for (const [key, value] of Object.entries(data.defaults)) if (form.elements[key]) {
      if (typeof value === 'boolean') form.elements[key].checked = value; else form.elements[key].value = value;
    }
    form.onsubmit = async event => {
      event.preventDefault(); clearError(); const button = form.querySelector('button'); button.disabled = true;
      const values = new FormData(form); const config = {};
      if (values.get('order') !== 'auto') config.order = values.get('order');
      try {
        current = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ participant: values.get('participant'), config }) });
        localStorage.setItem('a5-pilot1108-session', current.id); render();
      } catch (error) { showError(error.message); button.disabled = false; }
    };
    app.querySelectorAll('[data-resume]').forEach(button => button.onclick = () => resume(button.dataset.resume));
    app.querySelectorAll('[data-export]').forEach(button => button.onclick = () => download(button.dataset.export));
    app.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => {
      if (confirm(`删除 ${button.dataset.participant} 的这条记录？删除后可在“已删除记录”中恢复，原始数据会保留。`)) return changeRecord(button, button.dataset.delete, 'delete');
    });
    app.querySelectorAll('[data-restore]').forEach(button => button.onclick = () => changeRecord(button, button.dataset.restore, 'restore'));
  } catch (error) { showError(error.message); }
}
async function resume(id) {
  try { current = await api(`/api/sessions/${id}`); localStorage.setItem('a5-pilot1108-session', id); render(); }
  catch (error) { localStorage.removeItem('a5-pilot1108-session'); await home(); showError(error.message); }
}
homeEntry.onclick = async () => {
  clearTimeout(loadingTimer);
  // 等待已排队的输入保存完成，再回设置页；不删除、结束或重置会话。
  homeEntry.disabled = true;
  app.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = true);
  try { await chain; await home(); }
  finally { homeEntry.disabled = false; app.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = false); }
};
const session = localStorage.getItem('a5-pilot1108-session');
if (session && location.pathname === '/pilot') await resume(session); else await home();
