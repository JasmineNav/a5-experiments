import { createHash } from 'node:crypto';
import { readFile, mkdir, access, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { ParticipantConfig, Stimulus } from './contracts.ts';
import { validateConfig } from './config.ts';
import type { TaskContent } from './tasks.ts';
import { experimentRoot, profile, readJson } from './profile.ts';

export { experimentRoot, readJson };

export async function preflight() {
  // 原始材料清单与历史来源预分配只有从Word提取材料的分项（SH）才有；SL直接维护content/。
  const optional = async <T>(relative: string): Promise<T | null> => { try { return await readJson<T>(relative); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  const [pilot, source, material, manifest, tasks] = await Promise.all([
    readJson<ParticipantConfig>('config/participants.pilot.json'),
    optional<ParticipantConfig>('config/participants.source.json'),
    readJson<{ content_version: string; stimuli: Stimulus[] }>('content/stimuli.json'),
    optional<{ files: { path: string; sha256: string }[]; image_count: number; native_table_count: number; embedded_workbook_count?: number; sheet_names: string[] }>('content/source/manifest.json'),
    readJson<TaskContent>('content/tasks.json'),
  ]);
  const pilotErrors = validateConfig(pilot, material.stimuli);
  // participants.source.json 是原工作簿（V1，5组）的历史来源，V2起不再作为可用预分配校验。
  const sourceStages = new Set((source?.participants ?? []).flatMap(p => p.stages.map(s => s.stage_id)));
  const materialErrors: string[] = [];
  if (tasks.stages.length !== 7 || tasks.stages.some(s => s.units.length !== 2)) materialErrors.push('任务配置必须为7组14单元。');
  const rest = tasks.in_unit_rest;
  // 显示端 1000—60000ms 任意整数时长；默认 11000，改值只需改 content/tasks.json。
  if (!Number.isInteger(tasks.message_duration_ms) || tasks.message_duration_ms < 1000 || tasks.message_duration_ms > 60000) materialErrors.push('消息目标时长必须是 1000—60000 的整数毫秒。');
  if (!rest || !(rest.duration_ms > 0) || !(rest.tutorial_duration_ms > 0) || !(rest.t2_delay_ms >= 0 && rest.t2_delay_ms < rest.duration_ms) || !(rest.window_min_ms >= 0) || Object.values(rest.window_min_ms_by_stage ?? {}).some(v => !(v >= 0)) || !rest.reminder_text || !rest.early_click_text) materialErrors.push('第二单元休息配置缺失或无效：需正的休息时长，T2延迟须小于休息时长，窗口下限不能为负。');
  if (tasks.practice) {
    const units = tasks.practice.units;
    if (units.map(u => u.unit_id).join() !== 'PRACTICE_U1,PRACTICE_U2' || !!units[0].reveal !== profile.attachments || units[1].reveal) materialErrors.push(profile.attachments ? '练习任务必须为PRACTICE_U1（含附件）和PRACTICE_U2（无附件）。' : '练习任务必须为PRACTICE_U1和PRACTICE_U2，且都没有附件。');
    if (!(rest?.practice_window_min_ms! >= 0) || !(rest?.practice_duration_ms! > 0)) materialErrors.push('练习休息的窗口下限或时长无效。');
    for (const unit of units) {
      if (!unit.fields.length || unit.fields.some(f => !f.required) || !['exact', 'items'].includes(unit.scoring.type)) materialErrors.push(`${unit.unit_id}必须配置完整必答字段和参考答案。`);
      if (unit.reveal && !unit.paragraphs.some(p => p.includes(`《${unit.reveal!.button_label}》`))) materialErrors.push(`${unit.unit_id}题干必须按文件名引用附件。`);
      for (const table of [...(unit.tables ?? []), ...(unit.reveal?.tables ?? [])]) {
        if ((profile.attachments && !table.caption) || typeof table.caption !== 'string' || !table.columns.length || !table.rows.length || table.rows.some(row => row.length !== table.columns.length)) materialErrors.push(`${unit.unit_id}文本表格结构无效。`);
      }
    }
  }
  for (const stage of tasks.stages) for (const unit of stage.units) {
    if (!unit.fields.length || unit.fields.some(f => !f.required)) materialErrors.push(`${unit.unit_id}必须配置完整必答字段。`);
    for (const table of [...(unit.tables ?? []), ...(unit.reveal?.tables ?? [])]) {
      if ((profile.attachments && !table.caption) || typeof table.caption !== 'string' || !table.columns.length || !table.rows.length || table.rows.some(row => row.length !== table.columns.length)) materialErrors.push(`${unit.unit_id}文本表格结构无效。`);
    }
    for (const asset of [...unit.assets, ...(unit.reveal?.assets ?? [])]) {
      if (!/^image\d+\.png$/.test(asset.id)) materialErrors.push(`${unit.unit_id}原图标识非法。`);
      else await access(join(experimentRoot, 'content/source/assets', asset.id), constants.R_OK);
    }
  }
  for (const file of manifest?.files ?? []) {
    const hash = createHash('sha256').update(await readFile(join(experimentRoot, file.path))).digest('hex');
    if (hash !== file.sha256) materialErrors.push(`${file.path} 已变更，请重新提取并核对材料。`);
  }
  for (const directory of ['runtime', 'exports']) {
    const path = join(experimentRoot, directory);
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    const probe = join(path, `.write-probe-${process.pid}-${crypto.randomUUID()}`);
    try { await writeFile(probe, '', { flag: 'wx' }); } finally { await unlink(probe).catch(() => {}); }
  }
  return {
    repository: 'a5-experiments',
    experiment_id: profile.experiment_id,
    phase: 'core',
    startup_ok: pilotErrors.length === 0 && materialErrors.length === 0,
    software_flow_ready: pilotErrors.length === 0 && materialErrors.length === 0,
    pilot_ready: false,
    content_version: tasks.content_version,
    stimulus_version: material.content_version,
    materials: { source_files: manifest?.files.length ?? 0, native_tables: manifest?.native_table_count ?? 0, embedded_images: manifest?.image_count ?? 0, embedded_workbooks: manifest?.embedded_workbook_count ?? 0,
      text_tables: tasks.stages.reduce((sum, s) => sum + s.units.reduce((n, u) => n + (u.tables?.length ?? 0) + (u.reveal?.tables?.length ?? 0), 0), 0), sheets: manifest?.sheet_names ?? [], sh_stimuli: material.stimuli.length },
    pilot_participants: pilot.participants.map(p => p.participant_id),
    pilot_errors: pilotErrors,
    source_config_errors: [] as string[],
    source_config_note: source ? `participants.source.json 为原工作簿历史来源（${source.participants.length}人、${sourceStages.size}组），V2不再用于创建会话。` : '本分项没有历史来源预分配。',
    material_errors: materialErrors,
    remaining: profile.remaining ?? ['雷鸟显示端真机部署与实际硬件呈现验证', '统一30秒休息窗口的现场使用效果验证', '新版任务材料的实际耗时与负荷复测', 'Windows现场实机验证'],
  };
}
