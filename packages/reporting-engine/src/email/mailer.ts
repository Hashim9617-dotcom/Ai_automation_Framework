import nodemailer, { type Transporter } from 'nodemailer';
import { rootLogger, type Run } from '@aitp/shared';
import { renderRunSummaryHtml } from '../html/summary';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export function smtpConfigFromEnv(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM ?? 'AI Testing Platform <no-reply@localhost>',
  };
}

export class ReportMailer {
  private readonly log = rootLogger.child('mailer');
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
  }

  /** Sends the self-contained HTML summary; attachments stay out to keep it deliverable. */
  async sendRunSummary(run: Run, recipients: string[]): Promise<void> {
    if (!recipients.length) {
      this.log.warn('No recipients configured — skipping run summary email.');
      return;
    }

    const summary = run.summary;
    const subject = `[${run.status.toUpperCase()}] ${run.request.environment} — ${summary?.passed ?? 0}/${summary?.total ?? 0} passed (${summary?.passRate ?? 0}%)`;

    await this.transporter.sendMail({
      from: this.config.from,
      to: recipients.join(','),
      subject,
      html: renderRunSummaryHtml(run),
    });
    this.log.info('Run summary email sent', { runId: run.id, recipients: recipients.length });
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      this.log.error('SMTP verification failed', { error: (error as Error).message });
      return false;
    }
  }
}
