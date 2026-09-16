/**
 * What a run actually ran against.
 *
 * `docs/phase-2-command-box.md` §5. `environment` alone is not enough: it is a
 * key (`local`, `qa`, `app`), and a reader three weeks later cannot tell which
 * URL that resolved to. Worse, the same key resolves differently on different
 * machines — on 2026-09-11 every key here resolved to a live customer system,
 * including `local`, whose file names the demo app in plain text.
 *
 * > **A green run against the demo app must never read like one against a
 * > customer system** — and a run against a customer system must never be
 * > mistakable for a demo.
 *
 * So the resolved URL travels with every response and every run record, and
 * `isDemoApp` is COMPUTED from that URL rather than declared. Same reason the
 * triage report carries its provenance block instead of leaving the qualifier
 * in prose: a qualifier in prose does not survive being copied into a slide.
 */

export interface RunTarget {
  /** The key that was asked for. */
  environment: string;
  /** What that key actually resolved to, after interpolation and overrides. */
  baseUrl: string;
  /**
   * True only when this is the repo's own bundled demo app.
   *
   * Computed by comparing the resolved ORIGIN to the demo server's, never by
   * trusting the environment's name — `local` pointing at a customer system is
   * exactly the case this exists to make visible.
   */
  isDemoApp: boolean;
}

/** The origin `scripts/serve-demo.mjs` listens on. */
export function demoAppOrigin(port = process.env.DEMO_APP_PORT ?? '4173'): string {
  return `http://127.0.0.1:${port}`;
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

export function describeTarget(environment: string, baseUrl: string): RunTarget {
  const resolved = originOf(baseUrl);
  const demo = originOf(demoAppOrigin());
  // `localhost` and `127.0.0.1` are the same server and different origins, so
  // the host is compared by value rather than by string equality of the origin.
  const isLoopback = (origin: string | undefined): boolean => {
    if (!origin) return false;
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  };
  const samePort =
    resolved !== undefined && demo !== undefined && new URL(resolved).port === new URL(demo).port;

  return {
    environment,
    baseUrl,
    isDemoApp: isLoopback(resolved) && samePort,
  };
}
