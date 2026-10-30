import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status, canClose, close, worklist, patientMessage, metrics, requestConsult, answerConsult } from '../public/loop.mjs';
import { cohort } from '../public/cases.mjs';

const base = {
  id: 'T1', urgency: 'urgent', issuedAt: '2026-11-01T08:00:00Z',
  owner: { notified: 'Lab', acknowledged: 'Nav', confirmatory: 'GP', referred: 'GP', accepted: 'Spec', appointed: 'Spec', care: 'Spec', closed: 'GP' },
  events: [],
};

test('next step, owner and due date follow the urgency SLA', () => {
  const s = status(base, '2026-11-01T10:00:00Z');
  assert.equal(s.next, 'notified');
  assert.equal(s.owner, 'Lab');
  assert.equal(s.dueAt, '2026-11-02T08:00:00.000Z');
  assert.deepEqual(s.flags, []);
});

test('overdue urgent case escalates; unassigned hand-off is flagged', () => {
  const s = status({ ...base, owner: { ...base.owner, notified: null } }, '2026-11-03T08:00:00Z');
  assert.deepEqual(s.flags, ['unassigned', 'overdue', 'escalate']);
});

test('rejected referral shows up at the acceptance step', () => {
  const c = { ...base, urgency: 'routine', referral: 'rejected', events: ['notified', 'acknowledged', 'confirmatory', 'referred'].map((step) => ({ step, at: '2026-11-02T08:00:00Z' })) };
  assert.ok(status(c, '2026-11-03T08:00:00Z').flags.includes('referral-rejected'));
});

test('closure needs every step, evidence and a clinician', () => {
  const steps = ['notified', 'acknowledged', 'confirmatory', 'referred', 'accepted', 'appointed', 'care'];
  const c = { ...base, events: steps.map((step) => ({ step, at: '2026-11-05T08:00:00Z' })) };
  assert.match(canClose(c).reason, /evidence/);
  c.events[6].evidence = 'plan.pdf';
  assert.throws(() => close(c, { name: 'Navigator', clinician: false }, '2026-11-06T08:00:00Z'), /clinician/);
  const done = close(c, { name: 'Dr. X', clinician: true }, '2026-11-06T08:00:00Z');
  assert.equal(status(done, '2026-11-07T08:00:00Z').stage, 'closed');
  assert.throws(() => close({ ...c, events: c.events.slice(0, 3) }, { name: 'Dr', clinician: true }, 'x'), /missing/);
});

test('worklist puts escalations first and skips healthy cases', () => {
  const healthy = { ...base, id: 'ok' };
  const late = { ...base, id: 'late', urgency: 'routine', issuedAt: '2026-10-01T08:00:00Z' };
  const urgentLate = { ...base, id: 'urg', issuedAt: '2026-10-25T08:00:00Z' };
  const ids = worklist([healthy, late, urgentLate], '2026-11-01T10:00:00Z').map((x) => x.c.id);
  assert.deepEqual(ids, ['urg', 'late']);
});

test('patient message is plain language in English and Arabic, never a diagnosis', () => {
  const en = patientMessage(base, '2026-11-01T10:00:00Z', 'en');
  assert.match(en, /not a diagnosis/);
  assert.match(en, /Next step: Patient notified/);
  assert.match(patientMessage(base, '2026-11-01T10:00:00Z', 'ar'), /ليس تشخيصًا/);
});

test('simulated cohort is reproducible and produces a real worklist', () => {
  const now = '2026-11-15T09:00:00Z';
  const a = cohort(now), b = cohort(now);
  assert.deepEqual(a, b);
  const m = metrics(a, now);
  assert.equal(m.total, 60);
  assert.ok(m.closed > 0 && m.closed < 60);
  assert.ok(worklist(a, now).length > 0);
  for (const c of a.filter((c) => c.events.some((e) => e.step === 'closed'))) {
    assert.ok(c.events.find((e) => e.step === 'care')?.evidence, `${c.id} closed without evidence`);
  }
});

test('overdue case never shows the patient a past due date', () => {
  const msg = patientMessage(base, '2026-11-05T10:00:00Z', 'en');
  assert.doesNotMatch(msg, /By: 2026-11-02/);
  assert.match(msg, /care team has been alerted/);
});

test('unanswered consult is flagged after its service level and clears when answered', () => {
  const c = requestConsult(base, { kind: 'clinician-to-clinician', from: 'GP', to: 'Spec', question: 'Colonoscopy or CT?' }, '2026-11-01T09:00:00Z');
  assert.ok(!status(c, '2026-11-01T12:00:00Z').flags.includes('consult-waiting'));
  assert.ok(status(c, '2026-11-02T12:00:00Z').flags.includes('consult-waiting'));
  const a = answerConsult(c, 0, 'Colonoscopy', 'Spec', '2026-11-02T13:00:00Z');
  assert.ok(!status(a, '2026-11-02T14:00:00Z').flags.includes('consult-waiting'));
  assert.equal(base.consults, undefined);
});

test('metrics report completion rates, unresolved results and why cases stalled', () => {
  const now = '2026-11-15T09:00:00Z';
  const m = metrics(cohort(now), now);
  assert.ok(m.notifiedPct > 0 && m.notifiedPct <= 100);
  assert.ok(m.referralCompletionPct > 0 && m.referralCompletionPct <= 100);
  assert.equal(m.unresolved, m.total - m.closed);
  assert.ok(Object.keys(m.stallReasons).length > 0);
});

test('scenario: same cohort, surfacing exceptions closes more cases than leaving them silent', () => {
  const now = '2026-11-15T09:00:00Z';
  const off = metrics(cohort(now, 60, 7, 0), now), on = metrics(cohort(now, 60, 7, 0.8), now);
  assert.ok(on.closed > off.closed, `${on.closed} > ${off.closed}`);
  assert.ok(on.stalled < off.stalled);
  assert.deepEqual(cohort(now, 60, 7, 0.8).map((c) => c.urgency), cohort(now, 60, 7, 0).map((c) => c.urgency));
});
