// Loop Closer interoperability: lab results in (HL7 v2 ORU^R01, FHIR R4), case state out (FHIR R4 transaction Bundle).
// Pure functions, no I/O: the same code runs in the browser, in the Worker and in node --test.
import { STEPS, status, patientMessage } from './loop.mjs';

export class MessageError extends Error {}

// Which results are actionable. Illustrative defaults: each program's clinical lead owns this table.
// A value the rule cannot read goes to a person. It is never treated as normal.
export const RULES = {
  '29771-3': fit, '57905-2': fit,
  '4548-4': (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return { unreadable: true };
    if (n < 6.5) return { actionable: false, rule: 'HbA1c below 6.5%' };
    return { actionable: true, rule: 'HbA1c 6.5% or above', urgency: n >= 10 ? 'urgent' : n >= 8 ? 'priority' : 'routine',
      program: 'Diabetes (HbA1c)', finding: `HbA1c ${n}%`, confirm: 'Repeat HbA1c', specialist: 'Endocrinology' };
  },
  '24606-6': (v) => {
    const m = /BI-?RADS\s*(?:category\s*)?([0-6])/i.exec(String(v));
    if (!m) return { unreadable: true };
    const cat = +m[1];
    if (cat === 1 || cat === 2) return { actionable: false, rule: `BI-RADS ${cat}` };
    if (cat === 6) return { actionable: false, rule: 'BI-RADS 6: known cancer, already in care' };
    const biopsy = cat >= 4;
    return { actionable: true, rule: `BI-RADS ${cat}`, urgency: cat === 5 ? 'urgent' : cat === 4 ? 'priority' : 'routine',
      program: 'Breast (mammography)', finding: `BI-RADS ${cat}`, confirm: biopsy ? 'Biopsy' : 'Diagnostic imaging', specialist: 'Breast clinic' };
  },
};

function fit(v) {
  const s = String(v);
  if (/neg|not detected/i.test(s)) return { actionable: false, rule: 'FIT negative' };
  if (!/pos|detected/i.test(s)) return { unreadable: true };
  return { actionable: true, rule: 'FIT positive', urgency: 'priority', program: 'Colorectal (FIT)', finding: 'Positive FIT', confirm: 'Colonoscopy', specialist: 'Gastroenterology' };
}

export function triage(result, rules = RULES) {
  const rule = rules[result.loinc];
  if (!rule) return { actionable: false, unmapped: true, rule: `no rule for code ${result.loinc}` };
  const t = rule(result.value);
  return t.unreadable ? { actionable: false, unreadable: true, rule: `value not readable: ${result.value}` } : t;
}

