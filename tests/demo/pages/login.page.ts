import { BasePage } from '@aitp/execution-engine';
import { locator } from '@aitp/shared';

/**
 * Page objects hold *business vocabulary only*. Notice every locator carries a
 * description and an ordered candidate list — that is what lets the Phase 2
 * healer re-derive a selector when the app changes, without a human editing
 * this file.
 */
export class LoginPage extends BasePage {
  protected readonly path = '/login';

  private readonly username = locator('login.username', 'Username input on the sign-in form', [
    { strategy: 'testId', value: 'login-username', confidence: 1 },
    { strategy: 'label', value: 'Username' },
    { strategy: 'placeholder', value: 'Enter username' },
    { strategy: 'css', value: '#username' },
  ]);

  private readonly password = locator('login.password', 'Password input on the sign-in form', [
    { strategy: 'testId', value: 'login-password', confidence: 1 },
    { strategy: 'label', value: 'Password' },
    { strategy: 'css', value: 'input[type="password"]' },
  ]);

  private readonly submit = locator('login.submit', 'Primary sign-in button', [
    { strategy: 'testId', value: 'login-submit', confidence: 1 },
    { strategy: 'role', value: 'button', options: { name: 'Login' } },
    { strategy: 'css', value: '#login-submit' },
  ]);

  private readonly error = locator('login.error', 'Invalid-credentials error banner', [
    { strategy: 'testId', value: 'login-error', confidence: 1 },
    { strategy: 'css', value: '.alert.error' },
  ]);

  async login(username: string, password: string): Promise<void> {
    this.log.info('Signing in', { username });
    await this.type(this.username, username);
    await this.type(this.password, password);
    await this.click(this.submit);
  }

  async errorMessage(): Promise<string> {
    return this.textOf(this.error);
  }

  async hasError(): Promise<boolean> {
    return this.isVisible(this.error);
  }
}
