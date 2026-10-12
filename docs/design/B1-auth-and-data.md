# B1 — authentication, authorization and persistence

**Status: design only.** No code, no dependencies installed, no schema migrated.
Written before building, so the decisions can be argued with while they are still
cheap. The batches that implement it are [§10](#10-batch-plan-b1bb1d).

**What this doc decides:** where the data lives, how a human proves who they
are, what each role may do, what is written down about it afterwards, and how
the dashboard's own passwords are kept apart from the credentials used to drive
somebody else's application.

**What it does not decide:** the encrypted secret store itself (B4 — [§7](#7-two-kinds-of-password-and-the-b4-interface)
declares the interface and nothing more), the dashboard UI (B3), live view (B5),
or anything about transport security (see [§9](#9-threat-list)'s NOT COVERED list).

---

## 0. Measured on this machine first

Taken 2026-10-12 on the development host, because three of the decisions below
turn on what is actually installed here rather than on what a design doc would
like to assume. **Re-measure before quoting any of this** — a working tree, a
PATH and an installed service are all things outside this repo can change.

| Question                         | Answer                                     | How it was measured                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                             | **v24.19.0**                               | `node --version`. `package.json` `engines` says `>=20`; `infra/docker/Dockerfile.api:1` pins `node:22-bookworm-slim`. Three versions in play — see the stop conditions in §10.                                                                                                                                                                                                              |
| pnpm / npm                       | 10.28.0 / 11.17.0                          | `pnpm --version`, `npm --version`                                                                                                                                                                                                                                                                                                                                                           |
| **Postgres**                     | **NOT PRESENT**                            | `psql` and `pg_ctl` not on PATH; no service matching `postgres\|pgsql`; `C:\Program Files\PostgreSQL` absent; a TCP connect to `127.0.0.1:5432` returns **ECONNREFUSED**                                                                                                                                                                                                                    |
| **Docker**                       | **NOT PRESENT**                            | `docker --version` → command not found (git-bash and PowerShell both); no `C:\Program Files\Docker`, no `%LOCALAPPDATA%\Docker`, no `DockerDesktop` service                                                                                                                                                                                                                                 |
| **WSL**                          | **NOT INSTALLED**                          | `wsl --status` → "The Windows Subsystem for Linux is not installed"                                                                                                                                                                                                                                                                                                                         |
| Package manager for installs     | **winget present**; choco and scoop absent | `Get-Command winget` → `…\WindowsApps\winget.exe`                                                                                                                                                                                                                                                                                                                                           |
| **Native module toolchain**      | **CANNOT BUILD**                           | Three independent blockers, each observed: `vswhere.exe` absent (so no Visual Studio _or_ Build Tools installer at all); `cl.exe` not on PATH; no `Windows Kits\10\Include`. Separately, the only `python` on PATH is a Microsoft Store alias stub that prints _"Python was not found"_ when run. And `%LOCALAPPDATA%\node-gyp\Cache` does not exist, so node-gyp has never completed here. |
| Native modules in the tree today | **zero**                                   | `find node_modules -name "*.node"`, excluding Playwright's own → 0                                                                                                                                                                                                                                                                                                                          |

**Honest limit on the toolchain measurement.** I did not complete a `node-gyp`
build: node-gyp is not in the npm cache and fetching it was out of scope for a
design task. The verdict rests on the three observations above, **any one of
which independently prevents a build on Windows**. If someone installs VS Build
Tools and a real Python, re-measure rather than trusting this row.

**The consequence that shapes §1 and §2.** This machine has no container
runtime, no WSL, no database and no C++ compiler, and the repository currently
has **no native dependency at all**. A design that needs any of those four
things needs an install first, and a design that needs a _compiler_ needs a
multi-gigabyte one. Both §1 and §2 are chosen so that only the smallest of those
installs is required.

### 0.1 Re-measured 2026-10-12, after the Postgres install

The §1 decision was acted on. Re-measured rather than assumed, and **two of the
three facts differ from what was reported to me**, which is why the table above
is amended here instead of edited in place — a measurement that quietly changes
cannot be checked against what was believed at the time.

| Question                 | Answer                                                                                                                                                                                                                             | How                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Postgres service         | **`postgresql-x64-17`, Running, Automatic**                                                                                                                                                                                        | `Get-Service`                                                                                     |
| **Version**              | **PostgreSQL 17.11** — not the 16 this doc specified                                                                                                                                                                               | `psql --version` from `C:\Program Files\PostgreSQL\17\bin`                                        |
| `psql` on PATH           | **no** — it lives in the install's `bin`, which winget did not add to PATH                                                                                                                                                         | `Get-Command psql`                                                                                |
| Port 5432 reachable      | `127.0.0.1` ✅ `::1` ✅ **`192.168.1.16` (LAN) ✅**                                                                                                                                                                                | TCP connect to each                                                                               |
| **`listen_addresses`**   | **`'*'`** — the socket binds `0.0.0.0` and `::`, **not loopback only**                                                                                                                                                             | `postgresql.conf`; confirmed by `Get-NetTCPConnection -LocalPort 5432` showing `0.0.0.0` and `::` |
| `pg_hba.conf` host rules | **`127.0.0.1/32` and `::1/128` only**, both `scram-sha-256`                                                                                                                                                                        | `pg_hba.conf`                                                                                     |
| Firewall rule for 5432   | **none specifically**                                                                                                                                                                                                              | `Get-NetFirewallPortFilter`                                                                       |
| `.env` is gitignored     | **yes** — `.gitignore:27`, and `git ls-files .env` is empty                                                                                                                                                                        | `git check-ignore -v .env`                                                                        |
| **`DATABASE_URL`**       | **ABSENT** — not in `.env`, no `.env.local` exists, not in the process environment, not in User or Machine scope, and nothing under `config/` mentions it. `.env` was last written **21 Sep 2026**, three weeks before the install | `grep -c`, `[Environment]::GetEnvironmentVariables`, file mtime                                   |

**The listener is a real finding and it is not what the install was believed to
do.** `listen_addresses = '*'` is the EnterpriseDB installer's default, so the
database accepts a TCP connection from the LAN — measured, not inferred. What
stops that being an exposed database is `pg_hba.conf`, which permits only
`127.0.0.1/32` and `::1/128`, so a non-loopback connection is refused at
authentication rather than at the socket.

That is fail-closed, and it is one layer thinner than it should be: the port
answers, so the service is discoverable and its version is probeable, and a
later well-meaning `pg_hba` edit — the file people reach for when a colleague
cannot connect — is the only thing between that and a reachable database. Exactly
the shape B0 corrected in the API: `app.listen(port)` bound `::` and the fix was
to bind loopback rather than to rely on a layer above. The remedy is one line:

```conf
# C:\Program Files\PostgreSQL\17\data\postgresql.conf
listen_addresses = '127.0.0.1'
```

then restart the service. **Recommended**, and it costs nothing here — every
consumer in this design is on the same host.

---

## 1. Database — Postgres via Prisma

**Decision: PostgreSQL, accessed through Prisma, with `RunRepository` and the
in-memory implementation both kept. Recommended.**

> **Installed version: 17.11**, not the 16 this section originally named (§0.1).
> Nothing in the design depends on the difference and Prisma supports both, so
> the version is recorded rather than pinned — but no migration may assume 16,
> and the CI sidecar in this section should move to `postgres:17-alpine` so the
> two halves cannot drift apart. A pipeline testing a different major version
> than the one developers run is a difference that shows up as one failing
> constraint, months later.

**Why.** The data model is already written down and already relational —
`infra/prisma/schema.prisma` has been checked in and unused since Phase 1, and
ADR-008 says in as many words that swapping Postgres in "touches
`run.repository.ts` only". B1 is where that promise gets tested rather than
repeated. Postgres specifically because three things B1 needs are things it does
well and SQLite does not: a real `TIMESTAMPTZ`, row-level grants (which is how
the audit log becomes append-only in [§6](#6-audit-log) rather than append-only
by convention), and concurrent writers, which the API will have the moment two
people are logged in. Prisma specifically because the schema is already in its
dialect, and because **its query engine ships as a prebuilt binary** — it needs
no compiler, which on the host measured in §0 is the difference between working
and not.

**How the dev machine gets Postgres.** `winget` is the only package manager
present:

```powershell
winget install PostgreSQL.PostgreSQL.16
```

That installs a native Windows service, needs no Docker and no WSL, survives a
reboot, and is a real Postgres rather than an emulation of one. It needs
administrator rights. **If admin rights are not available**, the fallback is the
EnterpriseDB _binaries-only_ zip extracted to a directory and started with
`pg_ctl -D <datadir> start` — same server, no installer, no service, started per
session. Either way the connection string goes in `.env` as `DATABASE_URL`, and
**it has no default**: an unset value refuses to boot by name, the way
`resolveEnvName` refuses rather than assuming `qa`. A database URL that falls
back to a guess is a guess about which data a run writes to.

**Rejected, each for a measured reason:**

- **Docker Compose** — `infra/docker/docker-compose.yml:4-18` already defines a
  `postgres:16-alpine` service, and it is read by nothing. It is the obvious
  answer and it is the wrong one _here_: Docker is not installed, and Docker
  Desktop on Windows needs WSL2 or Hyper-V, and WSL is not installed either. So
  it is two installs totalling several gigabytes to obtain one database that
  winget provides directly. The compose file stays and becomes correct for CI
  and for the B6 worker story; it is just not how this laptop gets a database.
- **WSL2 + Postgres inside it** — same two-install objection, plus a second
  filesystem and a networking hop between the API and its own database.
- **SQLite for development, Postgres for production** — rejected firmly. Prisma
  migrations are generated against one provider and would be applied to the
  other, so every migration would be unverified against the engine that actually
  runs it. That is this repo's own "a mock is a claim about a system you have
  never called" failure, in database form, and the thing it would hide is
  schema-level: a constraint, a cascade or a grant that behaves differently.
  It also forfeits the row-level grant that §6 depends on.
- **An embedded in-process Postgres (PGlite and similar)** — no server, so no
  concurrent connections and no roles; it cannot express §6's append-only grant,
  which is the property it would be adopted to avoid having to install anything
  for.
- **Keep the in-memory repository and persist nothing** — this is the status quo.
  ADR-008 already calls run history loss "the first thing Phase 3 should fix",
  and sessions and audit rows cannot live in a `Map` at all: a restart would log
  everyone out and erase the record of who did what.

**How CI gets Postgres.** State of play, measured in the Part 0 audit and
unchanged: `infra/jenkins/Jenkinsfile` **has never run** — there is no Jenkins
instance and no build history. So this section defines a pipeline rather than
describing one, and it must not be written up as though it were working.

The Jenkinsfile already runs its whole build inside a Docker agent
(`mcr.microsoft.com/playwright:v1.50.0-noble`, line 6), so a database sidecar is
natural there even though it is unavailable on the laptop:

```groovy
docker.image('postgres:17-alpine').withRun('-e POSTGRES_PASSWORD=ci -e POSTGRES_DB=aitp_ci') { db ->
  docker.image('mcr.microsoft.com/playwright:…').inside("--link ${db.id}:db") {
    sh 'pnpm prisma migrate deploy'
    sh 'pnpm verify'
  }
}
```

Two things that must be true of it and are not yet: the image pin is **12 minor
versions behind** the installed Playwright (1.50.0 against 1.62.1 — the drift
recorded in the Part 0 audit), and the pipeline runs lint plus one
`playwright test` rather than `pnpm verify`'s eight gates. Both are B6 work and
are named here so B1 does not quietly depend on a pipeline that would not catch
its own regressions.

**`pnpm verify` must not require a database.** This is the load-bearing
constraint on the whole batch. `verify` runs on every commit on a developer
machine, and the unit and demo suites are where almost all of B1's logic lives.
So:

| Suite                       | Storage                                                                                                                                                 | Why                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `unit`                      | `InMemory*` repositories                                                                                                                                | No database, no network, no install. This is why the in-memory implementation **stays** rather than being replaced |
| `demo`                      | `InMemory*`                                                                                                                                             | Same                                                                                                               |
| `api`                       | `InMemory*` by default; the Postgres-backed tests are tagged and excluded from `test:api:internal`, the way `app-health.spec.ts` already is by `@smoke` | A contributor with no Postgres can still run `pnpm verify`                                                         |
| the Postgres contract suite | real Postgres, opt-in                                                                                                                                   | Run by `pnpm test:db` and by CI                                                                                    |

**The two implementations are kept honest by one suite, run twice.** A repository
contract suite is written once and parameterised over both implementations. This
is not tidiness: an in-memory repository written by the same author as the code
is a stub that cannot falsify itself, and the only thing that catches a
divergence is the same assertions meeting the real engine. If a contributor has
no Postgres, the Postgres half is **skipped with a stated reason** — never
reported as passing, and never silently absent.

**The interface stays exactly as it is.** `RunRepository`
([run.repository.ts:4-8](../../apps/api/src/modules/runs/run.repository.ts)) is
unchanged. `InMemoryRunRepository` is unchanged. `PrismaRunRepository` is added
beside it and bound by the module, which is the one-file swap ADR-008 predicted.
`UserRepository`, `SessionRepository`, `AuditRepository`, `InviteRepository` and
`ApplicationRepository` follow the identical shape — abstract class, in-memory
implementation, Prisma implementation, one contract suite.

**The schema that is checked in today is not sufficient and should not be
trusted as a starting point.** It has no `User`, `Session`, `Invite`,
`AuditEvent`, `Application` or `Secret` model, and its `Run` model has already
drifted behind the canonical `Run` in
[types/run.ts:154-187](../../packages/shared/src/types/run.ts): no `target`
(which is SEC-2's whole point), no `FailureContext`, no `healingProposals`. B1b
rewrites it; it does not extend it.

---

## 2. Password hashing — Argon2id via a prebuilt binary

**Decision: `@node-rs/argon2`, Argon2id. Recommended.**

**Why.** Argon2id is the current first choice for password storage, and
`@node-rs/argon2` is a napi-rs package that ships **prebuilt platform binaries**
— so it installs without a compiler. On the host measured in §0 that is not a
preference, it is the only way an Argon2 library installs at all: there is no
MSVC toolset, no Windows SDK and no working Python, so anything requiring
node-gyp fails at install time and takes `pnpm install` down with it.

**Parameters, stated rather than defaulted:**

| Parameter              | Value                                                        | Reason                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm              | **Argon2id**                                                 | Hybrid; resists both side-channel and GPU/ASIC attack. Not Argon2i, not Argon2d                                                                                                                                                               |
| Memory cost            | **19456 KiB** (19 MiB)                                       | OWASP's current floor for Argon2id at `t=2, p=1`                                                                                                                                                                                              |
| Time cost (iterations) | **2**                                                        | Paired with the memory above; the two are a single choice, not two                                                                                                                                                                            |
| Parallelism            | **1**                                                        | One degree, so a request's cost is predictable under concurrency. Raising it multiplies cost per login by the number of concurrent logins                                                                                                     |
| Salt                   | **16 random bytes**, per password, from `crypto.randomBytes` | Never derived from the email or the user id                                                                                                                                                                                                   |
| Output length          | **32 bytes**                                                 |                                                                                                                                                                                                                                               |
| Pepper                 | **none**                                                     | Rejected: it adds a key-management problem (where it lives, how it rotates, what happens when it is lost) for a benefit that only materialises in a database-only leak — and §9 already assumes that leak and answers it with the hash itself |

**Verify the cost on the target host, do not inherit these numbers.** A hash
should take roughly 100–500 ms on the machine that serves logins. Too fast and
the parameters are decorative; too slow and the login endpoint becomes its own
denial of service. B1c measures it and records the measurement next to the
parameters, in the same file — a number quoted away from the hardware it was
measured on is not a fact about anything.

**Store the parameters with the hash.** Argon2's encoded output
(`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) already carries them, so a
verify never has to guess, and **a successful login whose stored parameters are
weaker than the current policy re-hashes the password in place**. Without that,
raising the cost protects only accounts created afterwards.

**Rejected:**

- **`bcrypt`** — native, needs node-gyp. Measured impossible on this host, and
  it would make `pnpm install` fail rather than degrade. It also silently
  truncates passwords at 72 bytes, which is a correctness bug a passphrase user
  would never be told about.
- **`argon2` (the npm package)** — same node-gyp objection.
- **`bcryptjs`** — pure JavaScript, so it installs anywhere, but it is markedly
  slower per unit of attacker resistance and inherits bcrypt's 72-byte
  truncation.
- **`node:crypto` `scrypt`** — this is the serious alternative and it deserves
  naming rather than dismissing. It is **built into Node, so it adds no
  dependency at all**, and OWASP accepts scrypt (`N=2^17, r=8, p=1`) where
  Argon2 is unavailable. The argument against is narrow: Argon2id is the better
  primitive, and a prebuilt binary is not a build. The argument _for_ is also
  real and this repo values it — the dependency tree currently contains **zero**
  native or platform-specific binaries outside Playwright, and `@node-rs/argon2`
  ends that. A prebuilt binary is still a binary that must match the platform,
  so an unusual host (Alpine, ARM64, a future Node ABI) can fail at install
  where `node:crypto` never can. **This is question 2 in [§11](#11-decisions-i-need-from-you).**
- **Plain SHA-256/512, with or without salt** — not a password hash; no work
  factor.

---

## 3. Sessions

**Decision: server-side session rows, an opaque random token in a cookie, and
only a hash of that token in the database. Recommended.**

### The token and the row

|            |                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Token      | 32 bytes from `crypto.randomBytes`, base64url-encoded (43 chars). Opaque — it carries no claims, so it cannot be read, forged or mis-parsed |
| **Stored** | **SHA-256 of the token**, never the token itself                                                                                            |
| Comparison | `crypto.timingSafeEqual` over the two 32-byte digests, after a length check                                                                 |
| Lookup     | by the digest, which is the primary key                                                                                                     |

**Storing only the digest is the point, and it is why this is not a JWT
argument.** If the database leaks, the attacker holds digests and cannot derive a
usable cookie from them — so a database leak does not hand over live sessions.
A plain `scrypt`-style stretch is unnecessary here because the token is 256 bits
of entropy rather than a human-chosen secret; SHA-256 is sufficient and fast
enough to run on every request.

Session row: `tokenHash` (PK), `userId`, `createdAt`, `lastSeenAt`,
`idleExpiresAt`, `absoluteExpiresAt`, `createdIp`, `createdUserAgent`,
`revokedAt`, `revokedReason`.

### Cookie

`aitp_session`, with:

- **`HttpOnly`** — JavaScript cannot read it, so an XSS bug does not
  immediately become a stolen session.
- **`SameSite=Strict`** — the dashboard is served from the same origin as the
  API (one server, which is the whole premise of the website phase), so no
  legitimate cross-site navigation needs this cookie and `Strict` costs nothing.
  `Lax` would still send it on a top-level cross-site GET.
- **`Secure`**, set **when the request is not loopback**. Computed from the
  request, not declared by configuration: a flag that says "we are in
  production" is exactly the kind of label SEC-2 showed can be wrong while
  reading as right. On `127.0.0.1` it is omitted, because a `Secure` cookie over
  plain HTTP is simply dropped and the developer sees "login does not work".
- **`Path=/`**, no `Domain` attribute (host-only).

### Expiry — two clocks, and the second one never moves

- **Idle: 8 hours**, sliding. Each authenticated request pushes `idleExpiresAt`
  forward. Written at most once a minute, so a busy tab does not write a row per
  request.
- **Absolute: 7 days**, from `createdAt`, and **never extended by activity**.
  An idle timeout alone means a session that is used daily lives forever, which
  is the property that makes a stolen cookie permanent.

A request is authenticated only if `revokedAt IS NULL` **and** `now < idleExpiresAt`
**and** `now < absoluteExpiresAt`. Expired rows are deleted by a sweep; the
check never depends on the sweep having run.

**Issue a new token on login** (never reuse or upgrade an existing one — session
fixation). **Revoke on logout.** **Revoke every session for a user** on password
change, role change, or disable.

### CSRF

**Decision: `SameSite=Strict` plus a mandatory origin check on every
state-changing request, failing closed. No double-submit token. Recommended.**

For `POST`, `PUT`, `PATCH` and `DELETE`, the request is rejected with 403 unless
**either** `Sec-Fetch-Site: same-origin` **or** `Origin` exactly matches an
entry in the server's own allowlist — the same list B0 built for CORS
([network.ts](../../apps/api/src/config/network.ts) `resolveAllowedOrigins`), so
there is one place that knows which origins are ours. **A state-changing request
carrying neither header is rejected**, not allowed: browsers always send `Origin`
on these methods, so an absent header means the caller is not a browser and
should be using the CI token path instead.

A separate double-submit CSRF token was considered and rejected as redundant
given two independent controls that each already stop the attack, and not free:
it is another thing to mint, store, rotate and get wrong, and a CSRF token
implementation that silently stops validating looks exactly like one that works.
The CI service path is immune by construction — it uses a bearer token, not a
cookie, so a browser cannot be tricked into sending it.

### Login throttling

| Control            | Value                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| Per **username**   | 5 failures in 15 minutes → locked for 15 minutes, auto-clearing                |
| Per **IP**         | 20 failures in 15 minutes → throttled                                          |
| On success         | both counters for that username reset                                          |
| Lockout visibility | **none** — a locked account returns the identical response to a wrong password |

Counters live in the database, not in process memory: an in-memory counter
resets when the API restarts, which turns "lock after 5" into "lock after 5 per
restart".

### No user enumeration

Login returns **the same status (401), the same body, and the same timing**
whether the email is unknown, the password is wrong, or the account is locked or
disabled. The message is `Email or password is incorrect.`

Timing matters as much as the message and is easier to get wrong: if an unknown
email returns before a hash is computed, the response time tells an attacker the
address exists. So **a login for an unknown user still runs an Argon2id verify**
against a fixed dummy hash held in the code, and discards the result. The same
discipline applies to the invite and password-reset paths, which leak the same
fact if they answer differently.

---

## 4. First Owner bootstrap

**Decision: a one-time CLI command. There is no signup route, and no HTTP path
by which the first Owner can be created. Recommended.**

```bash
pnpm aitp:create-owner --email owner@example.com
```

- **Refuses if any user already exists**, so it is one-time by construction
  rather than by being run once. The refusal names the condition.
- Prompts for the password on stdin, unechoed. Never an argument (which lands in
  shell history and in the process table) and never an environment variable
  (which lands in `.env` and stays there).
- Writes the Argon2id hash per §2 and an `AuditEvent` with `action: 'owner.bootstrap'`.
- Runs the kit integrity check first, like every other QA-facing command in this
  repo — a bootstrap from a modified kit is not a bootstrap anybody should trust.

**Everyone else arrives by invitation.** An Owner (or a Manager, within their own
application scope) creates an `Invite`: single-use token, 72-hour expiry, bound
to one email, one role and one scope. The invitee sets their own password through
it. Creation and acceptance are both audited. **There is no self-registration
anywhere**, and no route that creates a user without an authenticated, authorised
actor.

**Rejected:**

- **A seeded default Owner** (`admin`/`admin`, or a password in a seed file) —
  ships a known credential in the repository. The kit lock exists to stop a
  shipped artifact from being trusted when it should not be; shipping a password
  inside it would be the same mistake in the other direction.
- **Bootstrap from environment variables** (`OWNER_EMAIL`/`OWNER_PASSWORD`) —
  this repo has already reasoned this out once, for the maintainer marker:
  _"a variable can be set by anything that can set a variable — a shell profile,
  a CI step, an AI agent running a command — and none of those leave a trace a
  reader can check afterwards"_ ([kit/integrity.ts:161](../../packages/execution-engine/src/kit/integrity.ts)).
  It would also leave the first Owner's password sitting in `.env` indefinitely.
- **A first-request-wins bootstrap route** (`POST /api/setup`, open until a user
  exists) — a race against anyone who can reach the port between deploy and
  first login, and the port is reachable by anything on the host.
- **Open signup with manual approval** — an unauthenticated write endpoint that
  creates rows, for a product with a fixed, small set of users.

---

## 5. Roles, scopes and the endpoint matrix

### Roles

| Role                 | What it is                                                                                                              | Can it write? | UI?    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- | ------ |
| **Owner**            | Runs the installation. The only role that can manage secrets, other Owners, and take control of a live browser anywhere | yes           | yes    |
| **Manager**          | Runs one or more applications: invites QAs, configures applications, starts and cancels runs within scope               | yes, in scope | yes    |
| **Executive viewer** | **Read-only, always.** Sees runs, reports and dashboards; can change nothing, anywhere                                  | **no**        | yes    |
| **QA**               | Does the work: starts runs, uploads sheets, triages, takes control of a browser for runs assigned to them               | yes, in scope | yes    |
| **CI service**       | A pipeline. Bearer token, no cookie, no password, no browser session                                                    | yes, narrowly | **no** |

### Scopes

| Scope | Means                                                              |
| ----- | ------------------------------------------------------------------ |
| `own` | Rows this actor created, or runs assigned to them                  |
| `app` | Everything belonging to the applications this actor is a member of |
| `all` | The whole installation                                             |

A grant is the pair `(role, scope)` on a `Membership` row. Owner is `all` by
definition; Executive viewer is normally `all` but read-only; Manager and QA are
`app`, and a QA may be narrowed to `own`.

### Default deny, and how that is made true rather than asserted

A **global** guard, registered as `APP_GUARD`, so a route is protected by
existing rather than by being annotated. Only an explicit `@Public()` decorator
opens one. Today's default is the opposite — no guard anywhere, so every route is
open — and a design that inverts it by adding `@Auth()` to each controller would
fail the moment someone adds a route and forgets.

Every decision goes through one function:

```ts
can(actor: Actor, action: Action, resource: Resource): Decision
```

One function, so there is one place to read and one place to test. It returns a
`Decision` carrying the reason, because [§6](#6-audit-log) records denials and
"denied" with no reason is not something a reviewer can act on.

**The guard's default-deny property is proven by adding a route.** B1d's test
registers a new, unannotated route in a test module and asserts it answers
**401**. A test that enumerates today's routes and checks each one is a test of
today's list; this is a test of the default.

### The matrix

Every route in `apps/api` today, enumerated from the decorators rather than from
memory, plus the ones the website phase adds. **Blank means denied** — there is
no "unspecified" column, because an unspecified cell is how a gate opens.

| Endpoint                               | Source                                                                       | Owner                              | Manager                            | Exec viewer   | QA                   | CI service                                  |
| -------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- | ------------- | -------------------- | ------------------------------------------- |
| `GET /api/health`                      | [health.module.ts:7](../../apps/api/src/modules/health/health.module.ts)     | ✅                                 | ✅                                 | ✅            | ✅                   | ✅ **`@Public()`** — but see the note below |
| `GET /api/docs`                        | [main.ts:58](../../apps/api/src/main.ts)                                     | ✅ all                             | ✅                                 |               |                      |                                             |
| `POST /api/runs`                       | [runs.module.ts:25](../../apps/api/src/modules/runs/runs.module.ts)          | ✅ all                             | ✅ app                             |               | ✅ app               | ✅ app                                      |
| `GET /api/runs`                        | [runs.module.ts:31](../../apps/api/src/modules/runs/runs.module.ts)          | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               | ✅ own                                      |
| `GET /api/runs/:id`                    | [runs.module.ts:36](../../apps/api/src/modules/runs/runs.module.ts)          | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               | ✅ own                                      |
| `POST /api/runs/:id/cancel`            | [runs.module.ts:41](../../apps/api/src/modules/runs/runs.module.ts)          | ✅ all                             | ✅ app                             |               | ✅ own               | ✅ own                                      |
| `POST /api/command`                    | [command.module.ts:18](../../apps/api/src/modules/command/command.module.ts) | ✅ all                             | ✅ app                             |               | ✅ app               |                                             |
| `POST /api/events`                     | [events.module.ts:22](../../apps/api/src/modules/events/events.module.ts)    |                                    |                                    |               |                      | ✅ **per-run ingest token only**            |
| `GET /api/events/stream/:runId`        | [events.module.ts:30](../../apps/api/src/modules/events/events.module.ts)    | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               |                                             |
| `GET /api/events/history/:runId`       | [events.module.ts:35](../../apps/api/src/modules/events/events.module.ts)    | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               |                                             |
| `POST /api/auth/login`                 | B1c                                                                          | **`@Public()`**, rate-limited      |                                    |               |                      |                                             |
| `POST /api/auth/logout`                | B1c                                                                          | ✅                                 | ✅                                 | ✅            | ✅                   |                                             |
| `GET /api/auth/me`                     | B1c                                                                          | ✅                                 | ✅                                 | ✅            | ✅                   |                                             |
| `POST /api/auth/password`              | B1c                                                                          | ✅ own                             | ✅ own                             | ✅ own        | ✅ own               |                                             |
| `POST /api/invites`                    | B1c                                                                          | ✅ all                             | ✅ app, **cannot invite an Owner** |               |                      |                                             |
| `POST /api/invites/accept`             | B1c                                                                          | **`@Public()`** + single-use token |                                    |               |                      |                                             |
| `GET /api/users`                       | B1d                                                                          | ✅ all                             | ✅ app                             |               |                      |                                             |
| `POST /api/users/:id/role`             | B1d                                                                          | ✅ all                             | ✅ app, **cannot grant Owner**     |               |                      |                                             |
| `POST /api/users/:id/disable`          | B1d                                                                          | ✅ all                             | ✅ app                             |               |                      |                                             |
| `GET /api/audit`                       | B1d                                                                          | ✅ all                             | ✅ app                             |               |                      |                                             |
| `GET /api/applications`                | B4                                                                           | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               |                                             |
| `POST /api/applications`               | B4                                                                           | ✅ all                             |                                    |               |                      |                                             |
| `PATCH /api/applications/:slug`        | B4                                                                           | ✅ all                             | ✅ app                             |               |                      |                                             |
| `PUT /api/applications/:slug/secrets`  | B4                                                                           | ✅ all, **write-only**             |                                    |               |                      |                                             |
| `POST /api/applications/:slug/auth`    | B4                                                                           | ✅ all                             | ✅ app                             |               | ✅ app               |                                             |
| `POST /api/applications/:slug/capture` | B4                                                                           | ✅ all                             | ✅ app                             |               | ✅ app               |                                             |
| `POST /api/sheets` (upload)            | B4                                                                           | ✅ all                             | ✅ app                             |               | ✅ app               |                                             |
| `GET /api/sheets/:id/triage`           | B4                                                                           | ✅ all                             | ✅ app                             | ✅ all (read) | ✅ app               |                                             |
| `GET /api/runs/:id/view` (watch)       | B5                                                                           | ✅ all                             | ✅ app                             | ✅ app (read) | ✅ app               |                                             |
| `POST /api/runs/:id/control`           | B5                                                                           | ✅ all                             |                                    |               | ✅ **assigned only** |                                             |

**Three cells worth arguing with before they are built:**

- **`GET /api/health` is public and currently leaks.** It returns
  `environment: process.env.TEST_ENV ?? 'qa'`
  ([health.module.ts:13](../../apps/api/src/modules/health/health.module.ts)) —
  which is both a disclosure and, as recorded separately, capable of
  disagreeing with where runs actually go. B1d narrows the public body to
  `{status, service, timestamp}` and moves version, environment and uptime
  behind authentication.
- **`POST /api/events` is reassigned entirely.** It is open today, unauthenticated,
  and B0 only gave it a schema. It is not a user-facing route at all: the only
  legitimate caller is a Playwright reporter in a child this API spawned. So it
  is authenticated by a **per-run ingest token** minted when the run is created,
  passed to the child in its environment, scoped to that one `runId`, and
  expiring when the run finishes. That needs one more entry on B0's child-env
  allowlist and is **question 3** in §11.
- **`POST /api/command` denies CI service.** It is an interactive affordance
  whose generation door produces proposals for human review; a pipeline calling
  it would be asking for judgement nobody is there to give.

---

## 6. Audit log

**Append-only, enforced by the database rather than by the code that writes to
it. Recommended.**

```prisma
model AuditEvent {
  id            String   @id @default(uuid())
  at            DateTime @default(now())

  /// Who. Nullable, because a failed login for an unknown address has no user.
  actorUserId   String?
  /// The actor AS THEY WERE, copied at write time — see the note below.
  actorEmail    String?
  actorRole     String?
  actorScope    String?
  /// Set when the actor is a pipeline rather than a person.
  actorTokenId  String?

  /// What.
  action        String
  subjectType   String?
  subjectId     String?
  applicationId String?
  /// allowed | denied | failed
  outcome       String

  /// From where.
  ip            String?
  userAgent     String?
  requestId     String?

  /// Redacted before it gets here. Never a secret, never a password, never a token.
  detail        Json     @default("{}")

  @@index([at])
  @@index([actorUserId, at])
  @@index([applicationId, at])
  @@index([action, at])
}
```

**Why the actor is denormalised.** `actorUserId` alone cannot explain itself: if
the user is renamed, has their role changed, or is deleted, the row stops saying
who acted. This is the same lesson as `assertionId` in the generation design —
_a hash cannot explain itself_ — so the identifier decides and the copied fields
explain. The two roles are kept apart deliberately: the copy is never used to
look anything up.

**How append-only is enforced.** The application's database role is granted
`INSERT` and `SELECT` on `audit_event` and nothing else — no `UPDATE`, no
`DELETE`, no `TRUNCATE`. The `AuditRepository` interface correspondingly has only
`append()` and query methods, so there is no code path to call. **The grant is
the control and the interface is the convenience**: an interface with no update
method is a convention, and this repo has learned repeatedly that a convention is
a thing someone eventually works around. Retention, when it is needed, is a
separate privileged job and not something the API can do.

**What is audited.** Every login attempt including failures; logout; password
change; invite created and accepted; user created, role changed, disabled; **every
denied authorization decision**, with the reason from `can()`; run created and
cancelled; sheet uploaded; secret written (the fact and the actor, never the
value) and every `reveal`; capture and auth buttons; take-control granted and
released; and reads of the audit log itself.

Denials are audited as deliberately as successes. A log that records only what
worked cannot answer "has anyone been probing this", which is most of what an
audit log is for.

**There is no "log in as" feature, and that is a decision rather than an
omission.** Impersonation makes every subsequent row ambiguous about who really
acted — and the two readings ("the Owner did this" / "the Owner did this while
impersonating a QA") are indistinguishable afterwards, which is precisely the
property the audit log exists to provide. Where support genuinely needs to see
what a user sees, the answer is a read-only view scoped by that user's
permissions, attributed to the Owner who opened it.

---

## 7. Two kinds of "password", and the B4 interface

**These must never share a table, a type, a function or a log line.** They look
alike and are opposites:

|                      | **Dashboard credential**                           | **App-under-test credential**                        |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Whose                | A human logging in to **our** website              | A robot signing in to the **customer's** application |
| Needed in plaintext? | **Never**                                          | **Always, at run time**                              |
| Therefore            | **hashed** (Argon2id, §2) — irreversible by design | **encrypted** — reversible by necessity              |
| Lives in             | `user.passwordHash`                                | `application_secret.ciphertext` (B4)                 |
| If it leaks          | the hash is useless to an attacker                 | the customer's system is compromised                 |

The distinction is worth this much space because the failure mode is a code
review that sees two "password" fields and reaches for one helper. This repo has
already paid for a shared identifier once — `openQuestions` held two different
concepts and _"a shared name does not merely confuse; it HIDES"_. So:

- **Separate tables**, never a shared `credential` table with a `kind` column.
- **Separate branded types**: `PasswordHash` and `SecretCiphertext` are distinct
  and not assignable to each other or to `string`, so a mix-up is a compile
  error and not a review miss.
- **Separate vocabulary.** Nothing in shared code calls either one "password".
  The human one is a _credential_; the other is a _secret_.
- A third thing exists and is in the second category: the saved Playwright
  `storageState` files at `artifacts/<app>/auth/<env>.json` hold **live customer
  session cookies and tokens in plaintext on disk**. They are the same class of
  material as an app-under-test password and belong behind the same store. **B1
  does not move them**, and that is stated here so nobody concludes from B1
  shipping that credentials are now handled.

### The interface B4 will implement — declared now, implemented not at all

```ts
/** A write-only store. There is deliberately no `get` that returns a value to HTTP. */
export interface SecretStore {
  /** Store or replace. Returns metadata; never echoes the plaintext back. */
  put(ref: SecretRef, plaintext: Plaintext, actor: Actor): Promise<SecretMetadata>;

  /**
   * The ONLY path to plaintext, and it is narrow on purpose: callable from the
   * run path, requires a stated purpose, and writes an audit row every time.
   */
  reveal(ref: SecretRef, purpose: RunPurpose, actor: Actor): Promise<Plaintext>;

  /** Names, versions and timestamps. Never values. This is what the UI reads. */
  list(applicationId: string): Promise<SecretMetadata[]>;

  destroy(ref: SecretRef, actor: Actor): Promise<void>;
}
```

**B1 ships this interface bound to a `RefusingSecretStore` whose every method
throws** `"the secret store is not implemented until B4"`. Not a store that
returns `null`, and not one that reads `.env` as a stand-in. This repo's rule is
_prefer a loud gap to a quiet one_: a placeholder that half-works reads as
coverage, and the specific risk here is a `reveal()` that quietly falls back to
an environment variable and therefore appears to work — after which nobody
notices that no encryption was ever built.

---

## 8. `AuthProvider` — local now, Microsoft SSO later

**Decision: local password authentication only in B1, behind an interface shaped
so that adding Microsoft Entra ID touches no call site. Recommended.**

```ts
export type AuthOutcome =
  | {
      kind: 'authenticated';
      providerId: string;
      externalId: string;
      email: string;
      displayName?: string;
    }
  /** The reason is for the AUDIT LOG. It is never returned to the caller — §3. */
  | { kind: 'rejected'; reason: 'bad-credentials' | 'locked' | 'disabled' | 'unknown-user' }
  /** An SSO provider cannot answer a password; it answers with somewhere to go. */
  | { kind: 'redirect'; url: string; state: string };

export interface AuthProvider {
  readonly id: string;
  /** Local reads email+password; an OIDC provider reads a callback code. */
  authenticate(input: unknown): Promise<AuthOutcome>;
}
```

`User` carries `authProviderId` (`'local'` today), `externalId` (null for local)
and `passwordHash` (**null for an SSO user** — an SSO account has no password to
store, and a nullable column is how that is said rather than an empty string
that a verify would accept).

Two properties the interface exists to guarantee:

- **The redirect variant is in the type from the start.** A provider that cannot
  answer a password synchronously must be representable, or adding SSO later
  means changing the return type and therefore every call site — which is the
  thing the interface is for.
- **A caller cannot choose its own provider.** The provider is read from the
  `User` row, never from the request body. Otherwise a request claiming
  `providerId: 'microsoft'` would route around the local password check.

**Rejected:** `passport.js` — brings a strategy ecosystem and its own session
model, and we own the session model in §3 deliberately; its value is breadth we
do not need. **Also rejected: building the OIDC path now** — an SSO flow nobody
uses is an SSO flow nobody tests, and this repo has three recorded instances of a
verification that never met the conditions it claimed to verify.

---

## 9. Threat list

Top ten for **this layer**, each with the control that addresses it.

| #   | Threat                                                                                                                                                                                                   | Control                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Unauthenticated run trigger against a live customer system** — the largest finding in the Part 0 audit, and reachable today                                                                            | Global `APP_GUARD`, default deny, `@Public()` only for health, login and invite-accept. Proven by a test that adds an unannotated route and asserts 401 (§5)                                                                                                                                                                               |
| 2   | Credential stuffing / brute force                                                                                                                                                                        | Argon2id cost (§2), per-username and per-IP throttling with lockout, counters in the database not in memory (§3)                                                                                                                                                                                                                           |
| 3   | Session theft via XSS in the dashboard                                                                                                                                                                   | `HttpOnly` cookie, so script cannot read it; `SameSite=Strict`; CSP and output encoding are B3's half and are named as such                                                                                                                                                                                                                |
| 4   | CSRF on a state-changing route                                                                                                                                                                           | `SameSite=Strict` **plus** a mandatory `Origin`/`Sec-Fetch-Site` check that **fails closed** when neither header is present (§3)                                                                                                                                                                                                           |
| 5   | Privilege escalation through role or scope confusion                                                                                                                                                     | One `can()` function, default deny, Manager cannot grant or invite Owner, every denial audited with its reason. Table-driven tests covering every cell including every deny (§10, B1d)                                                                                                                                                     |
| 6   | Session fixation, or a session that never dies                                                                                                                                                           | New token on login; idle **and** absolute expiry, the absolute one never extended; revoke-all on password change, role change and disable (§3)                                                                                                                                                                                             |
| 7   | User enumeration via login, invite or reset                                                                                                                                                              | Identical status, body **and timing** — an unknown user still runs an Argon2id verify against a dummy hash (§3)                                                                                                                                                                                                                            |
| 8   | Audit tampering, by an attacker or by a well-meaning bug                                                                                                                                                 | Database `GRANT INSERT, SELECT` only; no update or delete method exists to call (§6)                                                                                                                                                                                                                                                       |
| 9   | Secret or credential leaking into a log, an SSE frame or a report                                                                                                                                        | Wire `redactSecrets` into the API's Nest logger (**it is not today** — only the repo's own logger redacts); `reveal()` is the single audited path to plaintext; B0's `metadata` caps already landed                                                                                                                                        |
| 10  | A database leak yielding usable sessions                                                                                                                                                                 | Only the SHA-256 of the session token is stored, so digests are not cookies; passwords are Argon2id; **no plaintext secret exists in B1 at all**, because the store refuses until B4                                                                                                                                                       |
| 11  | **The database itself is reachable off-host.** Measured 2026-10-12: `listen_addresses = '*'`, so 5432 answers on the LAN address, holding every session, password hash and audit row this design creates | `pg_hba.conf` permits only `127.0.0.1/32` and `::1/128`, so a non-loopback connection is refused at authentication. That is one layer, and the port still answers — so set `listen_addresses = '127.0.0.1'` and restart (§0.1). Same correction B0 made to the API, for the same reason: bind loopback rather than rely on the layer above |

Eleven, not ten, because the eleventh arrived with the install rather than with
the code — and a threat list that only grows when someone edits a source file
would have missed it.

### Explicitly NOT covered by B1

Named so that shipping B1 is not mistaken for having finished.

- **Transport security.** No TLS anywhere. B0 binds loopback, which is why that
  is survivable today; exposing the API needs a reverse proxy terminating TLS,
  and the `Secure` cookie flag is meaningless without it.
- **Encryption at rest for app-under-test credentials** — B4. B1 ships a
  refusing interface (§7).
- **The saved `storageState` files** — still plaintext live customer sessions on
  disk, still gitignored, unchanged.
- **Trace, video and HTML-report artifacts containing live customer sessions** —
  the pre-existing hazard documented in `docs/WHERE-WE-ARE.md`. B3 must not serve
  them; B1 does nothing about them.
- **MFA, and SSO itself** — interface only (§8).
- **General denial of service.** The throttling in §3 protects the login
  endpoint. Nothing protects the rest.
- **Host and platform** — OS patching, disk encryption, backup and restore,
  secrets in the process environment, who can read `.env` on the host.
- **Supply chain** beyond the committed lockfile and the kit manifest.
- **The `GET /api/health` environment drift** — narrowed in B1d (§5) but the
  underlying disagreement between what health reports and where runs go is a
  separate, recorded issue.
- **`POST /api/runs` cannot run the demo suite** — measured and reported in the
  B0 follow-up; it belongs to the runs API (B2), not here.

---

## 10. Batch plan B1b–B1d

Baseline, measured 2026-10-12 at commit `9ce3331`: **unit 676 / demo 38 / api 25**.

Deltas are **pre-registered**: the number is committed to before the code is
written, and a mismatch is reported and explained rather than quietly absorbed.
One lesson from B0 is folded in — `tests/unit/counterfactual.spec.ts` is
_generative_, emitting one test per entry in its `COVERED` registry, so **every
new spec file added to that registry is +1 unit test on top of its own contents**.
B0's prediction missed by exactly that. The counts below include it.

### B1b — Postgres, Prisma, schema, repositories

No authentication yet. Database only, so a schema problem surfaces on its own.

**Scope:** Postgres installed per §1; `prisma` and `@prisma/client` added to
`apps/api`; the schema rewritten with `User`, `Session`, `Invite`, `AuditEvent`,
`Application`, `Membership`, and `Run`/`TestRun` realigned to the canonical
`Run`; `PrismaRunRepository` plus the five new repository pairs; one
parameterised contract suite; `DATABASE_URL` with no default and a refusal that
names it; `pnpm test:db`; migrations via `prisma migrate deploy`.

**Pre-registered: unit +12, demo +0, api +4 → unit 688 / demo 38 / api 29.**
(unit: 9 contract-suite tests against the in-memory implementation + 2 for
`DATABASE_URL`'s three states + 1 generative. api: run history survives an API
restart — the one claim the in-memory implementation cannot make — plus 3 for the
repository binding.)

**Stop and report if:**

- Postgres cannot be installed without administrator rights **and** the portable
  zip fallback also fails;
- Prisma's query engine has no prebuilt binary for this platform and Node ABI;
- `prisma migrate dev` needs a shadow database the developer's role cannot create;
- the contract suite cannot be parameterised over both implementations from one
  file — two copies of it would drift, and a drifted contract reads as a passing one;
- `pnpm verify` starts requiring a database.

### B1c — identity: users, hashing, sessions, bootstrap, invites

**Scope:** `@node-rs/argon2` with §2's parameters and a recorded cost
measurement; session issue/verify/revoke per §3; `POST /api/auth/login`,
`/logout`, `/me`, `/password`; the cookie and its flags; CSRF origin check;
throttling and lockout; `pnpm aitp:create-owner`; invites.

**Pre-registered: unit +22, demo +2, api +14 → unit 710 / demo 40 / api 43.**
(unit: hashing parameters and rehash-on-login, token entropy and
hashed-at-rest, `timingSafeEqual` usage, idle vs absolute expiry as separate
clocks, the `Secure` flag computed from the request, origin-check fail-closed,
throttle counters, bootstrap refusal when a user exists, invite single-use and
expiry, plus 2 generative. demo: the bootstrap CLI driven as a real process,
once for success and once for its refusal. api: login success and failure,
cookie flags, CSRF both ways, rate limit and lockout, logout revokes, session
survives restart, no enumeration by status/body/timing.)

**Stop and report if:**

- `@node-rs/argon2` has no prebuilt binary for win32-x64 on Node 24 — then fall
  back to `node:crypto` scrypt (§2) and **re-pre-register the counts** rather
  than absorbing the change;
- a hash at §2's parameters exceeds ~1s on the slowest target host;
- the no-enumeration timing test is flaky, which means the dummy-hash path
  diverges from the real one and the control does not hold;
- any test needs a real `.env` credential to pass (§AJ — a guard that reads the
  environment is testing the machine it runs on).

### B1d — authorization: default deny, roles, scopes, audit

**Scope:** the global guard; `can()`; the §5 matrix enforced; `AuditEvent`
written for allow and deny; the append-only grant; `GET /api/audit`;
`GET/POST /api/users`, role change, disable; the `health` body narrowed;
`POST /api/events` moved to the per-run ingest token; `redactSecrets` wired into
the Nest logger; `SecretStore` + `RefusingSecretStore`.

**Pre-registered: unit +18, demo +0, api +20 → unit 728 / demo 40 / api 63.**
(unit: the `(role, scope, action)` matrix table-driven with every deny cell
asserted, the append-only repository having no mutating method, redaction of the
API logger, plus 2 generative. api: per endpoint class, an unauthorised role gets
403 and an authorised one succeeds; every non-public route is 401 unauthenticated;
a `@Public()` route stays reachable; **a newly added unannotated route is 401**;
audit rows written for allow and for deny.)

**Stop and report if:**

- the endpoint matrix cannot be **derived** from Nest's route table — a
  hand-written matrix beside a derived route set is §AE with a verdict attached,
  and a missing row would open a gate rather than degrade a message. If it cannot
  be derived, stop and redesign;
- the append-only grant cannot be expressed in the chosen deployment;
- the default-deny property cannot be demonstrated by adding a route — if the
  only available proof is enumerating today's routes, the guard is not
  default-deny and the design is wrong;
- `can()` survives a mutation pass. It is the load-bearing safety property of
  this layer, so it gets the treatment `checkGrounding()` got: break each rule
  deliberately and confirm a named test fails for each. Per this repo's rule, do
  the **awkward** mutation first — here that is scope narrowing, not role
  comparison.

### Across all three

- No batch may make `pnpm verify` depend on a database, a credential or a network.
- Every new spec file carries a `// wrong:` counterfactual per test and is added
  to `counterfactual.spec.ts` (remembering it is +1 each).
- `apps`, `tests` and `docs` are locked kit prefixes, so **every batch
  regenerates `kit-manifest.json` in the same commit** — B0 proved that a
  separate commit leaves an intermediate failing `kit-integrity-cli.spec.ts` KC2.
- No batch creates a tag or runs `kit:release`.

---

## 11. Decisions — answered 2026-10-12

Two of the three are settled. The third was returned as an unfilled template and
is what B1b is blocked on. The questions as originally asked are kept below the
answers, because an answer with the question deleted stops being checkable.

### 11.1 Postgres — ANSWERED (winget), but B1b is still blocked, on `DATABASE_URL`

**Answered 2026-10-12: installed via winget.** Confirmed by measurement, and the
server is up — `postgresql-x64-17` Running, 17.11, answering on `127.0.0.1:5432`
(§0.1).

**`DATABASE_URL` does not exist anywhere**, which is the one thing the rest of
B1b cannot proceed without. Checked, all negative: not in `.env` (whose mtime is
**21 Sep 2026**, three weeks before the install), no `.env.local` on disk, not in
the running process environment, not in the User or Machine environment scopes,
and nothing under `config/` mentions it.

It cannot be reconstructed from here, and that is not a limitation to work
around. Building one means knowing a role and a password; the superuser password
was set during the install and is not recorded in this tree, and **inventing or
setting a database password is not something this layer may do** — the same rule
that keeps the first-Owner bootstrap off an environment variable (§4). There is
also no passwordless route: on Windows the `local` lines in `pg_hba.conf` are
inert, so there is no peer-authenticated socket to fall back to.

**To unblock, in `.env` (gitignored, confirmed at `.gitignore:27`):**

```dotenv
DATABASE_URL=postgresql://aitp:<password>@127.0.0.1:5432/aitp?schema=public
```

Recommended shape, and why each part: a **dedicated `aitp` role** rather than
`postgres`, so the application never holds superuser rights and so §6's
`GRANT INSERT, SELECT`-only on the audit table is expressible at all — a
superuser cannot be restricted by a grant. A **dedicated `aitp` database**, so a
`prisma migrate reset` during development cannot reach anything else.
`127.0.0.1` explicitly rather than `localhost`, which resolves to `::1` first on
Windows and would then depend on the second `pg_hba` line.

Creating them, once, from an elevated shell (the password is typed at the prompt,
never passed as an argument where it would land in shell history):

```powershell
$env:PATH += ';C:\Program Files\PostgreSQL\17\bin'
psql -U postgres -h 127.0.0.1 -c "CREATE ROLE aitp LOGIN PASSWORD '<choose one>';"
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE aitp OWNER aitp;"
```

The earlier re-measurement, kept because it is what made the winget branch the
recommended one: before the install this shell was **not elevated** though the
account **is** in local Administrators, so a UAC prompt could not be answered
non-interactively — the install was available to the user and not to the tooling.
That is still true of the role creation above.

Also measured, because it decides whether the winget branch is even available:
this shell is **not elevated**, though the account **is** in the local
Administrators group. So `winget install PostgreSQL.PostgreSQL.16` would raise a
UAC prompt that a non-interactive session cannot answer — the install is
available to the user and not to the tooling.

Per the standing instruction ("do steps that need no database first and STOP at
the first one that does"), **B1b stops at its own step 1.** The ordered scope in
§10 begins with _"Postgres installed per §1"_, and every later step is shaped by
it: the schema wants `prisma validate` to be meaningful, `PrismaRunRepository`
cannot be executed against anything, and `prisma migrate dev` needs a server. The
in-memory half could be written first, but the repository shapes follow the
schema, so writing them first invites rework rather than avoiding it.

**What each branch does next, so the restart is one command:**

| Answer               | First action                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **winget installed** | From an elevated shell: `winget install PostgreSQL.PostgreSQL.16`, then `DATABASE_URL` in `.env`, then B1b proceeds in §10's order                                                                                                                          |
| **portable zip**     | Extract the EnterpriseDB binaries-only zip, `pg_ctl -D <datadir> init`, then `start`; add a `pnpm db:up` so it is one command and not a remembered ritual                                                                                                   |
| **waiting on IT**    | B1b stays blocked. The useful work that needs no database is **B1c's pure half** — `PasswordHasher` and the PHC round-trip (§11.2), which is unit-testable with no server at all. Say the word and that is done out of order, with its own pre-registration |

### 11.2 Hashing — `@node-rs/argon2`, with three conditions. ACCEPTED

Argon2id at §2's parameters. The three conditions, and what each costs:

**(a) The dependency lives in `apps/api`, not the root.** Accepted, and it turns
out this is **already enforced rather than merely intended**:
`scripts/check-api-deps.mjs` resolves every bare specifier in every compiled
`apps/api` file from that file's own directory, and its failure message is
literally _"Add them to apps/api/package.json"_. It is gate SEC-3c inside
`pnpm verify`. So a hashing import that reached the root instead would turn
`verify` red rather than passing review — the condition has a test, which is the
only form a convention survives in.

**(b) PHC strings behind a `PasswordHasher` interface.** Accepted. Argon2's
encoded output is already a PHC string
(`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), which carries the algorithm and
every parameter inside the value — so a verify never has to be told which
algorithm produced it, and a stored hash with weaker parameters than current
policy is detectable and re-hashable on next login (§2). The interface:

```ts
export interface PasswordHasher {
  /** Returns a PHC string. The algorithm and its parameters live INSIDE it. */
  hash(plaintext: string): Promise<PasswordHash>;
  /** Constant-time. Reads the parameters out of the stored value, never from config. */
  verify(stored: PasswordHash, plaintext: string): Promise<boolean>;
  /** True when `stored` was produced under weaker parameters than current policy. */
  needsRehash(stored: PasswordHash): boolean;
}
```

`needsRehash` is on the interface rather than left to the caller because
otherwise raising the cost protects only accounts created afterwards, and nothing
would say so. A second implementation (`ScryptPasswordHasher`) is then a swap at
one binding, which is the escape hatch 11.2's own rejected alternative asked for.

**(c) Effect on `kit-manifest.json` and the lockfile.** Measured in shape, not
guessed:

- `pnpm-lock.yaml` and `apps/api/package.json` are **both inside locked kit
  prefixes** (`pnpm-lock.yaml` is listed explicitly; `apps` covers the other). So
  adding the dependency makes `kit-manifest.json` stale and it must be
  regenerated **in the same commit** — the rule B0 established, and which this
  session has now seen bite twice, the second time because a locked file was
  edited _after_ the regeneration.
- `@node-rs/argon2` resolves platform binaries as **optional** dependencies
  (`@node-rs/argon2-win32-x64-msvc` and siblings). Those land in `node_modules`,
  which is neither tracked nor locked, but every one of them appears in
  `pnpm-lock.yaml` — so the lockfile grows by roughly a dozen entries and its
  hash changes. That is one manifest line; it is not a kit version bump.
- `.node` binaries do **not** enter the manifest: it is built from
  `git ls-files`, and `node_modules` is gitignored. The kit therefore still ships
  no binary — it ships a lockfile that will fetch one.

### 11.3 Ingest token — APPROVED, and it collides with B0's own tripwire

The design is accepted as specified: 256-bit random, only its hash stored, valid
for one `runId`, expiring when the run ends, never logged, and a test proving a
token for run A is rejected for run B.

**But `AITP_INGEST_TOKEN` cannot simply be added, and this is measured.** B0's
`child-env.ts` carries a tripwire over the name of anything that may reach a
child: `/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i`.
`AITP_INGEST_TOKEN` contains `TOKEN`, so `buildChildEnv` **throws on both
paths** — verified 2026-10-12:

```
on the ALLOWLIST: THROWS -> the child-env allowlist names AITP_INGEST_TOKEN …
as an OVERRIDE:   THROWS -> the overrides for this spawn names AITP_INGEST_TOKEN …
```

This is the tripwire working. It was built so that a careless widening of the
allowlist fails loudly, and the first deliberate widening is indistinguishable
from a careless one _by name alone_. Two consequences:

**It belongs in the OVERRIDES, not the inherited allowlist.** The instruction
said allowlist, and the allowlist is for variables inherited from the API's own
environment — which this one never is. It is minted per run, at run creation, by
the API; the parent process never holds it. Putting it on the inherited allowlist
would be dead config that also opens a door: it would let an
`AITP_INGEST_TOKEN` exported in the operator's shell reach every child, which is
precisely the inheritance B0 closed.

**The exemption must stay an allowlist of exemptions.** The wrong fix is to
narrow the pattern (it would stop catching real secrets); the wrong fix is also
to rename the variable to dodge the detector (same effect, hidden). The right
shape is a second, explicit set — exactly one member, override-path only:

```ts
/** Names a spawn may set DELIBERATELY, despite looking secret-shaped. */
const INTENDED_SECRET_OVERRIDES = new Set(['AITP_INGEST_TOKEN']);
```

Checked only for overrides, never for inherited keys, so the inherited path stays
completely closed to anything secret-shaped. It needs both halves of §W: a test
that `AITP_INGEST_TOKEN` passes as an override, and a test that it still **throws
on the allowlist** and that any other secret-shaped override still throws.

**Not implemented in B1b, deliberately.** Nothing mints or validates the token
until B1d (§5 assigns `POST /api/events` to it). Adding the exemption now would
weaken a tripwire for a variable that no code produces or consumes — strictly
worse than landing the exemption, the minting, the validation and the A-rejected-
for-B test together. Carried to **B1d**, where its pre-registered api delta grows
by 2 (the A/B rejection, and an expired token refused) and unit by 2 (the two
tripwire halves).

---

## The questions as originally asked

**1. Postgres on the dev machine: winget system install, or portable zip?**
winget (`PostgreSQL.PostgreSQL.16`) gives a real Windows service that survives
reboots but **needs administrator rights**. The EnterpriseDB binaries-only zip
needs no admin and no installer, but must be started per session with `pg_ctl`
and is easier to forget. _Recommended: winget_, if you have admin on this
machine — a database that disappears when you reboot will be blamed on the code.

**2. `@node-rs/argon2`, or `node:crypto` scrypt?**
Argon2id is the better primitive and the package ships prebuilt binaries, so no
compiler is needed. But it would be the **first native/platform-specific binary
in this dependency tree** (measured: zero today outside Playwright), and a
prebuilt binary can still fail to exist for a future platform or Node ABI, where
`node:crypto` scrypt — zero dependencies, OWASP-acceptable at `N=2^17, r=8, p=1`
— never can. _Recommended: `@node-rs/argon2`_, but the zero-dependency property
is genuinely valuable in a repo that locks and hashes its own file tree, so this
is yours to call.

**3. How does the Playwright reporter authenticate to `POST /api/events`?**
It is a child this API spawned, so it cannot hold a cookie. _Recommended: a
per-run ingest token_ — minted at run creation, scoped to that one `runId`,
expiring when the run finishes, and passed to the child in its environment,
which means **one new entry on B0's child-env allowlist** (`AITP_INGEST_TOKEN`).
The alternative is to trust loopback plus the `runId`, which needs no token but
means anything running on the host can post events into any run. I would rather
add the allowlist entry than keep that open, but B0 established that allowlist
additions are yours to approve.
