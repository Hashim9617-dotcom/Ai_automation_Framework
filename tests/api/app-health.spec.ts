import { apiTest as test, expect } from '@aitp/execution-engine';

/**
 * API-layer tests run in the `api` project — no browser is launched, so they are
 * fast enough to gate every commit. In the real application this is also where
 * UI tests reach for backend state verification.
 */
test.describe('Application availability', { tag: ['@smoke', '@api'] }, () => {
  test('the application under test responds', async ({ api }) => {
    const response = await api.get<string>('/', { expectStatus: [200] });
    expect(response.ok).toBe(true);
    expect(response.durationMs).toBeLessThan(10_000);
  });

  test('unknown routes still resolve to the SPA shell', async ({ api }) => {
    const response = await api.get<string>('/employees');
    expect([200, 301, 302, 304]).toContain(response.status);
  });
});
