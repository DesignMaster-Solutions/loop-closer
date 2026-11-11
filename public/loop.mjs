// Loop Closer core: every actionable screening result is a case that walks a fixed
// pathway; each step has an accountable owner and a service level by urgency.
// Pure functions, no I/O, so the same code runs in the browser and in node --test.

export const STEPS = [
  { id: 'issued', label: 'Result issued', owner: 'Screening program' },
  { id: 'notified', label: 'Patient notified', owner: 'Screening program' },
  { id: 'acknowledged', label: 'Patient confirmed understanding', owner: 'Care navigator' },
  { id: 'confirmatory', label: 'Confirmatory test done', owner: 'Primary care' },
  { id: 'referred', label: 'Referral sent', owner: 'Primary care' },
  { id: 'accepted', label: 'Referral accepted', owner: 'Specialist service' },
  { id: 'appointed', label: 'Appointment attended', owner: 'Specialist service' },
  { id: 'care', label: 'Treatment or surveillance plan', owner: 'Specialist service' },
  { id: 'closed', label: 'Closed with evidence', owner: 'Case owner (clinician)' },
];

// Hours allowed to complete the NEXT step, by urgency. Illustrative defaults: each program sets its own.
export const SLA_HOURS = {
  urgent: { notified: 24, acknowledged: 48, confirmatory: 7 * 24, referred: 24, accepted: 48, appointed: 14 * 24, care: 7 * 24, closed: 7 * 24 },
  priority: { notified: 72, acknowledged: 5 * 24, confirmatory: 21 * 24, referred: 3 * 24, accepted: 5 * 24, appointed: 42 * 24, care: 14 * 24, closed: 14 * 24 },
  routine: { notified: 7 * 24, acknowledged: 14 * 24, confirmatory: 42 * 24, referred: 7 * 24, accepted: 10 * 24, appointed: 90 * 24, care: 30 * 24, closed: 30 * 24 },
};

// Hours a patient-to-clinician or clinician-to-clinician question may wait for an answer. Illustrative too.
export const CONSULT_SLA_HOURS = { urgent: 4, priority: 24, routine: 72 };

// Hours to rebook after a missed appointment or a patient's request for a new date. Illustrative.
export const REBOOK_HOURS = { urgent: 48, priority: 5 * 24, routine: 14 * 24 };

const H = 3600e3;
const idx = (id) => STEPS.findIndex((s) => s.id === id);

// A case: { id, urgency, issuedAt, events: [{ step, at, by, evidence? }], owner?, referral?: 'rejected', consults?, stall? }
export function status(c, now) {
  const done = c.events.filter((e) => idx(e.step) >= 0).sort((a, b) => idx(a.step) - idx(b.step));
  const last = done.length ? done[done.length - 1] : { step: 'issued', at: c.issuedAt };
  const i = idx(last.step);
  const waiting = c.consults?.some((q) => !q.answer && new Date(now) - new Date(q.at) > CONSULT_SLA_HOURS[c.urgency] * H);
  // A lab correction or a patient question that lands after closure still needs a person: the case stays closed, the flag goes on the worklist.
  if (last.step === 'closed') {
    const late = [...(c.correction && !c.correction.reviewed ? ['result-corrected'] : []), ...(waiting ? ['consult-waiting'] : [])];
    return { stage: 'closed', next: null, owner: null, dueAt: null, flags: late.length && c.urgency === 'urgent' ? [...late, 'escalate'] : late };
  }
  const next = STEPS[i + 1];
  const dueAt = new Date(new Date(last.at).getTime() + SLA_HOURS[c.urgency][next.id] * H).toISOString();
  const owner = c.owner?.[next.id] ?? null;
  const flags = [];
  let due = dueAt;
  // A miss or a reschedule request after the last step resets the clock to the rebooking deadline.
  // A new booking answers the misses and requests before it: the clock then runs to the booked day.
  if (next.id === 'appointed') {
    const ev = c.events.filter((e) => ['missed', 'reschedule', 'rebooked'].includes(e.step) && e.at >= last.at);
    const book = ev.findLastIndex((e) => e.step === 'rebooked');
    const open = ev.slice(book + 1);
    if (open.some((e) => e.step === 'missed')) flags.push('missed-visit');
    if (open.some((e) => e.step === 'reschedule')) flags.push('reschedule-requested');
    const from = open.map((e) => e.at).sort().at(-1);
    if (from) due = new Date(new Date(from).getTime() + REBOOK_HOURS[c.urgency] * H).toISOString();
    else if (book >= 0) {
      due = ev[book].for;
      // A booking further out than this urgency allows is a decision someone must own; the limit day itself is inside.
      const limit = new Date(new Date(ev[book].at).getTime() + SLA_HOURS[c.urgency].appointed * H).setUTCHours(23, 59, 59, 999);
      if (new Date(due) > limit) flags.push('booked-late');
    }
  }
  if (!owner) flags.push('unassigned');
  if (new Date(now) > new Date(due)) flags.push('overdue');
  if (next.id === 'accepted' && c.referral === 'rejected') flags.push('referral-rejected');
  if (waiting) flags.push('consult-waiting');
  if (c.correction && !c.correction.reviewed) flags.push('result-corrected');
  if (c.urgency === 'urgent' && flags.length) flags.push('escalate');
  return { stage: last.step, next: next.id, nextLabel: next.label, role: next.owner, owner, dueAt: due, flags, lastAt: last.at };
}