// HL7 v2 timestamp (YYYYMMDDHHMM[SS][+ZZZZ]) to ISO. No zone in the message: read as UTC and say so in the docs.
function v2time(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(ts ?? '');
  if (!m) return null;
  const zone = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${zone}`).toISOString();
}

const V2_STATUS = { F: 'final', C: 'corrected', X: 'cancelled', P: 'preliminary', R: 'preliminary' };
const LANG = { ara: 'ar', ar: 'ar', eng: 'en', en: 'en' };

export function parseOru(text) {
  const segs = String(text).trim().split(/\r\n|\r|\n/).filter(Boolean);
  if (!segs[0]?.startsWith('MSH') || segs[0].length < 8) throw new MessageError('not an HL7 v2 message: no MSH segment');
  const FS = segs[0][3], CS = segs[0][4], ESC = segs[0][6];
  const esc = new RegExp(`\\${ESC}([FSTRE])\\${ESC}`, 'g');
  const unesc = (s = '') => s.replace(esc, (_, k) => ({ F: FS, S: CS, T: segs[0][7], R: segs[0][5], E: ESC }[k]));
  const fields = (s) => s.split(FS).map(unesc);
  const msh = fields(segs[0]);
  // MSH-1 is the separator itself, so field n of MSH sits at index n-1.
  if (!/^ORU\^R01/.test(msh[8] ?? '')) throw new MessageError(`only ORU^R01 is accepted, got ${msh[8] || 'nothing'}`);
  const test = msh[10] !== 'P'; // MSH-11 processing id: P is production; D and T are not real results.
  let pid = [], obr = null;
  const out = [];
  for (const s of segs.slice(1)) {
    const f = fields(s);
    if (f[0] === 'PID') pid = f;
    if (f[0] === 'OBR') obr = f;
    if (f[0] !== 'OBX') continue;
    if (!obr) throw new MessageError('OBX before any OBR');
    const [code, display, system] = (f[3] ?? '').split(CS);
    const st = f[11] || obr[25] || 'F';
    const raw = f[5] ?? '';
    out.push({ source: 'hl7v2', test, accession: obr[3]?.split(CS)[0] || obr[2]?.split(CS)[0] || null,
      patient: pid[3]?.split(CS)[0] || null, lang: LANG[(pid[15] ?? '').split(CS)[0].toLowerCase()] ?? 'en',
      loinc: system === 'LN' ? code : null, display, value: f[2] === 'NM' ? Number(raw) : raw, unit: f[6] ?? null,
      status: V2_STATUS[st] ?? 'final', at: v2time(f[14]) ?? v2time(obr[22]) ?? v2time(msh[6]) });
  }
  if (!out.length) throw new MessageError('no OBX segment: the message carries no result');
  if (out.some((r) => !r.accession)) throw new MessageError('OBR has no accession number (OBR-3 or OBR-2)');
  return out;
}

const loincOf = (cc) => cc?.coding?.find((x) => x.system === 'http://loinc.org') ?? null;

export function fromFhir(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const entries = doc.resourceType === 'Bundle' ? (doc.entry ?? []) : [{ resource: doc }];
  const find = (ref, owner) => {
    if (!ref) return null;
    if (ref.startsWith('#')) return owner?.contained?.find((x) => x.id === ref.slice(1)) ?? null;
    return entries.find((e) => e.fullUrl === ref || (e.resource && `${e.resource.resourceType}/${e.resource.id}` === ref))?.resource ?? null;
  };
  const reports = entries.map((e) => e.resource).filter((r) => r?.resourceType === 'DiagnosticReport');
  if (!reports.length) throw new MessageError('no DiagnosticReport in the message');
  const test = (x) => !!x?.meta?.tag?.some((t) => t.code === 'HTEST');
  return reports.map((rep) => {
    const pat = find(rep.subject?.reference, rep);
    const obs = (rep.result ?? []).map((r) => find(r.reference, rep)).filter(Boolean);
    const o = obs.find((x) => loincOf(x.code)) ?? obs[0];
    const code = loincOf(o?.code) ?? loincOf(rep.code);
    const value = o?.valueQuantity?.value ?? o?.valueString ?? o?.valueCodeableConcept?.text ?? o?.valueCodeableConcept?.coding?.[0]?.display ?? rep.conclusion ?? null;
    const accession = rep.identifier?.[0]?.value ?? rep.id;
    if (!accession) throw new MessageError('DiagnosticReport has no identifier');
    return { source: 'fhir', test: test(doc) || test(rep), accession, patient: pat?.identifier?.[0]?.value ?? rep.subject?.reference ?? null,
      lang: LANG[pat?.communication?.[0]?.language?.coding?.[0]?.code?.toLowerCase()] ?? 'en', loinc: code?.code ?? null, display: code?.display, value,
      unit: o?.valueQuantity?.unit ?? null, status: rep.status === 'entered-in-error' ? 'cancelled' : (rep.status ?? 'final'), at: rep.issued ? new Date(rep.issued).toISOString() : null };
  });
}

export function parseMessage(text) {
  const s = String(text).trimStart();
  if (s.startsWith('{')) {
    try { return fromFhir(JSON.parse(s)); } catch (e) { throw e instanceof MessageError ? e : new MessageError(`not valid JSON: ${e.message}`); }
  }
  return parseOru(s);
}

// One case per accession number and test, whatever the feed resends. Corrections raise a flag for a person: nothing closes itself.
export function ingest(cases, result, now, routing = () => ({})) {
  const open = cases.find((c) => c.accession === result.accession && (!c.loinc || c.loinc === result.loinc));
  if (open) {
    // A lab that resends a different value without the correction status (preliminary then final) is still a change a person must see.
    const changed = result.status === 'corrected' || result.status === 'cancelled' || triage(result).finding !== open.finding;
    if (!changed) return { cases, action: 'duplicate', id: open.id };
    const next = { ...open, correction: { status: result.status === 'cancelled' ? 'cancelled' : 'corrected', value: result.value, at: result.at ?? now, reviewed: false } };
    return { cases: cases.map((c) => (c === open ? next : c)), action: 'corrected', id: open.id };
  }
  if (result.status === 'cancelled') return { cases, action: 'not-actionable', reason: 'cancelled by the lab before any case was opened' };
  const t = triage(result);
  if (t.unmapped || t.unreadable) return { cases, action: 'needs-review', reason: t.rule };
  if (!t.actionable) return { cases, action: 'not-actionable', reason: t.rule };
  // A second actionable test on the same order gets its own case and its own id.
  const id = cases.some((c) => c.accession === result.accession) ? `C-${result.accession}-${result.loinc}` : `C-${result.accession}`;
  const c = { id, accession: result.accession, patient: result.patient, lang: result.lang, urgency: t.urgency, program: t.program,
    finding: t.finding, confirm: t.confirm, specialist: t.specialist, rule: t.rule, loinc: result.loinc, display: result.display, test: result.test,
    issuedAt: result.at ?? now, events: [], owner: routing(t.program) };
  return { cases: [...cases, c], action: 'opened', id: c.id, reason: t.rule };
}

// What the lab says it issued against what reached a case or was triaged as non-actionable.
export function reconcile(labAccessions, cases, seen = []) {
  const have = new Set([...cases.map((c) => c.accession), ...seen]);
  return { missing: labAccessions.filter((a) => !have.has(a)) };
}

export function feedHealth(lastMessageAt, now, maxSilentHours = 24) {
  const silentHours = lastMessageAt ? (new Date(now) - new Date(lastMessageAt)) / 36e5 : Infinity;
  return { stale: silentHours > maxSilentHours, silentHours };
}

// fullUrl must be absolute, and relative references resolve against it (the HAPI server refused our first urn: form).
const FHIR_BASE = 'https://loop-closer.designmaster.workers.dev/fhir';
const xml = (t) => String(t).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const safe = (s) => String(s).replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 50);

// The case as an idempotent FHIR R4 transaction: PUT with stable ids, so resending never duplicates.
export function toFhirBundle(c, now) {
  const key = safe(c.id);
  const res = [];
  const add = (r) => {
    if (c.test) r.meta = { tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST', display: 'test health data' }] };
    r.text = { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">Loop Closer ${r.resourceType} for case ${xml(c.id)}</div>` };
    res.push(r);
    return { reference: `${r.resourceType}/${r.id}` };
  };
  const ev = (step) => c.events.find((e) => e.step === step);
  const patient = add({ resourceType: 'Patient', id: `lc-pat-${key}`, identifier: [{ system: 'urn:loop-closer:pseudonym', value: c.patient ?? c.id }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: c.lang ?? 'en' }] } }] });
  const report = add({ resourceType: 'DiagnosticReport', id: `lc-rep-${key}`, identifier: [{ system: 'urn:loop-closer:accession', value: c.accession ?? c.id }],
    status: c.correction?.status === 'cancelled' ? 'cancelled' : c.correction ? 'corrected' : 'final',
    code: c.loinc ? { coding: [{ system: 'http://loinc.org', code: c.loinc, ...(c.display ? { display: c.display } : {}) }] } : { text: c.program },
    subject: patient, issued: c.issuedAt, conclusion: c.finding });
  const referred = ev('referred');
  const referral = add({ resourceType: 'ServiceRequest', id: `lc-ref-${key}`, status: ev('appointed') ? 'completed' : referred ? 'active' : 'draft', intent: 'order',
    code: { text: `Referral to ${c.specialist}` }, subject: patient, reasonReference: [report], ...(referred ? { authoredOn: referred.at, requester: { display: referred.by } } : {}),
    ...(c.owner?.accepted ? { performer: [{ display: c.owner.accepted }] } : {}) });
  const s = status(c, now);
  for (const st of STEPS.slice(1)) {
    const e = ev(st.id);
    const isNext = st.id === s.next;
    const taskStatus = e ? 'completed' : isNext && st.id === 'accepted' && c.referral === 'rejected' ? 'rejected' : isNext ? (s.owner ? 'requested' : 'ready') : 'draft';
    const who = e?.by ?? c.owner?.[st.id];
    add({ resourceType: 'Task', id: `lc-${key}-${st.id}`, status: taskStatus, intent: 'order',
      code: { coding: [{ system: 'urn:loop-closer:step', code: st.id, display: st.label }] },
      focus: st.id === 'referred' || st.id === 'accepted' ? referral : report, for: patient, authoredOn: c.issuedAt,
      ...(e ? { lastModified: e.at } : {}), ...(who ? { owner: { display: who } } : {}),
      ...(isNext ? { restriction: { period: { end: s.dueAt } } } : {}),
      ...(isNext && s.flags.length ? { businessStatus: { text: s.flags.join(', ') } } : {}) });
  }
  const told = ev('notified');
  if (told) add({ resourceType: 'Communication', id: `lc-com-${key}-notified`, status: 'completed', subject: patient, about: [report], sent: told.at, recipient: [patient],
    ...(told.by ? { sender: { display: told.by } } : {}), payload: [{ contentString: patientMessage({ ...c, events: [told] }, told.at, c.lang) ?? '' }] });
  const ack = ev('acknowledged');
  if (ack) add({ resourceType: 'Communication', id: `lc-com-${key}-ack`, status: 'completed', subject: patient, about: [report], received: ack.at, sender: patient, payload: [{ contentString: 'Patient confirmed understanding (reply 1)' }] });
  (c.consults ?? []).forEach((q, i) => add({ resourceType: 'Communication', id: `lc-com-${key}-q${i}`, status: q.answer ? 'completed' : 'in-progress', subject: patient, about: [report], sent: q.at,
    category: [{ text: q.kind }], sender: { display: q.from }, recipient: [{ display: q.to }], payload: [{ contentString: q.question }, ...(q.answer ? [{ contentString: q.answer }] : [])] }));
  const seen = ev('appointed');
  // Missed visits and new dates as Appointments. A booking that is replaced is cancelled, one the patient then
  // misses becomes the noshow, and the one the patient attended is fulfilled. A miss with no booking on file
  // carries the time it was recorded: the original slot was never given to us.
  let cur = null;
  c.events.forEach((e, i) => {
    if (e.step !== 'missed' && e.step !== 'rebooked') return;
    const open = cur?.status === 'booked';
    if (e.step === 'missed' && open) { cur.status = 'noshow'; cur = null; return; }
    if (open) cur.status = 'cancelled';
    const day = e.step === 'rebooked' ? { start: `${e.for.slice(0, 10)}T00:00:00.000Z`, end: e.for } : { start: e.at, end: e.at };
    cur = { resourceType: 'Appointment', id: `lc-appt-${key}-${i}`, status: e.step === 'missed' ? 'noshow' : 'booked', ...day, created: e.at, basedOn: [referral],
      description: e.step === 'missed' ? `Patient did not attend (recorded by ${e.by ?? 'the program'})` : `New date booked by ${e.by ?? 'the program'}`,
      participant: [{ actor: patient, status: 'accepted' }] };
    add(cur);
  });
  if (seen && cur?.status === 'booked') cur.status = 'fulfilled';
  if (seen) add({ resourceType: 'Encounter', id: `lc-enc-${key}`, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: patient, basedOn: [referral], period: { start: seen.at }, ...(seen.by ? { participant: [{ individual: { display: seen.by } }] } : {}) });
  const care = ev('care');
  if (care) {
    const doc = care.evidence ? add({ resourceType: 'DocumentReference', id: `lc-doc-${key}`, status: 'current', subject: patient, date: care.at, content: [{ attachment: { contentType: 'application/pdf', title: care.evidence } }] }) : null;
    const closed = ev('closed');
    const plan = add({ resourceType: 'CarePlan', id: `lc-plan-${key}`, status: closed ? 'completed' : 'active', intent: 'plan', subject: patient, created: care.at, title: `Treatment or surveillance plan, ${c.specialist}`,
      ...(care.by ? { author: { display: care.by } } : {}), ...(closed?.outcome ? { note: [{ text: `Closure outcome: ${closed.outcome}` }] } : {}), ...(doc ? { supportingInfo: [doc, report] } : { supportingInfo: [report] }) });
    if (closed) add({ resourceType: 'Provenance', id: `lc-prov-${key}`, target: [plan, report], recorded: closed.at, agent: [{ who: { display: closed.by } }] });
  }
  return { resourceType: 'Bundle', type: 'transaction', entry: res.map((r) => ({ fullUrl: `${FHIR_BASE}/${r.resourceType}/${r.id}`, resource: r, request: { method: 'PUT', url: `${r.resourceType}/${r.id}` } })) };
}
