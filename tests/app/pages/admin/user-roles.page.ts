import { expect } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AdminListPage } from './admin-list.page';

export interface NewRole {
  name: string;
  code?: string;
  description?: string;
}

/** Admin → User Role. */
export class UserRolesPage extends AdminListPage {
  protected readonly path = '/admin/user-roles';
  protected readonly searchPlaceholder = 'Search roles...';
  protected readonly newButtonLabel = 'New Role';

  private readonly name = locator('roles.form.name', 'Role name field', [
    { strategy: 'placeholder', value: 'Name', confidence: 1 },
  ]);

  private readonly code = locator('roles.form.code', 'Role code field', [
    { strategy: 'placeholder', value: 'Code', confidence: 1 },
  ]);

  private readonly description = locator('roles.form.description', 'Role description field', [
    { strategy: 'placeholder', value: 'Role description', confidence: 1 },
  ]);

  private readonly systemRole = locator('roles.form.systemRole', 'System Role checkbox', [
    { strategy: 'role', value: 'checkbox', options: { name: 'System Role' }, confidence: 1 },
  ]);

  private readonly submit = locator('roles.form.submit', 'Create Role button', [
    // Same PUA icon-glyph issue as UsersPage.submit — real accessible name is
    // " Create Role", confirmed via the CDP accessibility tree. Exact
    // match against "Create Role" is not stale, it is impossible, so it has
    // been removed rather than kept as a demoted (permanently dead) candidate.
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'Create Role' },
      confidence: 0.8,
    },
    // \b, not ^...$: \s does not match the PUA glyph. See UsersPage.submit.
    {
      strategy: 'role',
      value: 'button',
      options: { name: /\bCreate Role\b/i },
      confidence: 0.6,
    },
  ]);

  async expectCreateFormOpen(): Promise<void> {
    await this.expectVisible(this.name);
    await this.expectVisible(this.submit);
  }

  async fillRole(role: NewRole): Promise<void> {
    this.log.info('Filling new role form', { role: role.name });
    await this.type(this.name, role.name);
    if (role.code) await this.type(this.code, role.code);
    if (role.description) await this.type(this.description, role.description);
  }

  async markAsSystemRole(): Promise<void> {
    await this.click(this.systemRole);
  }

  async submitCreate(): Promise<void> {
    await this.click(this.submit);
  }

  async nameFieldValue(): Promise<string> {
    return (await this.find(this.name)).inputValue();
  }

  /**
   * This app does not disable Create ahead of time — confirmed live by
   * deliberately clicking it with every field empty (see
   * `docs/dms-findings.md`): no network request fired, the dialog stayed
   * open, and exactly these three inline messages appeared. Asserted
   * precisely here because this is the one form that was actually tested
   * this way; UsersPage/UserGroupsPage use the generic version of this check
   * since their exact message sets are not directly verified.
   */
  async expectCreateValidationErrors(): Promise<void> {
    await this.click(this.submit);
    for (const message of ['Name is required', 'Code is required', 'Portal is required']) {
      await expect(this.page.getByText(message, { exact: true })).toBeVisible();
    }
    await this.expectVisible(this.submit);
  }
}
