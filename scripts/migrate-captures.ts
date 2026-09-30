#!/usr/bin/env node
/* eslint-disable no-console -- a migration report for a human to read by eye, the
   same exemption `triage-sheet.ts` takes: this is a one-off operator tool whose
   whole output is a summary, not a service emitting structured log lines. */
/**
 * Moves pre-M1 capture sessions into their application's directory.
 *
 *   pnpm migrate:captures            # reports, moves nothing
 *   pnpm migrate:captures --apply
 *
 * ## The rule, and it is COMPUTED
 *
 * Captures written before 2026-09-30 carry no `application`: the file recorded
 * `sessionId, capturedAt, states, transitions` and nothing else, so the only trace
 * of where a session came from is the URL inside each state.
 *
 * A session moves to `artifacts/<application>/inspect/` only when the HOST of every
 * URL it recorded matches the host of one environment's resolved `baseUrl`. Not the
 * first URL, not most of them — every one, because a session mixing two hosts is not
 * evidence about either, and picking the majority would be inventing the label this
 * whole change exists to stop inventing.
 *
 * Anything that does not match STAYS WHERE IT IS and is counted. A capture is
 * provenance — it is what a locator was written against, and an old one is more
 * valuable than a new one for answering "why does this say ABCD" — so nothing is
 * deleted, and the readers count what is left behind and say so.
 *
 * Moved sessions get `labelledBy: "migration-host-match"` beside the application.
 * The inspector writes `labelledBy: "inspect"`, because it knew first-hand; this
 * script derived it afterwards from a URL. Those are different claims and one field
 * would hide the difference.
 *
 * ## Both session shapes
 *
 * Measured before writing this: of 26 sessions on this machine, 4 have
 * `capture.json` and 6 have `pages.json` (the older format). Reading only the newer
 * one would have left 22 behind while reporting a confident number — so both are
 * read, and a session with neither is counted as exactly that.
 *
 * ## LOCAL ONLY
 *
 * Prints COUNTS, application names, and why sessions were left. Never a URL, a state
 * label, a session id or anything else out of a capture: those hold real workspace
 * names, document titles and user names.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { loadEnvironment } from '@aitp/execution-engine';

const apply = process.argv.includes('--apply');
const root = findRepoRoot();
const legacy = path.join(root, 'artifacts', 'inspect');
const envDir = path.join(root, 'config', 'env');

if (!existsSync(legacy)) {
  console.log('nothing to migrate: artifacts/inspect/ does not exist');
  process.exit(0);
}

/**
 * host -> application, from environments RESOLVED against the current `.env`.
 *
 * The raw files are not enough: `app.json` and `staging.json` hold `${BASE_URL}`, so
 * the DMS host exists only after interpolation. A first draft read the files
 * directly and found ONE host — the bundled demo's — and would have reported
 * "would move: 0" as though nothing matched, when the truth was that it had not
 * looked up the address.
 */
