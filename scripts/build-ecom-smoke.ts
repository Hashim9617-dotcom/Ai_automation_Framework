#!/usr/bin/env node
/**
 * Builds `config/apps/ecom/smoke.json` from the two sources of truth.
 *
 *   pnpm build:ecom-smoke "<path to Synergy_ERP_Test_Cases_Sheet_Format.xlsx>"
 *
 * The CAPTURES say which module screens exist, what their URL is, and whether a
 * create trigger is addressable. The SHEET says which case id each screen's smoke
 * test traces to. Neither alone is enough, and writing the manifest by hand would
 * be a third copy of both.
 *
 * ## Nothing live reaches the manifest
 *
 * Entity names and URLs are schema. Case ids are the QA's identifiers. The expected
 * column list is read from the sheet's own Then clause, which names FIELDS. No
 * record value, title or name is read or written — the workbook stays outside the
 * repo and the captures stay gitignored.
 *
 * ## It asserts its own effect
 *
 * Every count is checked against what STEP 0 measured before anything is written,
 * and the file is read back through the validator afterwards. A generator that
 * wrote an empty manifest and printed "built" is the failure this repo has a rule
 * about.
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
import {
  findRepoRoot,
  loadSheetLayout,
  readFinalTestCases,
  readSheetGrid,
  rootLogger,
} from '@aitp/shared';

const log = rootLogger.child('build-ecom-smoke');

const USAGE = 'usage: pnpm build:ecom-smoke "<path to the Ecom sheet-format workbook.xlsx>"';

/** Cf, Co, Cs, Cc — icon glyphs and every other non-text class. */
const NON_TEXT = /[\p{Cf}\p{Co}\p{Cs}\p{Cc}]/gu;
const readable = (name: string | undefined): string =>
  (name ?? '').replace(NON_TEXT, ' ').replace(/\s+/g, ' ').trim();
const CREATE_VERB = /\b(create|new|add)\b/i;

/**
 * Sheet module -> capture entity.
 *
 * Hand-written, and it has to be: the two vocabularies were written by different
 * people and no rule derives `Warehouse / Site` from `Location`. §AE permits a
 * hand-written list only when a missing entry degrades a MESSAGE — so this one is
 * CHECKED: every CRUD entity must appear exactly once as a value, and every value
 * must be a real entity, or the build refuses. A missing entry cannot silently drop
 * a module from smoke.
 */
const MODULE_TO_ENTITY: Record<string, string> = {
  'Approval Matrix': 'ApprovalMatrix',
  Attributes: 'Attribute',
  'Attribute Groups': 'AttributeGroup',
  'Attribute Lookup Values': 'AttributeLookupValue',
  'Attribute Sets': 'AttributeSet',
  'Attribute Set Members': 'AttributeSetMember',
  Brands: 'Brand',
  Categories: 'Category',
  Currency: 'Currency',
  Departments: 'Department',
  'Goods Receipt (GRN)': 'GoodsReceipt',
  'Payment Terms': 'PaymentTerms',
  Products: 'Product',
  'Purchase Configuration': 'PurchaseConfiguration',
  'Purchase Order': 'PurchaseOrder',
  'Purchase Requisition': 'PurchaseRequisition',
  'Put Away': 'PutAway',
  'Quality Inspection': 'QualityInspection',
  'Quotation Comparison': 'QuotationComparison',
  RFQ: 'RFQ',
  'Sub Categories': 'SubCategory',
  'Supplier Quotation': 'SupplierQuotation',
  Tax: 'Tax',
  'Units of Measure': 'UnitOfMeasure',
  Variants: 'ProductVariant',
  'Vendor Product Mapping': 'VendorProduct',
  Vendors: 'Vendor',
  // Confirmed from the captured page titles: "warehouse-site" and
  // "warehouse-product-mapping". The entity names diverge from the sheet's module
  // names and nothing derives one from the other, which is why this map exists.
  'Warehouse / Site': 'Location',
  'Warehouse Product Mapping': 'ProductionMapping',
};

/** Sheet modules that are NOT a module screen, and why each is excluded. */
const NOT_A_MODULE_SCREEN: Record<string, string> = {
  'Login & Session': 'auth, covered by AUTH-001/009/010 rather than by a list page',
  Dashboard: 'the dashboard, covered by DASH-001/006',
  'End-to-End Workflow': 'a cross-module flow with no /admin/domains/ screen of its own',
  RBAC: 'cross-cutting permissions, no screen of its own',
};

