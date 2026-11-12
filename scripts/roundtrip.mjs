// Posts a sample transaction Bundle to a FHIR R4 server, reads it back, posts it again and checks that nothing duplicated.
// Run: node scripts/roundtrip.mjs [base] [sample] (default: the public HAPI test server and bundle-closed; synthetic data tagged HTEST only).
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'https://hapi.fhir.org/baseR4';
const H = { accept: 'application/fhir+json', 'content-type': 'application/fhir+json' };
const SAMPLE = process.argv[3] ?? 'bundle-closed';
const bundle = JSON.parse(readFileSync(new URL(`../docs/samples/${SAMPLE}.json`, import.meta.url)));
const ids = (type, pick = () => true) => bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === type && pick(r)).map((r) => r.id);
const get = async (path) => (await fetch(`${BASE}/${path}`, { headers: H })).json();
const send = async () => {
  const r = await fetch(BASE, { method: 'POST', headers: H, body: JSON.stringify(bundle) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 600)}`);
  const codes = j.entry.map((e) => e.response.status.split(' ')[0]);
  return { http: r.status, type: j.type, entries: j.entry.length, codes: Object.fromEntries([...new Set(codes)].map((c) => [c, codes.filter((x) => x === c).length])) };
};
const key = bundle.entry.find((e) => e.resource.resourceType === 'Patient').resource.id;
const tasksFor = async () => {
  const r = await fetch(`${BASE}/Task?subject=Patient/${key}&_summary=count`, { headers: H });
  return (await r.json()).total;
};
console.log('server', BASE, SAMPLE, new Date().toISOString());
console.log('first post ', JSON.stringify(await send()));
for (const id of ids('Task', (t) => t.id.endsWith('-closed'))) {
  const closure = await get(`Task/${id}`);
  console.log('read back  ', closure.resourceType, closure.id, closure.status, closure.owner?.display, 'version', closure.meta?.versionId);
}
// What the receiving system sees of the missed visit and the new date: status and day as stored by the server.
for (const id of ids('Appointment')) {
  const a = await get(`Appointment/${id}`);
  console.log('read back  ', a.resourceType, a.id, a.status, a.start, 'basedOn', a.basedOn?.[0]?.reference, 'version', a.meta?.versionId);
}
console.log('tasks      ', await tasksFor());
console.log('second post', JSON.stringify(await send()));
console.log('tasks again', await tasksFor());
