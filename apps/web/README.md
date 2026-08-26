# apps/web — Dashboard (Phase 3)

Intentionally empty in Phase 1. The backend contracts it will consume already
exist and are running, so the frontend can be built without any further API work:

| Need                    | Endpoint                                  | Shape                     |
| ----------------------- | ----------------------------------------- | ------------------------- |
| Trigger a run           | `POST /api/runs`                          | `RunRequest` → `Run`      |
| AI Command Box          | `POST /api/command`                       | `{ command, dryRun }`     |
| Run detail / results    | `GET /api/runs/:id`                       | `Run`                     |
| Run history             | `GET /api/runs?limit=25`                  | `Run[]`                   |
| Live logs + test events | `GET /api/events/stream/:runId` (SSE)     | `LiveEvent`               |
| Replay missed events    | `GET /api/events/history/:runId`          | `LiveEvent[]`             |
| Cancel                  | `POST /api/runs/:id/cancel`               | `Run`                     |

Every type is exported from `@aitp/shared`, so the dashboard imports the same
definitions the backend uses — no hand-written API types.

Planned stack (from the architecture doc): Vite + React + TypeScript, TanStack
Query for server state, SSE for the live stream, and Playwright's trace viewer
embedded for failure inspection.

Scaffold it with:

```bash
pnpm create vite@latest apps/web -- --template react-ts
```
