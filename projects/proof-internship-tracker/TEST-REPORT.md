# TEST-REPORT — Internship Tracker

## Latest run

- **Date:** 12 Nov 2026, ~01:25 IST (run on this VM)
- **Command:** `npm test` (`node --test tests/test.js`)
- **Node:** v24.22.1, npm 10.9.4
- **Result: 9 passed, 0 failed, 0 skipped** (exit code 0, ~5.9 s)

```
✔ health endpoint works without a token
✔ frontend is served and contains the app (no CDN)
✔ auth: missing token is rejected on protected routes
✔ auth: wrong token is rejected
✔ validation: missing company and role are rejected
✔ validation: bad status, deadline, link and oversized notes are rejected
✔ CRUD: create, read, update, delete an application end to end
✔ list: filter by status, sort by deadline, stats add up
✔ persistence: data survives a server restart (real SQLite file)
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 5890.695599
```

## How the tests work

The suite spawns the real server as a child process
(`node server.js`, port 34123, `127.0.0.1`) with a throwaway SQLite file
in the OS temp dir, waits for `/api/health`, then drives it over HTTP
with `fetch`. Nothing is tested against an in-process app object or a
mock database. The persistence test kills the server, restarts it
against the same DB file, and re-reads the row — plus checks the file on
disk starts with the `SQLite format 3` header.

## What is covered

| Area | Checks |
| ---- | ------ |
| Auth | No token → 401 on `/api/applications` and `/api/stats`; wrong token → 401; `/api/health` works without a token |
| Validation | Missing/blank company or role → 400; bad status (incl. wrong case) → 400; bad deadline format, impossible date (`2026-02-30`), bad month → 400; non-URL / non-http(s) link → 400; notes over 2000 chars → 400 |
| CRUD | Create (201, defaults status to `applied`), read one, partial update (untouched fields survive), invalid update → 400, empty update → 400, delete, then read/delete/update of missing id → 404 |
| Filter / sort / stats | `?status=interview` returns only interviews; bad status/sort → 400; `?sort=deadline` orders soonest first with no-deadline last; stats sum: total = applied + interview + offer + rejected |
| Persistence | Row survives a server restart; DB file is real SQLite |
| Frontend | `/` serves the app HTML, `app.js`/`style.css` load, no CDN URLs in the page |

## Failures found and fixed during development

1. **First run: 5 passed, 4 failed.** Two bugs, both fixed and re-run green:
   - `POST /api/applications` without a `status` returned 400 instead of
     defaulting to `applied`. Fixed in `server.js` (`validateApplication`
     now defaults a missing status to `applied` on create; PUT without a
     status still leaves it unchanged).
   - The test helper `createApp` read the response body twice
     (`res.text()` inside the assert message, then `res.json()`), which
     throws `Body is unusable`. Fixed in `tests/test.js` to read the body
     only on failure.
2. **Second run: 9 passed, 0 failed.** Re-run a third time to confirm:
   9 passed, 0 failed, exit code 0.

## Manual smoke test (live server, separate from `npm test`)

Started with `PORT=3200 ANKU_TOKEN=smoke-token-123 node server.js` and
checked with curl on 12 Nov 2026 ~01:23 IST:

- `GET /api/health` (no token) → 200 `{"ok":true,"service":"internship-tracker","version":"1.0.0"}`
- `GET /api/applications` (no token) → 401
- `POST /api/applications` (valid token, Acme Robotics / Backend Intern) → 201, row returned with `id: 1`
- `GET /api/stats` → `{"total":1,"applied":1,"interview":0,"offer":0,"rejected":0}`
- `GET /` (frontend) → 200

The smoke-test database was deleted afterwards, so the shipped project
starts empty. The smoke token was passed via environment only and does
not appear in any source file.
