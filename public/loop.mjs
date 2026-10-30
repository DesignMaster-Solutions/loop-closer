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

const H = 3600e3;
const idx = (id) => STEPS.findIndex((s) => s.id === id);

// A case: { id, urgency, issuedAt, events: [{ step, at, by, evidence? }], owner?, referral?: 'rejected', consults?, stall? }
export function status(c, now) {
  const done = c.events.filter((e) => idx(e.step) >= 0).sort((a, b) => idx(a.step) - idx(b.step));
  const last = done.length ? done[done.length - 1] : { step: 'issued', at: c.issuedAt };
  const i = idx(last.step);
  if (last.step === 'closed') return { stage: 'closed', next: null, owner: null, dueAt: null, flags: [] };
  const next = STEPS[i + 1];
  const dueAt = new Date(new Date(last.at).getTime() + SLA_HOURS[c.urgency][next.id] * H).toISOString();
  const owner = c.owner?.[next.id] ?? null;
  const flags = [];
  if (!owner) flags.push('unassigned');
  if (new Date(now) > new Date(dueAt)) flags.push('overdue');
  if (next.id === 'accepted' && c.referral === 'rejected') flags.push('referral-rejected');
  if (c.consults?.some((q) => !q.answer && new Date(now) - new Date(q.at) > CONSULT_SLA_HOURS[c.urgency] * H)) flags.push('consult-waiting');
  if (c.urgency === 'urgent' && flags.length) flags.push('escalate');
  return { stage: last.step, next: next.id, nextLabel: next.label, role: next.owner, owner, dueAt, flags };
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

export function close(c, by, at) {
  if (!by?.clinician) throw new Error('closure requires a qualified clinician');
  const check = canClose(c);
  if (!check.ok) throw new Error(check.reason);
  return { ...c, events: [...c.events, { step: 'closed', at, by: by.name }] };
}

// kind: 'patient-to-clinician' (the patient replied 2) or 'clinician-to-clinician' (e-consult across providers).
export function requestConsult(c, { kind, from, to, question }, at) {
  return { ...c, consults: [...(c.consults ?? []), { kind, from, to, question, at }] };
}

export function answerConsult(c, i, answer, by, at) {
  return { ...c, consults: c.consults.map((q, k) => (k === i ? { ...q, answer, by, answeredAt: at } : q)) };
}

const RANK = { escalate: 0, 'referral-rejected': 1, 'consult-waiting': 2, overdue: 3, unassigned: 4 };
const U = { urgent: 0, priority: 1, routine: 2 };

// The exception queue a coordinator works every morning: only cases that need a human.
export function worklist(cases, now) {
  return cases
    .map((c) => ({ c, s: status(c, now) }))
    .filter(({ s }) => s.flags.length)
    .sort((a, b) => Math.min(...a.s.flags.map((f) => RANK[f])) - Math.min(...b.s.flags.map((f) => RANK[f]))
      || U[a.c.urgency] - U[b.c.urgency] || a.s.dueAt.localeCompare(b.s.dueAt));
}

// Plain-language next step for the patient. Clinical wording must be reviewed by the program.
const MSG = {
  en: {
    urgent: 'Your screening result needs a follow-up soon. This is not a diagnosis.',
    priority: 'Your screening result needs a follow-up. This is not a diagnosis.',
    routine: 'Your screening result needs a routine follow-up. This is not a diagnosis.',
    next: 'Next step', who: 'Who is looking after you', by: 'By', late: 'This step is late. Your care team has been alerted and will contact you.', ok: 'Reply 1 if you understood, 2 to talk to a nurse.',
  },
  ar: {
    urgent: 'نتيجة الفحص تحتاج إلى متابعة قريبًا. هذا ليس تشخيصًا.',
    priority: 'نتيجة الفحص تحتاج إلى متابعة. هذا ليس تشخيصًا.',
    routine: 'نتيجة الفحص تحتاج إلى متابعة روتينية. هذا ليس تشخيصًا.',
    next: 'الخطوة التالية', who: 'المسؤول عن متابعتك', by: 'قبل', late: 'هذه الخطوة متأخرة. تم تنبيه فريق الرعاية وسيتواصل معك.', ok: 'أرسل 1 إذا فهمت، أو 2 للتحدث مع ممرضة.',
  },
};

const AR = {
  notified: 'إبلاغ المريض', acknowledged: 'تأكيد فهم النتيجة', confirmatory: 'إجراء الفحص التأكيدي', referred: 'إرسال الإحالة',
  accepted: 'قبول الإحالة', appointed: 'حضور الموعد', care: 'خطة العلاج أو المتابعة', closed: 'إغلاق الحالة بالوثائق',
  'Screening program': 'برنامج الفحص', 'Care navigator': 'منسق الرعاية', 'Primary care': 'الرعاية الأولية',
  'Specialist service': 'الخدمة التخصصية', 'Case owner (clinician)': 'الطبيب المسؤول عن الحالة',
};

export function patientMessage(c, now, lang = 'en') {
  const m = MSG[lang] ?? MSG.en;
  const s = status(c, now);
  if (!s.next) return null;
  const ar = lang === 'ar';
  return [m[c.urgency], `${m.next}: ${ar ? AR[s.next] : s.nextLabel}`, `${m.who}: ${s.owner ?? (ar ? AR[s.role] : s.role)}`, s.flags.includes('overdue') ? m.late : `${m.by}: ${s.dueAt.slice(0, 10)}`, m.ok].join('\n');
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
