# Test Job 2 — draft an email from mailbox data (DRAFT ONLY — do not send)

## Source

Live Gmail read (Scaler mailbox): the Instructor Team email of 10 Nov 2026, 19:27 UTC / 11 Nov 00:57 IST, subject "Action Required: Clear Your PSP Backlogs During Diwali Break" — Advanced DSA 1 average PSP below 30%, catch up during the Diwali break, be up to date when classes resume. No topics or resume date given.

## Prompt used

> Using only the facts in that email, draft a short reply from Ankush Singh to the Instructor Team (noreply@scaler.com): acknowledge the below-30% PSP in Advanced DSA 1, state a concrete catch-up plan for the Diwali break (2 hours/day on Advanced DSA 1, in the gap between his other commitments), and ask which topics to prioritise since the email lists none. Do not invent a resume date, topics, or any score. Draft only — do not send.

## Result — PASSED (Gemini brain, 11 Nov 2026 ~15:10 IST)

- **Source verified live:** Gmail `+read` on the Scaler account (d8f0b477ddf44c038c6c43ddc70777fc), message 1a1c6edd15a999ed, retrieved 11 Nov 15:09 IST. Body confirmed: Advanced DSA 1 PSP below 30%, catch up during Diwali break, up to date when classes resume. No topics, no resume date. Saved copy: `~/workspace/email/gmail/c520c55c2da7febad83c017de0a6d2b27270641c63c5a96b2e9f72455e5c3b5d.md`.
- **Model:** `gemini-3.6-flash`, `finishReason: STOP`. ~7 seconds.
- **Draft produced (verbatim):**

> DRAFT ONLY — NOT SENT
>
> To: Instructor Team <noreply@scaler.com>
> From: Ankush Singh <ankush.25bcs10759@sst.scaler.com>
> Subject: Re: Action Required: Clear Your PSP Backlogs During Diwali Break
>
> Dear Instructor Team,
>
> Thank you for bringing this to my attention. I acknowledge that my average PSP in Advanced DSA 1 is currently below 30%.
>
> To clear my backlogs, I plan to dedicate 2 hours per day to Advanced DSA 1 during the Diwali break to catch up on my coursework.
>
> Since no specific topics were listed in the email, could you please advise which topics I should prioritize?
>
> Best regards,
> Ankush Singh

- **Check:** uses only the email's facts; asks for topics (not invented); 88 words, under 120. **Nothing was sent.** Job 2 PASSED.
