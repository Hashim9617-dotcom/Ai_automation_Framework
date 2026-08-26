#!/usr/bin/env node
/**
 * Emails the most recent run summary. Wire it into CI as a post-build step:
 *   pnpm exec tsx scripts/send-report.ts
 *
 * Silently no-ops when SMTP is not configured, so it is safe to leave in a
 * pipeline that runs on developer machines too.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ReportMailer, smtpConfigFromEnv } from '@aitp/reporting-engine';
import { rootLogger, type Run } from '@aitp/shared';

const log = rootLogger.child('send-report');

async function main(): Promise<void> {
  const config = smtpConfigFromEnv();
  if (!config) {
    log.warn('SMTP_HOST is not set — skipping the report email.');
    return;
  }

  const reportPath = path.join(process.cwd(), 'artifacts', 'reports', 'run.json');
  if (!existsSync(reportPath)) {
    log.error('No artifacts/reports/run.json found. Run the suite first.');
    process.exitCode = 1;
    return;
  }

  const run = JSON.parse(readFileSync(reportPath, 'utf8')) as Run;
  const recipients = (process.env.REPORT_RECIPIENTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  await new ReportMailer(config).sendRunSummary(run, recipients);
}

main().catch((error: Error) => {
  log.error('Failed to send the report', { error: error.message });
  process.exitCode = 1;
});