// Closure is a human decision with evidence: never automatic, never by a non-clinician.
export function canClose(c) {
  const steps = new Set(c.events.map((e) => e.step));
  const missing = STEPS.slice(1, -1).filter((s) => !steps.has(s.id) && !(s.id === 'confirmatory' && c.noConfirmatory));
  if (missing.length) return { ok: false, reason: `missing: ${missing.map((s) => s.id).join(', ')}` };
  const care = c.events.find((e) => e.step === 'care');
  if (!care?.evidence) return { ok: false, reason: 'care step has no evidence document' };
  return { ok: true };
}

// The closure record says who closed it, when, on what evidence and with what outcome.
export function close(c, by, at, outcome) {
  if (!by?.clinician) throw new Error('closure requires a qualified clinician');
  const check = canClose(c);
  if (!check.ok) throw new Error(check.reason);
  if (!String(outcome ?? '').trim()) throw new Error('closure needs an outcome (what happened to the patient)');
  const evidence = c.events.find((e) => e.step === 'care').evidence;
  return { ...c, events: [...c.events, { step: 'closed', at, by: by.name, evidence, outcome: outcome.trim() }] };
}

const URGENCY = ['urgent', 'priority', 'routine'];
const isDate = (t) => !Number.isNaN(Date.parse(t));
const iso = (t) => new Date(t).toISOString();

