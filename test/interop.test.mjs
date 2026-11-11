import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOru, fromFhir, triage, ingest, reconcile, feedHealth, toFhirBundle, parseMessage } from '../public/interop.mjs';
import { status, worklist, close, alerts } from '../public/loop.mjs';
import worker from '../src/worker.mjs';

const NOW = '2026-11-15T09:00:00Z';
const ROUTING = { notified: 'Lab liaison', acknowledged: 'Navigator', confirmatory: 'Dr. PHC', referred: 'Dr. PHC', accepted: 'Dr. Specialist', appointed: 'Dr. Specialist', care: 'Dr. Specialist', closed: 'Dr. PHC' };

const oru = ({ code = '29771-3^Hemoglobin [Presence] in Stool from gastrointestinal lower by Immunoassay^LN', type = 'CWE', value = 'Positive', acc = 'FIT-77120', st = 'F', proc = 'T', lang = 'ara' } = {}) => [
  `MSH|^~\\&|LAB|DEMOLAB|LOOPCLOSER|PROGRAM|20261115080000+0400||ORU^R01|MSG-${acc}|${proc}|2.5.1`,
  `PID|1||PSEUDO-4471^^^PROGRAM^PI||||||||||||${lang}`,
  `OBR|1||${acc}|${code}|||20261114100000+0400||||||||||||||20261115073000+0400|||${st}`,
  `OBX|1|${type}|${code}||${value}|||A|||${st}|||20261115073000+0400`,
].join('\r');

