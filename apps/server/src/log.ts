export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

/**
 * One JSON object per line on stdout or stderr, which `docker logs` and journald keep as is.
 * Message text, notes, amounts, and Telegram launch data are never passed in; every listed secret is masked anyway.
 */
export function createLogger(options?: {
  readonly secrets?: readonly string[];
  readonly write?: (level: "info" | "warn" | "error", line: string) => void;
}): Logger {
  const secrets = (options?.secrets ?? []).filter((secret) => secret.length >= 8);
  const write =
    options?.write ??
    ((level, line) => {
      if (level === "info") console.info(line);
      else if (level === "warn") console.warn(line);
      else console.error(line);
    });
  const emit = (level: "info" | "warn" | "error", message: string, fields?: LogFields): void => {
    let line = JSON.stringify({ time: new Date().toISOString(), level, message, ...normalize(fields) });
    for (const secret of secrets) line = line.replaceAll(secret, "[redacted]");
    write(level, line);
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** A logger that drops everything. Tests and one-off tools use it. */
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Name, message, and stack of a thrown value, in a shape that survives JSON. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const code =
      "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined;
    return { error: { name: error.name, message: error.message, code, stack: error.stack } };
  }
  return { error: { name: "NonError", message: String(error) } };
}

function normalize(fields: LogFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
