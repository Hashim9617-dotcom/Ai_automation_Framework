import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DEFAULT_API_HOST, resolveAllowedOrigins, resolveApiHost } from './config/network';

/** The request-body ceiling. Every POST body here is small; a megabyte is a payload. */
const MAX_BODY = '64kb';

async function bootstrap(): Promise<void> {
  // RESOLVED BEFORE THE SERVER EXISTS, so a malformed allowlist refuses to boot
  // rather than starting a server whose CORS does not do what its config says.
  const host = resolveApiHost(process.env.API_HOST);
  const allowedOrigins = resolveAllowedOrigins(process.env.API_ALLOWED_ORIGINS);

  // `bodyParser: false` is what makes the limit below effective. Nest registers
  // its own JSON parser at init with a 100kb default, and `useBodyParser` ADDS a
  // parser rather than replacing one — so with Nest's still in place, a 70kb body
  // would be accepted by the first parser to run and never meet ours.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: MAX_BODY });

  const port = Number(process.env.API_PORT ?? 3001);

  app.setGlobalPrefix('api');

  // NO REFLECTION, AND NO DEFAULT ALLOWANCE.
  //
  // This was `origin: process.env.CORS_ORIGIN?.split(',') ?? true`. Nest passes
  // `true` to the `cors` package, which ECHOES the caller's own `Origin` header
  // back as `Access-Control-Allow-Origin` — so any page the operator visited
  // could read this API, which can trigger runs against a customer system.
  //
  // An empty allowlist means CORS is not enabled AT ALL: no header on any
  // response, which is what makes a cross-origin read fail in the browser. That
  // is deliberately different from enabling CORS with a list that matches
  // nothing, because the second still announces itself in the preflight.
  if (allowedOrigins.length > 0) {
    app.enableCors({ origin: allowedOrigins, credentials: false });
  }

  // No global ValidationPipe: every body is validated by ZodValidationPipe against the
  // schemas in @aitp/shared and apps/api/src/common/request-schemas.ts, so
  // class-validator would be a second, redundant source of truth.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('AI Testing Platform API')
    .setDescription('Run orchestration, live execution events and the AI Command Box.')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(port, host);

  // THE ADDRESS THE SERVER ACTUALLY BOUND, asked of the server.
  //
  // Not the `host` variable above. A line that prints what was REQUESTED cannot
  // show a bind that went somewhere else, and this is the one fact an operator
  // needs to check before trusting that the API is not on the network — the same
  // reason a run's target is resolved rather than declared (SEC-2).
  const address = app.getHttpServer().address() as AddressInfo | string | null;
  const bound =
    typeof address === 'string'
      ? address
      : `${address?.address ?? 'unknown'}:${address?.port ?? port}`;

  const log = new Logger('bootstrap');
  log.log(`API bound to ${bound} (docs at /api/docs, max body ${MAX_BODY})`);
  log.log(
    allowedOrigins.length > 0
      ? `CORS: ${allowedOrigins.length} allowed origin(s) — ${allowedOrigins.join(', ')}`
      : 'CORS: disabled, no cross-origin browser access (set API_ALLOWED_ORIGINS to allow some)',
  );
  if (host === DEFAULT_API_HOST) {
    log.log('Reachable from this machine only. Set API_HOST to bind another address.');
  } else {
    log.warn(
      `API_HOST=${host} — this API has NO authentication, so anything that can reach ` +
        `${bound} can start runs against whatever it is configured to drive.`,
    );
  }
}

void bootstrap().catch((error: Error) => {
  // A refusal must read as a refusal. `resolveAllowedOrigins` throws a sentence
  // an operator is meant to act on, and fifteen frames of Nest under it says
  // "this is broken" instead.
  process.stderr.write(`\n${error.message}\n\n`);
  process.exitCode = 1;
});
