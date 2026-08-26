import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Finds the monorepo root by walking up for the workspace marker.
 *
 * Needed because the same code runs from very different working directories:
 * an IDE, `pnpm --filter`, a compiled dist/ folder, a Docker image and a Jenkins
 * agent. `AITP_REPO_ROOT` overrides it when the layout is unusual.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  if (process.env.AITP_REPO_ROOT) return process.env.AITP_REPO_ROOT;

  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
