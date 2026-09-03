import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { rootLogger } from '@aitp/shared';

const log = rootLogger.child('artifacts');

export interface PrunePolicy {
  /** Keep at most this many directories, newest first. */
  keep: number;
  /**
   * Also drop anything older than this many days. Omit for no age limit —
   * appropriate when the artifact is provenance rather than diagnostics, and
   * age is not what makes it worthless.
   */
  maxAgeDays?: number;
}

export interface PruneResult {
  pruned: string[];
  retained: number;
}

/**
 * Prunes timestamped/id-named subdirectories under `root`.
 *
 * Shared rather than duplicated because two implementations of a deletion
 * rule eventually disagree, and the one that disagrees quietly is the one
 * that deletes something you wanted. Callers supply the policy; the
 * mechanism — order by mtime, drop beyond the cap, never throw — is the same
 * everywhere.
 *
 * Ordered by directory mtime rather than by reading anything inside: the
 * contents can run to megabytes, and parsing them just to sort would cost
 * far more than this housekeeping is worth.
 *
 * Never throws. Housekeeping must not be able to abort the thing that
 * invoked it, so a locked file (an open trace viewer on Windows, say) logs
 * a warning and is skipped.
 */
export function pruneDirectories(root: string, policy: PrunePolicy): PruneResult {
  let entries: { name: string; path: string; mtimeMs: number }[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(root, entry.name);
        return { name: entry.name, path: full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  } catch {
    return { pruned: [], retained: 0 }; // no such directory yet, or unreadable
  }

  const cutoffMs =
    policy.maxAgeDays === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  const doomed = entries.filter(
    (entry, index) => index >= policy.keep || entry.mtimeMs < cutoffMs,
  );

  const pruned: string[] = [];
  for (const entry of doomed) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      pruned.push(entry.name);
    } catch (error) {
      log.warn('Could not prune a directory', {
        directory: entry.name,
        error: (error as Error).message,
      });
    }
  }

  return { pruned, retained: entries.length - pruned.length };
}
