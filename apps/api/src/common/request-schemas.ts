import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { findRepoRoot, runRequestSchema } from '@aitp/shared';

/**
 * WHAT THE TWO POST BODIES ARE ALLOWED TO BE.
 *
 * `POST /api/events` had no schema at all: `LiveEvent` is a TypeScript
 * interface, which exists only at compile time, so the body was whatever the
 * caller sent. It is then buffered under a caller-chosen `runId` and
 * re-serialised straight into the SSE stream — so an unvalidated body is both a
 * memory-growth surface and a way to put fabricated results on a dashboard.
 *
 * `POST /api/runs` had types but no BOUNDS: `command`, `metadata` and
 * `browsers` were unbounded, and `environment` was free text.
 *
 * ## The environment is checked by RESOLVING it, not against a written list
 *
 * A hand-written list of environment names beside the real set under
 * `config/env/` is the shape that drifts, and here a missing entry would refuse
 * a legitimate run rather than merely degrade a message (§AE). So the check is
 * derived: the name must look like a slug, and `config/env/<name>.json` must
 * exist. The pattern comes FIRST and is what makes the existence check safe —
 * without it, `environment` reaches `path.join` and `../../../etc/passwd` is a
 * probe for files outside the directory.
 *
 * Two states are kept apart deliberately. A name that is not a slug is
 * malformed; a slug with no file is unconfigured. They are different sentences
 * because they have different fixes.
 */

/** Long enough for any real name, short enough that nothing is a payload. */
const MAX_NAME = 64;
const MAX_TEXT = 500;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE = 512;

/** A run id as `newId()` makes one, and nothing else — it becomes a buffer key. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The same slug shape `environmentSchema.application` uses. Blocks `..` and `/`. */
const ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const runIdSchema = z.string().min(1).max(MAX_NAME).regex(ID_PATTERN, {
  message: 'runId must be alphanumeric with dashes or underscores',
});

/**
 * An environment name this installation actually has a file for.
 *
 * `root` is a parameter so a test can hand it a fixture directory and get the
 * same answer it would get on a clean checkout (§AJ).
 */
export function isKnownEnvironment(name: string, root: string = findRepoRoot()): boolean {
  if (!ENV_NAME_PATTERN.test(name)) return false;
  return existsSync(path.join(root, 'config', 'env', `${name}.json`));
}

const environmentSchema = z
  .string()
  .min(1)
  .max(MAX_NAME)
  .regex(ENV_NAME_PATTERN, {
    message:
      'environment must be a lower-case slug such as "qa" — it names a file under config/env/',
  })
  .refine((name) => isKnownEnvironment(name), {
    message:
      'no such environment: there is no config/env/<name>.json for it. This is a configuration ' +
      'gap, not a malformed request',
  });

/**
 * `POST /api/events`.
 *
 * `payload` stays `unknown` — the reporter sends several different shapes and
 * pinning them here would be a second source of truth for what an event is. Its
 * SIZE is bounded by the body limit in `main.ts`; what matters structurally is
 * the one field read out of it.
 *
 * `event` is capped and pattern-bounded but NOT allowlisted against the seven
 * names the reporter emits. Those names live in two files, so a list here would
 * be hand-written beside a derived set, and a missing entry would silently drop
 * a real event — a verdict, not a message (§AE).
 */
export const liveEventRequestSchema = z
  .object({
    event: z
      .string()
      .min(1)
      .max(MAX_NAME)
      .regex(/^[A-Za-z][A-Za-z0-9:._-]*$/, {
        message: 'event must be a short identifier such as "run:started"',
      }),
    payload: z.unknown().optional(),
    at: z.string().max(MAX_NAME).optional(),
    runId: runIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // THE NESTED runId IS A BUFFER KEY TOO. `EventsService.publish` falls back to
    // `payload.runId` when the top-level one is absent, so validating only the
    // top level leaves the actual key unvalidated in exactly the case it is used.
    const nested = (value.payload as { runId?: unknown } | null | undefined)?.runId;
    if (nested === undefined || nested === null) return;
    if (!runIdSchema.safeParse(nested).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'runId'],
        message: 'payload.runId must be alphanumeric with dashes or underscores',
      });
    }
  });

/**
 * `POST /api/runs` — the canonical schema, plus the bounds an HTTP boundary
 * needs.
 *
 * The caps live here rather than in `@aitp/shared` where that would change what
 * a `RunRequest` is for every producer in the repo, including the reporter. What
 * this adds is the limits of a REQUEST, which is this layer's own question.
 */
export const runRequestApiSchema = runRequestSchema.extend({
  command: z.string().min(3).max(MAX_TEXT).optional(),
  environment: environmentSchema.default('qa'),
  browsers: z
    .array(z.enum(['chromium', 'firefox', 'webkit']))
    .max(3)
    .default(['chromium']),
  metadata: z
    .record(z.string().min(1).max(MAX_NAME), z.string().max(MAX_METADATA_VALUE))
    .refine((value) => Object.keys(value).length <= MAX_METADATA_ENTRIES, {
      message: `metadata may not have more than ${MAX_METADATA_ENTRIES} entries`,
    })
    .default({}),
});
