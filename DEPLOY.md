# Deployment runbook — Neon + Cloudflare R2 + Groq + Vercel

Total cost: $0. Every service below is used on its free tier.

The application no longer uses Supabase. It talks to PostgreSQL directly over
the Neon serverless driver, stores resumes in a private R2 bucket via the
S3-compatible API, and runs as a normal Next.js app on Vercel.

---

## 0. The one rule that matters most

**The application runtime must never connect to PostgreSQL as the database
owner.**

Neon issues `neondb_owner`, and that role carries the `BYPASSRLS` attribute.
`BYPASSRLS` overrides row-level security unconditionally — including `FORCE ROW
LEVEL SECURITY`. An application connected as the owner has all ~100 policies in
`db/migrations/0002_rls.sql` silently switched off. No error, no warning; every
user simply sees every row.

This is not hypothetical. It was observed during Phase 3: a recruiter read
another recruiter's applications while `owns_application()` correctly returned
`false`, because the policy was never consulted.

The split this repo uses:

| Role | Used for | RLS |
|---|---|---|
| `neondb_owner` | migrations and schema maintenance only | bypasses (by design) |
| `tip_app` | the application runtime | **fully subject to policies** |

`scripts/db-setup-role.ts` provisions `tip_app` with `NOBYPASSRLS`, no
ownership of any table, and no `CREATE` on the schema — so the application
cannot alter its own security model. It refuses to finish if the role ends up
with `BYPASSRLS`.

`DATABASE_URL` in Vercel must be the **`tip_app`** connection string.
`DATABASE_URL_OWNER` should **not** be set in Vercel at all; it is a local
migration credential.

---

## 1. Neon (~5 min)

1. Create a project at neon.tech. Free tier, any region.
2. From the dashboard, copy both connection strings:
   - **Pooled** into `DATABASE_URL`
   - **Direct / unpooled** into `DATABASE_URL_UNPOOLED`
3. Put the direct one in `.env.local` as `DATABASE_URL_OWNER` as well, then:

```bash
npm run db:migrate
```

```bash
npm run db:setup-role
```

`db:migrate` applies `db/migrations/*.sql` as the owner. `db:setup-role` then
creates `tip_app`, rewrites `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to that
least-privilege role, and preserves `DATABASE_URL_OWNER` for future migrations.
It never prints the generated password.

4. Verify RLS is on everywhere — this must return **zero rows**:

```sql
select tablename from pg_tables
 where schemaname = 'public' and rowsecurity = false;
```

5. Verify the application role cannot bypass RLS — must return `f`:

```sql
select rolbypassrls from pg_roles where rolname = 'tip_app';
```

**Free-tier note:** Neon scales a branch to zero after 5 minutes idle and this
cannot be disabled on the free plan. The first request after an idle period
pays a cold start of roughly a second. Open the app once before a demo.

---

## 2. Cloudflare R2 (~5 min)

1. Cloudflare dashboard, R2, Create bucket. Name it, e.g.
   `talent-intelligence-resumes`.
2. **Keep it private.** Do not enable public access or an r2.dev public domain.
   Nothing in this codebase ever returns a public object URL; the browser only
   ever receives presigned URLs with a 5-minute expiry.
3. R2, Manage API Tokens, Create API Token, **Object Read & Write**, scoped to
   that single bucket.
4. Collect four values:

| Variable | Where it comes from |
|---|---|
| `R2_ACCOUNT_ID` | R2 overview page (the account id inside the S3 endpoint) |
| `R2_BUCKET` | the bucket name |
| `R2_ACCESS_KEY_ID` | from the API token |
| `R2_SECRET_ACCESS_KEY` | from the API token, shown once |

Server-side access needs no CORS rule, but the browser PUTs directly to the
presigned URL, so the bucket needs one allowing `PUT` from the deployment
origin:

```json
[{ "AllowedOrigins": ["https://YOUR-APP.vercel.app"],
   "AllowedMethods": ["PUT", "GET"],
   "AllowedHeaders": ["content-type"],
   "MaxAgeSeconds": 3000 }]
