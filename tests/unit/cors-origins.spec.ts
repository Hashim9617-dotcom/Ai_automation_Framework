import { test, expect } from '@playwright/test';
import {
  DEFAULT_API_HOST,
  resolveAllowedOrigins,
  resolveApiHost,
} from '../../apps/api/src/config/network';

/**
 * Where the API listens, and who may call it from a browser.
 *
 * Both are decided by pure functions so this suite can supply the environment
 * rather than read it (§AJ) — these two answers must come out the same on a
 * clean checkout as they do on the machine that wrote them, because what they
 * decide is whether an unauthenticated run trigger is on the network.
 *
 * The end-to-end halves — what the server actually binds, and what header comes
 * back for a foreign `Origin` — are in `tests/api/api-hardening.spec.ts`. Two
 * tests that compose to a property are fine; one that appears to state the
 * whole property alone is not (§L).
 */

test.describe('the API network surface @unit', () => {
  test('the host defaults to loopback, and only an explicit API_HOST moves it', () => {
    // wrong: without the default, `app.listen(port)` binds `::` — measured
    // directly on 2026-10-12: a server started that way accepts a connection on
    // `::1` AND `127.0.0.1`, so the API is on every interface of the machine.
    expect(resolveApiHost(undefined)).toBe(DEFAULT_API_HOST);
    expect(DEFAULT_API_HOST).toBe('127.0.0.1');

    // An empty or whitespace value is NOT an override. Nobody writes `API_HOST=`
    // meaning "listen on everything", and the fail-closed reading of a blank is
    // the default — the same reason `requireUser` refuses a blank password
    // instead of handing it to a login.
    expect(resolveApiHost('')).toBe(DEFAULT_API_HOST);
    expect(resolveApiHost('   ')).toBe(DEFAULT_API_HOST);

    // Discriminating: a real value must actually come through, or "always
    // loopback" would satisfy every assertion above while ignoring the variable.
    expect(resolveApiHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveApiHost('  10.0.0.5  ')).toBe('10.0.0.5');
  });

  test('origins are an exact allowlist, empty by default, and a wildcard is refused', () => {
    // wrong: this was `process.env.CORS_ORIGIN?.split(',') ?? true`, and Nest
    // passes `true` to the `cors` package, which ECHOES the caller's own Origin
    // back as Access-Control-Allow-Origin. Any page an operator visited could
    // then read this API — which can start runs against a customer system.
    expect(resolveAllowedOrigins(undefined)).toEqual([]);
    expect(resolveAllowedOrigins('')).toEqual([]);
    expect(resolveAllowedOrigins('  ,  ,')).toEqual([]);

    // Exact origins, trimmed, order preserved.
    expect(resolveAllowedOrigins('http://localhost:5173, https://qa.example.com')).toEqual([
      'http://localhost:5173',
      'https://qa.example.com',
    ]);

    // THE CATCHING HALF (§W). A wildcard is refused by name rather than dropped:
    // dropping it silently would leave an operator believing they had opened the
    // API up, with no header anywhere to show otherwise (§AC).
    expect(() => resolveAllowedOrigins('*')).toThrow(/may not contain "\*"/);
    expect(() => resolveAllowedOrigins('http://localhost:5173,*')).toThrow(/may not contain "\*"/);

    // An entry that is not a BARE origin can never equal an Origin header, so it
    // would sit in the config looking like an allowance while matching nothing —
    // a gate that looks open. Refused, and the message says why.
    expect(() => resolveAllowedOrigins('http://localhost:5173/')).toThrow(/not a bare origin/);
    expect(() => resolveAllowedOrigins('https://x.example/app')).toThrow(/not a bare origin/);
    expect(() => resolveAllowedOrigins('localhost:5173')).toThrow(/not a URL|not a bare origin/);

    // AND THE SILENT HALF, which is what the assertions above are written
    // against: a validator that threw on everything would pass every `toThrow`
    // here and refuse every real configuration.
    expect(() => resolveAllowedOrigins('http://localhost:5173')).not.toThrow();
    expect(() => resolveAllowedOrigins('https://qa.example.com:8443')).not.toThrow();
  });
});
