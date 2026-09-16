# Build status

## Verified

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `next build` (production) | succeeds |
| Scoring engine suite | 23 |
| Authorization suite | 80 |
| PDF ingestion suite | 32 |
| AI layer suite | 50 |
| Migration compatibility suite | 64 |
| Embedded-select suite | 42 |
| **Integration suite (real PostgreSQL)** | **120** |
| Live HTTP suite | 43 |

**454 assertions.** `npm test` covers the static suites;
`npm run test:integration` and `npm run test:http` need a live database.

The integration suite runs against a real Neon database, not a mock. That
distinction earned its keep: three production-breaking defects survived 291
static assertions, TypeScript and a clean production build, and were caught the
first time real SQL executed.

### 1. The application was bypassing row-level security entirely

Neon issues `neondb_owner`, and that role carries the `BYPASSRLS` attribute.
`BYPASSRLS` overrides row-level security unconditionally — including `FORCE ROW
LEVEL SECURITY`. Connected as the owner, all ~100 policies were inert.

It was observed, not theorised: a recruiter read another recruiter's
applications while `owns_application()` correctly returned `false`, because the
policy was never consulted.

The fix restores the shape Supabase had, where `authenticated` was neither the
table owner nor a bypassing role. `scripts/db-setup-role.ts` provisions
`tip_app` — `NOBYPASSRLS`, not an owner, no `CREATE` on the schema — and the
owner connection is now used only for migrations.

### 2. The auth path could not satisfy its own policies

Registration writes `profiles` and `candidate_profiles`. Under Supabase that
came from a `SECURITY DEFINER` trigger on `auth.users`; moving the logic into
application code left it without the equivalent permission. Worse,
`authenticate()` joins `profiles`, so with RLS genuinely enforced **every
password would have appeared wrong**. And `ON CONFLICT DO NOTHING` needs the
`SELECT` policy for its arbiter, so the insert failed even where the insert
policy allowed it. Four policies, gated on the same transaction-scoped
`app.auth_op` flag the `users` table already used, fixed it.

### 3. NUMERIC arrived as two different types

node-postgres decodes `numeric` as a string; `jsonb_build_object` emits a real
JSON number. The same column therefore arrived as `"85.50"` when selected
directly and `85.5` through an embedded resource. Every caller is written
against numbers, so `lib/db/pool.ts` now registers a type parser for OID 1700.

Earlier rounds also found: weight normalisation escaping its bounds
(clamp-then-rescale ran once, pushing `technical_skills` to 0.64 against a 0.45
ceiling — replaced with iterative projection, verified against 5,000 random
weight vectors), a dead `draft` branch in the seed script, and two of my own
authorization tests passing for the wrong reason — a character-window regex
bled into the adjacent policy statement, and static parsing could not see
policies generated inside a `do $$` loop. Both were replaced with a real policy
parser. A security test that passes for the wrong reason is worse than no test.

## Architecture

PostgreSQL is Neon, reached through the serverless driver rather than
PostgREST. Every query runs inside its own transaction carrying
`SET LOCAL app.user_id`, which is what keeps the RLS policies authoritative now
that nothing supplies `auth.uid()`. A PostgREST-compatible query builder sits
in front, so the 154 existing call sites were not rewritten; embedded selects
compile to correlated `jsonb` subqueries.

Resumes live in a private Cloudflare R2 bucket, reached over the S3-compatible
API. The browser uploads straight to a presigned URL — required, not an
optimisation, because a Vercel function caps request bodies at 4.5 MB against a
5 MB resume limit.

Sessions are `scrypt` password hashes plus HS256 JWTs in httpOnly cookies.
Middleware verifies the cookie signature locally, with no network dependency,
so a database outage can no longer stop pages rendering.

## Built

**Data layer** — 28 tables, foreign keys, check constraints, partial and
trigram indexes, `updated_at` triggers. RLS `FORCE`d and deny-by-default on
every table, with `SECURITY DEFINER` helpers that avoid policy recursion.
Private object storage scoped so a recruiter reaches a resume only through an
application to their own job.

**AI layer** — single Groq abstraction; nine Zod-validated operations sharing
one evidence contract; corrective retry on schema failure; queue with
optimistic claim, exponential backoff and `Retry-After` support; partial unique
index preventing duplicate in-flight work; failure paths that preserve stored
artifacts; usage and event logging.

**Scoring** — deterministic engine. The model supplies evidence states and one
bounded 0–1 semantic signal; arithmetic produces the number. Per-role weights
are clamped and renormalised. Unused dimensions redistribute rather than
scoring zero. Full component breakdown; contributions sum to the total.

**Candidate** — profile editor with completeness; resume upload with drag-drop,
PDF validation, extraction and ATS analysis; section rewriting with
fact-preservation warnings; role browsing; pre-application match preview with
no score exposed; apply flow with spec snapshotting; application tracking;
interview preparation and interactive practice with per-answer feedback.

**Recruiter** — job create/edit with AI-derived specification; ranked applicant
table with seven simultaneous filters; candidate workspace pairing the
requirement matrix with the original PDF; score breakdown; skill and experience
intelligence; decision panel where the recruiter's stage never overwrites the
assessment; notes and tags; interview kits; multi-candidate comparison; per-job
and per-candidate CSV export with formula-injection guards; pipeline board.

**Admin** — user management with self-lockout prevention; role oversight; AI
configuration and feature toggles; queue inspection with manual retry; system
monitoring; storage and processing health.

## Not built / not yet verified

- **Never deployed.** Everything above is verified locally and against a real
  Neon database. The application has not run on Vercel, against a real R2
  bucket, or against a real Groq key. Until it has, "works" means "compiles,
  passes 454 assertions, and serves correctly under a live HTTP server."
- **R2 and Groq are unconfigured.** `.env.local` still holds placeholders for
  both. No upload, download or AI call has been made against the real services.
- **Vercel Hobby runs cron at most once a day**, at an approximate time. The
  queue therefore depends on the opportunistic user-triggered drain described
  in `DEPLOY.md` section 6. A frequent schedule needs a paid plan.
- **Neon free tier scales to zero** after 5 minutes idle and this cannot be
  disabled. Expect a cold start of roughly a second on the first request.
- **Seeded resumes have no PDF file.** The seed inserts extracted text
  directly, so the recruiter PDF viewer degrades to its fallback for seeded
  candidates. Upload a real PDF before demoing the viewer.
- **Storage cleanup on hard-deleted candidates** is not implemented; orphaned
  objects would accumulate. Irrelevant at demo scale.

## Honest read

The database layer is the part that has actually been proven. It was rebuilt
from empty twice, exercised by 120 assertions against real PostgreSQL, and its
security model was found broken and then fixed — which is worth more than the
same model passing a static audit.

What remains is genuinely unproven rather than merely untidy: no deployment, no
real object storage, no real AI call. `DEPLOY.md` is the path through that, and
its section 0 is the one part not to skim.
