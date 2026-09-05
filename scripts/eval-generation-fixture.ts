#!/usr/bin/env node
/**
 * The four-mistake fixture (docs/phase-2-generation.md, eval axis 4).
 *
 *   pnpm eval:generation
 *
 * This is the acceptance test for the generation prerequisites. Each of the
 * four mistakes we made by hand is scored on TWO conditions:
 *
 *   safety     — the known-WRONG assertion must NOT grade `observed`
 *   capability — the known-RIGHT assertion MUST grade `observed`
 *
 * caught = safety && capability. Safety alone is satisfied before any
 * prerequisite lands (an ungrounded claim grades `assumed`, which is not
 * `observed`), so a fixture scoring only safety would read 4/4 from the start
 * and mean nothing. Capability is the half that moves when P1/P2 deliver.
 *
 * Deterministic and free: no LLM, no live application. The capture comes out
 * of the REAL capture functions run against a controlled local page, so when
 * the capture gains a property the fixture sees it without anyone editing the
 * fixture. Whether a *model* would produce these assertions is a different
 * question, measured by eval axes 1-3 once the generator exists.
 */
/* eslint-disable no-console -- tabular acceptance report for a human. */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import {
  captureAccessibilityTree,
  crossCheckTransition,
  diffAxTrees,
} from '@aitp/execution-engine';
import {
  checkGrounding,
  findRepoRoot,
  type CandidateCase,
  type CapturedState,
  type DeclaredTransition,
  type StateCapture,
} from '@aitp/shared';

const repoRoot = findRepoRoot(__dirname);
const html = readFileSync(
  path.join(repoRoot, 'tests', 'fixtures', 'generation', 'four-mistakes.html'),
  'utf8',
);

interface MistakeCase {
  id: string;
  title: string;
  /** Which prerequisite is supposed to make `capability` pass. */
  owner: 'P1' | 'P2a' | 'P2';
  wrong: CandidateCase;
  right: CandidateCase;
  /** What the wrong assertion was, in words, for the report. */
  wrongDescription: string;
  /**
   * The grade the WRONG assertion must receive — not merely "anything but
   * observed".
   *
   * A criterion that can be satisfied by knowing nothing is not a criterion.
   * "Not observed" is free: an empty capture grades everything `assumed` and
   * would pass. So where the capture is capable of positively refuting the
   * mistake, the fixture demands exactly that — `contradicted`, which no
   * empty capture can produce. Where refutation is genuinely impossible
   * (#2: we never captured what Next does, so `assumed` is the correct and
   * honest grade), safety carries no positive weight and `caught` rests
   * entirely on capability, which is itself positive.
   */
  expectedWrongGrade: 'contradicted' | 'assumed';
  /** Why that grade, in words, for the report and for the next reader. */
  wrongGradeReason: string;
}

function serve(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function captureState(page: Page, id: string, label: string): Promise<CapturedState> {
  const tree = await captureAccessibilityTree(page, { maxNodes: 1_000 });
  return { id, label, url: tree.url, nodes: tree.nodes, truncated: tree.truncated };
}

/**
 * Which prerequisite's capability the capture is allowed to use.
 *
 * `AITP_FIXTURE_STAGE=baseline|p2a|p2` (default `p2`). Each earlier stage is
 * reproduced by REMOVING exactly what the prerequisite added — selection
 * properties for P2a, declared transitions for P2 — so the staged scores in
 * docs/phase-2-generation.md stay re-derivable by anyone, instead of being a
 * one-off measurement nobody can check.
 */
type Stage = 'baseline' | 'p2a' | 'p2';
const STAGE: Stage = (process.env.AITP_FIXTURE_STAGE as Stage) || 'p2';

function degradeToStage(capture: StateCapture, stage: Stage): StateCapture {
  if (stage === 'p2') return capture;
  const withoutTransitions = { ...capture, transitions: [] };
  if (stage === 'p2a') return withoutTransitions; // selection kept, transitions removed
  // baseline: also strip what P2a added, back to {role, name, enabled}.
  return {
    ...withoutTransitions,
    states: withoutTransitions.states.map((state) => ({
      ...state,
      nodes: state.nodes.map(({ role, name, enabled }) => ({ role, name, enabled })),
    })),
  };
}

/**
 * Builds the capture the way the tooling can build it TODAY. Transitions are
 * only declared if the capture format supports them — which is what P2 adds.
 * Nothing here fakes a capability the tool does not have; that is the whole
 * point of running this before building.
 */
async function buildCapture(baseUrl: string): Promise<StateCapture> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const states: CapturedState[] = [];
  const transitions: DeclaredTransition[] = [];

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

    // Every state a human could reach and label with today's tooling.
    states.push(await captureState(page, 'admin.create-role.empty', 'Create Role dialog, empty'));
    states.push(await captureState(page, 'files.tree', 'Workspace tree'));
    states.push(await captureState(page, 'upload.workspace-step', 'Upload: Workspace step'));

    const beforeClick = states[states.length - 1]!.nodes;
    await page.click('#tile-alpha');
    await page.waitForTimeout(200);
    states.push(await captureState(page, 'upload.folder-step', 'Upload: Folder step'));

    // P2: the transition is DECLARED (as a human would) and its verdict is
    // EARNED by the same cross-check the inspector runs — not asserted here.
    // If the declaration and the observed delta disagreed, this would come
    // back `suspect` and would stop grounding anything, which is the point.
    const action = 'clicked "WS-ALPHA"';
    const delta = diffAxTrees(beforeClick, states[states.length - 1]!.nodes);
    const check = crossCheckTransition(action, beforeClick, delta);
    transitions.push({
      from: 'upload.workspace-step',
      to: 'upload.folder-step',
      action,
      verdict: check.verdict,
    });
    if (check.verdict === 'suspect') {
      console.log(`  cross-check flagged the fixture's own transition: ${check.reasons.join('; ')}`);
    }

    await page.click('#select-all');
    await page.waitForTimeout(200);
    states.push(await captureState(page, 'search.all-selected', 'Search results, all selected'));

  } finally {
    await browser.close();
  }

  return { sessionId: 'fixture', states, transitions };
}

