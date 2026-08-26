import { BasePage } from '@aitp/execution-engine';
import { locator } from '@aitp/shared';

/**
 * Sign-in screen.
 *
 * Most specs never touch this — `pnpm auth` saves a session and tests start
 * already authenticated. It exists for the tests that are *about* login:
 * bad credentials, validation, the SSO route.
 */
export class LoginPage extends BasePage {
  protected readonly path = '/login';

  private readonly email = locator('login.email', 'Email address field', [
    { strategy: 'placeholder', value: 'Enter your email address', confidence: 1 },
    { strategy: 'label', value: 'Email Address' },
    { strategy: 'css', value: 'input[type="email"]' },
  ]);

  private readonly password = locator('login.password', 'Password field', [
    { strategy: 'placeholder', value: 'Enter your password', confidence: 1 },
    { strategy: 'label', value: 'Password' },
    { strategy: 'css', value: 'input[type="password"]' },
  ]);

  private readonly submit = locator('login.submit', 'Sign In button', [
    { strategy: 'role', value: 'button', options: { name: 'Sign In', exact: true }, confidence: 1 },
    { strategy: 'css', value: 'button[type="submit"]' },
  ]);

  private readonly ssoSubmit = locator('login.sso', 'Sign in with SSO button', [
    { strategy: 'role', value: 'button', options: { name: 'Sign in with SSO' }, confidence: 1 },
  ]);

  private readonly forgotPassword = locator('login.forgotPassword', 'Forgot password link', [
    { strategy: 'role', value: 'link', options: { name: 'Forgot password?' }, confidence: 1 },
  ]);

  private readonly createAccount = locator('login.createAccount', 'Create your account link', [
    { strategy: 'role', value: 'link', options: { name: 'Create your account' }, confidence: 1 },
  ]);

  async login(username: string, password: string): Promise<void> {
    this.log.info('Signing in', { username });
    await this.type(this.email, username);
    await this.type(this.password, password);
    await this.click(this.submit);
  }

  async expectLoaded(): Promise<void> {
    await this.expectVisible(this.email);
    await this.expectVisible(this.submit);
  }

  async expectSsoAvailable(): Promise<void> {
    await this.expectVisible(this.ssoSubmit);
  }

  async goToForgotPassword(): Promise<void> {
    await this.click(this.forgotPassword);
  }

  async goToRegister(): Promise<void> {
    await this.click(this.createAccount);
  }

  /**
   * The app does not expose an error region with a stable name, so we assert on
   * the outcome instead: still on /login means the attempt was rejected.
   */
  async isStillOnLogin(): Promise<boolean> {
    return /\/login\b/.test(this.page.url());
  }
}
