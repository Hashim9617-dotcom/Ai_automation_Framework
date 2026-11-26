import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A MINIMAL ZIP WRITER, so the full Playwright report can travel as one file.
 *
 * ## Why this exists rather than a dependency or a shell-out
 *
 * Node has no zip writer. The three alternatives were each worse here:
 *
 * - **`kit-release.mjs`'s approach** is `git archive --format=zip`, which only
 *   sees TRACKED files. The Playwright HTML report is untracked output under
 *   `artifacts/`, so `git archive` cannot see it at all.
 * - **`tar -a -c -f out.zip`** (bsdtar on Windows 10+) works and is a shell-out,
 *   which this repo moved kit-release AWAY from on purpose; it is also absent on
 *   some Linux images.
 * - **`Compress-Archive`** is PowerShell, so Windows-only — and `pnpm verify`
 *   must not need Windows.
 *
 * So: the format, written by hand. It is about eighty lines because ZIP's
 * central directory is simple, and it adds no dependency to a repo whose
 * tree currently contains no native binary outside Playwright's own.
 *
 * ## Deflate, and the one case that must not be deflated
 *
 * `deflateRawSync` per entry, except where the compressed form would be LARGER
 * than the input — which happens for already-compressed payloads, and the
 * Playwright report is full of PNGs and zipped traces. Those are stored (method
 * 0). Writing a deflate stream that grew the file would make the 10 MB decision
 * worse for no reason.
 *
 * ## No ZIP64, stated rather than discovered
 *
 * Entries above 4 GiB, or more than 65535 of them, need ZIP64 and this does not
 * write it. `zipDirectory` REFUSES in that case instead of emitting an archive
 * that some readers open and others do not — a half-valid zip handed to
 * management is worse than a message saying the report is in the folder.
 */

/** ZIP's own epoch is 1980; anything earlier cannot be represented. */
const DOS_EPOCH_YEAR = 1980;
const MAX_ENTRIES = 0xffff;
const MAX_ENTRY_BYTES = 0xffffffff;

interface Entry {
  /** Forward-slashed, relative. ZIP paths are not platform paths. */
  name: string;
  source: Buffer;
  stored: Buffer;
  /** 0 = stored, 8 = deflated. */
  method: number;
  crc: number;
  modified: Date;
}

/** CRC-32, table built once. ZIP has no other option. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time. Clamped at the epoch rather than wrapping into 1980-adjacent nonsense. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), DOS_EPOCH_YEAR);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Paths that must NEVER enter a report archive.
 *
 * This is the §"never share a raw trace.zip" rule enforced at the one new place
 * a trace could leave the machine. `docs/WHERE-WE-ARE.md` records that a
 * `trace.zip` carries a live session — the `refresh_token` cookie plus
 * `access_token` from localStorage, verified by unzipping one — and that the
 * HTML report EMBEDS them under `html/data/*.zip`. The Jenkinsfile strips those
 * before publishing; an email attachment is the same exposure with a wider
 * audience, so the same strip happens here.
 *
 * A DENYLIST is the wrong shape for a capability and the right shape here: the
 * archive's purpose is "everything in this report directory", so the rule has to
 * name what comes out rather than what goes in. It is paired with a test that
 * plants each excluded shape and proves none of them lands.
 */
/**
 * WHAT MAY TRAVEL IN A NOTIFY BUNDLE — an ALLOWLIST, and the shape is the point.
 *
 * ## What this replaces, and why the old shape could not hold
 *
 * It was `EXCLUDED_FROM_REPORT_ZIP`: traces by extension, `auth/*.json`, anything
 * `storageState`-shaped, `.env`, password-shaped names. Every entry correct, and the
 * SHAPE fail-open — a denylist protects the kinds somebody thought of, and the next
 * file a report directory acquires travels by default (§AC).
 *
 * That was not hypothetical. The denylist did NOT exclude:
 *
 * - **the Playwright HTML report**, which is most of what the bundle WAS, and whose
 *   `data/` directory holds every attachment a run produced;
 * - **`network.json`**, every request path and status the run saw;
 * - **videos**, which are a recording of an authenticated session;
 * - a trace written under any name not ending `.zip`.
 *
 * And it was measured, on this application, that a trace carries the access token
 * and the account password through its network capture
 * (`tests/apps/ecom/trace-secrecy.spec.ts`). A bundle that can carry a trace is a
 * bundle that can mail a credential.
 *
 * ## So the rule is inverted: nothing travels unless it is named here
 *
 * A path this list does not match is EXCLUDED and recorded in `excluded`, which the
 * caller logs and the mail prints — a bundle that drops something says so rather
 * than implying it is complete. Adding a kind means editing this array, beside the
 * reason it is safe, where a reviewer will see it.
 *
 * Rules match the bundle-RELATIVE path, forward-slashed, so a rule can say where a
 * file must sit as well as what it is called: `run.json` means the run record at the
 * top of the bundle, not some `run.json` three directories down inside a report.
 */