const MISTAKES: MistakeCase[] = [
  {
    id: '#1',
    title: 'admin create form: Create is disabled while empty (Finding 9)',
    owner: 'P2',
    wrongDescription: 'Create button is DISABLED on an empty form',
    expectedWrongGrade: 'contradicted',
    wrongGradeReason:
      'the dialog state is captured and holds button "Create" enabled=true, so the capture actively refutes this — an empty capture could not',
    wrong: {
      entryState: 'admin.create-role.empty',
      steps: [{ kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: false }],
    },
    right: {
      entryState: 'admin.create-role.empty',
      steps: [{ kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true }],
    },
  },
  {
    id: '#2',
    title: 'upload wizard: choosing a workspace auto-advances (Finding 8)',
    owner: 'P2',
    wrongDescription: 'after choosing a workspace you click Next to reach the Folder step',
    expectedWrongGrade: 'assumed',
    wrongGradeReason:
      'nobody ever declared what clicking Next does, so the capture genuinely does not know — `assumed` is the honest grade, and #2 therefore rests entirely on its (positive) capability half',
    wrong: {
      entryState: 'upload.workspace-step',
      steps: [
        { kind: 'action', description: 'clicked Next' },
        { kind: 'assert', role: 'tab', name: 'Folder', property: 'selected', expected: true },
      ],
    },
    right: {
      entryState: 'upload.workspace-step',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        { kind: 'assert', role: 'tab', name: 'Folder', property: 'selected', expected: true },
      ],
    },
  },
  {
    id: '#3',
    title: 'global search: select-all reveals one consolidated download',
    owner: 'P2',
    wrongDescription: 'every result row gains its own "Download File" action',
    expectedWrongGrade: 'contradicted',
    wrongGradeReason:
      'the post-select-all state is captured and complete, and contains no such button — absence in a COMPLETE view is evidence (Finding 15)',
    wrong: {
      entryState: 'search.all-selected',
      steps: [
        { kind: 'assert', role: 'button', name: 'Download File', property: 'present', expected: true },
      ],
    },
    right: {
      entryState: 'search.all-selected',
      steps: [
        {
          kind: 'assert',
          role: 'button',
          name: 'Download Selected (2)',
          property: 'present',
          expected: true,
        },
      ],
    },
  },
  {
    id: '#4',
    title: 'file tree: a row is named for its nested controls too (Finding 11)',
    owner: 'P1',
    wrongDescription: 'the workspace row is named "WS-ALPHA"',
    expectedWrongGrade: 'contradicted',
    wrongGradeReason:
      'the tree state is captured and complete, and the row is named "Expand WS-ALPHA More options" — the bare name is positively absent',
    wrong: {
      entryState: 'files.tree',
      steps: [{ kind: 'assert', role: 'treeitem', name: 'WS-ALPHA', property: 'present', expected: true }],
    },
    right: {
      entryState: 'files.tree',
      steps: [
        {
          kind: 'assert',
          role: 'treeitem',
          name: 'Expand WS-ALPHA More options',
          property: 'present',
          expected: true,
        },
      ],
    },
  },
];

/**
 * Assertions that isolate ONE prerequisite's contribution, reported separately
 * from the four-mistake score.
 *
 * These exist because of a real gap found on 2026-09-05: the `baseline` and
 * `p2a` stages produced BYTE-IDENTICAL output. The degradation was working
 * (the raw capture carries `selected` on four nodes; baseline stripping
 * removes it), but no mistake could observe the difference — #2 is the only
 * case that touches `selected`, and it dies at the transition step long
 * before reaching a node lookup. So the `p2a` row was unfalsifiable: it
 * measured nothing the `baseline` row did not.
 *
 * A probe fixes that by asserting a property-only fact that needs no
 * transition at all. P2a's contribution then shows up directly, and deleting
 * P2a would visibly break this line rather than hiding behind #2.
 */
