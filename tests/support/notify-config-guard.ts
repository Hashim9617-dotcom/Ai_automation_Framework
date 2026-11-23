import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * PROOF THAT THE SUITE DID NOT TOUCH THE DEVELOPER'S OWN NOTIFY CONFIG.
 *
 * `notify-drop-e2e.spec.ts` used to write the real `.aitp-local/notify.json` — it had
 * to, because the child it spawns is a real `playwright test` that resolves its own
 * repo root — and restore the previous contents afterwards. That left a dead
 * `aitp-configured-*` temp folder configured in this repo for days, and a crash
 * between the write and the restore would have left a QA's real recipients replaced
 * by `qa@contoso.com`.
 *
 * `AITP_NOTIFY_CONFIG` removed the need. This is the check that it stayed removed:
 * the hazard is one somebody re-introduces by writing four convenient lines, and a
 * re-introduction is invisible — the file is gitignored, so `git status` stays clean
 * and nothing says a word.
 *
 * ## It records a DIGEST, never the contents
 *
 * The real file holds real colleagues' addresses. A guard that printed a diff to
 * explain itself would put them into a test report, a trace and an archive — so it
 * reports a hash and a byte count, which is everything needed to say THAT it changed
 * without saying what to.
 *
 * ## Absent is a state, not a missing measurement
 *
 * `digest: null` means the file is not there, and that must be preserved as
 * faithfully as its contents: a suite that CREATED a config on a machine that had
 * none would make the platform start claiming notification was set up. So absent is
 * recorded and compared, rather than skipped as nothing to compare.
 */
export interface NotifyConfigSnapshot {
  file: string;
  /** `null` when the file is absent. */
  digest: string | null;
  /** `null` when the file is absent. */
  bytes: number | null;
}

export function snapshotNotifyConfig(file: string): NotifyConfigSnapshot {
  if (!existsSync(file)) return { file, digest: null, bytes: null };
  const contents = readFileSync(file);
  return {
    file,
    digest: createHash('sha256').update(contents).digest('hex'),
    bytes: contents.byteLength,
  };
}

/**
 * One sentence naming what changed, or `null` for unchanged.
 *
 * Returns rather than throws so the detector has both halves a detector needs: a
 * case it catches and a case it stays SILENT about (§W). The silent one is what the
 * assertion in the spec is written against, and it is the one a broken comparison
 * would satisfy for free.
 */
export function describeNotifyConfigChange(
  before: NotifyConfigSnapshot,
  after: NotifyConfigSnapshot,
): string | null {
  if (before.file !== after.file) {
    return (
      `the guard compared two DIFFERENT files — "${before.file}" against "${after.file}". ` +
      'That is a bug in the guard, not a finding about the suite.'
    );
  }
  if (before.digest === null && after.digest === null) return null;
  if (before.digest === after.digest) return null;

  const what =
    before.digest === null
      ? `it did not exist before and is now ${after.bytes} bytes`
      : after.digest === null
        ? `it existed before (${before.bytes} bytes) and has been deleted`
        : `its contents changed (${before.bytes} -> ${after.bytes} bytes)`;

  return (
    `${before.file} was modified by this run: ${what}. The suite must never write the ` +
    "developer's own notify config — point a spawned run at its own file with " +
    'AITP_NOTIFY_CONFIG instead. (Contents are deliberately not shown: that file holds ' +
    'real addresses.)'
  );
}
