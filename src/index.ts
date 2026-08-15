/**
 * dsh-auto-mode — a review-based auto mode for DSH.
 *
 * Auto mode is surfaced as a `permission/preset` value (`'auto-mode'`) so it
 * sits next to read-only / workspace-write / danger-full-access in the
 * permission picker. The preset itself uses the core-valid approval policy
 * `'ask'`; this plugin's prepended `approval/request` answerer recognizes the
 * selected preset and decides the call before the ordinary UI answerer runs.
 *
 * Decision chain while `permission/preset === 'auto-mode'`:
 *
 *   1. operator veto rules           → rejected (standing rejections win)
 *   2. operator grant rules          → approved
 *   3. pre-approved read-only tools  → approved (no model call)
 *   4. review model                  → approved / rejected
 *   5. review failure                → rejected (`failClosed`) or the normal
 *                                      approval chain (`next()`)
 *
 * The plugin never writes an out-of-union `approval/policy` value and never
 * patches DSH core services.
 *
 * @module dsh-auto-mode
 */
import { type Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import {
  effectiveApprovalPolicy,
  setApprovalPolicy,
  type ApprovalOutcome,
  type ApprovalPolicy,
  type ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval';
import {
  effectiveSandboxMode,
  setSandboxMode,
} from '@deepseek-ai/dsh-sandbox-policy';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';
import { Config, type ConfigType } from './config.js';
import { findAllowRule, findDenyRule, isAllowlisted } from './rules.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import { classify, renderTranscript, resolveRoute } from './classifier.js';

export const name = 'dsh-auto-mode';
export { Config };

/** Required services — the plugin only loads when all of these exist. */
export const inject = ['approval', 'llm'];

/** The `permission/preset` value owned by this plugin. */
const AUTO_MODE_PRESET = 'auto-mode';

/** Sandbox bundled with the auto-mode preset. */
const AUTO_SANDBOX = 'workspace-write';

/** Model-facing statement for the auto-mode policy slot (order 115). */
const AUTO_SENTENCE =
  'Approval policy: auto. Every tool call that would normally need ' +
  'approval is inspected by a separate reviewer model, which returns one of ' +
  'three rulings: approved, blocked, or needs-human-input. If a tool result ' +
  'later says the user rejected the call, remember that the reviewer may be ' +
  'the one that blocked it — a person did not necessarily object. Continue ' +
  'with a safer tool or a smaller step, or get explicit user confirmation.';

const ASK_SENTENCE =
  'Approval policy: ask. Operations that require approval may ask through ' +
  'the configured answerers; without an available answerer, the request fails ' +
  'closed.';

/** Model-facing statement for the never policy slot. */
const NEVER_SENTENCE =
  'Approval prompts are disabled in this session: actions that require ' +
  'approval are rejected automatically — do not request sandbox escalation.';

/**
 * Whether a session currently runs in auto mode. Auto mode is the last
 * selected `permission/preset` value `'auto-mode'`; the underlying approval
 * policy stays core-valid (`'ask'`), so replay and core invariants remain
 * intact.
 */
export function isAuto(session: Session): boolean {
  return effectivePermissionPreset(session.events) === AUTO_MODE_PRESET;
}

/**
 * The session's product-level policy: `'auto'` when the auto-mode permission
 * preset is selected, otherwise the core `approval/policy` fold.
 */
function policyOf(session: Session): ApprovalPolicy | 'auto' | undefined {
  return isAuto(session) ? 'auto' : effectiveApprovalPolicy(session.events);
}

/**
 * Write the auto-mode knob events without the permission-presets service
 * (used when that optional service is absent, or when `service.set()` cannot
 * resolve the preset because a profile patch removed it). All values written
 * here are core-valid.
 */
function writeAutoModeKnobs(ctx: Context, session: Session): void {
  const events = session.events;
  if (effectivePermissionPreset(events) !== AUTO_MODE_PRESET) {
    session.append('permission/preset', { preset: AUTO_MODE_PRESET });
  }
  if (effectiveSandboxMode(events) !== AUTO_SANDBOX) {
    setSandboxMode(session, AUTO_SANDBOX);
  }
  const currentApproval =
    effectiveApprovalPolicy(events) ?? ctx.approval.config.policy ?? 'ask';
  if (currentApproval !== 'ask') {
    setApprovalPolicy(session, 'ask');
  }
}

/** Minimal public face of the permission-presets service used here. */
interface PermissionPresetServiceLike {
  set(session: Session, name: string): void;
}

/**
 * Switch one live agent to auto mode: select the `'auto-mode'` permission
 * preset through the public service write path when available, then notify
 * the model. Exported for tests.
 */
export function writeAutoMode(ctx: Context, agent: Agent): void {
  if (isAuto(agent.session)) return;
  const logger = ctx.logger('auto-mode');
  const service = ctx.get('permissionPresets') as
    | PermissionPresetServiceLike
    | undefined;
  if (service) {
    try {
      service.set(agent.session, AUTO_MODE_PRESET);
    } catch (error) {
      logger.warn(
        `auto-mode preset switch failed (${String(error)}) — falling back to direct knob events`,
      );
      writeAutoModeKnobs(ctx, agent.session);
    }
  } else {
    writeAutoModeKnobs(ctx, agent.session);
  }
  agent.inject(
    createUserMessage({
      content: [
        {
          type: 'text',
          text:
            'Auto mode enabled (permission preset "auto-mode"). ' +
            'Permission-gated tool calls will now be decided automatically: ' +
            'approved, blocked, or passed to the user for confirmation.',
        },
      ],
      source: { kind: 'plugin', plugin: 'auto-mode' },
    }),
  );
}

/** The runtime face of the user-questions service we consult (type-only). */
interface UserQuestionsLike {
  ask(request: {
    agent: Agent;
    signal?: AbortSignal;
    questions: Array<{
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
    }>;
  }): Promise<{
    answers: Array<{ id: string; selected: string[]; custom?: string }>;
  }>;
}

/** Outcome of asking the human for a decision on an uncertain call. */
type HumanDecision =
  | { kind: 'allow' }
  | { kind: 'reject' }
  | { kind: 'reject-with-text'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

/**
 * Ask the human (via the user-questions provider) for a decision on a call
 * the review model marked "ask". The user may allow the call, reject it, or
 * reject it while typing what they actually want. The typed text is
 * injected into the session directly (visible at the next model step)
 * instead of being queued as a new conversation message, so it overrides
 * any global mid-turn new-message setting. Exported for tests.
 */
export async function askHumanForDecision(
  ctx: Context,
  req: ApprovalRequest,
): Promise<HumanDecision> {
  const uq = ctx.get('userQuestions') as UserQuestionsLike | undefined;
  if (!uq) return { kind: 'unavailable' };
  try {
    const answer = await uq.ask({
      agent: req.agent,
      signal: req.signal,
      questions: [
        {
          id: 'auto-mode-approval',
          header: 'Auto mode 权限确认',
          question: `工具调用 ${req.toolName} 需要你的确认。${
            req.reason ? `原因：${req.reason}` : ''
          }`,
          detail: '分类器无法确定该操作是否符合你的意图，请人工决定。',
          options: [
            { label: '允许', description: '放行本次操作' },
            { label: '拒绝', description: '拒绝本次操作' },
            {
              label: '拒绝并指示',
              description: '拒绝操作，并在下方输入你期望的处理方式',
            },
          ],
        },
      ],
    });
    const item = answer.answers[0];
    const selected = item?.selected ?? [];
    const custom = item?.custom?.trim();
    if (selected.includes('允许')) return { kind: 'allow' };
    if (selected.includes('拒绝并指示') && custom) {
      return { kind: 'reject-with-text', text: custom };
    }
    if (selected.includes('拒绝并指示') || selected.includes('拒绝')) {
      return { kind: 'reject' };
    }
    if (custom) return { kind: 'reject-with-text', text: custom };
    // The user skipped the question (or left it unanswered): fail closed —
    // a skipped confirmation is not an approval, and re-prompting through
    // the standard approval chain would show a second dialog for the same
    // call.
    return { kind: 'reject' };
  } catch (error) {
    if (req.signal?.aborted) return { kind: 'cancelled' };
    // ASK_ABORTED = the user dismissed/skipped the dialog (or the provider
    // went away mid-question): treat a dismissal as a rejection, never as a
    // fall-through to a second dialog.
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ASK_ABORTED') return { kind: 'reject' };
    // Anything else (no provider support for this agent, provider errors):
    // fall back to the ordinary approval chain.
    return { kind: 'unavailable' };
  }
}

/**
 * The auto decision chain for one approval request. Returns the outcome, or
 * delegates to `next()` when the review model cannot decide and the plugin is
 * configured to fall back to the human chain.
 */
async function decideAuto(
  ctx: Context,
  config: ConfigType,
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
): Promise<ApprovalOutcome> {
  const logger = ctx.logger('auto-mode');
  const { agent, toolName, reason, signal } = req;

  if (signal?.aborted) return 'cancelled';

  // 1. Operator vetoes come first: a standing rejection always wins.
  const denyRule = findDenyRule(config.rules.deny, toolName, reason);
  if (denyRule) {
    logger.info(`deny rule "${denyRule}" matched → reject ${toolName}`);
    return 'rejected';
  }

  // 2. Operator grants: a matching standing approval ends the check.
  const allowRule = findAllowRule(config.rules.allow, toolName, reason);
  if (allowRule) {
    logger.info(`allow rule "${allowRule}" matched → approve ${toolName}`);
    return 'allowed-once';
  }

  // 3. Pre-approved read-only tools skip the review model.
  if (isAllowlisted(toolName, config.allowlist)) {
    logger.info(`allowlist fast path → approve ${toolName}`);
    return 'allowed-once';
  }

  // 4. Review model.
  const { provider, model } = resolveRoute(
    agent,
    config.classifier.provider,
    config.classifier.model,
  );
  if (!provider || !model) {
    logger.warn(
      `no classifier route (provider="${provider || ''}", model="${model || ''}") — ` +
        (config.failClosed
          ? 'rejecting (failClosed)'
          : 'falling back to the approval chain'),
    );
    return config.failClosed ? 'rejected' : next();
  }

  const transcript = renderTranscript(
    agent.session.deriveMessages(),
    config.classifier.maxTranscriptMessages,
  );
  const input = promptInputOf(
    req,
    config.rules.allow,
    config.rules.deny,
    config.rules.environment,
  );
  logger.info(
    `classifying ${toolName}${reason ? ` (${reason})` : ''} via ${provider}/${model}`,
  );
  const verdict = await classify(ctx, {
    system: buildSystemPrompt(input),
    user: buildUserMessage(input, transcript),
    provider,
    model,
    temperature: config.classifier.temperature,
    maxTokens: config.classifier.maxTokens,
    signal,
  });
  if (verdict) {
    logger.info(
      `classifier verdict: ${verdict.decision} — ${verdict.reason}`,
    );
    switch (verdict.decision) {
      case 'allow':
        return 'allowed-once';
      case 'reject': {
        // Distinguish reviewer blocks from human vetoes: the tool layer
        // reports both as "the user rejected …", which would otherwise make
        // the model believe a person declined the call.
        agent.inject(
          createUserMessage({
            content: [
              {
                type: 'text',
                text:
                  `Auto mode blocked the ${toolName} call before it reached anyone. ` +
                  `Reviewer reason: ${verdict.reason}. The tool result may say "the user ` +
                  'rejected" the call; in auto mode that usually means the reviewer, not ' +
                  'a person. Try a smaller or safer version of the action, or ask the ' +
                  'user for explicit permission before retrying.',
              },
            ],
            source: { kind: 'plugin', plugin: 'auto-mode' },
          }),
        );
        return 'rejected';
      }
      case 'ask': {
        // Uncertain but plausible: hand the decision to a human when the
        // configured fallback is on; otherwise treat as a rejection.
        if (!config.classifier.askFallback) {
          logger.info(
            `classifier asked for human confirmation of ${toolName} — treating as rejection (askFallback=false)`,
          );
          return 'rejected';
        }
        const decision = await askHumanForDecision(ctx, req);
        switch (decision.kind) {
          case 'allow':
            logger.info(`human allowed ${toolName} after classifier "ask"`);
            return 'allowed-once';
          case 'reject':
            logger.info(`human rejected ${toolName} after classifier "ask"`);
            return 'rejected';
          case 'cancelled':
            logger.info(`human cancelled the confirmation of ${toolName}`);
            return 'cancelled';
          case 'reject-with-text':
            logger.info(
              `human rejected ${toolName} with instructions: ${decision.text}`,
            );
            // Direct insert of the user's instruction — visible at the next
            // model step, not queued behind inbox scheduling.
            agent.inject(
              createUserMessage({
                content: [{ type: 'text', text: decision.text }],
                source: { kind: 'user' },
              }),
            );
            return 'rejected';
          case 'unavailable':
            logger.info(
              `no user-questions provider for ${toolName} — falling back to the approval chain`,
            );
            return next();
        }
      }
    }
  }

  // 5. No ruling (API error, abort, truncation, unparsable reply).
  if (signal?.aborted) return 'cancelled';
  logger.warn(
    `classifier produced no verdict for ${toolName} — ` +
      (config.failClosed ? 'rejecting (failClosed)' : 'falling back to the approval chain'),
  );
  return config.failClosed ? 'rejected' : next();
}

export function apply(ctx: Context, config: ConfigType): void {
  const logger = ctx.logger('auto-mode');

  // --- 1. The auto answerer -----------------------------------------------
  // `prepend` places this listener before the UI answerer, so while the
  // auto-mode permission preset is selected the request is claimed here and
  // no prompt is shown. In any other preset we delegate immediately.
  ctx.on(
    'approval/request',
    (req, next) => {
      if (!isAuto(req.agent.session)) return next();
      return decideAuto(ctx, config, req, next);
    },
    { prepend: true },
  );

  // --- 2. Preset availability diagnostic ----------------------------------
  // The auto-mode entry itself is declared by this package's
  // `cordis.patch.yml`. Warn (but do not mutate the service) when a profile
  // patch removed or shadowed it, so /auto can still fall back to direct
  // knob events.
  ctx.inject(['permissionPresets'], (scope) => {
    const service = scope.get('permissionPresets') as
      | { names?: readonly string[] }
      | undefined;
    if (service && !service.names?.includes(AUTO_MODE_PRESET)) {
      logger.warn(
        `auto-mode preset is missing from permissionPresets; ` +
          `check that the dsh-auto-mode bundle patch is applied`,
      );
    }
  });

  // --- 3. Correct system-prompt statement per agent -----------------------
  // The core `approval:policy` context (order 115) only knows ask/never and
  // would report an auto-mode session as "ask". Shadow it per agent with the
  // three-state statement. Optional: without dsh-system-prompt the model
  // simply learns the policy from the runtime-context snapshot instead.
  ctx.inject(['systemPrompt'], (scope) => {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.inject(['systemPrompt'], (agentScope) => {
        agentScope.systemPrompt.context({
          name: 'approval:policy',
          order: 115,
          text: (assemble) => {
            const target = assemble.agent ?? agent;
            if (!target) return '';
            const policy = policyOf(target.session) ?? 'ask';
            if (policy === 'auto') return AUTO_SENTENCE;
            return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE;
          },
        });
      });
    });
  });

  // --- 4. Commands --------------------------------------------------------
  // `/auto` selects the auto-mode permission preset; `/auto-status` prints
  // diagnostics. Optional: without dsh-commands the permission picker is the
  // entry point.
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'auto',
      description:
        'Switch this session to auto mode: permission-gated tool calls are ' +
        'approved, blocked, or sent to you for confirmation automatically.',
      handler: ({ agent }) => {
        if (isAuto(agent.session)) {
          return { kind: 'success', text: 'Already in auto mode.' };
        }
        writeAutoMode(ctx, agent);
        return {
          kind: 'success',
          text: 'Auto mode enabled (permission preset "auto-mode").',
        };
      },
    });
    scope.commands.register({
      name: 'auto-status',
      description: 'Show auto-mode diagnostics: preset, approval policy, and table state.',
      handler: ({ agent }) => {
        const auto = isAuto(agent.session);
        const preset = effectivePermissionPreset(agent.session.events);
        const approval =
          effectiveApprovalPolicy(agent.session.events) ??
          ctx.approval.config.policy ??
          'ask';
        const service = ctx.get('permissionPresets') as
          | { names?: readonly string[] }
          | undefined;
        const presets = service?.names ?? [];
        return {
          kind: 'success',
          text:
            `auto-mode=${auto}; permissionPreset=${preset ?? 'none'}; ` +
            `approvalPolicy=${approval}; permissionPresets=${service ? 'present' : 'absent'}; ` +
            `presets=[${presets.join(', ')}]`,
        };
      },
    });
  });
}
