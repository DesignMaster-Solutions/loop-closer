// Simulated cohort (no real patient data): 60 actionable results from three screening
// programs, with drop-offs at the transitions the challenge names. Seeded, so reproducible.
import { STEPS, SLA_HOURS } from './loop.mjs';

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const PROGRAMS = [
  { name: 'Colorectal (FIT)', test: 'Positive FIT', confirm: 'Colonoscopy', spec: 'Gastroenterology' },
  { name: 'Breast (mammography)', test: 'BI-RADS 4', confirm: 'Biopsy', spec: 'Breast clinic' },
  { name: 'Diabetes (HbA1c)', test: 'HbA1c 7.9%', confirm: 'Repeat HbA1c', spec: 'Endocrinology' },
];
const STAFF = {
  'Screening program': ['Lab liaison A. Haddad'],
  'Care navigator': ['Navigator S. Rahman', 'Navigator L. Costa'],
  'Primary care': ['Dr. M. Al Nuaimi (PHC Khalifa City)', 'Dr. R. Pereira (PHC Al Bateen)'],
  'Specialist service': ['Dr. K. Iyer (Specialist hospital)'],
  'Case owner (clinician)': ['Dr. M. Al Nuaimi (PHC Khalifa City)'],
};

export function cohort(now = '2026-11-15T09:00:00Z', n = 60, seed = 7) {
  const r = rng(seed);
  const end = new Date(now).getTime();
  const out = [];
  for (let k = 0; k < n; k++) {
    const p = PROGRAMS[k % 3];
    const urgency = r() < 0.2 ? 'urgent' : r() < 0.6 ? 'priority' : 'routine';
    const issued = end - (5 + r() * 120) * 864e5;
    const c = { id: `C-${String(1001 + k)}`, program: p.name, finding: p.test, confirm: p.confirm, specialist: p.spec,
      urgency, lang: r() < 0.5 ? 'ar' : 'en', issuedAt: new Date(issued).toISOString(), events: [], owner: {} };
    let t = issued;
    for (const s of STEPS.slice(1)) {
      if (r() < 0.12 && s.id !== 'closed') c.owner[s.id] = null; // hand-off nobody picked up
      else c.owner[s.id] = STAFF[s.owner][Math.floor(r() * STAFF[s.owner].length)];
      if (s.id === 'accepted' && r() < 0.1) { c.referral = 'rejected'; break; }
      const sla = SLA_HOURS[urgency][s.id] * 36e5;
      const took = sla * (0.2 + r() * 1.3); // some steps run late
      if (t + took > end || r() < 0.06) break; // not done yet, or the patient dropped off here
      t += took;
      if (s.id === 'closed') {
        c.events.push({ step: s.id, at: new Date(t).toISOString(), by: c.owner[s.id] });
        break;
      }
      c.events.push({ step: s.id, at: new Date(t).toISOString(), by: c.owner[s.id],
        evidence: s.id === 'care' ? `${p.spec} plan ${c.id}.pdf` : undefined });
    }
    out.push(c);
  }
  return out;
}
