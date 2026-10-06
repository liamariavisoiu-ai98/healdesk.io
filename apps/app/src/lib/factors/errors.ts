/**
 * Whether `error`, or a cause Drizzle wrapped it in, is a unique violation on
 * one of `constraints`. Matched by name, never by a bare 23505: a second
 * unique index on the same path would otherwise be read as the one hunted
 * (lib/provisioning.ts has the story).
 */
export function isUniqueViolationOn(error: unknown, constraints: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown };
    if (e.code === "23505") {
      return typeof e.constraint === "string" && constraints.includes(e.constraint);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
