/**
 * Plugin configuration schema.
 *
 * The classifier section controls the LLM that decides borderline tool calls;
 * the rules section carries the user's allow / deny / environment rules
 * (injected into the classifier prompt); the allowlist section is the
 * deterministic fast path; `failClosed` picks the behaviour when the
 * classifier itself fails.
 *
 * The `auto-mode` entry shown in the permission picker is declared in
 * `cordis.patch.yml` (permission-preset table), not here: that table must
 * exist at service-construction time so the settings page can advertise it.
 *
 * Everything has a default, so a bare `{}` config is a valid install.
 */
import z from '@deepseek-ai/schemastery';
import type Schema from '@deepseek-ai/schemastery';

/**
 * Tools approved without consulting the review model.
 *
 * Every entry is read-only or metadata-only in DSH's own tool surface: it
 * can inspect the project or agent state but cannot modify files, run
 * commands, or send data. The list is intentionally small and deterministic.
 */
export const DEFAULT_ALLOWLIST = [
  'read',
  'glob',
  'grep',
  'todo_write',
  'web_search',
  'job_list',
  'list_agents',
] as const;

export const Config = z.object({
  /** Classifier LLM settings. Empty provider/model follow the session model. */
  classifier: z.object({
    /** Provider route for classifier calls; empty = follow the session. */
    provider: z.string().default(''),
    /** Model id for classifier calls; empty = follow the session. */
    model: z.string().default(''),
    /** How many trailing transcript messages to include. */
    maxTranscriptMessages: z.number().default(40),
    /** Output token budget for the classifier reply. */
    maxTokens: z.number().default(512),
    /** Sampling temperature for the classifier (0 = deterministic). */
    temperature: z.number().default(0),
    /**
     * When the classifier is uncertain about a risky call (decision "ask"),
     * fall back to the ordinary approval chain (a human prompt). Set false
     * to treat "ask" as a rejection (fully unattended).
     */
    askFallback: z.boolean().default(true),
  }),
  /** User-authored rules fed to the classifier prompt. */
  rules: z.object({
    /** Rules that always allow a matching call. */
    allow: z.array(z.string()).default([]),
    /** Rules that always reject a matching call. */
    deny: z.array(z.string()).default([]),
    /** Free-form environment facts (platform, sandbox, …) for the classifier. */
    environment: z.array(z.string()).default([]),
  }),
  /**
   * Tool names approved without consulting the classifier. Rule matches are
   * evaluated first: a deny rule still rejects an allowlisted tool.
   */
  allowlist: z.array(z.string()).default([...DEFAULT_ALLOWLIST]),
  /**
   * What happens when the classifier cannot produce a verdict (API error,
   * unparsable reply, timeout):
   * - `true`  — reject the call (fail closed, never prompt the user).
   * - `false` — fall through to the ordinary approval chain (a prompt).
   */
  failClosed: z.boolean().default(false),
});

/** The normalized output type of the config schema. */
export type ConfigType = typeof Config extends Schema<any, infer T> ? T : never;
