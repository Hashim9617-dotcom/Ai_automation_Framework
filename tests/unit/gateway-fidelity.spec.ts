import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { HttpLlmGateway, MockLlmGateway } from '@aitp/ai-engine';
import type { LlmCompletionRequest } from '@aitp/shared';

/**
 * Does the MOCK behave like the REAL gateway?
 *
 * Every generation test to date used a mock or counting gateway written by the
 * same author as the code, from the same understanding — so both can be wrong
 * the same way while the suite stays green. The first real API call
 * (2026-09-09, `docs/phase-2-generation.md` §L) found four places where they
 * differ, and this suite is what stops them drifting apart again.
 *
 * **It costs nothing.** `HttpLlmGateway` accepts a `baseUrl`, so the real class
 * — its request body, its retry logic, its fence stripping, its usage parsing —
 * is exercised against a local server rather than a provider.
 *
 * Where the two legitimately differ, the difference is ASSERTED rather than
 * smoothed over, so a reader of the mock's output knows what it is not.
 */

/** Anthropic's real envelope. Fenced, because the real model fences. */
const anthropicReply = (text: string) => ({
  id: 'msg_x',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20 },
});

interface Harness {
  server: Server;
  url: string;
  bodies: Array<Record<string, unknown>>;
}

async function serve(reply: unknown): Promise<Harness> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/v1/messages`, bodies };
}

const gatewayAt = (url: string) =>
  new HttpLlmGateway({
    provider: 'anthropic',
    apiKey: 'not-a-real-key',
    models: { reasoning: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
    baseUrl: url,
  });

const REQUEST: LlmCompletionRequest = {
  model: 'reasoning',
  temperature: 0,
  maxTokens: 4096,
  messages: [{ role: 'user', content: 'THE RENDERED PROMPT' }],
  responseSchema: { type: 'object', required: ['cases'] },
  cacheKey: 'fidelity',
};

test.describe('the mock and the real gateway (G) @unit', () => {
  test('G1: completeJson APPENDS a schema instruction the mock never adds', async () => {
    // wrong: believing the mock, a test that asserts "the model sees exactly the
    // rendered prompt" is asserting fiction — the model receives a second
    // message the mock has no idea about, and prompt-content tests are
    // measuring a string the provider never saw.
    const harness = await serve(anthropicReply('{"cases":[]}'));
    try {
      await gatewayAt(harness.url).completeJson({ ...REQUEST });
      const mock = new MockLlmGateway().when('THE RENDERED PROMPT', '{"cases":[]}');
      await mock.completeJson({ ...REQUEST });

      const onWire = harness.bodies[0]!.messages as Array<{ content: string }>;
      expect(onWire).toHaveLength(2);
      expect(onWire[1]!.content).toContain('valid JSON only');
      // Discriminating: the mock records ONE, so the two genuinely disagree.
      expect(mock.calls[0]!.messages).toHaveLength(1);
    } finally {
      harness.server.close();
    }
  });

  test('G2: the responseSchema is inlined into a message, never sent as a field', async () => {
    // wrong: assuming the provider receives a `responseSchema` field would make
    // the schema look enforced by the API when it is only ever a request in
    // prose — the model can and does return extra keys.
    const harness = await serve(anthropicReply('{"cases":[]}'));
    try {
      await gatewayAt(harness.url).completeJson({ ...REQUEST });
      const body = harness.bodies[0]!;
      expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
      // Read the message CONTENT, not the stringified body: the schema is JSON
      // inside a JSON string, so `JSON.stringify(body)` double-escapes it and a
      // substring match there fails while the schema is present.
      const messages = body.messages as Array<{ content: string }>;
      expect(messages.at(-1)!.content).toContain('"required":["cases"]');
    } finally {
      harness.server.close();
    }
  });

  test('G3: the real gateway strips markdown fences and the mock cannot', async () => {
    // wrong: without the strip, every fenced reply is a malformed-JSON error —
    // and the mock never exercises the path, so the strip could be deleted and
    // no test would notice.
    const harness = await serve(anthropicReply('```json\n{"cases":[]}\n```'));
    try {
      const real = await gatewayAt(harness.url).completeJson<{ cases: unknown[] }>({ ...REQUEST });
      expect(real.content).toEqual({ cases: [] });

      // Discriminating: the SAME payload through the mock throws, which is what
      // proves the real gateway is doing the work rather than the model being
      // tidy.
      const mock = new MockLlmGateway().when('X', '```json\n{"cases":[]}\n```');
      await expect(
        mock.completeJson({ messages: [{ role: 'user', content: 'X' }] }),
      ).rejects.toThrow();
    } finally {
      harness.server.close();
    }
  });

  test('G4: provider, model and usage are real values, not mock placeholders', async () => {
    // wrong: a test asserting a proposal's `model` against the mock pins
    // "mock/reasoning", while every real proposal carries
    // "anthropic/claude-sonnet-4-5" — the provenance field would be tested
    // against a value that never occurs in production.
    const harness = await serve(anthropicReply('{"cases":[]}'));
    try {
      const real = await gatewayAt(harness.url).completeJson({ ...REQUEST });
      expect(real.provider).toBe('anthropic');
      expect(real.model).toBe('claude-sonnet-4-5');
      expect(real.usage.promptTokens).toBe(100);
      expect(real.usage.costUsd).toBeGreaterThan(0);

      const mock = new MockLlmGateway().when('THE RENDERED PROMPT', '{"cases":[]}');
      const mocked = await mock.completeJson({ ...REQUEST });
      // The mock resolves NOTHING: it echoes the logical name and charges $0.
      expect(mocked.provider).toBe('mock');
      expect(mocked.model).toBe('reasoning');
      expect(mocked.usage.costUsd).toBe(0);
    } finally {
      harness.server.close();
    }
  });

  test('G5: the mock has no cache, so it cannot testify about cache behaviour', async () => {
    // wrong: reading the mock as evidence that "the cache avoids the model"
    // proves the opposite of what it looks like — the mock dispatches every
    // time, so a cache test written against it passes with no cache at all.
    const harness = await serve(anthropicReply('{"cases":[]}'));
    try {
      const real = gatewayAt(harness.url);
      await real.completeJson({ ...REQUEST });
      await real.completeJson({ ...REQUEST });
      // One HTTP body, two calls: the real cache suppressed the second.
      expect(harness.bodies).toHaveLength(1);

      const mock = new MockLlmGateway().when('THE RENDERED PROMPT', '{"cases":[]}');
      await mock.completeJson({ ...REQUEST });
      await mock.completeJson({ ...REQUEST });
      expect(mock.calls).toHaveLength(2);
    } finally {
      harness.server.close();
    }
  });
});
