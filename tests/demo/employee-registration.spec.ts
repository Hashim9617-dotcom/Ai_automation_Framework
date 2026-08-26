import { test, expect } from '@aitp/execution-engine';
import { LoginPage } from './pages/login.page';
import { EmployeesPage } from './pages/employees.page';

/**
 * The flow the AI Command Box has to be able to produce on its own in Phase 2
 * ("test complete employee registration flow"). Hand-authoring it first gives
 * the generator a reference implementation to be measured against.
 */
test.describe('Employee registration', { tag: ['@regression', '@pim'] }, () => {
  test.beforeEach(async ({ makePage, env }) => {
    const login = makePage(LoginPage);
    await login.open();
    await login.login(env.users.admin!.username, env.users.admin!.password);
  });

  test('registers a new employee and shows it in the directory', async ({ makePage, data }) => {
    const employees = makePage(EmployeesPage);
    const employee = data.employee({ department: 'Engineering' });

    expect(await employees.isDirectoryEmpty()).toBe(true);

    await employees.register({
      firstName: employee.firstName,
      lastName: employee.lastName,
      employeeId: employee.employeeId,
      email: employee.email,
      department: 'Engineering',
      hireDate: employee.hireDate,
    });

    await employees.expectSaved();
    expect(await employees.resultMessage()).toContain('saved successfully');
    await employees.expectInDirectory(employee.employeeId);
    expect(await employees.rowCount()).toBe(1);
  });

  test('rejects a duplicate employee ID', async ({ makePage, data }) => {
    const employees = makePage(EmployeesPage);
    const employee = data.employee();
    const payload = {
      firstName: employee.firstName,
      lastName: employee.lastName,
      employeeId: employee.employeeId,
      email: employee.email,
      department: 'Finance',
    };

    await employees.register(payload);
    await employees.expectSaved();

    await employees.register(payload);
    await employees.expectRejected();
    expect(await employees.resultMessage()).toContain('already exists');
    expect(await employees.rowCount()).toBe(1);
  });

  test('requires the mandatory fields', { tag: '@smoke' }, async ({ makePage, data }) => {
    const employees = makePage(EmployeesPage);
    const employee = data.employee();

    await employees.register({
      firstName: employee.firstName,
      lastName: '',
      employeeId: employee.employeeId,
      department: '',
    });

    await employees.expectRejected();
    expect(await employees.resultMessage()).toContain('complete all required fields');
    expect(await employees.rowCount()).toBe(0);
  });
});
