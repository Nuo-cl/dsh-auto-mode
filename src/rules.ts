/**
 * Deterministic rule matching — the fast path that runs before the
 * classifier.
 *
 * Rule syntax (one per configured string):
 *
 *   `tool`            — match a tool by name (case-insensitive), e.g. `read`
 *   `tool:pattern`    — match a tool whose request reason contains the
 *                       pattern, e.g. `read:/etc/`, `pwsh:rm -rf`
 *   `*`               — any tool
 *   `*:pattern`       — any tool whose reason contains the pattern
 *
 * A pattern containing `*` or `?` is treated as a wildcard match against
 * the whole reason (e.g. `read:/etc/*`); any other pattern is a
 * case-insensitive substring match. Rules are evaluated in configured
 * order; the first match wins.
 */
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval';

/** One configured rule set: explicit allow rules and explicit deny rules. */
export interface RuleSet {
  /** Rules that always allow a matching request. */
  allow: readonly string[];
  /** Rules that always reject a matching request. */
  deny: readonly string[];
}

/** Translate a `*`/`?` wildcard pattern into an anchored case-insensitive regex. */
function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Whether one pattern matches one text. Patterns containing wildcards match
 * the entire text; plain patterns match as a case-insensitive substring —
 * reasons are human prose (e.g. `[sandbox: file access denied under
 * read-only mode]`), so exact anchoring would be unusable.
 */
export function patternMatches(pattern: string, text: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) {
    return wildcardToRegExp(pattern).test(text);
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/** Whether one rule entry matches a request's tool name and reason. */
export function ruleMatches(rule: string, toolName: string, reason: string | undefined): boolean {
  const colon = rule.indexOf(':');
  const toolPart = colon === -1 ? rule : rule.slice(0, colon);
  const patternPart = colon === -1 ? undefined : rule.slice(colon + 1);
  if (toolPart !== '*' && toolPart.toLowerCase() !== toolName.toLowerCase()) {
    return false;
  }
  if (patternPart === undefined || patternPart === '') return true;
  if (!reason) return false;
  return patternMatches(patternPart, reason);
}

/** First matching allow rule, or undefined. */
export function findAllowRule(
  rules: readonly string[],
  toolName: string,
  reason: string | undefined,
): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, reason));
}

/** First matching deny rule, or undefined. */
export function findDenyRule(
  rules: readonly string[],
  toolName: string,
  reason: string | undefined,
): string | undefined {
  return rules.find((rule) => ruleMatches(rule, toolName, reason));
}

/** Whether the tool is on the safe allowlist (name-only, case-insensitive). */
export function isAllowlisted(toolName: string, allowlist: readonly string[]): boolean {
  const name = toolName.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === name);
}

/** Build the environment-facts block handed to the classifier prompt. */
export function buildEnvironmentText(facts: readonly string[]): string {
  if (facts.length === 0) return '';
  return facts
    .map((fact) => `- ${fact}`)
    .join('\n');
}
