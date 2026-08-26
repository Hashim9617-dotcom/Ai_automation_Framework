import { test, expect, captureDomSnapshot } from '@aitp/execution-engine';
import { LoginPage } from './pages/login.page';

/**
 * The snapshot is what the AI layer sees. These tests guard the two properties
 * that matter: it must be useful enough to reason about, and it must never carry
 * a secret — it ends up in run.json, in reports, and in prompts sent to a
 * third-party model.
 */
test.describe('DOM snapshot', { tag: ['@smoke', '@platform'] }, () => {
  test('captures interactive elements with their accessible names', async ({ makePage, page }) => {
    const login = makePage(LoginPage);
    await login.open();

    const snapshot = await captureDomSnapshot(page);

    expect(snapshot.url).toContain('/login');
    expect(snapshot.elements.length).toBeGreaterThan(2);

    const submit = snapshot.elements.find((el) => el.testId === 'login-submit');
    expect(submit, 'the sign-in button should be in the snapshot').toBeDefined();
    expect(submit!.role).toBe('button');
    expect(submit!.name).toContain('Login');
  });

  test('never carries a password value', async ({ makePage, page, env }) => {
    const login = makePage(LoginPage);
    await login.open();
    await login.login(env.users.admin!.username, env.users.admin!.password);

    const snapshot = await captureDomSnapshot(page, { visibleOnly: false });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain(env.users.admin!.password);
    const password = snapshot.elements.find((el) => el.testId === 'login-password');
    if (password) expect(password.value).toBeUndefined();
  });

  test('keeps non-secret field values, which are useful context', async ({ makePage, page }) => {
    const login = makePage(LoginPage);
    await login.open();
    await page.getByTestId('login-username').fill('hr.admin');

    const snapshot = await captureDomSnapshot(page);
    const username = snapshot.elements.find((el) => el.testId === 'login-username');

    expect(username?.value).toBe('hr.admin');
  });
});