```

Direct-to-R2 upload is not an optimisation, it is required. A Vercel function
caps request bodies at 4.5 MB and the product's resume limit is 5 MB, so
routing the bytes through the server would reject large resumes.

---

## 3. Groq (~2 min)

1. console.groq.com, API Keys, Create.
2. `GROQ_API_KEY` is the key. `GROQ_MODEL` is `llama-3.3-70b-versatile`.

The free tier is rate-limited, which is why `lib/ai/service.ts` queues work
with exponential backoff and honours `Retry-After`.

---

## 4. Secrets you generate yourself

```bash
openssl rand -hex 32
```

Run it three times, for `AUTH_JWT_SECRET` (signs session cookies),
`AI_WORKER_SECRET` (authenticates the queue worker) and `CRON_SECRET`
(authenticates Vercel Cron).

`AUTH_JWT_SECRET` must be at least 32 characters or the middleware fails closed
and every protected route redirects to `/login`.

---

## 5. Vercel (~5 min)

1. vercel.com, Add New, Project, import the GitHub repository.
2. Framework preset: Next.js. Leave the build settings at their defaults.
3. Add these environment variables **before the first deploy**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** string for **`tip_app`** |
| `DATABASE_URL_UNPOOLED` | Neon **direct** string for **`tip_app`** |
| `AUTH_JWT_SECRET` | 32-byte hex |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_BUCKET` | bucket name |
| `R2_ACCESS_KEY_ID` | R2 token key id |
| `R2_SECRET_ACCESS_KEY` | R2 token secret |
| `GROQ_API_KEY` | Groq key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `AI_WORKER_SECRET` | 32-byte hex |
| `CRON_SECRET` | 32-byte hex |

Do **not** add `DATABASE_URL_OWNER`.

**Ordering matters.** `middleware.ts` reads `AUTH_JWT_SECRET`, and middleware
environment variables are bound at build time on Vercel. If the variable is
added after the build, the deployed middleware sees nothing, fails closed, and
every protected route redirects to `/login`. Set the variables first, then
deploy, or redeploy after adding them.

4. Deploy.

No `NEXT_PUBLIC_*` variable is required, and none should be added. There are
zero `NEXT_PUBLIC` references in the application source; every secret is
server-side by construction.

No site-URL variable is needed either — nothing in the codebase hardcodes an
origin.

---

## 6. Cron and the AI worker

`vercel.json` registers one job:

```json
{ "crons": [{ "path": "/api/worker/drain", "schedule": "0 3 * * *" }] }
```

**Vercel Hobby limitation:** cron jobs run at most **once per day**, and the
trigger time is approximate (within the hour). The schedule above is therefore
a daily sweep, not a real queue drain.

This is a genuine constraint, not something the code papers over. The
mitigation lives in `app/api/worker/drain/route.ts`: a signed-in user may also
trigger a drain, which is what the UI does opportunistically after an action
that enqueues work. Without it a candidate could apply and not see their
assessment until the next day. It is safe to expose — draining processes system
work and returns only a count, never a row.

Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when
`CRON_SECRET` is set, and the route compares it in constant time.

A genuinely frequent schedule requires a paid plan.

---

## 7. Post-deploy verification

On the live URL, in order:

- [ ] Landing page renders, no console errors
- [ ] `/jobs` loads while signed out and shows only active jobs
- [ ] Register, sign in, sign out
- [ ] **Security:** as a candidate, visit `/recruiter` and `/admin` — both must
      redirect, not render
- [ ] **Security:** as recruiter A, open an application belonging to recruiter
      B by editing the URL — must 404/403, not render
- [ ] Upload a resume; confirm the object is not publicly readable
- [ ] Retrieve the resume as its owner; attempt retrieval as another user —
      must be denied
- [ ] Trigger an AI analysis and confirm it completes
- [ ] Confirm the runtime is not the owner role:

```sql
select current_user,
       (select rolbypassrls from pg_roles where rolname = current_user);
```

---

## Cost guardrails

| Service | Free tier | Watch for |
|---|---|---|
| Neon | 0.5 GB storage, 100 CU-h/mo | Scales to zero after 5 min, first hit is slow |
| Cloudflare R2 | 10 GB storage, no egress fees | Nothing at demo scale |
| Vercel Hobby | 100 GB bandwidth, 300 s max duration, 4.5 MB request body | Cron once per day |
| Groq | Rate-limited free usage | Queue absorbs 429s; avoid bulk screening right before a demo |
