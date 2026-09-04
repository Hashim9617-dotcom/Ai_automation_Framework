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

async function main(): Promise<void> {
  const { server, baseUrl } = await serve();
  let capture: StateCapture;
  try {
    capture = await buildCapture(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n=== Four-mistake fixture ===\n');
  console.log(
    `capture: ${capture.states.length} state(s), ${capture.transitions.length} declared transition(s)\n`,
  );

  let caughtCount = 0;
  const rows: string[] = [];

  for (const mistake of MISTAKES) {
    const wrong = checkGrounding(capture, mistake.wrong);
    const right = checkGrounding(capture, mistake.right);

    const safety = wrong.overall !== 'observed';
    const capability = right.overall === 'observed';
    const caught = safety && capability;
    if (caught) caughtCount += 1;

    console.log(`${caught ? 'CAUGHT    ' : 'not caught'} ${mistake.id}  ${mistake.title}`);
    console.log(`    owner: ${mistake.owner}`);
    console.log(
      `    safety     ${safety ? 'PASS' : 'FAIL'}  wrong assertion (${mistake.wrongDescription}) graded ${wrong.overall}`,
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
