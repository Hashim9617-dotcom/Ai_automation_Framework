/**
 * A malformed environment value must never silently disable the limit it
 * configures — an empty string is 0 and "twenty" is NaN, and both would turn a
 * cap into "do nothing" or "do everything" without a word of warning.
 */
export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
