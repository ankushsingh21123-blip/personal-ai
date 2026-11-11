# Internship Tracker

A real, full-stack internship-application tracker built by Ankush Singh as a
proof project: **frontend + Express backend + SQLite database, working
end-to-end**. No mocks, no demo data, no paid service, no external CDN —
everything runs locally for $0.

## What it does

- **Add / list / update / delete** internship applications: company, role,
  status, deadline, link, notes.
- **Filter by status** — applied, interview, offer, rejected.
- **Stats** — total / applied / interview / offer / rejected.
- **Deadline sorting** — soonest first, applications with no deadline last.
- **Real persistence** — data lives in a SQLite file
  (`data/internships.db`) and survives a server restart (covered by a test).
- **Local token auth** — same pattern as Ankush's personal-ai app:
  `127.0.0.1` only, `X-Anku-Token` header on every `/api` route except
  `/api/health`, token in `.env.local` (git-ignored, generated on first
  start if missing).

## Stack

- Frontend: static HTML/CSS/vanilla JS in `public/` — no framework, no CDN.
- Backend: Node.js + Express 5 (`server.js`).
- Database: SQLite via `node:sqlite` (built into Node 22.5+, stable in
  Node 24) — no extra database dependency (`db.js`).
- Tests: `node --test`, hitting the live server over HTTP
  (`tests/test.js`).

## How to run

Requirements: Node.js 22 or newer (developed and tested on Node v24.22.1).

```bash
cd proof-internship-tracker
npm install
npm start
```

On first start the server generates a token and writes it to `.env.local`
(git-ignored, mode `0600`). Open http://127.0.0.1:3200, paste the token
from `.env.local` into the token box, and click **Connect**. The token is
kept in `sessionStorage` (cleared when the tab closes) and is never logged.

To use your own token instead, copy the example file first:

```bash
cp .env.example .env.local
# edit ANKU_TOKEN in .env.local, then npm start
```

Optional environment variables: `PORT` (default `3200`), `ANKU_TOKEN`,
`DB_PATH` (default `data/internships.db`).

## API

All `/api` routes except `/api/health` require header
`X-Anku-Token: <token>`.

| Method | Route | Description |
| ------ | ----- | ----------- |
| GET | `/api/health` | Health check, no auth |
| GET | `/api/stats` | `{ total, applied, interview, offer, rejected }` |
| GET | `/api/applications?status=&sort=` | List; `status` is one of the four statuses; `sort=deadline` or `sort=newest` |
| GET | `/api/applications/:id` | One application |
| POST | `/api/applications` | Create; `company` and `role` required, `status` defaults to `applied` |
| PUT | `/api/applications/:id` | Partial update |
| DELETE | `/api/applications/:id` | Delete |

Validation (400 on bad input): `status` must be `applied`, `interview`,
`offer` or `rejected`; `deadline` must be a real date in `YYYY-MM-DD`;
`link` must be a valid `http(s)` URL; `notes` max 2000 characters;
`company`/`role` max 200 characters.

## How to test

```bash
npm test
```

The suite spawns the real server as a child process on 127.0.0.1:34123
with a throwaway SQLite file, then exercises it over HTTP: auth
(missing/wrong token), validation, full CRUD, status filter, deadline
sorting, stats, and persistence across a server restart (including a
check that the DB file on disk starts with the `SQLite format 3` header).
See [TEST-REPORT.md](TEST-REPORT.md) for the latest real run.

## Project layout

```
proof-internship-tracker/
├── server.js          # Express app + validation + auth (127.0.0.1 only)
├── db.js              # SQLite schema + helpers (node:sqlite)
├── public/
│   ├── index.html     # UI: token box, stats, add/edit form, table
│   ├── style.css      # Styling, no external fonts or assets
│   └── app.js         # Vanilla JS calling the API with X-Anku-Token
├── tests/test.js       # node --test, live-server tests
├── package.json
├── .env.example       # No real keys — copy to .env.local
├── .gitignore         # node_modules/, .env.local, data/, *.db
├── README.md
└── TEST-REPORT.md
```

## Security notes

- Binds `127.0.0.1` only — never `0.0.0.0`. No CORS. Security headers
  (`nosniff`, `DENY` framing, `no-referrer`, `default-src 'self'` CSP).
- `.env.local` is git-ignored; the token is never logged and never appears
  in any source file. `.env.example` contains no real keys.
- JSON body limit 100kb; every write route validates its input.
