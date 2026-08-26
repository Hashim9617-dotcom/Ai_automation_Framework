import { Body, Controller, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
   * Phase 1 resolves a plain-language instruction to existing tagged tests and
   * schedules them. Phase 2 adds generation: when nothing matches, the AI writes
   * the test cases and the Playwright spec, then schedules those instead.
   */
  @Post()
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
