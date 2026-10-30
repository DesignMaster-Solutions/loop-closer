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
| Cross-provider coordination | Owners per provider (screening program, navigator, primary care, specialist); rejected referrals surface at the acceptance step |
| Safe, human-governed escalation | Urgent cases with any flag go to the top of the coordinator worklist; closure only by a clinician and only with every step and a care-plan document (`canClose`, `close`) |

The coordinator screen shows only the cases that need a human today, ranked escalation → rejected referral → overdue → unassigned, then by urgency and due date.

## Run

```
npm test          # node --test, no dependencies
npx wrangler dev  # static site on Cloudflare Workers assets
```

## Assumptions and limitations

- SLA hours per urgency are illustrative defaults; each screening program sets its own.
- The cohort (60 cases across colorectal FIT, mammography and HbA1c screening) is generated with a fixed seed to reproduce the drop-offs the challenge describes. It is not real data and the metrics are not outcomes.
- Arabic patient text was written for the prototype and must be reviewed by the program's clinical and language teams before any use.
- No integration yet with lab systems (HL7 v2 ORU / FHIR DiagnosticReport) or referral systems (FHIR ServiceRequest/Task); the case model maps onto them and is the next step.

## License

MIT, Design Master Solutions LLC.
