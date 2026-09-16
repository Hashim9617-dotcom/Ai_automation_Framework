import { Body, Controller, Module, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RunsModule } from '../runs/runs.module';
import { CommandService, commandRequestSchema, type CommandRequest } from './command.service';

@ApiTags('command')
@Controller('command')
class CommandController {
  constructor(private readonly commands: CommandService) {}

  /**
   * The AI Command Box endpoint.
   *
   * Specified in `docs/phase-2-command-box.md`. One endpoint, one stated
   * precedence: existing tests, then authored sheet rows, then generation.
   */
  @Post()
  @ApiOperation({
    summary: 'Interpret a plain-language instruction and act on it',
    description: [
      'Walks three doors in a fixed order and says which one answered:',
      '',
      '  1. **existing tests** — matched by keyword, run via `--grep`. Returns a run id.',
      '  2. **authored sheet rows** — a QA already wrote what this flow should do.',
      '     Preferred over generation because a sheet row is an EXTERNAL source of',
      '     truth, while a generated expectation comes from the system under test.',
      '  3. **generation** — only when nobody has written it down. Produces PROPOSALS',
      '     for per-assertion human review (`pnpm generate:review`), never a run.',
      '',
      'Nothing blocks: a run id comes back immediately. Poll `GET /api/runs/{id}`',
      'or stream `GET /api/events/stream/{runId}`.',
      '',
      'Every response carries `target` — the environment key, the URL it actually',
      'resolved to, and a computed `isDemoApp` — so a run against the bundled demo',
      'app can never be mistaken for one against a real system.',
      '',
      'When nothing answers, `searched` names what each door looked in and',
      '`skipped` says why each declined. "No tests found" and "no tests matched',
      'these two words across 446 tests, with no workbook configured and no',
      'capture on disk" are different answers with different next steps.',
      '',
      '`ALLOW_WRITES` is not settable from this or any request body.',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          minLength: 3,
          maxLength: 500,
          // Worded without domain vocabulary on purpose: apps/ and packages/
          // are app-agnostic, and tests/unit/app-agnostic.spec.ts scans CODE
          // (comments are stripped). A concrete noun here couples the API
          // schema to one customer's domain.
          example: 'test the complete registration flow',
        },
        source: {
          type: 'string',
          enum: ['auto', 'existing', 'sheet', 'generate'],
          default: 'auto',
          description: 'Pin a door instead of walking the precedence.',
        },
        environment: { type: 'string', default: 'qa', example: 'local' },
        browsers: {
          type: 'array',
          items: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] },
          default: ['chromium'],
        },
        dryRun: {
          type: 'boolean',
          default: false,
          description: 'Resolve and return the plan without starting a run.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'The plan, the door that answered, what was searched, and the target. ' +
      '`run` is a run id for the existing-tests door, and `null` for every other ' +
      'outcome — including the two that deliberately do not run anything.',
  })
  handle(@Body(new ZodValidationPipe(commandRequestSchema)) request: CommandRequest) {
    return this.commands.interpret(request);
  }
}

@Module({
  imports: [RunsModule],
  controllers: [CommandController],
  providers: [CommandService],
})
export class CommandModule {}
