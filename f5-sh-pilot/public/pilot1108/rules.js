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
export const progressModes = ['substeps-v1', 'substeps-v2'];
export const isSubstepProgress = mode => progressModes.includes(mode);
/**
 * 两段进度分别分配50%；提交段为五项填写及最终提交保留六个子步骤。
 * substeps-v2（R11起）：计算页每项9%，五项完整只到45%，点「下一步」进入加载后才到50%并点亮「完成筛选」。
 * substeps-v1：R8—R10旧快照每项10%，五项完整即50%，保留原计法。
 */
export function taskProgress(stage, answers, mode = 'substeps-v1') {
  const filled = filledState(answers), completed = Object.values(filled).filter(Boolean).length;
  const submitted = ['submitted', 'ratings', 'done'].includes(stage);
  const phase2 = stage === 'transcribe';
  const perField = mode === 'substeps-v2' ? 9 : 10;
  const value = submitted ? 100 : phase2 ? 50 + completed * 50 / 6
    : stage === 'loading' ? 50 : stage === 'scenario' ? 0 : completed * perField;
  return { mode: mode === 'substeps-v2' ? 'substeps-v2' : 'substeps-v1', value, filled, completed, submitted, means_correct: false };
}
