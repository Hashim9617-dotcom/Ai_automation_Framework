import { z } from 'zod';

/**
 * One environment = one JSON file under config/env/. Anything secret
 * (passwords, tokens) is referenced via ${ENV_VAR} placeholders and resolved
 * from process.env at load time, so no credential is ever committed.
 */
export const environmentSchema = z.object({
  name: z.string(),
  baseUrl: z.string().url(),
  apiBaseUrl: z.string().url().optional(),
  timeouts: z
    .object({
      action: z.number().int().positive().default(15_000),
      navigation: z.number().int().positive().default(30_000),
      expect: z.number().int().positive().default(10_000),
      test: z.number().int().positive().default(90_000),
    })
    .default({}),
  retries: z.number().int().min(0).max(5).default(1),
  workers: z.number().int().min(1).max(32).default(4),
  users: z
    .record(
      z.object({
        username: z.string(),
        password: z.string(),
        role: z.string().default('user'),
      }),
    )
    .default({}),
  database: z
    .object({
      host: z.string(),
      port: z.number().int().default(5432),
      name: z.string(),
      user: z.string(),
      password: z.string(),
    })
    .optional(),
  features: z
    .object({
      selfHealing: z.boolean().default(false),
      aiRootCause: z.boolean().default(false),
      video: z.boolean().default(true),
      trace: z.boolean().default(true),
    })
    .default({}),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
