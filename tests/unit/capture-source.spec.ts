import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { loadCaptureFromDisk } from '@aitp/execution-engine';
import type { AccessibilityNode } from '@aitp/shared';

/**
 * The captures on disk, merged — or three different ways of saying there is none.
 *
 * `runSheet` took its capture from the caller and said why: `artifacts/` is
 * gitignored, so a loader fails on every fresh clone for a reason that is not wrong.
 * 3b's CLI has no page to take one from, so the loader exists and the three answers
 * are kept apart instead — NOT CONFIGURED, nothing usable, and loaded.
 *
 * ## Every test writes its own artifacts root (§AJ)
 *
 * `AITP_REPO_ROOT` points at a temp directory in every case below. Reading the real
 * `artifacts/` would make this suite a measurement of this machine: green here,
 * green-for-the-wrong-reason on a colleague's, and vacuous in CI where the directory
 * does not exist. Four guards were corrected for exactly that on 2026-10-02, two of
 * them written an hour after the rule was.
 */

const node = (role: string, name: string): AccessibilityNode => ({ role, name, enabled: true });

interface SessionSpec {
  id: string;
  application?: string;
  baseUrl?: string;
  capturedAt?: string;
  states?: Array<{ id: string; url: string; nodes: AccessibilityNode[] }>;
  /** Written instead of capture.json, to stand for a pre-AX session. */
  pages?: Array<{ url: string }>;
  /** Written verbatim, for the malformed case. */
  raw?: string;
}

let root: string;

function writeSessions(application: string, sessions: SessionSpec[]): void {
  const dir = path.join(root, 'artifacts', application, 'inspect');
  for (const session of sessions) {
    mkdirSync(path.join(dir, session.id), { recursive: true });
    if (session.raw !== undefined) {
      writeFileSync(path.join(dir, session.id, 'capture.json'), session.raw, 'utf8');
      continue;
    }
    if (session.pages) {
      writeFileSync(
        path.join(dir, session.id, 'pages.json'),
        JSON.stringify(session.pages),
        'utf8',
      );
      continue;
    }
    writeFileSync(
      path.join(dir, session.id, 'capture.json'),
      JSON.stringify({
        sessionId: session.id,
        capturedAt: session.capturedAt ?? '2026-09-01T00:00:00.000Z',
        application: session.application ?? application,
        environment: 'app',
        baseUrl: session.baseUrl ?? 'https://app.example',
        labelledBy: 'inspect',
        states: (session.states ?? []).map((state) => ({
          ...state,
          label: state.id,
          truncated: false,
        })),
        transitions: [],
      }),
      'utf8',
    );
  }
}

test.beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aitp-capture-source-'));
  process.env.AITP_REPO_ROOT = root;
});

test.afterEach(() => {
  delete process.env.AITP_REPO_ROOT;
  rmSync(root, { recursive: true, force: true });
});

