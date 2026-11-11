// Stateless translation endpoint for the public demo: lab message in, case and FHIR bundle out. Stores nothing.
import { parseMessage, ingest, toFhirBundle, MessageError } from '../public/interop.mjs';

const MAX_BYTES = 256 * 1024;
const outcome = (status, code, diagnostics) => new Response(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] }),
  { status, headers: { 'content-type': 'application/fhir+json' } });

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname !== '/api/v1/results') return env.ASSETS.fetch(req);
    if (req.method !== 'POST') return outcome(405, 'not-supported', 'POST an HL7 v2 ORU^R01 message or a FHIR R4 Bundle with a DiagnosticReport');
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) return outcome(413, 'too-long', `message over ${MAX_BYTES} bytes`);
    let results;
    try { results = parseMessage(text); } catch (e) {
      if (e instanceof MessageError) return outcome(400, 'invalid', e.message);
      throw e;
    }
    // This host is a public demo: it must never see a real result, even for a moment.
    if (results.some((r) => !r.test)) return outcome(422, 'security', 'The public demo accepts test data only: MSH-11 = T or D (HL7 v2), or meta.tag HTEST (FHIR). A pilot runs inside the program environment.');
    const now = new Date().toISOString();
    let cases = []; // one message, one run: a repeat inside it is a duplicate, a second test gets its own case
    return Response.json({ results: results.map((r) => {
      const { cases: next, action, id, reason } = ingest(cases, r, now);
      cases = next;
      const c = action === 'duplicate' ? null : cases.find((x) => x.id === id);
      return { result: r, action, reason, ...(c ? { case: c, bundle: toFhirBundle(c, now) } : {}) };
    }) });
  },
};