// A case typed in by a user (their own pseudonymised patient), instead of the simulated cohort.
export function newCase({ id, patient, program, finding, confirm, specialist, urgency, lang = 'en', issuedAt, owner = {} }) {
  if (!String(patient ?? '').trim()) throw new Error('patient reference is required');
  if (!String(finding ?? '').trim()) throw new Error('screening finding is required');
  if (!URGENCY.includes(urgency)) throw new Error(`urgency must be one of ${URGENCY.join(', ')}`);
  if (!isDate(issuedAt)) throw new Error('result date is not a valid date');
  return { id: id ?? `U-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, patient: patient.trim(), program: program || 'Own case',
    finding: finding.trim(), confirm: confirm || 'Confirmatory test', specialist: specialist || 'Specialist service', urgency,
    lang: lang === 'ar' ? 'ar' : 'en', issuedAt: iso(issuedAt), events: [], owner: { ...owner }, custom: true };
}

// Record that the next step happened. Steps cannot be skipped or back-dated before the previous one.
export function record(c, step, { at, by, evidence } = {}) {
  if (step === 'closed') throw new Error('use close() to close: it needs a clinician and an outcome');
  const s = status(c, at);
  if (!s.next) throw new Error('case is already closed');
  if (step !== s.next) throw new Error(`next step is ${s.next}, not ${step}`);
  if (!isDate(at)) throw new Error('date is not a valid date');
  if (iso(at) < iso(s.lastAt)) throw new Error('a step cannot be dated before the previous one');
  const e = { step, at: iso(at), by: String(by ?? '').trim() || s.owner || s.role };
  if (evidence) e.evidence = String(evidence).trim();
  return { ...c, events: [...c.events, e] };
}

export function assign(c, step, name) {
  if (!String(name ?? '').trim()) throw new Error('owner name is required');
  return { ...c, owner: { ...c.owner, [step]: name.trim() } };
}

// The new appointment date, recorded by whoever rebooked. The day itself is allowed: due is the end of that day.
export function rebook(c, date, at, by) {
  if (status(c, at).next !== 'appointed') throw new Error('no appointment is pending on this case');
  if (!isDate(date)) throw new Error('new appointment date is not a valid date');
  const end = new Date(new Date(date).setUTCHours(23, 59, 59, 999)).toISOString();
  if (end < iso(at)) throw new Error('new appointment date is in the past');
  return { ...c, events: [...c.events, { step: 'rebooked', at: iso(at), by, for: end }] };
}

export function missedVisit(c, at, by) {
  if (status(c, at).next !== 'appointed') throw new Error('no appointment is pending on this case');
  return { ...c, events: [...c.events, { step: 'missed', at: iso(at), by }] };
}

// Automated alerts: what the system sends, to whom, for every case that slipped. Run on every tick.
export const COORDINATOR = 'Programme coordinator';
export function alerts(cases, now) {
  const out = [];
  for (const c of cases) {
    const s = status(c, now);
    if (!s.flags.length) continue;
    const head = c.owner?.closed;
    const send = (to, kind, text) => { if (to && !out.some((a) => a.caseId === c.id && a.to === to && a.kind === kind)) out.push({ caseId: c.id, to, kind, text: `${c.id} (${c.urgency}): ${text}` }); };
    const f = new Set(s.flags);
    if (f.has('unassigned')) send(COORDINATOR, 'unassigned', `no owner for "${s.nextLabel}". Assign one.`);
    if (f.has('missed-visit')) ['owner', 'head'].forEach((w) => send(w === 'owner' ? s.owner : head, 'missed-visit', `patient missed the appointment. Rebook by ${s.dueAt.slice(0, 10)}.`));
    if (f.has('reschedule-requested')) send(s.owner ?? COORDINATOR, 'reschedule', `patient asked for a new appointment date. Rebook by ${s.dueAt.slice(0, 10)}.`);
    if (f.has('overdue')) {
      send(s.owner ?? COORDINATOR, 'overdue', `"${s.nextLabel}" overdue since ${s.dueAt.slice(0, 10)}.`);
      if (f.has('escalate') && head !== s.owner) send(head, 'escalation', `urgent case, "${s.nextLabel}" overdue since ${s.dueAt.slice(0, 10)}. Escalated to you as case owner.`);
    }
    if (f.has('booked-late')) send(head ?? COORDINATOR, 'booked-late', `new appointment on ${s.dueAt.slice(0, 10)} is beyond the ${SLA_HOURS[c.urgency].appointed / 24} days allowed for this urgency. Book an earlier date or answer for the wait.`);
    if (f.has('referral-rejected')) send(head ?? COORDINATOR, 'referral-rejected', 'referral was rejected. Re-refer or document why not.');
    if (f.has('consult-waiting')) send(head ?? COORDINATOR, 'consult-waiting', 'a question is waiting past its service level.');
    if (f.has('result-corrected')) send(head ?? COORDINATOR, 'result-corrected', 'the lab corrected the result. Review the case.');
  }
  return out;
}

// The patient's reply to the message moves the case. Arabic-Indic digits count, including the extended forms
// typed on Urdu and Persian keyboards; nothing is ever dropped.
export function patientReply(c, text, at) {
  const t = String(text ?? '').trim().replace(/[٠-٩۰-۹]/g, (d) => { const c = d.charCodeAt(0); return String(c - (c >= 0x06F0 ? 0x06F0 : 0x0660)); });
  const s = status(c, at);
  const log = (n, effect) => ({ case: { ...n, inbox: [...(c.inbox ?? []), { at: iso(at), text: String(text), effect }] }, effect });
  if (t === '1' && s.next === 'acknowledged') return log(record(c, 'acknowledged', { at, by: 'Patient (replied 1)' }), 'acknowledged');
  if (t === '1' && s.next === 'appointed') return log({ ...c, events: [...c.events, { step: 'confirmed', at: iso(at), by: 'Patient (replied 1)' }] }, 'attendance-confirmed');
  if (t === '3' && s.next === 'appointed') return log({ ...c, events: [...c.events, { step: 'reschedule', at: iso(at), by: 'Patient (replied 3)' }] }, 'reschedule');
  if (t === '1') return log(c, 'understood'); // the message offers 1 at every step: a repeated 1 is not a question
  const to = c.owner?.acknowledged ?? 'Care navigator';
  const question = t === '2' ? 'Wants to talk to a nurse about the result' : `Patient wrote: "${String(text).slice(0, 300)}"`;
  return log(requestConsult(c, { kind: 'patient-to-clinician', from: `Patient (replied ${t === '2' ? '2' : 'text'})`, to, question }, iso(at)), 'consult');
}

// kind: 'patient-to-clinician' (the patient replied 2) or 'clinician-to-clinician' (e-consult across providers).
export function requestConsult(c, { kind, from, to, question }, at) {
  return { ...c, consults: [...(c.consults ?? []), { kind, from, to, question, at }] };
}

export function answerConsult(c, i, answer, by, at) {
  return { ...c, consults: c.consults.map((q, k) => (k === i ? { ...q, answer, by, answeredAt: at } : q)) };
}

const RANK = { escalate: 0, 'result-corrected': 1, 'referral-rejected': 1, 'missed-visit': 1, 'booked-late': 1, 'consult-waiting': 2, 'reschedule-requested': 2, overdue: 3, unassigned: 4 };
const U = { urgent: 0, priority: 1, routine: 2 };

// The exception queue a coordinator works every morning: only cases that need a human.
export function worklist(cases, now) {
  return cases
    .map((c) => ({ c, s: status(c, now) }))
    .filter(({ s }) => s.flags.length)
    .sort((a, b) => Math.min(...a.s.flags.map((f) => RANK[f])) - Math.min(...b.s.flags.map((f) => RANK[f]))
      || U[a.c.urgency] - U[b.c.urgency] || (a.s.dueAt ?? '').localeCompare(b.s.dueAt ?? ''));
}

// Plain-language next step for the patient. Clinical wording must be reviewed by the program.
const MSG = {
  en: {
    urgent: 'Your screening result needs a follow-up soon. This is not a diagnosis.',
    priority: 'Your screening result needs a follow-up. This is not a diagnosis.',
    routine: 'Your screening result needs a routine follow-up. This is not a diagnosis.',
    next: 'Next step', who: 'Who is looking after you', by: 'By', late: 'This step is late. Your care team has been alerted and will contact you.', ok: 'Reply 1 if you understood, 2 to talk to a nurse.',
    appt: 'Reply 1 to confirm you will attend, 3 if you need a new date, 2 to talk to a nurse.',
  },
  ar: {
    urgent: 'نتيجة فحصك تحتاج إلى متابعة قريبًا. هذا ليس تشخيصًا.',
    priority: 'نتيجة فحصك تحتاج إلى متابعة. هذا ليس تشخيصًا.',
    routine: 'نتيجة فحصك تحتاج إلى متابعة روتينية. هذا ليس تشخيصًا.',
    next: 'الخطوة التالية', who: 'المسؤول عن متابعتك', by: 'في موعد أقصاه', late: 'هذه الخطوة متأخرة. تم تنبيه فريق الرعاية وسيتواصل معك.', ok: 'أرسل 1 إذا فهمت، أو 2 للتحدث مع ممرضة.',
    appt: 'أرسل 1 لتأكيد حضورك، أو 3 إذا كنت بحاجة إلى موعد آخر، أو 2 للتحدث مع ممرضة.',
  },
};

const AR = {
  notified: 'إبلاغ المريض', acknowledged: 'تأكيد فهم النتيجة', confirmatory: 'إجراء الفحص التأكيدي', referred: 'إرسال الإحالة',
  accepted: 'قبول الإحالة', appointed: 'حضور الموعد', care: 'خطة العلاج أو المتابعة', closed: 'إغلاق الحالة مع التوثيق',
  'Screening program': 'برنامج الفحص', 'Care navigator': 'منسق الرعاية', 'Primary care': 'الرعاية الصحية الأولية',
  'Specialist service': 'الخدمة التخصصية', 'Case owner (clinician)': 'الطبيب المسؤول عن الحالة',
};

export function patientMessage(c, now, lang = 'en') {
  const m = MSG[lang] ?? MSG.en;
  const s = status(c, now);
  if (!s.next) return null;
  const ar = lang === 'ar';
  return [m[c.urgency], `${m.next}: ${ar ? AR[s.next] : s.nextLabel}`, `${m.who}: ${s.owner ?? (ar ? AR[s.role] : s.role)}`, s.flags.includes('overdue') ? m.late : `${m.by}: ${s.dueAt.slice(0, 10)}`, s.next === 'appointed' ? m.appt : m.ok].join('\n');
}

// Program metrics on a set of cases: the closure and patient-journey measures named by the challenge.
export function metrics(cases, now) {
  const waitingAt = {}, stallReasons = {}, days = [];
  let closed = 0, overdue = 0, stalled = 0;
  const reached = (id) => cases.filter((c) => c.events.some((e) => e.step === id)).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  for (const c of cases) {
    const s = status(c, now);
    const appt = c.events.find((e) => e.step === 'appointed');
    if (appt) days.push((new Date(appt.at) - new Date(c.issuedAt)) / (24 * H));
    if (s.stage === 'closed') { closed++; continue; }
    waitingAt[s.next] = (waitingAt[s.next] ?? 0) + 1;
    if (s.flags.includes('overdue')) overdue++;
    if (c.stall) { stalled++; stallReasons[c.stall] = (stallReasons[c.stall] ?? 0) + 1; }
  }
  days.sort((a, b) => a - b);
  return {
    total: cases.length, closed, overdue, stalled, unresolved: cases.length - closed,
    medianDaysToSpecialist: days.length ? days[Math.floor(days.length / 2)] : null,
    notifiedPct: pct(reached('notified'), cases.length),
    acknowledgedPct: pct(reached('acknowledged'), reached('notified')),
    referralCompletionPct: pct(reached('appointed'), reached('referred')),
    waitingAt, stallReasons,
  };
}
