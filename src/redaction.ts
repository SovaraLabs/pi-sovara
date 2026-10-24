const sensitiveKey =
  /^(authorization|api[_-]?key|access_token|refresh_token|session_token|run_write_token|trace_write_token|traceWriteToken|secret_key|x-sovara-.*token)$/i;

/** Mask known integration credentials and credential fields, not arbitrary user content. */
export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    for (const secret of secrets)
      if (secret) value = (value as string).split(secret).join("[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(item, secrets),
      ]),
    );
  }
  return value;
}
