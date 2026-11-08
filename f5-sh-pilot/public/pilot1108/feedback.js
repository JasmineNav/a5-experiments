/** 纯呈现函数：登记完成度，不判分；没有动画或声音。 */
export const fields = ['qualified', 'A', 'B', 'C', 'D'];
export const labels = { qualified: '合格方案编号', A: 'A方案总费用', B: 'B方案总费用', C: 'C方案总费用', D: 'D方案总费用' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function feedbackMarkup(kind, values) {
  const filled = fields.filter(f => values[f]?.trim());
  // 纯登记状态，不按答案正确与否提供反馈。清空字段立即回退；无动画、无提示音。
  const notice = '<p class="hint">仅表示已填写，不表示答案正确。</p>';
  if (kind === 'progress') {
    return `<strong>已登记 ${filled.length} / 5 项</strong><div class="segments" role="progressbar" aria-label="结果登记完成度" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${filled.length}">${fields.map((_, i) => `<span class="segment ${i < filled.length ? 'filled' : ''}"></span>`).join('')}</div>${notice}`;
  } else if (kind === 'registered') {
    return `<strong>登记结果</strong><ul class="registered">${fields.map(f => `<li class="${filled.includes(f) ? 'filled' : ''}">${filled.includes(f) ? '✓' : '○'} ${labels[f]}：${filled.includes(f) ? escape(values[f]) : '待登记'}</li>`).join('')}</ul>${notice}`;
  } else {
    return `<strong>登记状态</strong><div>${filled.map(f => `<p>${labels[f]}已完成</p>`).join('') || '<p>尚未登记结果</p>'}</div>${notice}`;
  }
}
