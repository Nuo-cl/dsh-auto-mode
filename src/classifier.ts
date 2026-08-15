/**
 * LLM classifier: renders the conversation transcript, streams one
 * classifier call through `ctx.llm`, and parses the JSON verdict.
 *
 * The classifier is fail-aware but not fail-closed by itself: it returns
 * `null` when no verdict can be produced (API error, aborted stream,
 * truncated or unparsable reply), and the caller decides what `null` means
 * (`failClosed` config, or falling back to the human approval chain).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';

/** A classifier decision: allow, ask a human, or reject. */
export type VerdictDecision = 'allow' | 'ask' | 'reject';

/** A parsed classifier verdict. */
export interface Verdict {
  /** The decision. */
  readonly decision: VerdictDecision;
  /** The classifier's one-sentence justification. */
  readonly reason: string;
}

/** Options for one classifier call. */
export interface ClassifyOptions {
  /** System prompt (see prompt.ts). */
  readonly system: string;
  /** User message: transcript + action (see prompt.ts). */
  readonly user: string;
  /** Provider route for the call (already resolved). */
  readonly provider: string;
  /** Model id for the call (already resolved). */
  readonly model: string;
  /** Sampling temperature. */
  readonly temperature: number;
  /** Output token budget. */
  readonly maxTokens: number;
  /** Cancellation signal (the approval request's signal). */
  readonly signal?: AbortSignal;
}

/** Render one content block into plain text. */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'reasoning':
      return `[thinking] ${block.text}`;
    case 'tool-call':
      return `[tool call: ${block.name} ${block.arguments}]`;
    case 'tool-result':
      return `[tool result${block.isError ? ' (error)' : ''}: ${block.content
        .map(renderBlock)
        .join(' ')}]`;
    case 'image':
      return '[image]';
    default:
      return '';
  }
}

/** Render one conversation message into a `role: content` line. */
function renderMessage(message: Message): string {
  const content = message.content.map(renderBlock).filter(Boolean).join(' ');
  return `${message.role}: ${content}`;
}

/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export function renderTranscript(
  messages: readonly Message[],
  maxMessages: number,
): string {
  const tail = messages.slice(Math.max(0, messages.length - maxMessages));
  return tail.map(renderMessage).join('\n\n');
}

/**
 * Resolve the classifier route: explicit config wins, otherwise the agent's
 * own options, otherwise the session's current request header.
 */
export function resolveRoute(
  agent: Agent,
  configuredProvider: string,
  configuredModel: string,
): { provider: string; model: string } {
  const header = agent.session.requestHeader()?.config;
  const provider =
    configuredProvider || agent.options.provider || header?.provider || '';
  const model = configuredModel || agent.options.model || header?.model || '';
  return { provider, model };
}

/**
 * Robustly parse the classifier's reply into a verdict. Tolerates markdown
 * fences, surrounding prose, and partial JSON by falling back to regex
 * scans of the `decision` (or legacy `allow`) field.
 */
export function parseVerdict(reply: string): Verdict | null {
  const trimmed = reply.trim();
  if (trimmed === '') return null;

  const decisionOf = (
    decision: unknown,
    reason: unknown,
  ): Verdict | null => {
    if (
      decision === 'allow' ||
      decision === 'ask' ||
      decision === 'reject'
    ) {
      return {
        decision,
        reason:
          typeof reason === 'string' && reason.length > 0
            ? reason
            : `classifier decision: ${decision}`,
      };
    }
    return null;
  };

  // Prefer a full JSON object (first `{` … last `}`).
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate) as {
        decision?: unknown;
        allow?: unknown;
        reason?: unknown;
      };
      // New three-value protocol.
      const byDecision = decisionOf(parsed.decision, parsed.reason);
      if (byDecision) return byDecision;
      // Legacy boolean protocol: true → allow, false → reject.
      if (typeof parsed.allow === 'boolean') {
        return {
          decision: parsed.allow ? 'allow' : 'reject',
          reason:
            typeof parsed.reason === 'string' && parsed.reason.length > 0
              ? parsed.reason
              : parsed.allow
                ? 'approved by classifier'
                : 'rejected by classifier',
        };
      }
    } catch {
      // fall through to the regex scans
    }
  }

  // Last resorts: scan for a `decision` or legacy `allow` token.
  const decisionMatch = /"?decision"?\s*[:=]\s*"(allow|ask|reject)"/i.exec(
    trimmed,
  );
  if (decisionMatch) {
    return {
      decision: decisionMatch[1]!.toLowerCase() as VerdictDecision,
      reason: 'classifier reply parsed from token scan',
    };
  }
  const allowMatch = /"?allow"?\s*[:=]\s*(true|false)/i.exec(trimmed);
  if (allowMatch) {
    return {
      decision: allowMatch[1]!.toLowerCase() === 'true' ? 'allow' : 'reject',
      reason: 'classifier reply parsed from token scan',
    };
  }
  return null;
}

/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(
  ctx: Context,
  options: ClassifyOptions,
): Promise<Verdict | null> {
  let text = '';
  try {
    for await (const chunk of ctx.llm.stream({
      provider: options.provider,
      model: options.model,
      system: options.system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: options.user }],
          source: { kind: 'plugin', plugin: 'auto-mode' },
        }),
      ],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: options.signal,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          return null;
        }
        if (chunk.reason.kind === 'max-tokens') {
          // The reply may be truncated mid-JSON; only a fully parsed verdict
          // is acceptable, otherwise treat as no verdict.
          return parseVerdict(text);
        }
      }
    }
  } catch {
    return null;
  }
  return parseVerdict(text);
}
