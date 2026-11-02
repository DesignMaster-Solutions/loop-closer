// Writes the sample messages and the FHIR bundles that docs/fhir-validation.txt validates. Run: node scripts/samples.mjs
import { writeFileSync } from 'node:fs';
import { parseMessage, ingest, toFhirBundle } from '../public/interop.mjs';
import { close, requestConsult } from '../public/loop.mjs';
import { routingFor } from '../public/cases.mjs';

const NOW = '2026-11-15T09:00:00Z';
const OUT = new URL('../docs/samples/', import.meta.url);
const write = (name, text) => writeFileSync(new URL(name, OUT), text.endsWith('\n') ? text : `${text}\n`);

const oru = [
  'MSH|^~\\&|LAB|DEMOLAB|LOOPCLOSER|PROGRAM|20261101080000+0400||ORU^R01|MSG-FIT-77120|T|2.5.1',
  'PID|1||PSEUDO-4471^^^PROGRAM^PI||||||||||||ara',
  'OBR|1||FIT-77120|29771-3^Hemoglobin [Presence] in Stool from gastrointestinal lower by Immunoassay^LN|||20261031100000+0400||||||||||||||20261101073000+0400|||F',
  'OBX|1|CWE|29771-3^Hemoglobin [Presence] in Stool from gastrointestinal lower by Immunoassay^LN||Positive|||A|||F|||20261101073000+0400',
].join('\r');
const fhir = {
  resourceType: 'Bundle', type: 'collection', meta: { tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' }] },
  entry: [
    { fullUrl: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0001', resource: { resourceType: 'Patient', id: 'p1', identifier: [{ system: 'urn:loop-closer:pseudonym', value: 'PSEUDO-9' }], communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en' }] } }] } },
    { fullUrl: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0002', resource: { resourceType: 'Observation', id: 'o1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }] }, subject: { reference: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0001' }, effectiveDateTime: '2026-11-14T10:00:00+04:00', valueQuantity: { value: 7.9, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } } },
    { fullUrl: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0003', resource: { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', identifier: [{ system: 'urn:loop-closer:accession', value: 'HBA-501' }], code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }] }, subject: { reference: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0001' }, issued: '2026-11-15T07:30:00+04:00', result: [{ reference: 'urn:uuid:7a1f0b7e-0d2a-4a7e-9d39-0b6f7c1f0002' }] } },
  ],
};
write('oru-fit-positive.hl7', oru.replace(/\r/g, '\n'));
write('report-hba1c.fhir.json', JSON.stringify(fhir, null, 2));

const base = ingest([], parseMessage(oru)[0], NOW, routingFor).cases[0];
const step = (c, steps) => ({ ...c, events: steps.map((s, i) => ({ step: s, at: new Date(Date.parse(c.issuedAt) + (i + 1) * 864e5).toISOString(), by: c.owner[s], evidence: s === 'care' ? 'Gastroenterology plan C-FIT-77120.pdf' : undefined })) });
const midway = requestConsult(step(base, ['notified', 'acknowledged', 'confirmatory']), { kind: 'clinician-to-clinician', from: base.owner.confirmatory, to: base.specialist, question: 'Is colonoscopy the right next step for this patient?' }, '2026-11-06T09:00:00Z');
const rejected = { ...step(base, ['notified', 'acknowledged', 'confirmatory', 'referred']), referral: 'rejected' };
const closed = close(step(base, ['notified', 'acknowledged', 'confirmatory', 'referred', 'accepted', 'appointed', 'care']), { name: base.owner.closed, clinician: true }, NOW);
write('bundle-midway.json', JSON.stringify(toFhirBundle(midway, NOW), null, 2));
write('bundle-referral-rejected.json', JSON.stringify(toFhirBundle(rejected, NOW), null, 2));
write('bundle-closed.json', JSON.stringify(toFhirBundle(closed, NOW), null, 2));
