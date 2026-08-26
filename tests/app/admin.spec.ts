import { test, expect } from '@aitp/execution-engine';
import { UsersPage } from './pages/admin/users.page';
import { UserRolesPage } from './pages/admin/user-roles.page';
import { UserGroupsPage } from './pages/admin/user-groups.page';

/**
 * Admin — Users, Roles and Groups.
 *
 * The three screens share one list pattern, so they share one set of
 * expectations. Creation is gated behind ALLOW_WRITES; everything else is
 * read-only and safe on any environment.
 */
const ALLOW_WRITES = process.env.ALLOW_WRITES === 'true';

test.describe('Admin lists', { tag: ['@regression', '@admin'] }, () => {
  test('Users list loads and is searchable', { tag: '@smoke' }, async ({ makePage }) => {
    const users = makePage(UsersPage);
    await users.open();
    await users.expectLoaded();

    await users.search('admin');
    expect(await users.isSignedOut()).toBe(false);
  });

  test('User Roles list loads and paginates', async ({ makePage, log }) => {
    const roles = makePage(UserRolesPage);
    await roles.open();
    await roles.expectLoaded();

    const pages = await roles.pageCount();
    log.info('Role pages', { pages });

    if (pages > 1) {
      await roles.goToPage(2);
      await roles.expectLoaded();
      await roles.goToPage(1);
    }
  });

  test('User Groups list loads', async ({ makePage }) => {
    const groups = makePage(UserGroupsPage);
    await groups.open();
    await groups.expectLoaded();
  });

  test('refresh keeps the list usable', async ({ makePage }) => {
    const users = makePage(UsersPage);
    await users.open();
    await users.refreshList();
    await users.expectLoaded();
  });
});

test.describe('Admin create forms', { tag: ['@regression', '@admin'] }, () => {
  test(
    'the create-user form shows validation errors instead of submitting when empty',
    { tag: '@safety' },
    async ({ makePage }) => {
      // Confirmed live on the Roles form (docs/dms-findings.md) that this app
      // validates on click rather than disabling Create ahead of time — no
      // network request fires, the dialog stays open, and inline
      // "<Field> is required" messages appear. The original framing here
      // ("will not submit while empty", asserting a disabled button) tested
      // a contract this app was never using.
      const users = makePage(UsersPage);
      await users.open();
      await users.openCreateForm();
      await users.expectCreateFormOpen();

      await users.expectCreateValidationErrors();
    },
  );

  test('the group picker stays disabled until a role is chosen', async ({ makePage }) => {
    const users = makePage(UsersPage);
    await users.open();
    await users.openCreateForm();
    await users.expectCreateFormOpen();

    // The control names itself "Select a role first" — the dependency is part
    // of the contract, so assert it rather than trusting the label. Not
    // `toBeDisabled()` — see UsersPage.expectGroupPickerDisabled for why.
    await users.expectGroupPickerDisabled();
  });

  test(
    'the create-role form shows validation errors instead of submitting when empty',
    async ({ makePage }) => {
      // Verified directly: clicking Create with every field empty fires no
      // network request, leaves the dialog open, and shows exactly these
      // three inline messages. See docs/dms-findings.md.
      const roles = makePage(UserRolesPage);
      await roles.open();
      await roles.openCreateForm();
      await roles.expectCreateFormOpen();

      await roles.expectCreateValidationErrors();
    },
  );

  test('Clear empties a partially filled role form', async ({ makePage, data }) => {
    const roles = makePage(UserRolesPage);
    await roles.open();
    await roles.openCreateForm();

    await roles.fillRole({ name: data.unique('role'), description: 'temporary' });
    await roles.clearFormFields();

    // Create never disables on this app (see docs/dms-findings.md) — Clear is
    // proven by the field actually being empty again, not by button state,
    // which was never a signal this form used.
    expect(await roles.nameFieldValue()).toBe('');
  });

  test(
    'the create-group form shows validation errors instead of submitting when empty',
    async ({ makePage }) => {
      const groups = makePage(UserGroupsPage);
      await groups.open();
      await groups.openCreateForm();
      await groups.expectCreateFormOpen();

      await groups.expectCreateValidationErrors();
    },
  );
});

test.describe('Admin creation', { tag: ['@regression', '@admin', '@write'] }, () => {
  test('creates a role', async ({ makePage, data, log }) => {
    test.skip(!ALLOW_WRITES, 'Set ALLOW_WRITES=true to run tests that create data.');

    const roles = makePage(UserRolesPage);
    const name = data.unique('aitp-role');

    await roles.open();
    await roles.openCreateForm();
    await roles.fillRole({ name, description: 'Created by the automation suite' });
    await roles.submitCreate();

    log.info('Created role', { name });
    await roles.search(name);
    await expect(roles.pageButton(1)).toBeVisible();
  });

  test('creates a user', async ({ makePage, data, log }) => {
    test.skip(!ALLOW_WRITES, 'Set ALLOW_WRITES=true to run tests that create data.');

    const users = makePage(UsersPage);
    const person = data.employee();
    const username = data.unique('aitp-user');

    await users.open();
    await users.openCreateForm();
    await users.fillUser({
      username,
      password: data.password(),
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
    });
    await users.submitCreate();

    log.info('Created user', { username });
    await users.search(username);
  });
});