const fhirHba1c = (value = 7.9, tagged = true) => ({
  resourceType: 'Bundle', type: 'collection', ...(tagged ? { meta: { tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } } : {}),
  entry: [
    { fullUrl: 'urn:uuid:p1', resource: { resourceType: 'Patient', id: 'p1', identifier: [{ value: 'PSEUDO-9' }], communication: [{ language: { coding: [{ code: 'en' }] } }] } },
    { fullUrl: 'urn:uuid:o1', resource: { resourceType: 'Observation', id: 'o1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }] }, subject: { reference: 'urn:uuid:p1' }, effectiveDateTime: '2026-11-14T10:00:00+04:00', valueQuantity: { value, unit: '%' } } },
    { fullUrl: 'urn:uuid:r1', resource: { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', identifier: [{ value: 'HBA-501' }], code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: 'urn:uuid:p1' }, issued: '2026-11-15T07:30:00+04:00', result: [{ reference: 'urn:uuid:o1' }] } },
  ],
});

test('HL7 v2 ORU^R01 becomes a normalized result', () => {
  const [r] = parseOru(oru());
  assert.equal(r.accession, 'FIT-77120');
  assert.equal(r.loinc, '29771-3');
  assert.equal(r.value, 'Positive');
  assert.equal(r.patient, 'PSEUDO-4471');
  assert.equal(r.lang, 'ar');
  assert.equal(r.status, 'final');
  assert.equal(r.test, true);
  assert.equal(r.at, '2026-11-15T03:30:00.000Z');
});

test('a message that is not ORU^R01, or has no observation, is refused and not guessed at', () => {
  assert.throws(() => parseOru('MSH|^~\\&|A|B|C|D|20261115||ADT^A01|1|T|2.5.1\rPID|1'), /ORU\^R01/);
  assert.throws(() => parseOru('hello'), /MSH/);
  assert.throws(() => parseOru(oru().split('\r').slice(0, 2).join('\r')), /OBX/);
});

test('HL7 escape sequences in a value are decoded', () => {
  const [r] = parseOru(oru({ code: '24606-6^MG Breast Screening^LN', type: 'ST', value: 'BI-RADS 4\\T\\ recall' }));
  assert.equal(r.value, 'BI-RADS 4& recall');
});

test('FHIR Bundle with DiagnosticReport and Observation becomes the same normalized result', () => {
  const [r] = fromFhir(fhirHba1c());
  assert.equal(r.accession, 'HBA-501');
  assert.equal(r.loinc, '4548-4');
  assert.equal(r.value, 7.9);
  assert.equal(r.patient, 'PSEUDO-9');
  assert.equal(r.test, true);
  assert.equal(fromFhir(fhirHba1c(7.9, false))[0].test, false);
  assert.throws(() => fromFhir({ resourceType: 'Patient' }), /DiagnosticReport/);
});

test('triage: the rule decides, with the reason visible', () => {
  const t = (code, value) => triage({ loinc: code, value });
  assert.equal(t('29771-3', 'Positive').actionable, true);
  assert.equal(t('29771-3', 'Negative').actionable, false);
  assert.equal(t('4548-4', 7.9).urgency, 'routine');
  assert.equal(t('4548-4', 8.5).urgency, 'priority');
  assert.equal(t('4548-4', 11).urgency, 'urgent');
  assert.equal(t('4548-4', 5.4).actionable, false);
  assert.equal(t('24606-6', 'BI-RADS 5').urgency, 'urgent');
  assert.equal(t('24606-6', 'BI-RADS 4b').urgency, 'priority');
  assert.equal(t('24606-6', 'BI-RADS 1').actionable, false);
  assert.equal(t('24606-6', 'see report').unreadable, true, 'an unreadable value goes to a person, it is never treated as normal');
  assert.equal(t('1234-5', 'x').unmapped, true);
});

test('ingest: a new actionable result opens one case with owners and a due date', () => {
  const [r] = parseOru(oru());
  const { cases, action, id } = ingest([], r, NOW, () => ROUTING);
  assert.equal(action, 'opened');
  assert.equal(cases.length, 1);
  const s = status(cases[0], NOW);
  assert.equal(s.next, 'notified');
  assert.equal(s.owner, 'Lab liaison');
  assert.equal(cases[0].id, id);
  assert.equal(cases[0].lang, 'ar');
});

test('ingest: the same message twice does not open a second case', () => {
  const [r] = parseOru(oru());
  const a = ingest([], r, NOW, () => ROUTING);
  const b = ingest(a.cases, r, NOW, () => ROUTING);
  assert.equal(b.action, 'duplicate');
  assert.equal(b.cases.length, 1);
});

test('ingest: a corrected or cancelled result raises a flag on the open case and never closes it', () => {
  const [r] = parseOru(oru());
  const a = ingest([], r, NOW, () => ROUTING);
  const [c] = parseOru(oru({ value: 'Negative', st: 'C' }));
  const b = ingest(a.cases, c, NOW, () => ROUTING);
  assert.equal(b.action, 'corrected');
  assert.equal(b.cases.length, 1);
  assert.ok(status(b.cases[0], NOW).flags.includes('result-corrected'));
  assert.equal(worklist(b.cases, NOW).length, 1);
  assert.notEqual(status(b.cases[0], NOW).stage, 'closed');
  const [x] = parseOru(oru({ st: 'X' }));
  assert.ok(status(ingest(a.cases, x, NOW, () => ROUTING).cases[0], NOW).flags.includes('result-corrected'));
});

test('ingest: unmapped and unreadable results are returned for a person, not dropped', () => {
  const [u] = parseOru(oru({ code: '1234-5^Unknown^LN' }));
  assert.equal(ingest([], u, NOW, () => ROUTING).action, 'needs-review');
  const [v] = parseOru(oru({ code: '24606-6^MG Breast Screening^LN', type: 'ST', value: 'see report' }));
  assert.equal(ingest([], v, NOW, () => ROUTING).action, 'needs-review');
  const [n] = parseOru(oru({ value: 'Negative' }));
  assert.equal(ingest([], n, NOW, () => ROUTING).action, 'not-actionable');
});

test('ingest: a program with no routing opens the case flagged unassigned', () => {
  const [r] = parseOru(oru());
  const { cases } = ingest([], r, NOW);
  assert.ok(status(cases[0], NOW).flags.includes('unassigned'));
});

test('reconciliation finds what the lab issued and we never received', () => {
  const [r] = parseOru(oru());
  const { cases } = ingest([], r, NOW, () => ROUTING);
  assert.deepEqual(reconcile(['FIT-77120', 'FIT-77121'], cases, ['FIT-77122']).missing, ['FIT-77121']);
});

test('a silent feed is an alarm', () => {
  assert.equal(feedHealth('2026-11-15T08:00:00Z', NOW).stale, false);
  assert.equal(feedHealth('2026-11-13T08:00:00Z', NOW).stale, true);
  assert.equal(feedHealth(null, NOW).stale, true);
});

const done = (c, steps) => ({ ...c, events: steps.map((step, i) => ({ step, at: new Date(Date.parse(c.issuedAt) + (i + 1) * 864e5).toISOString(), by: ROUTING[step], evidence: step === 'care' ? 'plan.pdf' : undefined })) });
const ALL = ['notified', 'acknowledged', 'confirmatory', 'referred', 'accepted', 'appointed', 'care'];

test('FHIR export: one Task per step, statuses follow the case, every reference resolves', () => {
  const [r] = parseOru(oru());
  const c = done(ingest([], r, '2026-11-01T09:00:00Z', () => ROUTING).cases[0], ['notified', 'acknowledged']);
  const b = toFhirBundle(c, NOW);
  assert.equal(b.resourceType, 'Bundle');
  assert.equal(b.type, 'transaction');
  const res = b.entry.map((e) => e.resource);
  const tasks = res.filter((x) => x.resourceType === 'Task');
  assert.equal(tasks.length, 8);
  const by = Object.fromEntries(tasks.map((t) => [t.code.coding[0].code, t]));
  assert.equal(by.notified.status, 'completed');
  assert.equal(by.confirmatory.status, 'requested');
  assert.ok(by.confirmatory.restriction.period.end);
  assert.equal(by.care.status, 'draft');
  assert.equal(res.filter((x) => x.resourceType === 'Communication').length, 2);
  for (const e of b.entry) {
    assert.match(e.resource.id, /^[A-Za-z0-9.-]{1,64}$/);
    assert.equal(e.request.method, 'PUT');
    assert.equal(e.request.url, `${e.resource.resourceType}/${e.resource.id}`);
  }
  const ids = new Set(b.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`));
  JSON.stringify(b, (k, v) => { if (k === 'reference') assert.ok(ids.has(v), `dangling ${v}`); return v; });
  const pat = res.find((x) => x.resourceType === 'Patient');
  assert.equal(pat.name, undefined, 'the export carries a pseudonym, never a name');
});

test('FHIR export: a rejected referral is a rejected Task, closure carries the clinician in Provenance', () => {
  const [r] = parseOru(oru());
  const base = ingest([], r, '2026-11-01T09:00:00Z', () => ROUTING).cases[0];
  const rej = { ...done(base, ['notified', 'acknowledged', 'confirmatory', 'referred']), referral: 'rejected' };
  const tasks = toFhirBundle(rej, NOW).entry.map((e) => e.resource).filter((x) => x.resourceType === 'Task');
  assert.equal(tasks.find((t) => t.code.coding[0].code === 'accepted').status, 'rejected');
  const closed = close(done(base, ALL), { name: 'Dr. PHC', clinician: true }, NOW, 'Adenoma removed, surveillance in 3 years');
  const res = toFhirBundle(closed, NOW).entry.map((e) => e.resource);
  assert.equal(res.find((x) => x.resourceType === 'Encounter').status, 'finished');
  assert.equal(res.find((x) => x.resourceType === 'CarePlan').status, 'completed');
  assert.equal(res.find((x) => x.resourceType === 'DocumentReference').content[0].attachment.title, 'plan.pdf');
  assert.equal(res.find((x) => x.resourceType === 'Provenance').agent[0].who.display, 'Dr. PHC');
});

const post = (body, type) => worker.fetch(new Request('https://x/api/v1/results', { method: 'POST', headers: { 'content-type': type }, body }), { ASSETS: { fetch: () => new Response('asset') } });

test('API: test data is translated, real data is refused by the public demo', async () => {
  const ok = await post(oru(), 'application/hl7-v2');
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.results[0].action, 'opened');
  assert.equal(j.results[0].bundle.resourceType, 'Bundle');
  const real = await post(oru({ proc: 'P' }), 'application/hl7-v2');
  assert.equal(real.status, 422);
  assert.equal((await real.json()).resourceType, 'OperationOutcome');
  const fh = await post(JSON.stringify(fhirHba1c()), 'application/fhir+json');
  assert.equal(fh.status, 200);
  assert.equal((await post(JSON.stringify(fhirHba1c(7.9, false)), 'application/fhir+json')).status, 422);
});

test('API: bad input is a 400 with a reason, big input is refused, other paths are the static site', async () => {
  const bad = await post('garbage', 'application/hl7-v2');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).issue[0].diagnostics, /MSH/);
  assert.equal((await post('{not json', 'application/fhir+json')).status, 400);
  assert.equal((await post('x'.repeat(300 * 1024), 'application/hl7-v2')).status, 413);
  const page = await worker.fetch(new Request('https://x/'), { ASSETS: { fetch: () => new Response('asset') } });
  assert.equal(await page.text(), 'asset');
  const get = await worker.fetch(new Request('https://x/api/v1/results'), { ASSETS: { fetch: () => new Response('asset') } });
  assert.equal(get.status, 405);
});

test('parseMessage picks the parser by content', () => {
  assert.equal(parseMessage(oru())[0].source, 'hl7v2');
  assert.equal(parseMessage(JSON.stringify(fhirHba1c()))[0].source, 'fhir');
});

test('ingest: a cancelled result with no case opens nothing', () => {
  const [x] = parseOru(oru({ st: 'X' }));
  const a = ingest([], x, NOW, () => ROUTING);
  assert.equal(a.action, 'not-actionable');
  assert.equal(a.cases.length, 0);
});

test('ingest: a resend whose value changed without the correction status still raises the flag', () => {
  const [p] = parseOru(oru({ st: 'P' }));
  const a = ingest([], p, NOW, () => ROUTING);
  const [f] = parseOru(oru({ value: 'Negative' }));
  const b = ingest(a.cases, f, NOW, () => ROUTING);
  assert.equal(b.action, 'corrected');
  assert.ok(status(b.cases[0], NOW).flags.includes('result-corrected'));
  const h = ingest([], fromFhir(fhirHba1c(7))[0], NOW, () => ROUTING);
  assert.equal(ingest(h.cases, fromFhir(fhirHba1c(11))[0], NOW, () => ROUTING).action, 'corrected');
  assert.equal(ingest(h.cases, fromFhir(fhirHba1c(7))[0], NOW, () => ROUTING).action, 'duplicate');
});

test('ingest: another test on the same accession is triaged on its own, never swallowed as a duplicate', () => {
  const a = ingest([], fromFhir(fhirHba1c(9))[0], NOW, () => ROUTING);
  const glucose = { ...fromFhir(fhirHba1c(9))[0], loinc: '2345-7', value: 180 };
  assert.equal(ingest(a.cases, glucose, NOW, () => ROUTING).action, 'needs-review');
  const fitToo = { ...parseOru(oru())[0], accession: 'HBA-501' };
  const b = ingest(a.cases, fitToo, NOW, () => ROUTING);
  assert.equal(b.action, 'opened');
  assert.equal(new Set(b.cases.map((c) => c.id)).size, 2);
});

test('API: two results in one message are ingested together, a repeat inside it is a duplicate', async () => {
  const twice = `${oru()}\r${oru().split('\r')[3]}`;
  const j = await (await post(twice, 'application/hl7-v2')).json();
  assert.deepEqual(j.results.map((r) => r.action), ['opened', 'duplicate']);
});

test('ingest: a result the lab corrects after the case was closed still reaches a clinician', () => {
  const [r] = parseOru(oru());
  const a = ingest([], r, NOW, () => ROUTING);
  const shut = [{ ...a.cases[0], events: [{ step: 'closed', at: NOW, by: 'Dr. Specialist', evidence: 'plan.pdf', outcome: 'done' }] }];
  assert.equal(worklist(shut, NOW).length, 0);
  const [c] = parseOru(oru({ value: 'Negative', st: 'C' }));
  const b = ingest(shut, c, NOW, () => ROUTING);
  assert.equal(b.action, 'corrected');
  const s = status(b.cases[0], NOW);
  assert.equal(s.stage, 'closed'); // the correction never reopens the case by itself
  assert.deepEqual(s.flags, ['result-corrected']);
  assert.equal(worklist(b.cases, NOW).length, 1);
  assert.deepEqual(alerts(b.cases, NOW).map((x) => [x.to, x.kind]), [['Dr. PHC', 'result-corrected']]);
  const seen = [{ ...b.cases[0], correction: { ...b.cases[0].correction, reviewed: true } }];
  assert.equal(worklist(seen, NOW).length, 0);
});
