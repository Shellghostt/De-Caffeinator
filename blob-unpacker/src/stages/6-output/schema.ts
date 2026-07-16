// ============================================================
// STAGE 6 — OUTPUT SCHEMA DEFINITIONS (Zod-validated)
// ============================================================

import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0";

export const EndpointSchema = z.object({
  value: z.string().min(1),
  method: z
    .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
    .optional(),
  confidence: z.enum(["high", "medium", "low"]),
  source_file: z.string(),
  line: z.number().int().nonnegative(),
  context_snippet: z.string(),
  classification: z.enum(["public", "internal", "hidden"]).optional(),
});

export const SecretSchema = z.object({
  type: z.string(),
  value: z.string(),
  entropy: z.number(),
  context_snippet: z.string(),
  source_file: z.string(),
  line: z.number().int().nonnegative(),
});

export const CommentSchema = z.object({
  text: z.string(),
  category: z.enum(["todo", "fixme", "hack", "bypass", "debug", "note"]),
  source_file: z.string(),
  line: z.number().int().nonnegative(),
});

export const ConfigSchema = z.object({
  key: z.string(),
  value: z.string(),
  source_file: z.string(),
  line: z.number().int().nonnegative().optional(),
});

export const EndpointsContractSchema = z.object({
  _schema_version: z.string(),
  _generated_at: z.string(),
  endpoints: z.array(
    z.object({
      url: z.string(),
      method: z.string().nullable().optional(),
      confidence: z.string(),
      source_file: z.string(),
      line: z.number().optional(),
      context: z.string().optional(),
    })
  ),
});

export const ArtifactsContractSchema = z.object({
  _schema_version: z.string(),
  _generated_at: z.string(),
  artifacts: z.array(
    z.object({
      type: z.string(),
      value: z.string(),
      source_file: z.string(),
      line: z.number().optional(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
    })
  ),
});

/** Validate and return data, or throw with a clear message. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Schema validation failed for ${label}: ${detail}`);
  }
  return result.data;
}
