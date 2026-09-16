import { createServer } from 'node:net';

/**
 * A port the OS has just confirmed is free, for a spec that boots the API.
 *
 * Replaces `3600 + Math.floor(Math.random() * 300)` and its sibling in
 * api-boot.spec.ts. Those ranges OVERLAPPED, and command-box.spec.ts is
 * fullyParallel, so every worker ran its own beforeAll and booted its own API:
 * up to five instances drawing from a few hundred ports. Measured on
 * 2026-09-16 with a control (the first API healthy first): a second API on the
 * same port exits with code 1 and EADDRINUSE — exactly the "the API exited with
 * 1" that made CB1 flaky in the gate.
 *
 * Probed with NO host, on purpose. Nest's `app.listen(port)` binds `::`, and on
 * Windows a probe bound to `0.0.0.0` can coexist with it on the same port —
 * also measured — so a 0.0.0.0 probe would call a taken port free.
 *
 * A window remains between this probe closing and the API binding. It is
 * milliseconds and the OS does not hand the same ephemeral port straight back;
 * the random range was a lottery drawn up to five times per run.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error('the OS returned no port for listen(0)')),
      );
    });
  });
}
