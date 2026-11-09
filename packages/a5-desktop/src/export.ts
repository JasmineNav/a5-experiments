import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Engine } from './engine.ts';
import { HttpError } from './engine.ts';
import type { EventRecord, Intervention, Session } from './store.ts';
import type { Snapshot } from './tasks.ts';
import type { Participant } from './contracts.ts';

type Row = Record<string, unknown>;
function csv(headers: string[], rows: Row[]) {
  const cell = (v: unknown) => {
    if (v === undefined || v === null) return '';
    let text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [headers.map(cell).join(','), ...rows.map(row => headers.map(h => cell(row[h])).join(','))].join('\r\n') + '\r\n';
}
const timestamp = (event?: EventRecord) => event?.timestamp_iso ?? null;
const elapsed = (event?: EventRecord) => event?.elapsed_ms ?? null;
const last = <T>(array: T[]) => array[array.length - 1];
const formal = (e: EventRecord) => !e.data_kind || e.data_kind === 'formal';
const diff = (to?: number | null, from?: number | null) => typeof to === 'number' && typeof from === 'number' ? to - from : null;
const clientFields = (client: unknown) => {
  const c = client && typeof client === 'object' ? client as Row : null;
  return { client_timestamp_iso: c?.timestamp_iso ?? null, client_monotonic_ms: c?.monotonic_ms ?? null, client_time_origin_ms: c?.time_origin_ms ?? null, client_visibility_state: c?.visibility_state ?? null };
};
/** 仅在同一设备 clock_id 内计算设备事件间隔，不跨设备换算。 */
function deviceDuration(message: Intervention, from: string, to: string) {
  const a = message.device_events?.find(e => e.kind === from), b = message.device_events?.find(e => e.kind === to);
  return a && b && a.clock_id === b.clock_id && b.device_monotonic_ms >= a.device_monotonic_ms ? b.device_monotonic_ms - a.device_monotonic_ms : null;
}
/** 本组任务单元中、在某服务端时刻之后的第一次作答变化（不含理解题/量表页）。 */
function firstAnswerAfter(events: EventRecord[], unitIds: string[], after?: number | null) {
  if (typeof after !== 'number') return null;
  const next = events.find(e => e.event_type === 'answer_changed' && formal(e) && e.unit_id !== null && unitIds.includes(e.unit_id) && e.elapsed_ms >= after);
  return next ? next.elapsed_ms - after : null;
}

type Capture = { session: Session; events: EventRecord[]; interventions: Intervention[] };
type Stage = Snapshot['content']['stages'][number];
/** 每组一行：rests.csv（仅V2快照）与 stage_summary.csv（全部快照）。未知值留空，不伪造。 */
function stageRows(c: Capture, stage: Stage, assignment: Participant['stages'][number], common: Row, unitRows: Record<string, Row>,
  comp: EventRecord | undefined, ratings: EventRecord | undefined, ratingsSkipped: EventRecord | undefined, rests: Row[], stageSummary: Row[]) {
  const s = c.session, config = s.snapshot.content.in_unit_rest, stageId = stage.stage_id;
  const ev = c.events.filter(e => formal(e) && e.stage_id === stageId);
  const first = (type: string, match: (e: EventRecord) => boolean = () => true) => ev.find(e => e.event_type === type && match(e));
  const unitIds = stage.units.map(u => u.unit_id), u1Id = stage.units[0]?.unit_id, u2Id = stage.units[1]?.unit_id;
  const isT2 = assignment.condition.endsWith('T2');
  const message = c.interventions.find(m => (!m.data_kind || m.data_kind === 'formal') && m.stage_id === stageId);
  // 设备事件：服务端接收时刻即事件 elapsed_ms；payload.evidence 为设备原始时钟，不与服务器时间相减。
  const drawn = message ? c.events.find(e => e.event_type === 'message_device_drawn' && e.payload.request_id === message.request_id) : undefined;
  const hidden = message ? c.events.find(e => e.event_type === 'message_device_hidden' && e.payload.request_id === message.request_id) : undefined;
  const noticeClick = message ? c.events.find(e => e.event_type === 'notice_read_clicked' && e.payload.disposition === 'confirmation_requested' && e.payload.confirmation_request_id === message.request_id) : undefined;
  const compShown = first('comprehension_displayed');
  const compSkipped = first('comprehension_skipped');
  const t2Missing = first('t2_not_triggered');
  const u2Shown = first('u2_displayed');
  const u2Submit = first('submission_recorded', e => e.unit_id === u2Id);
  const request = first('rest_clicked', e => e.payload.disposition === 'rest_requested');
  const restId = request?.payload.rest_id ?? null;
  const ofRest = (type: string) => restId === null ? undefined : first(type, e => e.payload.rest_id === restId);
  const started = ofRest('rest_started'), ended = ofRest('rest_ended'), interrupted = ofRest('rest_interrupted'), countdown = ofRest('rest_countdown_ended');
  const notTaken = first('rest_not_taken');
  const restStatus = !config ? null : ended ? 'rested' : interrupted ? 'interrupted' : request ? 'in_progress' : notTaken ? 'not_rested' : u2Shown ? 'u2_in_progress' : 'not_reached';
  const windowMs = config ? config.window_min_ms_by_stage?.[stageId] ?? config.window_min_ms : null;
  const windowOpen = u2Shown && windowMs !== null ? u2Shown.elapsed_ms + windowMs : null;
  const resumeAfterRest = firstAnswerAfter(c.events, unitIds, ended?.elapsed_ms);
  const t2Planned = ofRest('rest_t2_planned'), t2Due = ofRest('rest_t2_due');
  const t2Status = !isT2 ? 'not_applicable' : message ? (['failed', 'not_sent'].includes(message.status) ? message.status : 'sent') : t2Missing ? 'not_triggered' : 'pending';
  if (config) {
    const clicks = ev.filter(e => e.event_type === 'rest_clicked'), reminders = ev.filter(e => e.event_type === 'rest_reminder_sent');
    rests.push({ ...common, stage_id: stageId, condition: assignment.condition, message_id: assignment.message_id, rest_status: restStatus, rest_id: restId,
      after_reminder: started?.payload.after_reminder ?? null, reminder_count: reminders.length, first_reminder_at: timestamp(reminders[0]), first_reminder_elapsed_ms: elapsed(reminders[0]),
      u2_displayed_at: timestamp(u2Shown), u2_displayed_elapsed_ms: elapsed(u2Shown), window_min_ms: windowMs, window_open_elapsed_ms: windowOpen,
      click_count: clicks.length, early_click_count: clicks.filter(e => e.payload.disposition === 'too_early').length,
      repeat_click_count: clicks.filter(e => e.payload.disposition === 'already_resting' || e.payload.disposition === 'already_rested').length,
      first_click_at: timestamp(clicks[0]), first_click_elapsed_ms: elapsed(clicks[0]), first_click_disposition: clicks[0]?.payload.disposition ?? null,
      first_click_from_u2_ms: diff(clicks[0]?.elapsed_ms, u2Shown?.elapsed_ms),
      rest_requested_at: timestamp(request), rest_requested_elapsed_ms: elapsed(request),
      rest_started_at: timestamp(started), rest_started_elapsed_ms: elapsed(started), rest_start_client: started?.payload.client ?? null,
      start_from_u2_ms: diff(started?.elapsed_ms, u2Shown?.elapsed_ms), start_from_window_open_ms: diff(started?.elapsed_ms, windowOpen),
      start_to_u2_submit_ms: diff(u2Submit?.elapsed_ms, started?.elapsed_ms),
      answered_fields_at_start: started?.payload.answered_fields ?? null, total_fields: started?.payload.total_fields ?? null,
      answer_snapshot_at_start: started?.payload.answer_snapshot ?? null, scratchpad_length_at_start: started?.payload.scratchpad_length ?? null,
      countdown_ended_elapsed_ms: countdown?.payload.countdown_ended_elapsed_ms ?? ended?.payload.countdown_ended_elapsed_ms ?? null,
      rest_returned_at: timestamp(ended), rest_returned_elapsed_ms: elapsed(ended), rest_return_client: ended?.payload.client ?? null,
      planned_rest_ms: started?.payload.duration_ms ?? ended?.payload.planned_rest_ms ?? null, actual_rest_ms: ended?.payload.actual_rest_ms ?? null,
      paused_during_rest: ended?.payload.paused_during ?? null, paused_ms: ended?.payload.paused_ms ?? null,
      interrupted_at: timestamp(interrupted), interrupt_reason: interrupted?.payload.reason ?? null,
      u2_submitted_at: timestamp(u2Submit), u2_submitted_elapsed_ms: elapsed(u2Submit), resume_answer_after_rest_ms: resumeAfterRest,
      t2_status: t2Status, t2_planned_elapsed_ms: t2Planned?.payload.planned_elapsed_ms ?? null, t2_due_elapsed_ms: elapsed(t2Due) ?? null,
      t2_actual_delay_ms: t2Due?.payload.actual_delay_ms ?? null, t2_request_id: isT2 ? message?.request_id ?? null : null,
      t2_failure_reason: isT2 && ['failed', 'not_sent'].includes(message?.status ?? '') ? message!.error ?? null : null });
  }
  const u1 = u1Id ? unitRows[u1Id] : undefined, u2 = u2Id ? unitRows[u2Id] : undefined;
  stageSummary.push({ ...common, stage_id: stageId, condition: assignment.condition, message_id: assignment.message_id, timing: assignment.condition.split('-')[1] ?? null,
    message_status: assignment.condition === 'NONE' ? 'none' : message ? message.status : t2Missing ? 't2_not_triggered' : 'not_triggered',
    t2_not_triggered: !!t2Missing, send_failed: ['failed', 'not_sent'].includes(message?.status ?? ''), message_request_id: message?.request_id ?? null, message_error: message?.error ?? null,
    message_event_elapsed_ms: message?.event_elapsed_ms ?? null, message_drawn_received_elapsed_ms: elapsed(drawn), message_hidden_received_elapsed_ms: elapsed(hidden),
    rest_status: restStatus, rest_started_elapsed_ms: elapsed(started), rest_start_from_u2_ms: diff(started?.elapsed_ms, u2Shown?.elapsed_ms),
    rest_answered_fields_at_start: started?.payload.answered_fields ?? null, rest_total_fields: started?.payload.total_fields ?? null,
    rest_after_reminder: started?.payload.after_reminder ?? null, rest_reminder_count: config ? ev.filter(e => e.event_type === 'rest_reminder_sent').length : null,
    message_trigger_minus_rest_start_ms: diff(message?.event_elapsed_ms, started?.elapsed_ms),
    message_notice: comp?.payload.message_notice ?? null, comprehension_correct: comp?.payload.correct ?? null,
    comprehension_skipped: !!compSkipped, comprehension_skip_reason: compSkipped?.payload.reason ?? null,
    ratings_status: ratings ? 'submitted' : ratingsSkipped ? 'skipped' : 'pending', ratings_skipped: !!ratingsSkipped, ratings_skip_reason: ratingsSkipped?.payload.reason ?? null,
    notice_click_after_drawn_ms: diff(noticeClick?.elapsed_ms, drawn?.elapsed_ms),
    device_confirmation_delay_ms: message ? deviceDuration(message, 'drawn', 'confirmed') : null,
    message_trigger_to_comprehension_ms: diff(compShown?.elapsed_ms, message?.event_elapsed_ms),
    message_drawn_to_comprehension_ms: diff(compShown?.elapsed_ms, drawn?.elapsed_ms),
    resume_answer_after_message_ms: firstAnswerAfter(c.events, unitIds, hidden?.elapsed_ms),
    resume_answer_after_rest_ms: resumeAfterRest,
    u1_score: u1?.score ?? null, u1_completion_ms: u1?.completion_ms ?? null, u2_score: u2?.score ?? null, u2_completion_ms: u2?.completion_ms ?? null });
}

export async function exportData(engine: Engine, ids: string[], outputRoot: string) {
  const captures = ids.map(id => {
    if (engine.session(id).state.deleted) throw new HttpError(410, '此会话记录已删除，请先恢复记录再导出。');
    const summary = engine.summary(id);
    return { session: engine.session(id), events: engine.store.events(id), interventions: engine.store.interventions(id), summary };
  });
  const events = captures.flatMap(c => c.events);
  const trials: Row[] = [], surveys: Row[] = [], breaks: Row[] = [], notes: Row[] = [], sessions: Row[] = [], interventions: Row[] = [];
  const rests: Row[] = [], restClicks: Row[] = [], restReminders: Row[] = [], stageSummary: Row[] = [];
  for (const c of captures) {
    const { session: s } = c; const participant = s.snapshot.participant;
    const common = { session_id: s.id, participant_id: participant.participant_id, is_debug: engine.isDebug(s), version_label: participant.version_label ?? '', content_version: s.snapshot.content.content_version };
    const intro = c.events.find(e => e.event_type === 'intro_displayed'); const introEnd = c.events.find(e => e.event_type === 'intro_continue');
    const tutorialStart=c.events.find(e=>e.event_type==='tutorial_intro_displayed'), tutorialEnd=c.events.find(e=>e.event_type==='tutorial_completed');
    sessions.push({ ...common, tutorial_started_at:timestamp(tutorialStart),tutorial_completed_at:timestamp(tutorialEnd),tutorial_duration_ms:tutorialStart&&tutorialEnd?tutorialEnd.elapsed_ms-tutorialStart.elapsed_ms:null,tutorial_answer_attempts:c.events.filter(e=>e.event_type==='tutorial_answer_submitted').length, ...c.summary, device_source: (c.events.find(e => e.event_type === 'session_created')?.payload.adapter as { source?: string })?.source,
      stimulus_version: s.snapshot.stimulus_version, content_hash: s.snapshot.content_hash,
      experiment_commit: s.snapshot.run_versions?.experiment_commit ?? null, experiment_dirty: s.snapshot.run_versions?.experiment_dirty ?? null,
      display_base_tag: s.snapshot.run_versions?.display_base_tag ?? null, display_base_commit: s.snapshot.run_versions?.display_base_commit ?? null,
      display_apk_sha256: s.snapshot.run_versions?.installed_apk_sha256 ?? null, display_apk_sha256_pinned: s.snapshot.run_versions?.display_apk_sha256_pinned ?? null,
      display_app_version: s.snapshot.run_versions?.app_version ?? null, intro_displayed: timestamp(intro), intro_continue: timestamp(introEnd), intro_duration_ms: intro && introEnd ? introEnd.elapsed_ms - intro.elapsed_ms : null,
      resume_count: c.events.filter(e => e.event_type === 'app_resumed').length, anomaly_count: s.state.attention.length,
      breaks_skipped: c.events.filter(e => e.event_type === 'break_skipped').length,
      rests_taken: c.events.filter(e => formal(e) && e.event_type === 'rest_started').length,
      rests_after_reminder: c.events.filter(e => formal(e) && e.event_type === 'rest_started' && e.payload.after_reminder === true).length,
      reminders_sent: c.events.filter(e => e.event_type === 'rest_reminder_sent').length,
      t2_not_triggered_count: c.events.filter(e => e.event_type === 't2_not_triggered').length, debug_jumps: c.events.filter(e => e.event_type === 'debug_jump').length });
    for (const stage of s.snapshot.content.stages) {
      const assignment = participant.stages.find(a => a.stage_id === stage.stage_id)!;
      const unitRows: Record<string, Row> = {};
      for (const unit of stage.units) {
        const unitEvents = c.events.filter(e => e.unit_id === unit.unit_id);
        const displayed = unitEvents.find(e => e.event_type === 'unit_displayed');
        const submission = unitEvents.find(e => e.event_type === 'submission_recorded');
        if (!unitEvents.length) continue;
        const edits = unitEvents.filter(e => e.event_type === 'answer_changed');
        const revealClick = unitEvents.find(e => e.event_type === 'reveal_clicked' && e.payload.open === true);
        const reveal = unitEvents.find(e => e.event_type === 'reveal_displayed'); const f = unitEvents.find(e => e.event_type === 'F_candidate');
        trials.push(unitRows[unit.unit_id] = { ...common, stage_id: stage.stage_id, unit_id: unit.unit_id, condition: assignment.condition,
          page_displayed: timestamp(displayed), page_displayed_elapsed_ms: elapsed(displayed), client_display_evidence: displayed?.payload.client ?? null,
          e_clicked: timestamp(revealClick), e_displayed: timestamp(reveal), e_elapsed_ms: elapsed(reveal), f_submitted: timestamp(f), f_semantics: f?.payload.semantics ?? null,
          first_answer: timestamp(edits[0]), last_answer: timestamp(last(edits)), first_answer_elapsed_ms: elapsed(edits[0]), last_answer_elapsed_ms: elapsed(last(edits)),
          submitted: timestamp(submission), submitted_elapsed_ms: elapsed(submission), raw_answer: submission?.payload.raw_answer ?? null, normalized_answer: submission?.payload.normalized_answer ?? null,
          score: unitEvents.find(e => e.event_type === 'unit_scored')?.payload.score ?? null,
          max_score: unitEvents.find(e => e.event_type === 'unit_scored')?.payload.max_score ?? null, item_results: unitEvents.find(e => e.event_type === 'unit_scored')?.payload.item_results ?? null,
          completion_ms: displayed && submission ? submission.elapsed_ms - displayed.elapsed_ms : null, submission_attempts: unitEvents.filter(e => e.event_type === 'submit_clicked').length,
          scratchpad_text: s.state.scratchpads?.[unit.unit_id] ?? '', scratchpad_changes: unitEvents.filter(e => e.event_type === 'scratchpad_changed').length });
      }
      const comp = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'comprehension_submitted');
      const ratings = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'ratings_submitted');
      const ratingsSkipped = c.events.find(e => e.stage_id === stage.stage_id && e.event_type === 'ratings_skipped');
      if (comp || ratings) surveys.push({ ...common, stage_id: stage.stage_id, condition: assignment.condition, message_id: assignment.message_id,
        message_notice: comp?.payload.message_notice ?? null,
        comprehension_answer: comp?.payload.answer ?? null, comprehension_correct: comp?.payload.correct ?? null, comprehension_submitted: timestamp(comp),
        ratings_status: ratings ? 'submitted' : ratingsSkipped ? 'skipped' : 'pending',
        ratings_skip_reason: ratingsSkipped?.payload.reason ?? null, ratings_skipped_at: timestamp(ratingsSkipped),
        ...(ratings?.payload.ratings as Row ?? {}), ratings_submitted: timestamp(ratings) });
      stageRows(c, stage, assignment, common, unitRows, comp, ratings, ratingsSkipped, rests, stageSummary);
    }
    for (const displayed of c.events.filter(e => e.event_type === 'break_displayed')) {
      const breakId = displayed.payload.page_token;
      const related = c.events.filter(e => breakId && e.payload.break_id === breakId);
      const started = related.find(e => e.event_type === 'break_started');
      const completed = related.find(e => e.event_type === 'break_completed');
      const continued = related.find(e => e.event_type === 'continue_clicked');
      const skipped = related.find(e => e.event_type === 'break_skipped');
      const finish = continued ?? skipped;
      breaks.push({ ...common, break_id: breakId, stage_id: displayed.stage_id, condition: displayed.condition,
        planned_rest_ms: started?.payload.duration_ms ?? s.snapshot.content.break_ms,
        displayed_at: displayed.timestamp_iso, displayed_elapsed_ms: displayed.elapsed_ms, display_client: displayed.payload.client ?? null,
        countdown_ended_at: completed?.payload.countdown_ended_at ?? null,
        countdown_ended_elapsed_ms: completed?.payload.countdown_ended_elapsed_ms ?? null, completion_observed_at: timestamp(completed),
        continue_clicked_at: timestamp(continued), continue_clicked_elapsed_ms: elapsed(continued), continue_client: continued?.payload.client ?? null,
        actual_rest_ms: finish?.payload.actual_rest_ms ?? null,
        ended_by: continued ? 'continue' : skipped ? 'skip' : null,
        skipped_at: timestamp(skipped), skip_actor: skipped?.payload.actor ?? null, skip_reason: skipped?.payload.reason ?? null,
        remaining_at_skip_ms: skipped?.payload.remaining_ms ?? null });
    }
    for (const e of c.events.filter(e => e.event_type === 'rest_reminder_sent')) {
      const id = e.payload.reminder_id;
      const shown = c.events.find(x => x.event_type === 'rest_reminder_displayed' && x.payload.reminder_id === id);
      const restAfter = c.events.find(x => formal(x) && x.event_type === 'rest_started' && x.stage_id === e.stage_id && x.elapsed_ms >= e.elapsed_ms);
      restReminders.push({ ...common, stage_id: e.stage_id, unit_id: e.unit_id, condition: e.condition, reminder_id: id, reminder_index: e.payload.reminder_index ?? null,
        sent_at: e.timestamp_iso, sent_elapsed_ms: e.elapsed_ms, text: e.payload.text ?? null, reason: e.payload.reason ?? null, u2_elapsed_ms: e.payload.u2_elapsed_ms ?? null,
        display_ms: e.payload.display_ms ?? null, displayed_at: timestamp(shown), displayed_elapsed_ms: elapsed(shown), display_client: shown?.payload.client ?? null,
        rest_started_after: !!restAfter, rest_id_after: restAfter?.payload.rest_id ?? null, sent_to_rest_start_ms: restAfter ? restAfter.elapsed_ms - e.elapsed_ms : null });
    }
    for (const e of c.events.filter(e => e.event_type === 'rest_clicked')) restClicks.push({ ...common, data_kind: e.data_kind ?? 'formal', event_id: e.event_id, timestamp_iso: e.timestamp_iso, elapsed_ms: e.elapsed_ms,
      stage_id: e.stage_id, unit_id: e.unit_id, condition: e.condition, rest_key: e.payload.rest_key ?? null, rest_id: e.payload.rest_id ?? null, disposition: e.payload.disposition ?? null,
      u2_elapsed_ms: e.payload.u2_elapsed_ms ?? null, window_min_ms: e.payload.window_min_ms ?? null, window_open: e.payload.window_open ?? null,
      reminder_count: e.payload.reminder_count ?? null, ...clientFields(e.payload.client), client: e.payload.client ?? null });
    for (const e of c.events.filter(e => e.event_type === 'note_saved')) notes.push({ ...common, ...e.payload, saved_at: e.timestamp_iso, elapsed_ms: e.elapsed_ms });
    for (const message of c.interventions) {
      const deviceEvent = (kind: string) => message.device_events?.find(e => e.kind === kind);
      const duration = (from: string, to: string) => deviceDuration(message, from, to);
      const sent = message.t_send ? Date.parse(message.t_send) : null;
      const ack = message.t_ack ? Date.parse(message.t_ack) : null;
      const displayed = message.t_display ? Date.parse(message.t_display) : null;
      interventions.push({ ...common, ...message, data_kind:message.data_kind??'formal', timing: message.condition.split('-')[1], latency_baseline: 't_event', latency_unit: 'ms',
        display_mode: message.display_mode ?? s.snapshot.display_mode ?? 'legacy_8500',
        auto_hide_after_ms: (message.display_mode ?? s.snapshot.display_mode) === 'confirm_until_ack' ? null : message.duration_ms,
        device_drawn_wall_ms: deviceEvent('drawn')?.device_wall_ms ?? null, device_drawn_monotonic_ms: deviceEvent('drawn')?.device_monotonic_ms ?? null,
        device_hidden_wall_ms: deviceEvent('hidden')?.device_wall_ms ?? null, device_hidden_monotonic_ms: deviceEvent('hidden')?.device_monotonic_ms ?? null,
        hide_reason: deviceEvent('hidden')?.hide_reason ?? null,
        device_confirmed_wall_ms: deviceEvent('confirmed')?.device_wall_ms ?? null, device_confirmed_monotonic_ms: deviceEvent('confirmed')?.device_monotonic_ms ?? null,
        cue_status: deviceEvent('cue_failed') ? 'failed' : deviceEvent('cue_started') ? 'started' : message.display_mode === 'tone_8500' ? 'unverified' : 'not_required',
        confirmation_recorded: !!message.confirmation_requested_at, device_confirmation_recorded: !!deviceEvent('confirmed'),
        device_confirmation_delay_ms: duration('drawn', 'confirmed'), actual_display_duration_ms: duration('drawn', 'hidden'), post_confirmation_duration_ms: duration('confirmed', 'hidden'),
        send_latency_ms: sent === null ? null : sent - Date.parse(message.t_event), acknowledgement_latency_ms: sent !== null && ack !== null ? ack - sent : null,
        display_latency_ms: displayed === null ? null : displayed - Date.parse(message.t_event) });
    }
  }
  const rowCounts = { events: events.length, trials: trials.length, interventions: interventions.length, surveys: surveys.length, breaks: breaks.length, sessions: sessions.length, notes: notes.length,
    rests: rests.length, rest_clicks: restClicks.length, rest_reminders: restReminders.length, stage_summary: stageSummary.length };
  const files: Record<string, string> = {
    'notice_clicks.csv': csv(['session_id','participant_id','is_debug','data_kind','event_id','timestamp_iso','elapsed_ms','stage_id','unit_id','condition','click_id','disposition','pending_request_id','confirmation_request_id','phase','page_token','page_token_matches','visible_request_id','client_timestamp_iso','client_monotonic_ms','client_time_origin_ms','client_visibility_state','client'],events.filter(e=>e.event_type==='notice_read_clicked').map(e=>({...e,...e.payload,client_timestamp_iso:(e.payload.client as Row|null)?.timestamp_iso??null,client_monotonic_ms:(e.payload.client as Row|null)?.monotonic_ms??null,client_time_origin_ms:(e.payload.client as Row|null)?.time_origin_ms??null,client_visibility_state:(e.payload.client as Row|null)?.visibility_state??null}))),
    'tutorial.csv': csv(['session_id','participant_id','data_kind','event_id','event_type','timestamp_iso','elapsed_ms','payload'],events.filter(e=>e.data_kind==='tutorial').map(e=>({...e,data_kind:'tutorial'}))),
    'events.jsonl': events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    'rests.csv': csv(['session_id','participant_id','is_debug','version_label','stage_id','condition','message_id','rest_status','rest_id','after_reminder','reminder_count','first_reminder_at','first_reminder_elapsed_ms','u2_displayed_at','u2_displayed_elapsed_ms','window_min_ms','window_open_elapsed_ms','click_count','early_click_count','repeat_click_count','first_click_at','first_click_elapsed_ms','first_click_disposition','first_click_from_u2_ms','rest_requested_at','rest_requested_elapsed_ms','rest_started_at','rest_started_elapsed_ms','rest_start_client','start_from_u2_ms','start_from_window_open_ms','start_to_u2_submit_ms','answered_fields_at_start','total_fields','answer_snapshot_at_start','scratchpad_length_at_start','countdown_ended_elapsed_ms','rest_returned_at','rest_returned_elapsed_ms','rest_return_client','planned_rest_ms','actual_rest_ms','paused_during_rest','paused_ms','interrupted_at','interrupt_reason','u2_submitted_at','u2_submitted_elapsed_ms','resume_answer_after_rest_ms','t2_status','t2_planned_elapsed_ms','t2_due_elapsed_ms','t2_actual_delay_ms','t2_request_id','t2_failure_reason','content_version'], rests),
    'rest_clicks.csv': csv(['session_id','participant_id','is_debug','data_kind','event_id','timestamp_iso','elapsed_ms','stage_id','unit_id','condition','rest_key','rest_id','disposition','u2_elapsed_ms','window_min_ms','window_open','reminder_count','client_timestamp_iso','client_monotonic_ms','client_time_origin_ms','client_visibility_state','client','content_version'], restClicks),
    'rest_reminders.csv': csv(['session_id','participant_id','is_debug','stage_id','unit_id','condition','reminder_id','reminder_index','sent_at','sent_elapsed_ms','text','reason','u2_elapsed_ms','display_ms','displayed_at','displayed_elapsed_ms','display_client','rest_started_after','rest_id_after','sent_to_rest_start_ms','content_version'], restReminders),
    'stage_summary.csv': csv(['session_id','participant_id','is_debug','version_label','stage_id','condition','message_id','timing','message_status','t2_not_triggered','send_failed','message_request_id','message_error','message_event_elapsed_ms','message_drawn_received_elapsed_ms','message_hidden_received_elapsed_ms','rest_status','rest_started_elapsed_ms','rest_start_from_u2_ms','rest_answered_fields_at_start','rest_total_fields','rest_after_reminder','rest_reminder_count','message_trigger_minus_rest_start_ms','message_notice','comprehension_correct','comprehension_skipped','comprehension_skip_reason','ratings_status','ratings_skipped','ratings_skip_reason','notice_click_after_drawn_ms','device_confirmation_delay_ms','message_trigger_to_comprehension_ms','message_drawn_to_comprehension_ms','resume_answer_after_message_ms','resume_answer_after_rest_ms','u1_score','u1_completion_ms','u2_score','u2_completion_ms','content_version'], stageSummary),
    'trials.csv': csv(['session_id', 'participant_id', 'is_debug', 'version_label', 'stage_id', 'unit_id', 'condition', 'page_displayed', 'page_displayed_elapsed_ms', 'client_display_evidence', 'e_clicked', 'e_displayed', 'e_elapsed_ms', 'f_submitted', 'f_semantics', 'first_answer', 'last_answer', 'first_answer_elapsed_ms', 'last_answer_elapsed_ms', 'submitted', 'submitted_elapsed_ms', 'raw_answer', 'normalized_answer', 'score', ...(trials.some(t => t.item_results != null) ? ['max_score', 'item_results'] : []), 'completion_ms', 'submission_attempts', 'scratchpad_text', 'scratchpad_changes', 'content_version'], trials),
    'interventions.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'data_kind', 'timing', 'request_id', 'device_id', 'device_events', 'duration_ms', 'display_mode', 'auto_hide_after_ms', 'device_drawn_wall_ms', 'device_drawn_monotonic_ms', 'device_hidden_wall_ms', 'device_hidden_monotonic_ms', 'hide_reason', 'device_confirmed_wall_ms', 'device_confirmed_monotonic_ms', 'cue_status', 'confirmation_requested_at', 'confirmation_elapsed_ms', 'confirmation_status', 'confirmation_recorded', 'device_confirmation_recorded', 'device_confirmation_delay_ms', 'actual_display_duration_ms', 'post_confirmation_duration_ms', 't_event', 'event_elapsed_ms', 't_send', 't_ack', 't_display', 't_hide', 'source', 'display_time_source', 'status', 'error', 'send_latency_ms', 'acknowledgement_latency_ms', 'display_latency_ms', 'latency_baseline', 'latency_unit', 'receipt', 'content_version'], interventions),
    'surveys.csv': csv(['session_id', 'participant_id', 'is_debug', 'stage_id', 'condition', 'message_id', 'message_notice', 'comprehension_answer', 'comprehension_correct', 'comprehension_submitted', 'ratings_status', 'ratings_skip_reason', 'ratings_skipped_at', 'timing', 'attention_distraction', 'thought_disruption', 'task_interference', 'perceived_disturbance', 'disruption', 'effort', 'helpfulness', 'ratings_submitted', 'content_version'], surveys),
    'sessions.csv': csv(['session_id', 'participant_id', 'is_debug', 'copied_from', 'version_label', 'display_mode', 'status', 'phase', 'started_at', 'ended_at', 'elapsed_ms', 'device_source', 'real_presentation_verified', 'validation_status', 'device_id', 'expected_messages', 'device_drawn_messages', 'application_presentation_complete', 'tutorial_started_at','tutorial_completed_at','tutorial_duration_ms','tutorial_answer_attempts','intro_displayed', 'intro_continue', 'intro_duration_ms', 'resume_count', 'anomaly_count', 'breaks_skipped', 'rests_taken', 'rests_after_reminder', 'reminders_sent', 't2_not_triggered_count', 'debug_jumps', 'attention', 'config_hash', 'content_hash', 'content_version', 'stimulus_version'], sessions),
    'notes.csv': csv(['session_id', 'participant_id', 'is_debug', 'note_id', 'category', 'stage_id', 'text', 'saved_at', 'elapsed_ms', 'content_version'], notes),
    ...(breaks.length ? { 'breaks.csv': csv(['session_id', 'participant_id', 'is_debug', 'break_id', 'stage_id', 'condition', 'planned_rest_ms', 'displayed_at', 'displayed_elapsed_ms', 'display_client', 'countdown_ended_at', 'countdown_ended_elapsed_ms', 'completion_observed_at', 'continue_clicked_at', 'continue_clicked_elapsed_ms', 'continue_client', 'actual_rest_ms', 'ended_by', 'skipped_at', 'skip_actor', 'skip_reason', 'remaining_at_skip_ms', 'content_version'], breaks) } : {}),
    'snapshots.json': JSON.stringify(captures.map(c => ({ session_id: c.session.id, snapshot: c.session.snapshot })), null, 2),
    'manifest.json': JSON.stringify({ schema_version: '2.0', created_at: new Date().toISOString(), session_ids: ids,
      break_semantics: 'V2（快照含content.in_unit_rest）取消组间休息，由第二单元内自主休息替代，记录见rests.csv/rest_clicks.csv/rest_reminders.csv；breaks.csv仅在存在旧组间休息记录时输出（旧快照兼容），以下为旧规则说明：v9起默认30000毫秒，休息页实际可见回执后起算。breaks.csv记录显示、倒计时结束、继续点击和实际休息毫秒数；actual_rest_ms为显示到继续/跳过的会话单调时间差，包含到零后停留及人工暂停时间，不封顶为计划时长。人工暂停冻结倒计时。countdown_ended_at为倒计时逻辑到零时刻，completion_observed_at为服务端检测时刻；客户端显示与点击证据另存。未继续/未跳过或历史缺字段时留空，不伪造实际时长。',
      survey_fields: { message_notice: { not_noticed: '没有注意到任何消息', partially_read: '注意到了消息，但没有完整读到消息内容', fully_read: '完整读到了消息内容' },
        ratings: { timing: '消息出现的时机', attention_distraction: '分散注意力', thought_disruption: '扰乱思路', task_interference: '妨碍继续完成任务', perceived_disturbance: '感到被打扰' },
        legacy_ratings: ['disruption', 'effort', 'helpfulness'],
        ratings_status: { submitted: '已提交', skipped: '按规则跳过', pending: '尚未提交' },
        ratings_skip_reason: { not_noticed: '未注意到消息提示', no_message: '无消息条件', t2_not_triggered: 'T2组提交第二单元前未休息，T2未触发，不补发' },
        semantics: '消息注意情况与内容题分别保存，内容题仍单独判分。v8起提交并保存理解页后，未注意到提示者跳过量表，其余进入量表，与内容题正误无关。跳过的评分为空；无消息组与T2未触发组的两页跳过原因写入events.jsonl并在stage_summary.csv中逐组标记，不生成虚假问卷行。旧会话按快照规则执行，缺少的新增字段导出为空。' },
      tutorial_event_count:events.filter(e=>e.data_kind==='tutorial').length, tutorial_semantics:'教程数据单独标记，不计入正式题目和正式呈现完成率；tutorial.csv包含作答尝试及设备证据。手动通知标记manual。',
      debug_session_ids: captures.filter(c => engine.isDebug(c.session)).map(c => c.session.id),
      rest_semantics: {
        rest_start: '休息开始以休息页实际可见回执（rest_started）为准；点击（rest_clicked）与开始分开记录。',
        window: '第二单元出现（u2_displayed）后window_min_ms内点击记录为too_early，不开始休息；window_open_elapsed_ms=U2出现elapsed+window_min_ms。',
        once_per_stage: '每组第二单元只能休息一次；重复点击记为already_resting/already_rested并计入repeat_click_count。',
        after_reminder: '主试点击“提醒休息”后开始的休息after_reminder=true；口头提醒需查notes.csv。',
        pause: '人工暂停冻结休息倒计时与T2计划时刻；actual_rest_ms为休息开始到回到第二单元可见的会话单调时间差，包含暂停时间（paused_ms另列）。',
        t2: 'T2在休息开始后t2_delay_ms到期时触发；眼镜不可用时记为发送失败（t2_status=failed，t2_failure_reason），不覆盖、不排队、不补发。',
        t2_not_triggered: 'T2组提交第二单元前未休息记为t2_not_triggered（无intervention记录、跳过理解题与量表），与发送失败分开统计。',
        rest_status: { rested: '已休息并回到任务', interrupted: '休息被调试跳转或停止会话中断', in_progress: '已请求或正在休息', not_rested: '提交第二单元时未休息', not_reached: '尚未到第二单元', u2_in_progress: '第二单元已出现但未休息也未提交（含会话结束或跳转离开）' },
        t2_status: { not_applicable: '非T2条件', sent: '已生成发送记录（状态见stage_summary.message_status）', failed: '发送失败', not_triggered: 'T2未触发', pending: '尚未休息或尚未到期' },
        rows: 'rests.csv每会话每正式任务组一行，仅V2快照输出；旧快照不输出行。',
        unknown: '未知或未发生的值留空，不伪造。' },
      derived_semantics: {
        clock: 'elapsed_ms为服务器会话单调时钟（含暂停与停机）；设备事件的“接收elapsed”是服务端收到设备回执的时刻，不是设备原始时间；不跨设备换算时钟。',
        notice_click_after_drawn_ms: '首个disposition=confirmation_requested的“已阅读消息”点击服务端elapsed − 该消息message_device_drawn的服务端接收elapsed；为服务端接收时间近似，包含传输延迟。Mock无drawn时留空。',
        device_confirmation_delay_ms: '同一设备clock_id内drawn→confirmed的设备单调时间差。',
        message_trigger_to_comprehension_ms: 'intervention.event_elapsed_ms（触发事件）→ 本组comprehension_displayed elapsed。',
        message_drawn_to_comprehension_ms: 'drawn服务端接收elapsed → comprehension_displayed elapsed；无drawn留空。',
        resume_answer_after_message_ms: 'message_device_hidden服务端接收elapsed之后本组任务单元第一次answer_changed的间隔；无则留空。',
        resume_answer_after_rest_ms: 'rest_ended（回到第二单元可见）之后本组任务单元第一次answer_changed的间隔；无则留空。',
        message_trigger_minus_rest_start_ms: '消息触发elapsed − 休息开始elapsed（负值表示消息在休息前触发）。',
        start_from_u2_ms: '休息开始elapsed − U2出现elapsed；start_from_window_open_ms、start_to_u2_submit_ms同理。' },
      row_counts: rowCounts,
      timing: '服务器ISO墙上时间与会话单调相对毫秒；客户端实际可见证据在事件payload；未测得时间为null/CSV空值。恢复衔接包含停机时间。',
      presentation: 'Mock不是真机证据。策略标识legacy_8500、tone_8500为兼容名称，v10起新会话两种固定模式从设备drawn事件记录时刻起计11000ms，分别无提示音/沿用提示音。confirm_until_ack沿用原提示音配置，持续至确认后立即关闭，不设自动或确认后倒计时；其duration_ms为兼容协议值，不参与计时，auto_hide_after_ms为空。实际绘制、隐藏和确认时间来自设备事件；hide_reason区分auto_timeout、user_confirmed及异常取消，旧数据缺失原因时留空。cue_started仅说明播放调用成功，不证明可听见；确认不是注意起点。电脑与眼镜时钟未同步，仅在同一设备clock_id内计算间隔，不换算跨设备时间。结束会话时取消未结束的持续消息，保留失败/未确认记录。', adapter: engine.adapter.getStatus(), csv: 'UTF-8 BOM；公式前缀字符串在CSV加单引号，原始值在JSONL中保留。' }, null, 2),
  };
  const exportId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(outputRoot, exportId); await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(directory, name), text, 'utf8')));
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 1 });
  await writeFile(join(directory, 'export.zip'), bytes);
  return { export_id: exportId, directory, bytes, row_counts: rowCounts };
}