export const ALLOWED_IN_NOTIFY_BUNDLE: ReadonlyArray<{
  label: string;
  test: (p: string) => boolean;
  /**
   * When set, this rule only applies if the caller opted in for this application.
   *
   * An entry on the allowlist that is NOT unconditionally safe needs somewhere to
   * say so, and that somewhere has to be the list itself — a second list of
   * "conditional kinds" kept beside it would be the two-sources-of-truth shape, and
   * the one that drifts is the one that opens the gate.
   */
  optIn?: 'includeScreenshots';
}> = [
  {
    // AitpReporter's own record: counts, outcomes, annotations, the network SUMMARY.
    // No request bodies, no headers, no cell values.
    label: 'the machine-readable run record',
    test: (p) => p === 'run.json',
  },
  { label: 'the JUnit result file', test: (p) => p === 'junit.xml' },
  {
    // Header names and bucket verdicts only — `tests/unit/sheet-drift.spec.ts` V3
    // holds that no cell value can reach it.
    label: 'the sheet-drift review file',
    test: (p) => p === 'sheet-drift.csv',
  },
  {
    /**
     * The per-endpoint call table.
     *
     * Method, templated path, origin, counts, status mix, slowest call and module
     * names. No query string — dropped when the request is recorded AND again when
     * the path is templated — no headers and no bodies, because none of those is
     * ever read. Id-like path segments become `:id`, so a record identifier from a
     * live system cannot travel in a URL either.
     *
     * Unconditional rather than opt-in, which is a judgement and worth saying: a
     * path template is schema, like the `/admin/domains/<Entity>` routes already in
     * every run.json, where a screenshot is a picture of data. `Z6` is the test that
     * holds this claim to a planted secret.
     */
    label: 'the API call table',
    test: (p) => p === 'api-calls.csv',
  },
  { label: 'the human summary', test: (p) => p === 'summary.md' },
  {
    /**
     * Playwright's own failure screenshot, PER-APPLICATION OPT-IN, and only under
     * `test-results`.
     *
     * A screenshot shows the application at the moment it broke, so it carries
     * whatever was on screen. On a live UAT system like DMS that is real names and
     * real document titles; on a dev environment like Ecom it is nothing. The
     * platform cannot tell those apart, so it does not try: the application's own
     * notify config says, and `includeScreenshots` defaults to false.
     *
     * Bounded two ways beyond that: to the name Playwright gives a failure shot, so
     * a spec cannot widen this by attaching an image of its own, and to
     * `test-results`, so the HTML report's `data/` directory cannot come in through
     * this rule.
     */
    label: 'a failure screenshot',
    test: (p) => /^test-results\/.+\/test-failed-\d+\.png$/.test(p),
    optIn: 'includeScreenshots',
  },
];

export interface ZipResult {
  bytes: Buffer;
  entryCount: number;
  /** What was left out, and why — so the email can say so rather than imply completeness. */
  excluded: Array<{ name: string; why: string }>;
}

function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Every file under `root`, as one zip — minus what must never travel.
 *
 * @throws when the result would need ZIP64, rather than writing a half-valid archive.
 */
/**
 * Takes no clock, on purpose.
 *
 * An earlier signature accepted `now` so a test could make timestamps
 * deterministic — and never used it, because each entry's time comes from that
 * file's own `mtime`, which is the honest value. `eslint` caught the dead
 * parameter; it is removed rather than wired up, because a caller passing a date
 * would reasonably believe it controlled the archive's timestamps and it never
 * could.
 */
export function zipDirectory(root: string, options: BundleOptions = {}): ZipResult {
  return zipSources([{ root, prefix: '' }], options);
}

/**
 * What this application has opted into.
 *
 * Every field DEFAULTS TO THE RESTRICTIVE VALUE when absent, so a caller that forgets
 * one gets the safe bundle rather than the complete one. That is the only direction
 * worth defaulting in: a missing picture is an inconvenience and a mailed one can be
 * personal data.
 */
export interface BundleOptions {
  /** `false` unless the application's notify config says otherwise. */
  includeScreenshots?: boolean | undefined;
}

