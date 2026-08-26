import type { Locator, Response } from '@playwright/test';
import { BasePage } from '@aitp/execution-engine';
import { locator, SessionExpiredError, type LocatorSpec } from '@aitp/shared';

/**
 * Everything every DmsSynergy screen has in common: the left navigation and the
 * top bar. Each real page extends this, so a change to the shell is fixed once.
 *
 * Note on strategy: this application ships **no `data-testid` anywhere** (0% on
 * all 24 captured screens). What it does have is a properly built accessibility
 * tree — real roles and real accessible names on every control. So every locator
 * here leads with `role` + name, and falls back to text. That is more robust than
 * CSS would be, and it breaks loudly if the app's accessibility regresses, which
 * is a bug worth catching anyway.
 */
export abstract class AppPage extends BasePage {
  // ── Left navigation ───────────────────────────────────────────────────────
  private readonly navDashboard = locator('nav.dashboard', 'Dashboard link in the sidebar', [
    { strategy: 'role', value: 'link', options: { name: 'Dashboard', exact: true }, confidence: 1 },
  ]);

  private readonly navDocuments = locator('nav.documents', 'Documents link in the sidebar', [
    { strategy: 'role', value: 'link', options: { name: 'Documents', exact: true }, confidence: 1 },
  ]);

  private readonly navFileExplorer = locator('nav.fileExplorer', 'File Explorer link', [
    {
      strategy: 'role',
      value: 'link',
      options: { name: 'File Explorer', exact: true },
      confidence: 1,
    },
  ]);

  private readonly navGlobalSearch = locator('nav.globalSearch', 'Global Search link', [
    {
      strategy: 'role',
      value: 'link',
      options: { name: 'Global Search', exact: true },
      confidence: 1,
    },
  ]);

  private readonly navAuditReport = locator('nav.auditReport', 'Audit Report link', [
    {
      strategy: 'role',
      value: 'link',
      options: { name: 'Audit Report', exact: true },
      confidence: 1,
    },
  ]);

  // Collapsible sections. `exact` matters: "Upload" the section button would
  // otherwise also match the "Upload Files" and "Upload Zip File" controls.
  private readonly navAiAgents = locator('nav.aiAgents', 'AI Agents section toggle', [
    { strategy: 'role', value: 'button', options: { name: 'AI Agents', exact: true }, confidence: 1 },
  ]);

  private readonly navUpload = locator('nav.upload', 'Upload section toggle', [
    { strategy: 'role', value: 'button', options: { name: 'Upload', exact: true }, confidence: 1 },
  ]);

  private readonly navAdmin = locator('nav.admin', 'Admin section toggle', [
    { strategy: 'role', value: 'button', options: { name: 'Admin', exact: true }, confidence: 1 },
  ]);

  private readonly navWorkflow = locator('nav.workflow', 'Workflow section toggle', [
    { strategy: 'role', value: 'button', options: { name: 'Workflow', exact: true }, confidence: 1 },
  ]);

  // ── Top bar ───────────────────────────────────────────────────────────────
  private readonly userMenu = locator('header.userMenu', 'User menu button', [
    { strategy: 'role', value: 'button', options: { name: 'Open user menu' }, confidence: 1 },
  ]);

  private readonly commandSearch = locator('header.commandSearch', 'Command-K search button', [
    { strategy: 'role', value: 'button', options: { name: 'Open search' }, confidence: 1 },
  ]);

  private readonly notifications = locator('header.notifications', 'Notifications button', [
    { strategy: 'role', value: 'button', options: { name: 'Notifications' }, confidence: 1 },
  ]);

  private readonly themeToggle = locator('header.themeToggle', 'Theme toggle button', [
    { strategy: 'role', value: 'button', options: { name: 'Toggle theme' }, confidence: 1 },
  ]);

  // ── Navigation actions ────────────────────────────────────────────────────
  async goToDashboard(): Promise<void> {
    await this.click(this.navDashboard);
  }
  async goToDocuments(): Promise<void> {
    await this.click(this.navDocuments);
  }
  async goToFileExplorer(): Promise<void> {
    await this.click(this.navFileExplorer);
  }
  async goToGlobalSearch(): Promise<void> {
    await this.click(this.navGlobalSearch);
  }
  async goToAuditReport(): Promise<void> {
    await this.click(this.navAuditReport);
  }

  /** Expands a collapsible sidebar section so its links become reachable. */
  async expandNavSection(section: 'AI Agents' | 'Upload' | 'Admin' | 'Workflow'): Promise<void> {
    const specs = {
      'AI Agents': this.navAiAgents,
      Upload: this.navUpload,
      Admin: this.navAdmin,
      Workflow: this.navWorkflow,
    };
    await this.click(specs[section]);
  }

  /** A sidebar link that only exists once its section is expanded. */
  navLink(name: string): Locator {
    return this.page.getByRole('link', { name, exact: true });
  }

  async openUserMenu(): Promise<void> {
    await this.click(this.userMenu);
  }
  async openCommandSearch(): Promise<void> {
    await this.click(this.commandSearch);
  }
  async openNotifications(): Promise<void> {
    await this.click(this.notifications);
  }
  async toggleTheme(): Promise<void> {
    await this.click(this.themeToggle);
  }

  /** The shell is the cheapest proof that a page loaded and we are signed in. */
  async expectShellVisible(): Promise<void> {
    await this.expectVisible(this.navFileExplorer);
    await this.expectVisible(this.userMenu);
  }

  /** True when the app has bounced us back to the sign-in screen. */
  async isSignedOut(): Promise<boolean> {
    return /\/login\b/.test(this.page.url());
  }

  /**
   * A session dying mid-test and a stale locator produce the same visible
   * symptom — something never appears. Left unguarded, both get reported as
   * LocatorResolutionError and are indistinguishable in the test report,
   * which is exactly how a fleet of real session failures got misdiagnosed as
   * 27 locator bugs. This turns that ambiguity into a distinct, explicit
   * failure the moment the page is on /login, before any locator is even
   * attempted.
   */
  private assertSignedIn(): void {
    if (/\/login\b/.test(this.page.url())) {
      throw new SessionExpiredError({ url: this.page.url() });
    }
  }

  override async open(query: Record<string, string> = {}): Promise<Response | null> {
    const response = await super.open(query);
    this.assertSignedIn();
    return response;
  }

  protected override find(spec: LocatorSpec): Promise<Locator> {
    this.assertSignedIn();
    return super.find(spec);
  }
}