const hostToApplication = new Map<string, string>();
const unresolvable: string[] = [];
for (const file of readdirSync(envDir).filter((f) => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  try {
    const env = loadEnvironment(name);
    hostToApplication.set(new URL(env.baseUrl).host, env.application);
  } catch {
    // A file whose variables are not set in this shell. Counted, not guessed: a
    // session belonging to it will be left behind, and the report says how many
    // environments could not be consulted at all.
    unresolvable.push(name);
  }
}
if (hostToApplication.size === 0) {
  throw new Error(
    'no environment resolved to a host — refusing to report a migration that could only ' +
      `ever move nothing. Unresolvable: ${unresolvable.join(', ') || '(none)'}`,
  );
}

const sessions = readdirSync(legacy, { withFileTypes: true }).filter((e) => e.isDirectory());
console.log(`sessions found: ${sessions.length}`);
console.log(`environments resolved to a host: ${hostToApplication.size}`);
if (unresolvable.length > 0) {
  console.log(
    `environments that could NOT be resolved (their variables are unset here): ` +
      `${unresolvable.length} — ${unresolvable.join(', ')}`,
  );
}

interface Capture {
  application?: string;
  states?: Array<{ url?: unknown }>;
}

/** Every URL a session recorded, from either file format. `undefined` = unreadable. */
function urlsOf(dir: string): string[] | undefined {
  const urls: string[] = [];
  let readAnything = false;

  const capture = path.join(dir, 'capture.json');
  if (existsSync(capture)) {
    try {
      const parsed = JSON.parse(readFileSync(capture, 'utf8')) as Capture;
      for (const state of parsed.states ?? []) {
        if (typeof state.url === 'string') urls.push(state.url);
      }
      readAnything = true;
    } catch {
      return undefined;
    }
  }

  const pages = path.join(dir, 'pages.json');
  if (existsSync(pages)) {
    try {
      const parsed = JSON.parse(readFileSync(pages, 'utf8')) as Array<{ url?: unknown }>;
      for (const page of parsed) {
        if (typeof page.url === 'string') urls.push(page.url);
      }
      readAnything = true;
    } catch {
      return undefined;
    }
  }

  return readAnything ? urls : undefined;
}

let moved = 0;
let left = 0;
const leftBecause = new Map<string, number>();
const movedTo = new Map<string, number>();
const note = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

for (const session of sessions) {
  const dir = path.join(legacy, session.name);

  const captureFile = path.join(dir, 'capture.json');
  if (existsSync(captureFile)) {
    try {
      const parsed = JSON.parse(readFileSync(captureFile, 'utf8')) as Capture;
      if (typeof parsed.application === 'string') {
        left += 1;
        note(leftBecause, 'already labelled');
        continue;
      }
    } catch {
      left += 1;
      note(leftBecause, 'capture.json does not parse');
      continue;
    }
  }

  const urls = urlsOf(dir);
  if (urls === undefined) {
    left += 1;
    note(leftBecause, 'neither capture.json nor pages.json is readable');
    continue;
  }
  if (urls.length === 0) {
    left += 1;
    note(leftBecause, 'no URLs recorded');
    continue;
  }

  const hosts = new Set<string>();
  let unparseable = false;
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      unparseable = true;
    }
  }
  if (unparseable) {
    left += 1;
    note(leftBecause, 'a recorded URL does not parse');
    continue;
  }
  if (hosts.size !== 1) {
    left += 1;
    note(leftBecause, `${hosts.size} distinct hosts in one session`);
    continue;
  }

  const application = hostToApplication.get([...hosts][0]!);
  if (!application) {
    left += 1;
    note(leftBecause, 'host matches no resolvable environment');
    continue;
  }

  if (!apply) {
    moved += 1;
    note(movedTo, application);
    continue;
  }

  const destRoot = path.join(root, 'artifacts', application, 'inspect');
  mkdirSync(destRoot, { recursive: true });
  const dest = path.join(destRoot, session.name);
  if (existsSync(dest)) {
    left += 1;
    note(leftBecause, 'destination already exists');
    continue;
  }

  // THE LABEL FIRST, THEN THE MOVE. A session that arrives unlabelled because the
  // process died between the two reads exactly like one the inspector wrote.
  if (existsSync(captureFile)) {
    const parsed = JSON.parse(readFileSync(captureFile, 'utf8')) as Capture;
    writeFileSync(
      captureFile,
      JSON.stringify({ ...parsed, application, labelledBy: 'migration-host-match' }, null, 2),
      'utf8',
    );
  } else {
    // A `pages.json`-only session has no capture file to label, so the label goes
    // beside it. Without this the move would be the only record of the decision,
    // and a move leaves no reason behind.
    writeFileSync(
      path.join(dir, 'migration.json'),
      JSON.stringify({ application, labelledBy: 'migration-host-match' }, null, 2),
      'utf8',
    );
  }

  renameSync(dir, dest);

  // Asserts its own effect: it landed, and it landed labelled.
  const label = existsSync(path.join(dest, 'capture.json'))
    ? (JSON.parse(readFileSync(path.join(dest, 'capture.json'), 'utf8')) as Capture & {
        labelledBy?: string;
      })
    : (JSON.parse(readFileSync(path.join(dest, 'migration.json'), 'utf8')) as {
        application?: string;
        labelledBy?: string;
      });
  if (label.application !== application || label.labelledBy !== 'migration-host-match') {
    throw new Error(
      `${session.name}: moved but the label did not land. Check artifacts/${application}/inspect/.`,
    );
  }
  moved += 1;
  note(movedTo, application);
}

console.log(`\n${apply ? 'moved' : 'would move'}: ${moved}`);
for (const [application, count] of [...movedTo].sort()) console.log(`  ${application}: ${count}`);
console.log(`left in artifacts/inspect/: ${left}`);
for (const [why, count] of [...leftBecause].sort()) console.log(`  ${why}: ${count}`);

if (moved + left !== sessions.length) {
  throw new Error(
    `accounting does not balance: ${sessions.length} session(s) in, ${moved + left} accounted for`,
  );
}
if (!apply && moved > 0) console.log('\nnothing was changed. Re-run with --apply to move them.');