/**
 * One source directory, and where its files sit inside the bundle.
 *
 * Several are needed because the allowed kinds do not live together: `run.json`,
 * `junit.xml`, `sheet-drift.csv` and `summary.md` are the reporter's, under
 * `artifacts/reports`, and the failure screenshots are Playwright's, under
 * `artifacts/test-results`. Zipping their common parent would walk every archive
 * and saved session under `artifacts/` and lean on the allowlist to catch all of
 * it — naming the roots keeps the walk small as well as the filter strict.
 */
export interface BundleSource {
  root: string;
  /** Forward-slashed prefix inside the bundle. `''` means the bundle's top level. */
  prefix: string;
}

/**
 * Builds a bundle from several roots, keeping ONLY what the allowlist names.
 *
 * @throws when the result would need ZIP64, rather than writing a half-valid archive.
 */
export function zipSources(
  sources: readonly BundleSource[],
  options: BundleOptions = {},
): ZipResult {
  const excluded: Array<{ name: string; why: string }> = [];
  const entries: Entry[] = [];

  // The rules in play for THIS application. An opt-in rule the caller did not ask
  // for is not merely skipped — it is removed from the list, so a path it would have
  // matched falls through to the allowlist's own refusal and is reported with the
  // reason, rather than being silently absent from the bundle.
  const rules = ALLOWED_IN_NOTIFY_BUNDLE.filter(
    (rule) => !rule.optIn || options[rule.optIn] === true,
  );

  const candidates: Array<{ name: string; full: string }> = [];
  for (const source of sources) {
    if (!existsSync(source.root)) continue;
    for (const rel of walk(source.root)) {
      candidates.push({
        name: source.prefix ? `${source.prefix}/${rel}` : rel,
        full: path.join(source.root, rel),
      });
    }
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  for (const candidate of candidates) {
    const name = candidate.name;
    if (!rules.some((allowed) => allowed.test(name))) {
      // NOT allowed for this application. Recorded so the mail can name what it left
      // behind — "the report is in the project folder" only helps a reader who knows
      // what is missing from the attachment. The reason distinguishes a kind that
      // never travels from one this application has simply not opted into.
      const optedOut = ALLOWED_IN_NOTIFY_BUNDLE.find((rule) => rule.optIn && rule.test(name));
      excluded.push({
        name,
        why: optedOut
          ? `${optedOut.label} — not included for this application`
          : 'not on the notify allowlist',
      });
      continue;
    }
    const full = candidate.full;
    const source = readFileSync(full);
    if (source.length > MAX_ENTRY_BYTES) {
      throw new Error(
        `refusing to zip: ${name} is ${source.length} bytes, which needs ZIP64. This writer ` +
          'does not emit ZIP64, and a half-valid archive is worse than a message saying the ' +
          'report is in the project folder.',
      );
    }
    const deflated = deflateRawSync(source, { level: 9 });
    // Stored when deflate did not help, which is most of a report: PNGs and
    // already-compressed payloads.
    const useDeflate = deflated.length < source.length;
    entries.push({
      name,
      source,
      stored: useDeflate ? deflated : source,
      method: useDeflate ? 8 : 0,
      crc: crc32(source),
      modified: statSync(full).mtime,
    });
  }

  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `refusing to zip: ${entries.length} entries exceeds the ${MAX_ENTRIES} a non-ZIP64 ` +
        'archive can address.',
    );
  }

  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.modified);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0
    // Bit 11: the name is UTF-8. Without it a reader guesses a code page, and a
    // report path with a non-ASCII character opens under the wrong name.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.stored.length, 18);
    local.writeUInt32LE(entry.source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, nameBytes, entry.stored);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory header
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(entry.method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(entry.crc, 16);
    dir.writeUInt32LE(entry.stored.length, 20);
    dir.writeUInt32LE(entry.source.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + entry.stored.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return {
    bytes: Buffer.concat([...locals, centralBytes, end]),
    entryCount: entries.length,
    excluded,
  };
}

/**
 * The attachment ceiling, and it is checked against the REAL file.
 *
 * 10 MB, per the brief. Above it the mail says the report is in the project
 * folder rather than implying an attachment that is not there — the failure this
 * avoids is a manager clicking a paperclip that was silently dropped by a mail
 * gateway.
 */
export const REPORT_ZIP_LIMIT_BYTES = 10 * 1024 * 1024;

export function isReportZipTooLarge(bytes: number): boolean {
  return bytes > REPORT_ZIP_LIMIT_BYTES;
}

/** A stable short digest, for naming an archive without a clock. */
export function shortDigest(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}
