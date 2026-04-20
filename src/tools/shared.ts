// Generische Tool-Utilities für MCP-Server.
// Keine Notion-Abhängigkeiten — vom Split auf das Minimum reduziert, das
// tools/learnweb.ts benötigt.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type WorkspaceScope = string | undefined;

export type ToolInputSchema = Record<string, z.ZodTypeAny>;
export type ToolOutputSchema = Record<string, z.ZodTypeAny> | z.ZodTypeAny;

export type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: ToolInputSchema | z.ZodTypeAny;
  outputSchema?: ToolOutputSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

type ToolResult<TStructured = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TStructured;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

type ToolResultOptions<TStructured> = {
  text?: string;
  structuredContent?: TStructured;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

// Standard-Annotations für MCP-Tools, damit Clients Read-Only vs. Mutating unterscheiden können.
export const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MUTATING_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const IDEMPOTENT_MUTATING_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const DESTRUCTIVE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function serializeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Baut ein Standard-Erfolg-ToolResult (mit optionaler strukturierter Antwort).
 * Strings landen nur als content[0].text; Objekte zusätzlich als structuredContent.
 */
export function ok<TStructured = unknown>(
  value: string | TStructured,
  options: ToolResultOptions<TStructured> = {}
): ToolResult<TStructured> {
  const result: ToolResult<TStructured> = {
    content: [{ type: "text", text: options.text ?? serializeText(value) }],
  };

  const structuredContent =
    options.structuredContent !== undefined
      ? options.structuredContent
      : typeof value === "string"
        ? undefined
        : value;

  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }
  if (options._meta) {
    result._meta = options._meta;
  }
  if (options.isError) {
    result.isError = true;
  }
  return result;
}

type ErrorPayload = {
  error: true;
  code?: string;
  status?: number;
  message: string;
  details?: unknown;
};

function errorResult(payload: ErrorPayload): ToolResult<ErrorPayload> {
  return ok(payload, {
    text: JSON.stringify(payload),
    structuredContent: payload,
    isError: true,
  });
}

/**
 * Parst einen JSON-String in ein Objekt oder Array, sofern möglich.
 * Verhindert doppelte Serialisierung durch LLM-Clients — der MCP-SDK
 * validiert mit Zod und macht keine Auto-Koerzion von JSON-Strings.
 * undefined bleibt unverändert (für optionale Felder).
 */
export function jsonPreprocess(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      /* Original-Wert behalten. */
    }
  }
  return val;
}

/**
 * Strukturierter Validierungsfehler, den MCP-Clients als Error erkennen.
 */
export function validationError(message: string) {
  return errorResult({
    error: true,
    code: "validation_error",
    message,
  });
}
