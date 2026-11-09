/** 浏览器与服务器共用的填写判定；只检查格式，不判断答案正确性。 */
export const fields = ['qualified', 'A', 'B', 'C', 'D'];
export function feeFilled(value) {
  return typeof value === 'string' && /^\d+\.\d{2}$/.test(value.trim()) && Number.isFinite(Number(value));
}
export function planSelection(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  if (!/^[ABCD\s,，、;；]+$/.test(text)) return null;
  const selected = [...new Set(text.replace(/[^ABCD]/g, '').split(''))].sort();
  return selected.length ? selected : null;
}
export function filledState(answers) {
  return Object.fromEntries(fields.map(field => [field, field === 'qualified' ? planSelection(answers[field]) !== null : feeFilled(answers[field])]));
}
/** 两段进度分别分配50%；提交段为五项填写及最终提交保留六个子步骤。 */
export function taskProgress(stage, answers) {
  const filled = filledState(answers), completed = Object.values(filled).filter(Boolean).length;
  const submitted = ['submitted', 'ratings', 'done'].includes(stage);
  const phase2 = stage === 'transcribe';
  const value = submitted ? 100 : phase2 ? 50 + completed * 50 / 6
    : stage === 'loading' ? 50 : stage === 'scenario' ? 0 : completed * 10;
  return { mode: 'substeps-v1', value, filled, completed, submitted, means_correct: false };
}
