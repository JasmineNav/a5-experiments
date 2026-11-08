import { fields, filledState } from './rules.js';
export { fields } from './rules.js';
export const labels = { qualified: '合格方案编号', A: 'A方案总费用', B: 'B方案总费用', C: 'C方案总费用', D: 'D方案总费用' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 固定位置、固定标签的五节点；节点按字段判定，连线至最右已填节点。 */
export function feedbackMarkup(kind, values) {
  if (kind !== 'progress') return '';
  const filled = filledState(values);
  const count = fields.filter(f => filled[f]).length;
  const last = fields.reduce((result, field, index) => filled[field] ? index : result, -1);
  return `<strong>填写进度</strong><div class="progress-nodes" role="group" aria-label="填写进度，已填写${count}项，共5项">${fields.map((field, index) => `<div class="progress-node ${filled[field] ? 'filled' : ''}" data-node="${field}" aria-label="${field === 'qualified' ? '方案' : field}：${filled[field] ? '已填写' : '未填完整'}"><span class="node-dot" aria-hidden="true"></span><span class="node-label">${field === 'qualified' ? '方案' : field}</span>${index < 4 ? `<span class="node-line ${index < last ? 'filled' : ''}" aria-hidden="true"></span>` : ''}</div>`).join('')}</div><p class="hint">仅表示填写格式完整，不表示答案正确。</p>`;
}