interface Probe {
  owner: 'P1' | 'P2a' | 'P2';
  what: string;
  candidate: CandidateCase;
  expected: 'observed';
}

const PROBES: Probe[] = [
  {
    owner: 'P2a',
    what: 'selection state is recorded at all (needs no transition)',
    candidate: {
      entryState: 'upload.workspace-step',
      steps: [
        { kind: 'assert', role: 'tab', name: 'Workspace', property: 'selected', expected: true },
      ],
    },
    expected: 'observed',
  },
];

async function main(): Promise<void> {
  const { server, baseUrl } = await serve();
  let capture: StateCapture;
  try {
    capture = await buildCapture(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  capture = degradeToStage(capture, STAGE);

  console.log('\n=== Four-mistake fixture ===\n');
  console.log(
    `stage:   ${STAGE}${STAGE === 'p2' ? ' (full)' : ' (earlier capability, reproduced by removal)'}`,
  );
  console.log(
    `capture: ${capture.states.length} state(s), ${capture.transitions.length} declared transition(s)\n`,
  );

  // A criterion that can be satisfied by knowing nothing is not a criterion.
  // This runs every time, against a capture that knows nothing at all. If any
  // mistake scores caught here, the criterion has rotted into something
  // ignorance can pass, and the fixture says so loudly rather than reporting a
  // comfortable number.
  const emptyCapture: StateCapture = { sessionId: 'empty', states: [], transitions: [] };
  const ignoranceCaught = MISTAKES.filter((mistake) => {
    const wrong = checkGrounding(emptyCapture, mistake.wrong);
    const right = checkGrounding(emptyCapture, mistake.right);
    return wrong.overall === mistake.expectedWrongGrade && right.overall === 'observed';
  });
  console.log(
    ignoranceCaught.length === 0
      ? 'ignorance check: an empty capture scores 0/4 — the criterion needs positive evidence. ok\n'
      : `IGNORANCE CHECK FAILED: an empty capture scored ${ignoranceCaught.length}/4 (${ignoranceCaught
          .map((m) => m.id)
          .join(', ')}) — the criterion can be satisfied by knowing nothing.\n`,
  );
  if (ignoranceCaught.length > 0) process.exitCode = 1;

  console.log('--- prerequisite probes (isolate one prerequisite each) ---');
  let probeFailures = 0;
  for (const probe of PROBES) {
    const result = checkGrounding(capture, probe.candidate);
    const pass = result.overall === probe.expected;
    if (!pass) probeFailures += 1;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${probe.owner}] ${probe.what}`);
    for (const step of result.steps) console.log(`          ${step.grade}: ${step.reason}`);
  }
  // Probes gate only at the full stage. Failing at an earlier stage is the
  // whole point — that is the prerequisite's absence being visible — so
  // treating it as an error there would make the staged runs unusable.
  if (probeFailures > 0 && STAGE === 'p2') {
    console.log(`  ${probeFailures} probe(s) FAILED at the full stage — a prerequisite regressed.`);
    process.exitCode = 1;
  }
  console.log('');

  let caughtCount = 0;
  const rows: string[] = [];

  for (const mistake of MISTAKES) {
    const wrong = checkGrounding(capture, mistake.wrong);
    const right = checkGrounding(capture, mistake.right);

    // Not "anything but observed" — the specific grade the capture ought to
    // be able to reach. Demanding `contradicted` where refutation is possible
    // is what stops an empty capture passing this half by default.
    const safety = wrong.overall === mistake.expectedWrongGrade;
    const capability = right.overall === 'observed';
    const caught = safety && capability;
    if (caught) caughtCount += 1;

    console.log(`${caught ? 'CAUGHT    ' : 'not caught'} ${mistake.id}  ${mistake.title}`);
    console.log(`    owner: ${mistake.owner}`);
    console.log(
      `    safety     ${safety ? 'PASS' : 'FAIL'}  wrong assertion (${mistake.wrongDescription}) graded ${wrong.overall}, required ${mistake.expectedWrongGrade}`,
    );
    for (const s of wrong.steps) console.log(`        - ${s.grade}: ${s.reason}`);
    console.log(
      `    capability ${capability ? 'PASS' : 'FAIL'}  right assertion graded ${right.overall}`,
    );
    for (const s of right.steps) console.log(`        - ${s.grade}: ${s.reason}`);
    console.log('');

    rows.push(
      `| ${mistake.id} | ${mistake.owner} | ${safety ? 'pass' : 'FAIL'} | ${capability ? 'pass' : 'FAIL'} | ${caught ? '**caught**' : 'not caught'} |`,
    );
  }

  console.log('| mistake | owner | safety | capability | verdict |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
  console.log(`\nSCORE: ${caughtCount}/${MISTAKES.length} caught\n`);

  const safetyFailures = MISTAKES.filter(
    (m) => checkGrounding(capture, m.wrong).overall === 'observed',
  );
  if (safetyFailures.length > 0) {
    console.log(
      `SAFETY REGRESSION on ${safetyFailures.map((m) => m.id).join(', ')} — a known-wrong assertion graded observed.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
