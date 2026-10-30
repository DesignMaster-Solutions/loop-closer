# Builds the Loop Closer demo: real captures of the live app, real npm test, `say` narration -> docs/demo.mp4
import subprocess, pathlib
from PIL import Image, ImageDraw, ImageFont
V = pathlib.Path(__file__).parent
R = V.parent
W, H = 1920, 1080
F = "/System/Library/Fonts/HelveticaNeue.ttc"
SANS, SUB = ImageFont.truetype(F, 58, index=1), ImageFont.truetype(F, 32)
MONO = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 26)
tests = [l.replace("ℹ ", "").split(" (")[0] for l in
         subprocess.run(["npm", "test"], cwd=R, capture_output=True, text=True).stdout.splitlines()
         if l.startswith(("✔", "✖", "ℹ pass", "ℹ fail"))]
S = [
 ("Loop Closer", ["Every actionable screening result reaches care,", "with an owner, a due date and a documented closure.", "",
   "loop-closer.designmaster.workers.dev", "", "Design Master Solutions · Future Health Digital Innovation Challenge", "Population Health 05. Simulated cohort, no real patient data."], None, None,
  "Loop Closer. A screening program only helps when an actionable result becomes care. Between the lab, primary care and the specialist, results get lost, and nobody can say who owns the next step."),
 ("Only what needs a person", ["The coordinator does not", "read every result.", "", "Ranked: escalation,", "rejected referral,", "waiting consultation,", "overdue, no owner."], None, ["worklist.png"],
  "The coordinator does not read sixty results. This list shows only the cases that need a person today. Urgent escalations come first, then rejected referrals, waiting consultations, overdue steps and hand-offs with no owner."),
 ("One case, one pathway", ["Nine steps, from result", "to documented closure.", "", "Each next step has", "a named owner and a due", "date set by urgency."], None, ["case.png"],
  "Open a case and you see the full journey, from the result to closure. Each finished step shows who did it and when. The next step has a named owner and a due date set by urgency."),
 ("The patient knows what is next", ["Arabic or English.", "Always: this is not", "a diagnosis.", "", "Reply 1: I understood.", "Reply 2: talk to a nurse.", "", "Wording needs clinical", "and language review."], None, ["message_ar.png"],
  "The patient gets a plain next step in Arabic or English, and it always says this is not a diagnosis. They reply one to confirm they understood, or two to reach a nurse. A clinical team must review this wording before real use."),
 ("Consultation stays on the case", ["Patient to clinician.", "Clinician to clinician.", "", "A question has its own", "service level, and an", "unanswered one is flagged.", "", "Closing needs a clinician", "and every step documented."], None, ["consult.png"],
  "Questions stay on the case. The patient's request for a nurse and a doctor's question to the specialist each have a service level, and an unanswered one is flagged. Closure stays human. This case cannot close, because steps are missing. Only a clinician can close, with evidence. No A I makes a clinical decision here."),
 ("A simulated scenario", ["Same 60 simulated cases.", "", "Left silent: 19 closed, 23 stalled unseen.", "With the worklist: 29 closed, 7 stalled.", "",
   "Assumes coordinators resolve 80% of exceptions", "two days after the service level is breached.", "", "This is a model, not a measured outcome.", "A pilot replaces it with the program's real baseline."], None, None,
  "Here is a simulation on the same sixty cases. Left silent, nineteen close and twenty three stall with nobody acting. With the worklist, assuming coordinators resolve eighty percent of exceptions, twenty nine close and seven stall. This is a model, not a measured outcome. A pilot on one program would replace it with real numbers."),
 ("Tested", [], ["$ npm test"] + tests, None,
  "The rules are covered by automated tests, including escalation, clinician only closure and consultations. Lab and referral integration is the next step. It is not built yet."),
 ("Loop Closer", ["Every result. One owner. Documented closure.", "", "loop-closer.designmaster.workers.dev", "github.com/DesignMaster-Solutions/loop-closer  (MIT)"], None, None,
  "Loop Closer. Every actionable result, one accountable owner, and a documented closure. The demo and the code are public. Thanks for watching."),
]
parts = []
for i, (title, sub, mono, shots, narr) in enumerate(S):
    im = Image.new("RGB", (W, H), "#0d2a2a"); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 10], fill="#14b8a6")
    d.text((90, 70), title, font=SANS, fill="white")
    y = 210
    for l in sub: d.text((90, y), l, font=SUB, fill="#d5ece8"); y += 54
    if mono:
        d.rounded_rectangle([70, y - 20, W - 70, min(H - 90, y + 42 * len(mono) + 20)], 16, fill="#061616")
        for l in mono:
            col = "#86efac" if l.startswith(("$", "✔", "pass")) else "#fca5a5" if l.startswith(("✖",)) else "#e2e8f0"
            d.text((100, y), l, font=MONO, fill=col); y += 42
    for s in shots or []:
        p = Image.open(V/s).convert("RGB"); p.thumbnail((1250, 850))
        x = W - 60 - p.width
        im.paste(p, (x, 170)); d.rectangle([x - 2, 168, x + p.width + 1, 171 + p.height], outline="#2c6e68", width=2)
    d.text((90, H - 66), "Loop Closer · Design Master Solutions LLC · simulated data", font=MONO, fill="#7fa8a2")
    png, aiff, mp4 = V/f"s{i}.png", V/f"s{i}.aiff", V/f"s{i}.mp4"
    im.save(png)
    subprocess.run(["say", "-v", "Samantha", "-r", "180", "-o", aiff, narr], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", png, "-i", aiff, "-af", "apad=pad_dur=0.6",
                    "-shortest", "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30",
                    "-c:a", "aac", "-ar", "48000", mp4], check=True)
    parts.append(mp4)
(V/"list.txt").write_text("".join(f"file '{p}'\n" for p in parts))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", V/"list.txt", "-c", "copy",
                "-movflags", "+faststart", R/"docs/demo.mp4"], check=True)
