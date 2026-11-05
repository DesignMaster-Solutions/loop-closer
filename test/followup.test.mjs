// Review-round feedback: own patient data, step recording, missed visits, automated alerts,
// owner assignment, documented closure and patient replies that move the case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status, newCase, record, assign, missedVisit, alerts, close, patientReply, patientMessage } from '../public/loop.mjs';

const T0 = '2026-11-10T08:00:00Z';
const owners = { notified: 'Lab', acknowledged: 'Nav', confirmatory: 'GP', referred: 'GP', accepted: 'Spec', appointed: 'Spec', care: 'Spec', closed: 'Dr. Case' };
const mine = () => newCase({ patient: 'PSEUDO-77', program: 'Colorectal (FIT)', finding: 'Positive FIT', urgency: 'urgent', lang: 'en', issuedAt: T0, owner: owners });

test('a user-entered patient becomes a case with an id, owners and the first step due', () => {
  const c = mine();
  assert.match(c.id, /^U-/);
  assert.equal(status(c, T0).next, 'notified');
  assert.throws(() => newCase({ patient: '', finding: 'x', urgency: 'urgent', issuedAt: T0 }), /patient/);
  assert.throws(() => newCase({ patient: 'P', finding: 'x', urgency: 'soon', issuedAt: T0 }), /urgency/);
  assert.throws(() => newCase({ patient: 'P', finding: 'x', urgency: 'urgent', issuedAt: 'not a date' }), /date/);
});

test('steps are recorded in order, never skipped, never before the previous one', () => {
  let c = record(mine(), 'notified', { at: '2026-11-10T09:00:00Z', by: 'Lab' });
  assert.equal(status(c, '2026-11-10T10:00:00Z').next, 'acknowledged');
  assert.throws(() => record(c, 'referred', { at: '2026-11-10T10:00:00Z', by: 'GP' }), /next step is acknowledged/);
  assert.throws(() => record(c, 'acknowledged', { at: '2026-11-09T10:00:00Z', by: 'Nav' }), /before/);
  assert.throws(() => record(c, 'closed', { at: '2026-11-10T10:00:00Z', by: 'GP' }), /close/);
});

test('assigning an owner clears the unassigned flag', () => {
  const c = { ...mine(), owner: { ...owners, notified: null } };
  assert.ok(status(c, T0).flags.includes('unassigned'));
  assert.ok(!status(assign(c, 'notified', 'Lab liaison'), T0).flags.includes('unassigned'));
  assert.throws(() => assign(c, 'notified', '  '), /name/);
});

test('missed visit is flagged, sets a rebooking deadline and clears when the visit is attended', () => {
  let c = mine();
  for (const [step, at] of [['notified', '2026-11-10T09:00:00Z'], ['acknowledged', '2026-11-10T10:00:00Z'], ['confirmatory', '2026-11-11T10:00:00Z'], ['referred', '2026-11-11T12:00:00Z'], ['accepted', '2026-11-12T08:00:00Z']]) {
    c = record(c, step, { at, by: owners[step] });
  }
  c = missedVisit(c, '2026-11-14T09:00:00Z', 'Spec');
  const s = status(c, '2026-11-14T10:00:00Z');
  assert.ok(s.flags.includes('missed-visit'));
  assert.equal(s.dueAt, '2026-11-16T09:00:00.000Z'); // urgent rebooking: 48 h after the miss
  assert.throws(() => missedVisit(mine(), T0, 'Spec'), /appointment/);
  const back = record(c, 'appointed', { at: '2026-11-15T09:00:00Z', by: 'Spec' });
  assert.ok(!status(back, '2026-11-15T10:00:00Z').flags.includes('missed-visit'));
});

test('automated alerts go to the owner of the late step, escalate to the case owner, and to the coordinator when nobody owns it', () => {
  const late = mine(); // urgent: notification due 24 h after issue
  const a = alerts([late], '2026-11-11T09:00:00Z');
  assert.deepEqual(a.map((x) => x.to), ['Lab', 'Dr. Case']);
  assert.match(a[0].text, /overdue/i);
  const orphan = { ...mine(), owner: { ...owners, notified: null } };
  assert.ok(alerts([orphan], T0).some((x) => x.to === 'Programme coordinator' && /no owner/i.test(x.text)));
  assert.deepEqual(alerts([mine()], '2026-11-10T09:00:00Z'), []);
});

test('closure is documented: who, when, evidence and outcome', () => {
  let c = mine();
  const steps = ['notified', 'acknowledged', 'confirmatory', 'referred', 'accepted', 'appointed', 'care'];
  steps.forEach((step, k) => { c = record(c, step, { at: `2026-11-1${k}T12:00:00Z`, by: owners[step], evidence: step === 'care' ? 'plan.pdf' : undefined }); });
  assert.throws(() => close(c, { name: 'Dr. Case', clinician: true }, '2026-11-18T08:00:00Z'), /outcome/);
  const done = close(c, { name: 'Dr. Case', clinician: true }, '2026-11-18T08:00:00Z', 'Adenoma removed, surveillance in 3 years');
  const last = done.events.at(-1);
  assert.deepEqual([last.step, last.by, last.outcome], ['closed', 'Dr. Case', 'Adenoma removed, surveillance in 3 years']);
});

test('patient reply 1 advances the case, 2 opens a nurse consult, anything else is never dropped', () => {
  const sent = record(mine(), 'notified', { at: '2026-11-10T09:00:00Z', by: 'Lab' });
  const one = patientReply(sent, '1', '2026-11-10T09:30:00Z');
  assert.equal(one.effect, 'acknowledged');
  assert.equal(status(one.case, '2026-11-10T10:00:00Z').next, 'confirmatory');
  assert.equal(patientReply(sent, '١', '2026-11-10T09:30:00Z').effect, 'acknowledged'); // Arabic-Indic digit
  const two = patientReply(sent, '2', '2026-11-10T09:30:00Z');
  assert.equal(two.effect, 'consult');
  assert.equal(two.case.consults[0].kind, 'patient-to-clinician');
  const other = patientReply(sent, 'who is this?', '2026-11-10T09:30:00Z');
  assert.equal(other.effect, 'consult');
  assert.match(other.case.consults[0].question, /who is this/);
});

test('at the appointment step the patient can confirm (1) or ask for a new date (3)', () => {
  let c = mine();
  for (const step of ['notified', 'acknowledged', 'confirmatory', 'referred', 'accepted']) c = record(c, step, { at: '2026-11-11T08:00:00Z', by: owners[step] });
  assert.match(patientMessage(c, '2026-11-11T09:00:00Z', 'en'), /Reply 1 to confirm.*3/);
  const yes = patientReply(c, '1', '2026-11-11T09:00:00Z');
  assert.equal(yes.effect, 'attendance-confirmed');
  assert.equal(status(yes.case, '2026-11-11T09:00:00Z').next, 'appointed'); // confirming is not attending
  const re = patientReply(c, '3', '2026-11-11T09:00:00Z');
  assert.equal(re.effect, 'reschedule');
  assert.ok(status(re.case, '2026-11-11T09:00:00Z').flags.includes('reschedule-requested'));
});
