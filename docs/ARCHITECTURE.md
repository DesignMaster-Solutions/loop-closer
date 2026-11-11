# Loop Closer architecture and pilot path

What exists today is marked **built**. What a pilot adds is marked **pilot**. Nothing here is a claim of clinical validation: there has been no clinical testing and no real patient data.

## Components

```
Lab / screening program        Loop Closer                              People
HL7 v2 ORU^R01  ─┐      ┌─ parse and validate   (built)
FHIR R4 report  ─┼─────▶│  triage by LOINC rule (built, table owned by the clinical lead)
                 │      │  case per order + test (built)        ──▶ coordinator worklist (built)
Lab's list ──────┘      │  reconcile + feed alarm (built)        ──▶ clinician closes with evidence (built)
                        │  case engine: owner, service level, flags (built)
                        │  patient message EN/AR (built; delivery: pilot)  ──▶ patient
                        └─ FHIR R4 transaction out (built)       ──▶ FHIR server / Malaffi (pilot)
```

`public/loop.mjs` and `public/interop.mjs` are pure functions with no I/O. The browser, the Worker and the tests run the same code, so a rule tested here is the rule that runs.

## Clinical safety decisions in the code

| Failure the program fears | What the code does | Test |
|---|---|---|
| A result never arrives | `reconcile` lists what the lab issued and we never saw; `feedHealth` alarms on a silent feed | `reconciliation finds...`, `a silent feed is an alarm` |
| Duplicate case from a resend | One case per accession number and test; a second test on the same order is triaged on its own | `the same message twice...`, `another test on the same accession...` |
| A value that changes without the correction status is hidden as a duplicate | Same flag as a correction | `a resend whose value changed...` |
| A result cancelled before any case existed opens one | Opens nothing, and says why | `a cancelled result with no case...` |
| A correction that lands after the case was closed is never seen | The case stays closed, the flag goes on the worklist and to the case owner | `a result the lab corrects after the case was closed...` |
| A corrected result is ignored | A flag on the open case, ranked near the top of the worklist; never closes by itself | `a corrected or cancelled result...` |
| An unknown test or unreadable value is treated as normal | Returned as `needs-review`, for a person | `unmapped and unreadable...` |
| A hand-off nobody owns | `unassigned` flag from the moment the case opens | `a program with no routing...` |
| Closure without care | Clinician only, every step documented, care plan evidence required | `closure needs every step...` |

## Data governance

- **The public demo cannot see real data.** The API refuses any message not marked as test (`MSH-11` = T or D, FHIR `meta.tag` HTEST), stores nothing and has no database. All sample data is synthetic.
- **Pseudonym only in the export.** `Patient` carries a program identifier and a language, never a name.
- **No AI decides anything clinical.** Triage is a visible rule table and every flag has a stated reason. There is no model scoring patients to explain or to bias. Equity is checked by reporting measures by language and program (pilot).
- **Pilot hosting.** UAE Federal Law No. 2 of 2019 on ICT in health fields keeps health data inside the UAE unless an exception applies, so the engine runs inside the program's environment or a UAE region. The same module can run as a container on the program's own servers: it has no runtime dependencies and needs no outside call.
- **Pilot security.** Role-based access, an audit trail (`Provenance` for closure is built, an `AuditEvent` per read is pilot), encryption in transit and at rest, and review against ADHICS, the Abu Dhabi health information and cyber security standard. Formal legal review comes before any pilot.

## Scale

Measured in [bench.txt](bench.txt) on one laptop core: over 10,000 lab messages per second through parse and triage, about 10,000 FHIR bundles per second, a 100,000-case worklist in under 5 seconds. The engine holds no state, so it scales by running more copies. In a pilot, case lookup by accession moves to an indexed store; today's `ingest` scans an in-memory list, which is fine for a demo and not for production.

## What a pilot adds

1. Case store and login (FHIR server such as HAPI, or Postgres, inside the program environment).
2. A connection to the lab's interface engine, and to Malaffi, the Abu Dhabi health information exchange, subject to its onboarding.
3. Real delivery of patient messages, with undelivered messages surfacing as exceptions.
4. Service levels, rules and Arabic wording reviewed and owned by a named clinical lead. The team has no clinician today, and we say so.
5. A shadow period on one screening program, then a measured comparison with its baseline.
