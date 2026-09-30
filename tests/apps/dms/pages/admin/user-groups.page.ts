import { expect } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AdminListPage } from './admin-list.page';

/** Admin → User Group. */
export class UserGroupsPage extends AdminListPage {
  protected readonly path = '/admin/user-groups';
  protected readonly searchPlaceholder = 'Search groups...';
  protected readonly newButtonLabel = 'New Group';

  private readonly name = locator('groups.form.name', 'Group name field', [
    { strategy: 'placeholder', value: 'e.g. Finance Team', confidence: 1 },
  ]);

  private readonly userPicker = locator('groups.form.users', 'Select users dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Select users' }, confidence: 1 },
  ]);

  private readonly submit = locator('groups.form.submit', 'Create Group button', [
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'Create Group', exact: true },
      confidence: 1,
    },
  ]);

  async expectCreateFormOpen(): Promise<void> {
    await this.expectVisible(this.name);
    await this.expectVisible(this.submit);
  }

  async fillGroupName(name: string): Promise<void> {
    this.log.info('Filling new group form', { group: name });
    await this.type(this.name, name);
  }

  async chooseUser(user: string): Promise<void> {
    await this.selectOption(this.userPicker, user);
  }

  async submitCreate(): Promise<void> {
    await this.click(this.submit);
  }

  /**
   * Confirmed live by deliberately clicking Create with every field empty
   * (see `docs/dms-findings.md`): no network request fired, the dialog
   * stayed open, and exactly these two inline messages appeared. Note the
   * field label reads "Group name" here, not "Name" as on the Roles form —
   * the wording is form-specific, not generated from a shared template.
   */
  async expectCreateValidationErrors(): Promise<void> {
    await this.click(this.submit);
    for (const message of ['Group name is required', 'Portal is required']) {
      await expect(this.page.getByText(message, { exact: true })).toBeVisible();
    }
    await this.expectVisible(this.submit);
  }
}
