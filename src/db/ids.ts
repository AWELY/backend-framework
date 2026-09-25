const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All tables use UUID primary keys; anything else in an :id path segment cannot match a row. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const UUID_REGEX = UUID_PATTERN;
