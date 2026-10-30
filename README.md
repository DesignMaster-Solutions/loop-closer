# Loop Closer

Prototype for the **Future Health Digital Innovation Challenge 2026**, Population Health · Challenge 05, *Closing the Screening-to-Care Loop*.

Live demo: https://loop-closer.designmaster.workers.dev (simulated cohort, no real patient data)

## What it does

Every actionable screening result becomes a case that walks one pathway:

issued → patient notified → patient confirmed understanding → confirmatory test → referral sent → referral accepted → appointment attended → treatment or surveillance plan → closed with evidence

| Challenge requirement | How the prototype answers it |
|---|---|
| End-to-end case visibility | One timeline per case, with date, person and evidence for each step (`status`, timeline view) |
| Clear ownership and timely progression | Each next step has a named owner and a due date from the urgency SLA table (`SLA_HOURS`); unassigned hand-offs and overdue steps are flagged |
| Patient-centered communication | Plain-language next step in English or Arabic, always "this is not a diagnosis", with a reply to confirm understanding or ask for a nurse (`patientMessage`) |
| Cross-provider consultation | Owners per provider; rejected referrals surface at the acceptance step; patient-to-clinician and clinician-to-clinician questions live on the case with their own service level (`requestConsult`, `answerConsult`, `consult-waiting` flag) |
| Safe, human-governed escalation | Urgent cases with any flag go to the top of the coordinator worklist; closure only by a clinician and only with every step and a care-plan document (`canClose`, `close`) |
| Closure and patient impact measures | Notified, understood, referral completion, median days to specialist, unresolved results, where cases wait and why they stalled (`metrics`) |

The coordinator screen shows only the cases that need a human today, ranked escalation → rejected referral → overdue → unassigned, then by urgency and due date.

## Simulated scenario (not a measured outcome)

Same 60 seeded cases, two arms. In the first, a stall (no owner at a hand-off, rejected referral, unreachable patient) stays silent. In the second, the worklist surfaces it and we assume coordinators resolve 80% of exceptions two days after the service level is breached.

| Measure | Silent | With worklist |
|---|---|---|
| Closed with evidence | 19 | 29 |
| Stalled with nobody acting | 23 | 7 |
| Patient notified | 93% | 98% |
| Patient confirmed understanding | 89% | 95% |
| Referrals completed | 67% | 73% |

Drop-off rates (4% per hand-off, 3% per step, 10% rejected referrals) and the 80% are modelling assumptions. A pilot replaces them with the program's own baseline. Reproduce: `cohort(now, 60, 7, 0)` against `cohort(now, 60, 7, 0.8)` in `public/cases.mjs`.

## Run

```
npm test          # node --test, no dependencies
npx wrangler dev  # static site on Cloudflare Workers assets
```

## Assumptions and limitations

- SLA hours per urgency are illustrative defaults; each screening program sets its own.
- The cohort (60 cases across colorectal FIT, mammography and HbA1c screening) is generated with a fixed seed to reproduce the drop-offs the challenge describes. It is not real data and the metrics are not outcomes. Changes made in the demo live in the browser only.
- Arabic patient text was written for the prototype and must be reviewed by the program's clinical and language teams before any use.
- No integration yet with lab systems (HL7 v2 ORU / FHIR DiagnosticReport) or referral systems (FHIR ServiceRequest/Task); the case model maps onto them and is the next step.

## License

MIT, Design Master Solutions LLC.
