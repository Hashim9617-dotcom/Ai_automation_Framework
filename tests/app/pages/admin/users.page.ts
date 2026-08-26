import { expect } from '@playwright/test';
import { locator } from '@aitp/shared';
import { AdminListPage } from './admin-list.page';

export interface NewUser {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

/** Admin → User. List plus the create-user form. */
export class UsersPage extends AdminListPage {
  protected readonly path = '/admin/users';
  protected readonly searchPlaceholder = 'Search users...';
  protected readonly newButtonLabel = 'New User';

  private readonly roleFilter = locator('users.roleFilter', 'Filter by role dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Filter by role' }, confidence: 1 },
  ]);

  private readonly username = locator('users.form.username', 'Username field', [
    { strategy: 'placeholder', value: 'Username', confidence: 1 },
  ]);

  private readonly password = locator('users.form.password', 'Password field', [
    { strategy: 'placeholder', value: 'Password', confidence: 1 },
  ]);

  private readonly firstName = locator('users.form.firstName', 'First Name field', [
    { strategy: 'placeholder', value: 'First Name', confidence: 1 },
  ]);

  private readonly lastName = locator('users.form.lastName', 'Last Name field', [
    { strategy: 'placeholder', value: 'Last Name', confidence: 1 },
  ]);

  private readonly email = locator('users.form.email', 'Email field', [
    { strategy: 'placeholder', value: 'Email', confidence: 1 },
  ]);

  private readonly phone = locator('users.form.phone', 'Phone Number field', [
    { strategy: 'placeholder', value: 'Phone Number', confidence: 1 },
  ]);

  private readonly showPassword = locator('users.form.showPassword', 'Show password toggle', [
    { strategy: 'role', value: 'button', options: { name: 'Show password' }, confidence: 1 },
  ]);

  private readonly rolePicker = locator('users.form.roles', 'Select roles dropdown', [
    { strategy: 'role', value: 'combobox', options: { name: 'Select roles' }, confidence: 1 },
  ]);

  /**
   * The group picker's visible text does say "Select a role first" — but it
   * is a `<div role="combobox">` with no `aria-label`/`aria-labelledby`, and
   * per the ARIA spec `combobox` does not support "name from content" the
   * way `button` does. Confirmed live via the CDP accessibility tree: its
   * computed accessible name is empty, so `role + name` can never match here
   * regardless of exact/substring/regex — a different failure mode from the
   * icon-glyph naming bug elsewhere in this file. Matched by visible text via
   * CSS `:has-text()` instead, scoped to `[role="combobox"]` so it still
   * only matches the actual widget, not just any element containing the
   * phrase (confirmed live: `getByText()` alone resolves to an inner span
   * with no `role` attribute, not the combobox itself).
   */
  private readonly groupPicker = locator('users.form.groups', 'Group dropdown (needs a role)', [
    { strategy: 'css', value: '[role="combobox"]:has-text("Select a role first")', confidence: 1 },
  ]);

  private readonly submit = locator('users.form.submit', 'Create User button', [
    // TEMPORARY reorder for a timing-confound test — see admin.spec.ts run
    // notes. The icon before the label is a Private Use Area icon-font glyph
    // (U+EB62, Tabler Icons), confirmed via the real CDP accessibility tree:
    // the computed name is " Create User", not "Create User" — so
    // `exact: true` against "Create User" is not merely stale, it is
    // impossible, permanently. It has been removed rather than kept as a
    // demoted candidate, since a candidate that can never match only costs a
    // full LOCATOR_CANDIDATE_TIMEOUT on every resolution for no benefit.
    {
      strategy: 'role',
      value: 'button',
      options: { name: 'Create User' },
      confidence: 0.8,
    },
    // \b, not ^...$: \s does not match U+EB62 (it is not whitespace), so an
    // anchor expecting `^\s*` to absorb it never does. \b correctly treats
    // the PUA glyph as a non-word character on either side of the boundary.
    {
      strategy: 'role',
      value: 'button',
      options: { name: /\bCreate User\b/i },
      confidence: 0.6,
    },
  ]);

  async filterByRole(role: string): Promise<void> {
    await this.selectOption(this.roleFilter, role);
  }

  async expectCreateFormOpen(): Promise<void> {
    await this.expectVisible(this.username);
    await this.expectVisible(this.submit);
  }

  async fillUser(user: NewUser): Promise<void> {
    this.log.info('Filling new user form', { username: user.username });
    await this.type(this.username, user.username);
    await this.type(this.password, user.password);
    await this.type(this.firstName, user.firstName);
    await this.type(this.lastName, user.lastName);
    await this.type(this.email, user.email);
    if (user.phone) await this.type(this.phone, user.phone);
  }

  async togglePasswordVisibility(): Promise<void> {
    await this.click(this.showPassword);
  }

  async chooseRole(role: string): Promise<void> {
    await this.selectOption(this.rolePicker, role);
  }

  async groupPickerField() {
    return this.find(this.groupPicker);
  }

  /**
   * Not `toBeDisabled()` — confirmed live that this control carries no
   * `disabled` attribute and no `aria-disabled` either (`isEnabled()`
   * reports `true`); the "disabled" state is CSS-only (`cursor-not-allowed`,
   * `opacity-50`) and, behaviourally, clicking it does not open a listbox.
   * `toBeDisabled()` would fail here even against the correct element,
   * because there is no semantic disabled state for it to detect — asserting
   * it would repeat the exact mistake `expectCreateValidationErrors()`
   * replaced elsewhere on this form (see docs/dms-findings.md).
   */
  async expectGroupPickerDisabled(): Promise<void> {
    const field = await this.groupPickerField();
    await expect(field).toHaveClass(/cursor-not-allowed/);
  }

  async submitCreate(): Promise<void> {
    await this.click(this.submit);
  }

  /**
   * This app does not disable Create ahead of time — confirmed live by
   * deliberately clicking it with every field empty (see
   * `docs/dms-findings.md`): no network request fired, the dialog stayed
   * open, and exactly these seven inline messages appeared. Note the two
   * multi-select fields (User Role, Portal) use "At least one ... is
   * required" rather than the plain "<Field> is required" pattern the
   * single-value fields use — the wording is not uniform across fields, so
   * it was checked directly rather than generated from the field labels.
   */
  async expectCreateValidationErrors(): Promise<void> {
    await this.click(this.submit);
    const messages = [
      'Username is required',
      'Password is required',
      'First name is required',
      'Last name is required',
      'Email is required',
      'At least one user role is required',
      'At least one portal is required',
    ];
    for (const message of messages) {
      await expect(this.page.getByText(message, { exact: true })).toBeVisible();
    }
    await this.expectVisible(this.submit);
  }
}