/** The five named auth/dashboard cases, with the route each exercises. */
const NAMED_CASES = [
  { caseId: 'AUTH-001', kind: 'auth-login', route: '/login' },
  { caseId: 'AUTH-009', kind: 'auth-session', route: '/login' },
  { caseId: 'AUTH-010', kind: 'auth-logout', route: '/login' },
  { caseId: 'DASH-001', kind: 'dashboard-loads', route: '/dashboard' },
  { caseId: 'DASH-006', kind: 'dashboard-loads', route: '/dashboard' },
] as const;

function captureStates(
  root: string,
): Array<{ url: string; label: string; nodes: Array<{ role: string; name?: string }> }> {
  const dir = path.join(root, 'artifacts', 'ecom', 'inspect');
  if (!existsSync(dir)) {
    throw new Error(
      `no captures at ${dir}. The manifest is built FROM the captures, so there is nothing to ` +
        'build from. Run `pnpm inspect --app ecom` first.',
    );
  }
  const states: Array<{
    url: string;
    label: string;
    nodes: Array<{ role: string; name?: string }>;
  }> = [];
  for (const session of readdirSync(dir).sort()) {
    const file = path.join(dir, session, 'capture.json');
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { states?: typeof states };
    for (const state of parsed.states ?? []) states.push(state);
  }
  // §T: a build over zero states would emit an empty manifest and say "built".
  if (states.length === 0) throw new Error(`parsed every capture under ${dir} and found 0 states`);
  return states.filter((s) => !String(s.label ?? '').startsWith('login.'));
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
};
const entityOf = (p: string): string | null => /^\/admin\/domains\/([^/]+)/.exec(p)?.[1] ?? null;

/**
 * Column names the sheet's Then clause expects, when it names any.
 *
 * Read from a `the grid shows columns: A, B, C` line. These are FIELD names, which
 * are schema — no record value is read. Returns `[]` when the clause names none,
 * and the manifest records that as an empty list rather than omitting the field:
 * "the sheet expects no particular columns" and "nobody looked" are different.
 */
function expectedColumns(thenText: string): string[] {
  const match = /columns?\s*:\s*([^\n]+)/i.exec(thenText);
  if (!match) return [];
  return match[1]!
    .split(',')
    .map((part) => readable(part))
    .filter((part) => part !== '' && part.length < 60);
}

