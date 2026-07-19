// {{variable}} rendering for prompt bodies. Deliberately minimal — no
// conditionals or loops. Conditional blocks are passed in as pre-rendered
// "section" variables ("" when absent), so editors can still reposition or
// reword everything around them.

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Substitute every {{name}} in the template with vars[name]. Unknown
 * placeholders are left verbatim (and surfaced by missingPlaceholders at the
 * prompt-load guard) rather than silently blanked.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in vars ? vars[name]! : match,
  );
}

/**
 * Which of the required variable names have no {{name}} placeholder in the
 * template. A non-empty result means an edited body lost runtime context —
 * the caller must fall back to the code default rather than send a prompt
 * that's missing its inputs.
 */
export function missingPlaceholders(
  template: string,
  requiredVars: string[],
): string[] {
  return requiredVars.filter((name) => !template.includes(`{{${name}}}`));
}