test.describe('the capture directory has one reader (CS) @unit', () => {
  test('CS1: no directory is NOT CONFIGURED, and never an empty capture', () => {
    // wrong: it returns a capture with no states, and every caller then reports
    // "that element is not in the capture" about a capture that was never read. A
    // `catch` returning an empty collection turns a failure into a confident
    // negative, and the confidence is indistinguishable from a real answer.
    const source = loadCaptureFromDisk('nobody', {});

    expect(source.kind).toBe('none');
    if (source.kind !== 'none') throw new Error('unreachable');
    expect(source.reason).toMatch(/does not exist/);
    expect(source.reason).toMatch(/pnpm inspect/);
  });

  test('CS2: labelled sessions MERGE, and state ids are session-qualified', () => {
    // wrong: the loader takes one session — the biggest, or the newest — and a QA
    // who walked five screens over three weeks gets one week's worth. The Command
    // Box did exactly that ("the session with the most states"), which is a proxy
    // for recency that picks a six-week-old walk over yesterday's.
    writeSessions('dms', [
      {
        id: 's1',
        states: [
          { id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'Workspaces')] },
        ],
      },
      {
        id: 's2',
        states: [
          { id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'Workspaces')] },
        ],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    // QUALIFIED, because two sessions of one screen produce the same slug and
    // `CapturedState.id` is the cursor a grounding check moves. A collision would
    // merge two screens' node sets silently.
    expect(source.capture.states.map((s) => s.id)).toEqual(['s1/files', 's2/files']);
    // And the selection record says nothing was dropped for relevance, which is the
    // true answer for a full load rather than a bounding that never happened.
    expect(source.capture.selection.keywords).toEqual([]);
    expect(source.capture.selection.excluded).toEqual([]);
    expect(source.capture.selection.chosen).toHaveLength(2);
  });

  test('CS3: a session from another HOST is skipped, with both hosts named', () => {
    // wrong: a capture of the staging system answers questions about production.
    // A capture is what a locator was written against; pooling two systems is the
    // mistake `labelledBy` exists to prevent, one layer in.
    writeSessions('dms', [
      {
        id: 'elsewhere',
        baseUrl: 'https://staging.example',
        states: [{ id: 'files', url: 'https://staging.example/files', nodes: [node('tree', 'W')] }],
      },
      {
        id: 'here',
        baseUrl: 'https://app.example',
        states: [{ id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', { targetHost: 'app.example' });
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.sessions.map((s) => s.sessionId)).toEqual(['here']);
    expect(source.skipped[0]!.sessionId).toBe('elsewhere');
    expect(source.skipped[0]!.why).toMatch(/"staging\.example"/);
    expect(source.skipped[0]!.why).toMatch(/"app\.example"/);
  });

  test('CS3: without a targetHost, nothing is filtered by host', () => {
    // wrong: the host filter applies whether or not a caller asked for one, so
    // `triage` silently drops every session captured against staging and reports a
    // lower ceiling than the captures support. Zero sessions and "no capture at all"
    // then read alike.
    //
    // The silent half of CS3, and the distinction is deliberate rather than lax: a
    // RUN passes a host because it is about to drive it, and a COVERAGE COUNT must not —
    // the same screen captured against staging is still a screen somebody walked,
    // and dropping it would understate a ceiling that gets quoted. `triage` is the
    // caller that passes nothing.
    writeSessions('dms', [
      {
        id: 'elsewhere',
        baseUrl: 'https://staging.example',
        states: [{ id: 'files', url: 'https://staging.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.sessions.map((s) => s.sessionId)).toEqual(['elsewhere']);
    expect(source.skipped).toEqual([]);
  });

  test('CS4: a session labelled for ANOTHER application is skipped, not trusted', () => {
    // wrong: the directory it sits in decides, so a migration that moved a session
    // to the wrong application is believed forever. The path and the file are two
    // sources for one fact and they are written together — a disagreement is
    // exactly the kind nobody can see afterwards.
    writeSessions('dms', [
      {
        id: 'wrong-label',
        application: 'acme',
        states: [{ id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});

    expect(source.kind).toBe('none');
    if (source.kind !== 'none') throw new Error('unreachable');
    expect(source.skipped[0]!.why).toMatch(/labelled application "acme"/);
    expect(source.skipped[0]!.why).toMatch(/under "dms"/);
    // AND it is not reported as "the element is not in the capture" — nothing was
    // searched, and the reason says so.
    expect(source.reason).toMatch(/nothing was searched/);
  });

  test('CS5: an EMPTY state is dropped and counted, not merged', () => {
    // wrong: a state with no nodes is merged, and every "the capture has no X"
    // message lists a state that holds nothing. Six of the 104 DMS states on disk
    // are empty; `inspect` warns at capture time and this is the other end of it.
    writeSessions('dms', [
      {
        id: 's1',
        states: [
          { id: 'blank', url: 'https://app.example/files', nodes: [] },
          { id: 'real', url: 'https://app.example/files', nodes: [node('tree', 'Workspaces')] },
        ],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.capture.states.map((s) => s.id)).toEqual(['s1/real']);
    expect(source.emptyStatesDropped).toBe(1);
    // The surviving count is the session's, not the file's — a reader comparing the
    // two would otherwise see a number that does not match the directory.
    expect(source.sessions[0]!.states).toBe(1);
  });

  test('CS6: a pre-AX session cannot run rows, and its ROUTES still count', () => {
    // wrong: `pages.json` is silently ignored, and the coverage count drops six
    // sessions — understating a ceiling that gets quoted. Or the opposite: it is
    // merged as if it had nodes, and a row resolves against a state with none.
    //
    // THE DISCRIMINATING PAIR: the same session must be absent from the capture and
    // present in the coverage. Measured on the real disk before this was built —
    // pages.json contributes 0 routes capture.json does not already have — so the
    // two views are separated on principle, not on today's numbers.
    writeSessions('dms', [
      { id: 'old', pages: [{ url: 'https://app.example/legacy-screen' }] },
      {
        id: 'new',
        states: [{ id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.capture.states.map((s) => s.id)).toEqual(['new/files']);
    expect(source.skipped[0]!.sessionId).toBe('old');
    expect(source.skipped[0]!.why).toMatch(/no nodes/);
    expect([...source.coverage.routes].sort()).toEqual(['/files', '/legacy-screen']);
  });

  test('CS7: a malformed capture names the parse error, and is never silent', () => {
    // wrong: `catch {}` and move on, so a corrupt file reads exactly like an absent
    // one. A failed read and an empty result send a reader to two different places.
    writeSessions('dms', [
      { id: 'broken', raw: '{ not json' },
      {
        id: 'fine',
        states: [{ id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.skipped[0]!.sessionId).toBe('broken');
    expect(source.skipped[0]!.why).toMatch(/does not parse/);
    expect(source.capture.states).toHaveLength(1);
  });

  test('CS8: the age of the capture is reported, oldest and newest', () => {
    // wrong: a run reports no age, so a report built on a six-week-old walk of a
    // changing application reads exactly like one built this morning. Measured
    // 2026-10-02: the DMS /files anchor is older than the application — all 58
    // captured states still show a tab the screen no longer has.
    writeSessions('dms', [
      {
        id: 'older',
        capturedAt: '2026-08-01T10:00:00.000Z',
        states: [{ id: 'a', url: 'https://app.example/a', nodes: [node('tree', 'W')] }],
      },
      {
        id: 'newer',
        capturedAt: '2026-09-30T10:00:00.000Z',
        states: [{ id: 'b', url: 'https://app.example/b', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.oldest).toBe('2026-08-01T10:00:00.000Z');
    expect(source.newest).toBe('2026-09-30T10:00:00.000Z');
  });

  test('CS9: pre-move sessions in the legacy root are COUNTED, never merged', () => {
    // wrong: they are pooled into this application's set on the strength of nothing
    // — they carry no application at all — or ignored silently, which understates
    // the coverage. Sixteen of them exist on this machine and all sixteen are empty.
    mkdirSync(path.join(root, 'artifacts', 'inspect', 'pre-move'), { recursive: true });
    writeSessions('dms', [
      {
        id: 's1',
        states: [{ id: 'files', url: 'https://app.example/files', nodes: [node('tree', 'W')] }],
      },
    ]);

    const source = loadCaptureFromDisk('dms', {});
    if (source.kind !== 'loaded') throw new Error(`expected loaded, got ${source.kind}`);

    expect(source.unlabelled).toBe(1);
    expect(source.capture.states.map((s) => s.id)).toEqual(['s1/files']);
  });
});
