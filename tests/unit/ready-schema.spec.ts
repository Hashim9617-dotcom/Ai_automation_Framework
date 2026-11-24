import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  RunStatus,
  TestOutcome,
  describeTarget,
  emptySummary,
  findRepoRoot,
  type Run,
} from '@aitp/shared';
import {
  READY_SCHEMA_VERSION,
  buildReadyDrop,
  type NotifyAppConfig,
  type ReadyDrop,
} from '@aitp/reporting-engine';

/**
 * THE PUBLISHED SCHEMA IS WHAT THE CODE WRITES.
 *
 * ## Why this file exists at all
 *
 * `docs/notify/ready-schema.json` is not documentation — a human PASTES it into the
 * Power Automate flow's Parse JSON step, and every expression in that flow is
 * generated from it. So a field the code renames, drops or retypes does not fail
 * loudly in the flow: Parse JSON yields `null` for it, and the mail goes out with an
 * empty subject, or no recipients, or no body. That looks like a flow problem and is
 * not, and the person who has to diagnose it has no access to this repo.
 *
 * The schema and the writer are therefore two statements of one fact, which is the
 * §AE shape with a verdict attached. This welds them.
 *
 * ## The check is driven FROM the schema, not written beside it
 *
 * The validator reads `required` and `properties` out of the file and applies them to
 * real `buildReadyDrop` output. A hand-written list of expected fields would be a
 * THIRD copy, and the one most likely to drift — so the schema is the single source
 * and this is the instrument that holds the code to it.
 *
 * No JSON Schema library: this repo has no dependency for it, the subset the file
 * uses is small and fully specified, and `additionalProperties: false` plus `type`
 * plus `required` is what actually catches drift. Anything more would be a parser to
 * maintain, and the test asserts that the file uses nothing beyond that subset.
 */

const ROOT = findRepoRoot();
const SCHEMA_FILE = path.join(ROOT, 'docs', 'notify', 'ready-schema.json');

interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
}

function loadSchema(): JsonSchema {
  return JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as JsonSchema;
}

/** The keywords this validator implements. Anything else in the file is refused. */
const SUPPORTED = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'enum',
  'const',
  'items',
  'minItems',
  'minLength',
  'minimum',
  'maximum',
]);

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

/** Every violation, as a path plus a sentence. Empty means valid. */
function validate(value: unknown, schema: JsonSchema, at = '$'): string[] {
  const problems: string[] = [];

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    // `integer` satisfies `number`, and nothing else is widened.
    const ok = allowed.includes(actual) || (allowed.includes('number') && actual === 'integer');
    if (!ok) problems.push(`${at}: expected ${allowed.join(' or ')}, found ${actual}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${at}: expected the constant ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    problems.push(`${at}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${at}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${at}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${at}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        problems.push(...validate(item, schema.items!, `${at}[${index}]`)),
      );
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      // PRESENT, not merely truthy: `reportZipName: null` and `failed: 0` are both
      // legitimate values and both falsy, so a truthiness check would report the two
      // fields most likely to be null or zero as missing.
      if (!(name in record)) problems.push(`${at}.${name}: required and absent`);
    }
    for (const [name, nested] of Object.entries(record)) {
      const propertySchema = schema.properties?.[name];
      if (!propertySchema) {
        if (schema.additionalProperties === false) {
          problems.push(`${at}.${name}: not in the schema, and additionalProperties is false`);
        }
        continue;
      }
      problems.push(...validate(nested, propertySchema, `${at}.${name}`));
    }
  }
  return problems;
}

const APP: NotifyAppConfig = {
  folder: 'C:\\synced\\Ecom QA',
  includeScreenshots: false,
  to: ['qa@contoso.com'],
  cc: ['lead@contoso.com'],
  ranBy: 'me@contoso.com',
  ranBySource: 'upn',
  allowedDomain: 'contoso.com',
};

