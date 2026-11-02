// How the pure core behaves at program scale. Run: node scripts/bench.mjs
import { parseMessage, triage, toFhirBundle } from '../public/interop.mjs';
import { worklist, metrics } from '../public/loop.mjs';
import { cohort } from '../public/cases.mjs';
import { readFileSync } from 'node:fs';

const NOW = '2026-11-15T09:00:00Z';
const time = (label, n, fn) => { const t = performance.now(); fn(); const ms = performance.now() - t; console.log(`${label.padEnd(44)} ${n} in ${ms.toFixed(0)} ms (${Math.round(n / (ms / 1000)).toLocaleString('en-US')}/s)`); };
const msg = readFileSync(new URL('../docs/samples/oru-fit-positive.hl7', import.meta.url), 'utf8');
time('HL7 v2 parse + triage', 100000, () => { for (let i = 0; i < 100000; i++) triage(parseMessage(msg)[0]); });
const cases = cohort(NOW, 100000, 7, 0);
time('worklist over open cases', 100000, () => worklist(cases, NOW));
time('program metrics', 100000, () => metrics(cases, NOW));
time('FHIR bundle export', 10000, () => { for (let i = 0; i < 10000; i++) toFhirBundle(cases[i], NOW); });
console.log(process.version, process.platform, process.arch);
