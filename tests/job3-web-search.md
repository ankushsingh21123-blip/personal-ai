# Test Job 3 — web search and summarise

## Prompt used

> Search the web for the current status of SpaceX Starship Flight 15 (as of 11 Nov 2026): is there a confirmed launch date, and what is the latest official word? Summarise in under 150 words with the source. This matters because a Nova Explains Short on Starship is scheduled to publish 12 Nov 6 PM IST and the launch date must be re-verified that morning.

## Result — PASSED (web search + Gemini brain, 11 Nov 2026 ~15:12 IST)

- **Search:** `browser.search` (news vertical), query "SpaceX Starship Flight 15 launch date November 2026 status". 7 results, consistent: USA Today, The Space Road (live page), Engadget, shuttertothestars, starlust.org.
- **Model:** `gemini-3.6-flash`, `finishReason: STOP`. ~9 seconds.
- **Summary returned (verbatim, ~120 words):**

> As of November 11, 2026, SpaceX is targeting Friday, November 13, 2026, for Starship Flight 15, with a 75-minute launch window opening at 5:45 p.m. ET (4:45 p.m. CST).
>
> According to official updates from SpaceX, the mission featuring Booster 22 and Ship 42 aims to deploy 26 Starlink V3 satellites and attempt the first-ever retrieval to catch both the Super Heavy booster and the upper-stage ship at the launch site.
>
> The key caveat is that there is no fully confirmed launch date yet, as the flight remains strictly pending final FAA regulatory approval.
>
> This information is sourced from USA Today, The Space Road, Engadget, shuttertothestars, and starlust.org.

- **Check:** date, window, vehicles, payload, dual-catch first, and the pending-approval caveat all trace to the search results. No invented facts. **Real finding for Ankush:** Flight 15 is targeted **13 Nov** (14 Nov 4:15–5:30 AM IST), pending FAA approval — the Nova Explains Starship Short scheduled to publish **12 Nov 6 PM IST** is about a launch the next day, and the date must still be re-verified on the morning of 12 Nov. Job 3 PASSED.