/** A run. Typed, not cast (§AD), so a field the builder reads cannot be forgotten. */
function runOf(failed: number): Run {
  return {
    id: 'run_schema01',
    status: failed > 0 ? RunStatus.Failed : RunStatus.Passed,
    request: { environment: 'qa', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: '2026-11-11T09:00:00.000Z',
    startedAt: '2026-11-11T09:00:01.000Z',
    finishedAt: '2026-11-11T09:02:11.000Z',
    summary: {
      ...emptySummary(),
      total: 1 + failed,
      passed: 1,
      failed,
      durationMs: 130_000,
      passRate: failed > 0 ? 50 : 100,
    },
    target: describeTarget('qa', 'https://qa.example.test', 'ecom'),
    artifacts: {},
    results: [
      {
        id: 't1',
        title: 'Departments › DEPT-001 list loads',
        file: 'tests/apps/ecom/departments.spec.ts',
        project: 'chromium',
        tags: [],
        outcome: TestOutcome.Passed,
        durationMs: 1200,
        retry: 0,
        steps: [],
        attachments: [],
      },
    ],
  };
}

const dropFor = (overrides: Partial<Parameters<typeof buildReadyDrop>[0]> = {}): ReadyDrop =>
  buildReadyDrop({
    run: runOf(0),
    application: 'ecom',
    environment: 'qa',
    baseUrl: 'https://qa.example.test',
    app: APP,
    reportZipName: 'ecom-qa-run_schema01.zip',
    reportZipTooLarge: false,
    comparison: null,
    ...overrides,
  });

test.describe('the published ready schema matches what the code writes @unit', () => {
  test('S1: a real drop validates against the published schema', () => {
    // wrong: the schema describing a shape the code stopped writing. The flow's
    // Parse JSON is GENERATED from this file, so a renamed field does not fail there
    // — it arrives as null and the mail goes out with an empty subject or no
    // recipients. That reads as a flow problem, and the person diagnosing it has no
    // access to this repo.
    const problems = validate(JSON.parse(JSON.stringify(dropFor())), loadSchema());
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('S2: the FAILED shape validates too, and the three zip states with it', () => {
    // wrong: a schema that only admits the happy path. `reportZipName` is nullable
    // and `verdict` has more than one value, and each is a real state a run reaches
    // — so a schema validated against one green drop would reject the first failing
    // run, in the flow, at the moment somebody most needs the mail.
    for (const drop of [
      dropFor({ run: runOf(1) }),
      dropFor({ reportZipName: null }),
      dropFor({ reportZipTooLarge: true }),
      dropFor({ app: { ...APP, cc: [] } }),
    ]) {
      const problems = validate(JSON.parse(JSON.stringify(drop)), loadSchema());
      expect(problems, `${drop.verdict} ${drop.reportZipName}\n${problems.join('\n')}`).toEqual([]);
    }
  });

  test('S3: the validator CATCHES a missing, renamed, retyped or extra field', () => {
    // wrong: S1 over a correct drop cannot tell a working validator from one that
    // returns no problems for anything — "valid" and "I checked nothing" are the same
    // output (§AA, §W). Each of the four drifts the schema exists to catch is planted,
    // and the renamed one is the case that matters most: it is simultaneously a
    // missing field and an extra one, which is exactly how a rename arrives.
    const schema = loadSchema();
    const valid = JSON.parse(JSON.stringify(dropFor())) as Record<string, unknown>;

    const { subject: _dropped, ...missing } = valid;
    expect(validate(missing, schema).join('\n')).toContain('subject: required and absent');

    const renamed = { ...missing, emailSubject: valid.subject };
    const renamedProblems = validate(renamed, schema).join('\n');
    expect(renamedProblems).toContain('subject: required and absent');
    expect(renamedProblems).toContain('emailSubject: not in the schema');

    expect(validate({ ...valid, schemaVersion: '1' }, schema).join('\n')).toContain(
      'schemaVersion: expected integer, found string',
    );
    expect(validate({ ...valid, to: [] }, schema).join('\n')).toContain('fewer than minItems 1');
    expect(validate({ ...valid, verdict: 'GREEN' }, schema).join('\n')).toContain('is not one of');
    // A NESTED field, because `counts` is where a drift would be least visible.
    expect(
      validate({ ...valid, counts: { ...(valid.counts as object), passRate: 101 } }, schema).join(
        '\n',
      ),
    ).toContain('above maximum 100');
  });

  test('S4: null and zero are valid values, not missing fields', () => {
    // wrong: a `required` check written as truthiness. `reportZipName: null` means
    // "no archive" and `counts.failed: 0` means "nothing failed" — the two fields
    // most likely to be falsy are the two a truthiness check would report as absent,
    // so every green run with no archive would be rejected by its own schema.
    const schema = loadSchema();
    const drop = JSON.parse(JSON.stringify(dropFor({ reportZipName: null }))) as ReadyDrop;
    expect(drop.reportZipName).toBeNull();
    expect(drop.counts.failed).toBe(0);
    expect(drop.reportZipTooLarge).toBe(false);
    expect(validate(drop, schema)).toEqual([]);
  });

  test('S5: the schema uses no keyword this validator silently ignores', () => {
    // wrong: the file grows a `pattern` or a `oneOf`, the validator does not
    // implement it, and S1 keeps passing while that constraint is enforced by
    // NOBODY — green over a schema half of which is decoration. §Z: the instrument
    // must be asked whether it can answer the question, not assumed to.
    const seen = new Set<string>();
    const walk = (node: JsonSchema): void => {
      for (const [keyword, value] of Object.entries(node)) {
        seen.add(keyword);
        if (keyword === 'properties') {
          for (const nested of Object.values(value as Record<string, JsonSchema>)) walk(nested);
        } else if (keyword === 'items') {
          walk(value as JsonSchema);
        }
      }
    };
    walk(loadSchema());
    expect(seen.size, 'the walk visited nothing').toBeGreaterThan(5);
    expect([...seen].filter((keyword) => !SUPPORTED.has(keyword)).sort()).toEqual([]);
  });

  test('S6: the schema version in the file is the one the code writes', () => {
    // wrong: the code bumps READY_SCHEMA_VERSION and the published file keeps the old
    // `const`, so every drop is rejected by the flow's Parse JSON — or the reverse,
    // and the flow accepts a shape it was not written for. The two numbers are one
    // fact in two places, which is the whole reason this file is welded.
    const schema = loadSchema();
    expect(schema.properties?.schemaVersion?.const).toBe(READY_SCHEMA_VERSION);
    expect(dropFor().schemaVersion).toBe(READY_SCHEMA_VERSION);
  });

  test('S7: every field the FLOW DOC reads is a field the schema publishes', () => {
    // wrong: nothing checking the doc at all, which is where this drifts. §AG says
    // whatever you tell a human to write, write it and run it first — and a Power
    // Automate expression cannot be run here, so the half that CAN be checked is
    // checked: the doc tells somebody to read `?['importance']`, and if the code
    // never writes that field they build a flow that silently sends nothing useful.
    //
    // The failure direction is the quiet one. A flow reading a field that does not
    // exist gets `null`, and `coalesce` turns that into a plausible default — so the
    // mail arrives looking correct and the setting does nothing, forever.
    const doc = readFileSync(path.join(ROOT, 'docs', 'notify', 'POWER-AUTOMATE-FLOW.md'), 'utf8');
    const read = (source: string): string[] => [
      ...new Set([...source.matchAll(/\?\['([A-Za-z0-9_]+)'\]/g)].map((match) => match[1]!)),
    ];

    const fields = read(doc);
    // §T — the scan had a subject. A regex that matched nothing would report every
    // doc clean, which is this repo's oldest shape.
    expect(fields.length, 'no field references found in the flow doc').toBeGreaterThan(5);

    const published = new Set(Object.keys(loadSchema().properties ?? {}));
    // The nested ones the doc reaches into, which are not top-level properties.
    const nested = new Set([
      'total',
      'passed',
      'failed',
      'skipped',
      'flaky',
      'durationMs',
      'passRate',
    ]);
    const unknown = fields.filter((field) => !published.has(field) && !nested.has(field));
    expect(unknown, `the flow doc reads fields the schema does not publish: ${unknown}`).toEqual(
      [],
    );

    // The two fields this batch added are actually referenced, so the doc was
    // updated rather than merely not contradicted.
    expect(fields).toContain('importance');
    expect(fields).toContain('bodyHtml');

    // And the matcher OBJECTS to a field that does not exist, on synthetic source —
    // without this, an empty `unknown` could mean the regex stopped working.
    const planted = read("@{body('Parse_JSON')?['notAFieldAnybodyWrites']}");
    expect(planted).toEqual(['notAFieldAnybodyWrites']);
    expect(published.has(planted[0]!)).toBe(false);
  });
});
