# Loop Closer

Prototype for the **Future Health Digital Innovation Challenge 2026**, Population Health · Challenge 05, *Closing the Screening-to-Care Loop*.

Live demo: https://loop-closer.designmaster.workers.dev (simulated cohort, no real patient data)

Deck: [docs/LoopCloser-deck.pdf](docs/LoopCloser-deck.pdf). Demo video (2:28): https://youtu.be/gonR0ie1Dg0 , also in docs/demo.mp4 (rebuild with `python3 demo_slides.py video/demo.json`; real captures of the live demo in video/shots/).

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

## Review round (November 2026): what changed

The review team asked for three things. All three are in the demo and covered by `test/followup.test.mjs`.

- **Your own patient data.** "Add your own patient" takes a pseudonymised reference, programme, result, urgency, language, result date and case owner. "Start from an empty list" drops the simulated cohort. Cases are saved only in the browser. Every step is then recorded on the case (date, who, evidence), in order: a step cannot be skipped or dated before the previous one.
- **End-to-end follow-up with automated alerts.** A demo clock ("Advance one day") drives the alerts: each case that slips past its service level alerts the owner of the late step, urgent ones escalate to the case owner clinician, hand-offs with no owner go to the programme coordinator. A missed appointment ("Patient did not attend") is flagged, alerts owner and case owner, and sets a rebooking deadline (48 h urgent, 5 days priority, 14 days routine). "New date booked" records the new appointment: the alert stops, the patient message shows the new date, and the case is late again only if that day passes with no attendance on record. A new date further out than the urgency allows (14 days urgent, 42 priority, 90 routine) is flagged to the case owner until an earlier one is booked. A patient question that arrives after closure is still flagged once it waits past its service level. Owners can be assigned on any step. Closure records who signed, when, the evidence document and the outcome; it cannot close without an outcome.
- **Interactive patient notifications.** Sending the message records "Patient notified". The patient's reply moves the case: 1 confirms understanding (the case advances), 2 opens a nurse question with a service level, and at the appointment step 1 confirms attendance and 3 asks for a new date (flag and alert to the owner). Arabic-Indic digits count; free text is never dropped, it becomes a question for the care navigator.

## Interoperability

Results come in and case state goes out in the formats screening programs already use. The same pure module (`public/interop.mjs`) runs in the browser, in the API and in the tests.

- **In:** HL7 v2 `ORU^R01` and FHIR R4 `DiagnosticReport` with its `Observation`. Three programs mapped by LOINC: FIT (29771-3, 57905-2), mammography (24606-6, BI-RADS), HbA1c (4548-4). The thresholds are an explicit table the program's clinical lead owns (`RULES`).
- **One case per accession number and test.** The lab resending a message opens nothing new. A corrected or cancelled result raises a flag on the open case for a clinician: nothing closes itself. The same flag goes up when a resend carries a different value without the correction status (a preliminary that changes at final). A result cancelled before any case existed opens nothing, and a second test on the same order is triaged on its own.
- **Nothing vanishes.** A code with no rule or a value the rule cannot read goes to a person, never to "normal". `reconcile` compares the lab's list with what arrived, and `feedHealth` raises an alarm when the feed goes silent.
- **Out:** one idempotent FHIR R4 transaction per case: `Task` per step (owner, due date, flags), `ServiceRequest`, `Communication`, `Appointment` for each missed visit and each new date (`noshow`, `cancelled` when replaced, `booked`, `fulfilled`), `Encounter`, `CarePlan`, `DocumentReference`, `Provenance` for the clinician's sign-off. Patients travel as a pseudonym.

Proof, reproducible from this repo:

- `node scripts/samples.mjs` writes the sample messages and bundles to [docs/samples/](docs/samples/).
- [docs/fhir-validation.txt](docs/fhir-validation.txt): output of the official HL7 FHIR Validator on those bundles.
- [docs/fhir-roundtrip.txt](docs/fhir-roundtrip.txt): `node scripts/roundtrip.mjs` against the public HAPI FHIR R4 server. 17 resources created, read back, and posted again with no duplicates. That run also found a real bug our own tests missed (a `urn:` fullUrl the server refused), fixed in this repo.
- [docs/bench.txt](docs/bench.txt): `node scripts/bench.mjs`. On one laptop core, over 10,000 lab messages per second, and a 100,000-case worklist in under 5 seconds.

Try the API with the sample message. The public demo stores nothing and refuses anything not marked as test data (`MSH-11` = T or D, FHIR `meta.tag` HTEST):

```
curl -X POST https://loop-closer.designmaster.workers.dev/api/v1/results \
  -H 'content-type: application/hl7-v2' --data-binary @docs/samples/oru-fit-positive.hl7
```

Architecture, data governance and the pilot path: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
- Not connected yet to a production lab interface or to Malaffi. The formats are built and tested (see Interoperability); the connection needs a program and its security review.
- A demo browser keeps its changes in memory. A pilot adds the case store, login and real message delivery described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT, Design Master Solutions LLC.