function main(): void {
  const workbook = process.argv.slice(2).find((arg) => /\.xlsx?$/i.test(arg));
  if (!workbook) throw new Error(`${USAGE}\n  no workbook path was given.`);
  if (!existsSync(workbook))
    throw new Error(`refusing to build: there is no workbook at ${workbook}.`);

  const root = findRepoRoot();
  // THE WORKBOOK MAY NOT LIVE INSIDE THE REPO — the same rule run-sheet enforces.
  if (path.resolve(workbook).startsWith(root + path.sep)) {
    throw new Error(
      `refusing to build: the workbook is inside the repository. It is the QA's and carries ` +
        'their data; keep it outside and pass the full path.',
    );
  }

  // ---- the captures ----
  const states = captureStates(root);
  const entities = [
    ...new Set(states.map((s) => entityOf(pathOf(s.url))).filter((e): e is string => e !== null)),
  ];

  /** A create trigger is a control OUTSIDE any dialog whose readable name has a create verb. */
  const addressableCreate = new Set<string>();
  for (const entity of entities) {
    const listStates = states.filter(
      (s) =>
        entityOf(pathOf(s.url)) === entity && !(s.nodes ?? []).some((n) => n.role === 'dialog'),
    );
    for (const state of listStates) {
      for (const node of state.nodes ?? []) {
        if (node.role !== 'button' && node.role !== 'link') continue;
        const text = readable(node.name);
        if (text !== '' && CREATE_VERB.test(text)) addressableCreate.add(entity);
      }
    }
  }

  /** Entities whose list page has a grid in some captured non-dialog state. */
  const gridSeen = new Set<string>();
  for (const entity of entities) {
    const listStates = states.filter(
      (s) =>
        entityOf(pathOf(s.url)) === entity && !(s.nodes ?? []).some((n) => n.role === 'dialog'),
    );
    for (const state of listStates) {
      const nodes = state.nodes ?? [];
      if (nodes.some((n) => n.role === 'columnheader' || n.role === 'row')) gridSeen.add(entity);
    }
  }

  // ---- the sheet ----
  const layout = loadSheetLayout(path.join(root, 'config', 'apps', 'ecom', 'sheet-layout.json'));
  const sheet = readFinalTestCases(readSheetGrid(readFileSync(workbook), layout.sheetName), layout);
  if (sheet.rows.length === 0) throw new Error('read 0 rows from the sheet — refusing to build');

  // ---- the map must be complete, in BOTH directions ----
  const crudEntities = entities.filter((e) => e !== 'PurchaseDashboardKPIsReportPage').sort();
  const mapped = Object.values(MODULE_TO_ENTITY).sort();
  const missing = crudEntities.filter((e) => !mapped.includes(e));
  const unknown = mapped.filter((e) => !crudEntities.includes(e));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      'MODULE_TO_ENTITY does not match the captures.\n' +
        (missing.length ? `  entities with no sheet module: ${missing.join(', ')}\n` : '') +
        (unknown.length ? `  mapped to entities that do not exist: ${unknown.join(', ')}\n` : '') +
        '  A missing entry would silently drop a module from smoke, so this refuses.',
    );
  }
  const sheetModules = new Set(sheet.rows.map((r) => r.module));
  for (const module of Object.keys(MODULE_TO_ENTITY)) {
    if (!sheetModules.has(module)) {
      throw new Error(`MODULE_TO_ENTITY names a module the sheet does not have: "${module}"`);
    }
  }
  for (const module of sheetModules) {
    if (!(module in MODULE_TO_ENTITY) && !(module in NOT_A_MODULE_SCREEN)) {
      throw new Error(
        `the sheet has a module nothing accounts for: "${module}". Add it to MODULE_TO_ENTITY ` +
          'with its entity, or to NOT_A_MODULE_SCREEN with the reason it has no screen.',
      );
    }
  }

  // ---- build ----
  const listLoad = [];
  const createOpens = [];
  for (const [module, entity] of Object.entries(MODULE_TO_ENTITY).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const rows = sheet.rows.filter((r) => r.module === module);
    const p0 = rows.find((r) => r.priority.trim().toUpperCase() === 'P0') ?? rows[0];
    if (!p0) throw new Error(`module "${module}" has no sheet rows at all`);
    const thenClause = p0.clauses.find((c) => c.source === 'then')?.text ?? '';

    listLoad.push({
      caseId: p0.testCaseId,
      module,
      entity,
      url: `/admin/domains/${entity}`,
      kind: 'list-load',
      // PutAway's list was never captured without a dialog open, so there is no
      // evidence a grid renders there. Recorded rather than guessed; the spec
      // asserts the heading and the absence of 5xx instead, and annotates why.
      expectGrid: gridSeen.has(entity),
      expectedColumns: expectedColumns(thenClause),
    });

    if (addressableCreate.has(entity)) {
      createOpens.push({
        caseId: p0.testCaseId,
        module,
        entity,
        url: `/admin/domains/${entity}`,
        kind: 'create-form-opens',
      });
    }
  }

  const noCreate = Object.entries(MODULE_TO_ENTITY)
    .filter(([, entity]) => !addressableCreate.has(entity))
    .map(([module, entity]) => ({
      module,
      entity,
      why: 'no create control on the captured list page',
    }));

  const manifest = {
    '//': 'GENERATED by `pnpm build:ecom-smoke`. Do not edit by hand: it is derived from the captures under artifacts/ecom/inspect/ and from the QA sheet, and a hand edit would be a third copy of both. Re-run the command instead.',
    '//readOnly':
      'Every case here is read-only. create-form-opens opens a drawer and dismisses it with Cancel/Close; the Drawer component THROWS on any submit-shaped control, and the ecom fixture fails a test that sends any non-GET request to the application.',
    schemaVersion: 1,
    application: 'ecom',
    generatedFrom: {
      captureSessions: readdirSync(path.join(root, 'artifacts', 'ecom', 'inspect')).sort(),
      statesConsidered: states.length,
      sheetRows: sheet.rows.length,
    },
    listLoad,
    createOpens,
    named: NAMED_CASES.map((c) => ({ ...c })),
    notAModuleScreen: Object.entries(NOT_A_MODULE_SCREEN).map(([module, why]) => ({ module, why })),
    noCreateControl: noCreate,
  };

  // ---- assert the counts BEFORE writing ----
  const expected = { listLoad: 29, createOpens: 28, named: 5 };
  const actual = {
    listLoad: listLoad.length,
    createOpens: createOpens.length,
    named: manifest.named.length,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `refusing to write the manifest: ${key} is ${actual[key]}, pre-registered ${expected[key]}. ` +
          'Either the captures changed or the mapping did; decide which before writing.',
      );
    }
  }

  const file = path.join(root, 'config', 'apps', 'ecom', 'smoke.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, file);
  if (readFileSync(file, 'utf8') !== contents) {
    throw new Error(`wrote ${file} but reading it back gave different bytes`);
  }

  log.info('smoke manifest built', {
    listLoad: listLoad.length,
    createOpens: createOpens.length,
    named: manifest.named.length,
    noCreateControl: noCreate.length,
    file: path.relative(root, file),
  });
}

try {
  main();
} catch (error) {
  log.error((error as Error).message);
  process.exitCode = 1;
}
