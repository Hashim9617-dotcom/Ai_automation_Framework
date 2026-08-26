import { expect } from '@playwright/test';
import { BasePage } from '@aitp/execution-engine';
import { locator } from '@aitp/shared';

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  employeeId: string;
  email?: string;
  department?: string;
  hireDate?: string;
}

export class EmployeesPage extends BasePage {
  protected readonly path = '/employees';

  private readonly firstName = locator('employee.firstName', 'First name input', [
    { strategy: 'testId', value: 'employee-first-name', confidence: 1 },
    { strategy: 'label', value: 'First name' },
    { strategy: 'placeholder', value: 'First name' },
  ]);

  /** No test id on this field in the app — the fallback chain carries it. */
  private readonly lastName = locator('employee.lastName', 'Last name input', [
    { strategy: 'testId', value: 'employee-last-name', confidence: 0.2 },
    { strategy: 'label', value: 'Last name' },
    { strategy: 'placeholder', value: 'Last name' },
    { strategy: 'css', value: '#lastName' },
  ]);

  private readonly employeeId = locator('employee.id', 'Employee ID input', [
    { strategy: 'testId', value: 'employee-id', confidence: 1 },
    { strategy: 'label', value: 'Employee ID' },
  ]);

  private readonly email = locator('employee.email', 'Work email input', [
    { strategy: 'testId', value: 'employee-email', confidence: 1 },
    { strategy: 'label', value: 'Work email' },
  ]);

  private readonly department = locator('employee.department', 'Department dropdown', [
    { strategy: 'testId', value: 'employee-department', confidence: 1 },
    { strategy: 'label', value: 'Department' },
  ]);

  private readonly hireDate = locator('employee.hireDate', 'Hire date picker', [
    { strategy: 'testId', value: 'employee-hire-date', confidence: 1 },
    { strategy: 'label', value: 'Hire date' },
  ]);

  private readonly save = locator('employee.save', 'Save employee button', [
    { strategy: 'testId', value: 'employee-save', confidence: 1 },
    { strategy: 'role', value: 'button', options: { name: 'Save employee' } },
  ]);

  private readonly message = locator('employee.formMessage', 'Form result banner', [
    { strategy: 'testId', value: 'form-message', confidence: 1 },
    { strategy: 'css', value: '#form-message' },
  ]);

  private readonly emptyState = locator('employee.emptyState', 'Empty directory message', [
    { strategy: 'testId', value: 'empty-state', confidence: 1 },
  ]);

  async register(employee: EmployeeInput): Promise<void> {
    this.log.info('Registering employee', { employeeId: employee.employeeId });
    await this.type(this.firstName, employee.firstName);
    await this.type(this.lastName, employee.lastName);
    await this.type(this.employeeId, employee.employeeId);
    if (employee.email) await this.type(this.email, employee.email);
    if (employee.department) await this.selectOption(this.department, employee.department);
    if (employee.hireDate) await this.type(this.hireDate, employee.hireDate);
    await this.click(this.save);
  }

  async resultMessage(): Promise<string> {
    return this.textOf(this.message);
  }

  async expectSaved(): Promise<void> {
    const banner = await this.find(this.message);
    await expect(banner).toHaveClass(/success/, { timeout: this.env.timeouts.expect });
  }

  async expectRejected(): Promise<void> {
    const banner = await this.find(this.message);
    await expect(banner).toHaveClass(/error/, { timeout: this.env.timeouts.expect });
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('employee-row').count();
  }

  async expectInDirectory(employeeId: string): Promise<void> {
    await expect(
      this.page.getByTestId('employee-row').filter({ hasText: employeeId }),
    ).toHaveCount(1, { timeout: this.env.timeouts.expect });
  }

  async isDirectoryEmpty(): Promise<boolean> {
    return this.isVisible(this.emptyState);
  }
}
