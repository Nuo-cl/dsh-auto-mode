# dsh-auto-mode

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

An **auto mode** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH), shown as an **Auto mode** entry in the permission picker next to read-only / workspace-write / danger-full-access. While auto mode is selected, tool calls that would normally require a user confirmation are decided automatically:

- explicit **deny rules** → rejected (operator vetoes always win)
- explicit **allow rules** → approved
- **pre-approved tools** → approved without a model call
- otherwise a **review model** inspects the conversation transcript and the requested call, then approves, blocks, or flags it for human confirmation
- when the review model produces no ruling (API error, abort, truncation): reject (`failClosed`) or fall back to the ordinary approval chain (a prompt)

## Compatibility

Tested against DSH `0.1.0-rc.6`. The bundle patch restates the stock permission-preset table (`read-only`, `workspace-write`, `danger-full-access`); after a DSH upgrade, review that table in `cordis.patch.yml` and update it if the stock presets changed.

## Install

```bash
dsh plugin --profile web add dsh-auto-mode@<version>
```

or, for a local checkout:

```bash
# add to C:\Users\<you>\.dsh\profiles\web\package.json
#   "dependencies": { "dsh-auto-mode": "file:E:/Project/Interests/dsh-auto-mode" }
#   "dsh.profile.bundles": [..., "dsh-auto-mode"]
pnpm install --dir C:\Users\<you>\.dsh\profiles\web
```

Restart the web app. The permission picker (bottom-left of the chat box) now shows **Auto mode**; `/auto` switches the current session directly.

The picker entry is declared by the plugin's bundle patch (`cordis.patch.yml`). DSH's stock permission glyph table has no icon for custom preset ids, and the UI intentionally falls back to text-only labels — this plugin does **not** patch the DSH client bundle.

## Configuration

All options have defaults; a bare `{}` config is valid.

| Path | Type | Default | Meaning |
| --- | --- | --- | --- |
| `classifier.provider` / `classifier.model` | string | `''` | Route for classifier calls; empty follows the session's current model. |
| `classifier.maxTranscriptMessages` | number | `40` | Trailing transcript messages fed to the classifier. |
| `classifier.maxTokens` | number | `512` | Classifier output budget. |
| `classifier.temperature` | number | `0` | Classifier sampling temperature. |
| `classifier.askFallback` | boolean | `true` | Classifier decision `"ask"` (uncertain risky call) falls back to the human approval chain; `false` treats it as a rejection. |
| `rules.allow` | string[] | `[]` | Always-allow rules (see rule syntax below). |
| `rules.deny` | string[] | `[]` | Always-reject rules; evaluated before everything else. |
| `rules.environment` | string[] | `[]` | Free-form environment facts injected into the classifier prompt. |
| `allowlist` | string[] | `read`, `glob`, `grep`, `todo_write`, `web_search`, `job_list`, `list_agents` | Tools approved without a classifier call. |
| `failClosed` | boolean | `false` | `true`: classifier failure rejects; `false`: falls back to the normal approval chain. |

The auto-mode preset's label, description, and sandbox mode live in `cordis.patch.yml`, because the permission-preset table must be available when `@deepseek-ai/dsh-permission-presets` constructs its settings schema.

### Rule syntax

```
tool            match a tool by name (case-insensitive), e.g. `read`
tool:pattern    match a tool whose request reason contains the pattern, e.g. `read:/etc/`, `pwsh:rm -rf`
*               any tool
*:pattern       any tool whose reason contains the pattern
```

A pattern containing `*` or `?` is a wildcard match against the whole reason (`read:/etc/*`); any other pattern is a case-insensitive substring match.

## How it works

1. **Mode state** — auto mode is the session's selected `permission/preset` value `'auto-mode'`. The preset itself bundles `workspace-write` sandbox and the core-valid approval policy `ask`. The plugin detects that preset and takes over the approval answerer; it never writes an out-of-union `approval/policy` value and never patches DSH core services.
2. **Decision chain** — the plugin registers an `approval/request` answerer with `prepend`, so in auto mode requests are claimed before the web UI answerer. The review model returns one of three decisions:
   - `allow` — approved without prompting;
   - `reject` — the reviewer judged the call harmful or contrary to the user's interests. The model is told explicitly that the reviewer, not a person, blocked the call (the tool layer reports both outcomes as "the user rejected…");
   - `ask` — consequential but plausibly intended (installs, writes outside the workspace, sends data): the plugin shows a confirmation dialog with three choices — allow, reject, or reject and type what should happen instead. The typed text is injected directly into the session (visible at the next model step, bypassing inbox scheduling). Without a questions provider the ordinary approval chain is used instead.
   In any other permission preset the answerer delegates immediately.
3. **Review call** — built from the session's derived messages plus the requested action, streamed through `ctx.llm` with `temperature: 0`; the reply is parsed robustly (JSON object or token scan). The review prompt carries the operator's standing approvals, standing rejections, and environment notes in separate sections.
4. **Model awareness** — the plugin shadows the core `approval:policy` system-prompt context per agent so an auto-mode session is reported as *auto*, not *ask*, and tool-result wording ("the user rejected…") is clarified as a reviewer ruling rather than a human veto.
5. **Settings page** — because `cordis.patch.yml` declares the `auto-mode` preset at construction time with the valid `ask` approval value, the new-session default picker can advertise it without any runtime promotion or service patching.

## Security & privacy

Auto mode is a convenience mode, not a security boundary:

- the review model reads the recent conversation transcript and the requested action, and sends them to the configured LLM route (by default the session model);
- the default preset runs with `workspace-write` sandbox, so workspace-external writes still require sandbox escalation/approval paths;
- malicious content in the workspace (files, tool results) can attempt prompt injection against the review model — deterministic deny rules and the pre-approved tool list are evaluated before the model and should carry the rules you actually depend on;
- set `failClosed: true` if you want review-model failures to reject instead of prompting.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json → lib/
npm test            # smoke tests for pure logic
```

## License

MIT
