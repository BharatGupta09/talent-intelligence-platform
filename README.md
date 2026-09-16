# AI Resume Screening & Talent Intelligence Platform

**Live demo → https://talent-intelligence-platform-six.vercel.app**

An evidence-first recruitment platform. Every claim it makes about a candidate
is traceable to the line of the resume it came from.

<!-- Add screenshots here once deployed:
![Landing page](./docs/screenshot-landing.png)
-->

---

## The problem

Most resume screeners infer. A resume that says *"worked with cloud
technologies"* becomes an AWS qualification, and a recruiter acts on something
the candidate never actually claimed.

This platform refuses to infer. That phrase resolves to **not demonstrated**,
and becomes a question for the interview rather than a false credential.

Every requirement is resolved to one of exactly three states, and the two
positive states must carry the phrase from the resume that supports them:

| State | Meaning |
|---|---|
| **Demonstrated** | The resume explicitly supports this. Evidence quoted. |
| **Insufficient evidence** | Hinted at, but not established. Evidence quoted. |
| **Not demonstrated** | Not supported by the source at all. |

When the model is uncertain, it is instructed to choose the weaker state.
Under-claiming is treated as correct; over-claiming is treated as a failure.

---

## How an assessment is produced

```
Job posting
    ↓  AI extracts discrete, individually assessable requirements
Specification  (required / preferred / nice-to-have)
    ↓  AI assesses the resume against each one, citing evidence
Evidence states
    ↓  Deterministic scoring engine — fixed arithmetic, no model involvement
Score + full breakdown
    ↓  Recruiter reviews the matrix beside the original PDF
Decision  (stored separately; never overwrites the assessment)
```

**The language model never produces the score.** It supplies evidence states
and one bounded 0–1 semantic signal. A scoring engine then applies importance
weights and role-specific dimension weights using plain arithmetic.

This matters because language models are not consistent — ask twice, get 84
then 79. A recruiter cannot defend a decision on that basis, and in many
jurisdictions a rejected candidate can ask why. Fixed arithmetic gives the same
number for the same input, every time, with the breakdown visible on screen.

---

## Engineering notes

**Authorization is enforced in the database, not the interface.** 78
row-level security policies mean an unauthorized API call returns nothing even
if a UI check were bypassed. The API-layer guards are a second line, not the
only line.

**Recruiters cannot browse candidates.** There is no global talent pool. A
candidate becomes visible to a recruiter only by applying to that recruiter's
specific role — enforced by a policy that joins through job ownership.

**Applications snapshot their job specification at submission.** Editing a role
later cannot retroactively change an assessment that has already been made.

**The AI queue survives provider outages.** Exponential backoff, `Retry-After`
support, and partial-result preservation. A failed analysis never destroys an
uploaded file — the record degrades to a recoverable state instead.

**Cross-tenant access returns 404, not 403**, so application IDs cannot be
probed for existence.

**220 automated assertions** across the scoring engine, authorization model,
PDF handling, AI behaviour, and live HTTP responses.

---

## Architecture

```
Next.js (App Router) ──► API routes / server components
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
            Neon          Scoring         Groq
          Postgres        engine       (LLM only)
        + Cloudflare  (deterministic)
              R2
```

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15, React 19, TypeScript | Server components keep secrets server-side by construction |
| Database | Neon PostgreSQL, serverless driver | Row-level security moves authorization below the API |
| Object storage | Cloudflare R2, private bucket | Presigned direct upload sidesteps Vercel's 4.5 MB body cap; no egress fees |
| AI | Groq | Fast inference on a free tier; abstracted behind one service module |
| Validation | Zod | Model output is schema-validated before it can reach the database |
| Styling | Tailwind CSS | — |
| Hosting | Vercel | — |

### Project structure

```
app/                    Pages and API routes
  api/                  25 route handlers
  candidate/            Candidate workspace
  recruiter/            Recruiter workspace
  admin/                Administration
lib/
  ai/                   Groq client, prompts, queue, service layer
  scoring/engine.ts     Deterministic scoring — the core of the product
  auth/                 Password hashing, JWT sessions, server-side guards
  db/                   Pool, transaction-scoped identity, query builder,
                        embedded-select compiler, user/service clients
  storage/r2.ts         Cloudflare R2 via the S3-compatible API
  resume/pdf.ts         PDF validation and extraction
db/migrations/          Schema (28 tables) and RLS policies
scripts/                Seed script and test suites
```

---

## Running it yourself

Requires free accounts with Neon, Cloudflare R2, Groq and Vercel.

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in your own values, then apply the
schema and provision the least-privilege application role:

```bash
npm run db:migrate && npm run db:setup-role
```

`db:setup-role` matters: Neon's owner role carries `BYPASSRLS`, which switches
off every RLS policy in the schema. The application must connect as `tip_app`.
See [`DEPLOY.md`](./DEPLOY.md) section 0.

```bash
npm test && npm run dev
```

Seeding, once the database is up (set `SEED_PASSWORD_CANDIDATE`,
`SEED_PASSWORD_RECRUITER` and `SEED_PASSWORD_ADMIN` in `.env.local` first):

```bash
npm run seed
```

Full deployment walkthrough: [`DEPLOY.md`](./DEPLOY.md).
Honest scope notes, including what is *not* built: [`STATUS.md`](./STATUS.md).

---

## Responsible use

This is decision support, not decision automation.

- No candidate is ever automatically rejected — not for a low score, a missing
  requirement, or a match category.
- The recruiter's decision is stored separately from the AI assessment, so a
  deliberate disagreement between the two stays visible rather than being
  erased.
- The model is instructed never to infer or comment on age, gender, ethnicity,
  nationality, religion, marital status, disability or health, and never to
  treat a name or institution as a proxy for them.
- Every recruiter-facing AI output carries a disclosure of what it was
  generated from.

---

## Licence

All rights reserved. Available to view for evaluation purposes.
