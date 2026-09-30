/**
 * Escape a value for use inside an LDAP search filter (RFC 4515 §3):
 * `*`, `(`, `)`, `\` and NUL become `\2a`, `\28`, `\29`, `\5c`, `\00`.
 * Everything else (including UTF-8) is passed through unchanged.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[*()\\\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * Fill `{name}` placeholders in an administrator-supplied filter template
 * with escaped values. Unknown placeholders are left untouched, so a
 * literal `{` in the template is harmless. Values can never change the
 * structure of the filter.
 */
export function fillFilter(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? escapeFilterValue(values[name]!) : whole,
  );
}
