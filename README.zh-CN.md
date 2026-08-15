# dsh-auto-mode

> English: [README.md](./README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）提供的 **auto mode**。它在权限选择器中以 **Auto mode** 选项呈现，与 read-only / workspace-write / danger-full-access 并列。启用 auto mode 后，原本需要人工确认的工具调用会被自动裁决：

- 命中了明确的 **deny 规则** → 拒绝（用户否决优先）
- 命中了明确的 **allow 规则** → 放行
- 属于 **预批准工具** → 无需调用模型，直接放行
- 其他情况由 **审查模型** 查看对话记录与本次调用，决定放行、阻止或转交人工确认
- 审查模型没有给出结论（API 错误、中止、输出截断）时：拒绝（`failClosed`）或回落到普通审批链（弹窗确认）

## 兼容性

已在 DSH `0.1.0-rc.6` 上测试。bundle patch 会重述内置权限预设表（`read-only`、`workspace-write`、`danger-full-access`）；DSH 升级后请检查 `cordis.patch.yml` 中的这张表，并在内置预设变化时同步更新。

## 安装

```bash
dsh plugin --profile web add dsh-auto-mode@<version>
```

或者使用本地 checkout：

```bash
# 添加到 C:\Users\<you>\.dsh\profiles\web\package.json
#   "dependencies": { "dsh-auto-mode": "file:E:/Project/Interests/dsh-auto-mode" }
#   "dsh.profile.bundles": [..., "dsh-auto-mode"]
pnpm install --dir C:\Users\<you>\.dsh\profiles\web
```

重启 web 应用后，权限选择器（聊天框左下角）会出现 **Auto mode**；`/auto` 可直接切换当前会话。

选择器入口由插件的 bundle patch（`cordis.patch.yml`）声明。DSH 内置权限图标表没有为自定义 preset id 提供图标，UI 会按设计回退为纯文本标签——本插件**不会**补丁 DSH 客户端 bundle。

## 配置

所有选项都有默认值，空配置 `{}` 即可使用。

| 路径 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `classifier.provider` / `classifier.model` | string | `''` | 审查调用的路由；为空则跟随会话当前模型。 |
| `classifier.maxTranscriptMessages` | number | `40` | 送入审查模型的最近消息条数。 |
| `classifier.maxTokens` | number | `512` | 审查模型输出 token 预算。 |
| `classifier.temperature` | number | `0` | 审查模型采样温度。 |
| `classifier.askFallback` | boolean | `true` | 审查结果为 `"ask"`（有风险但不确定）时回落到人工审批链；`false` 则视为拒绝。 |
| `rules.allow` | string[] | `[]` | 总是放行的规则（语法见下）。 |
| `rules.deny` | string[] | `[]` | 总是拒绝的规则；最先评估。 |
| `rules.environment` | string[] | `[]` | 注入审查提示词的任意环境事实。 |
| `allowlist` | string[] | `read`、`glob`、`grep`、`todo_write`、`web_search`、`job_list`、`list_agents` | 无需调用审查模型即放行的工具。 |
| `failClosed` | boolean | `false` | `true`：审查失败时拒绝；`false`：回落到普通审批链。 |

auto-mode 预设的标签、描述与 sandbox 模式放在 `cordis.patch.yml` 中，因为权限预设表必须在 `@deepseek-ai/dsh-permission-presets` 构建设置 schema 时可用。

### 规则语法

```
tool            按工具名匹配（不区分大小写），例如 read
tool:pattern    匹配请求原因中包含 pattern 的工具，例如 read:/etc/、pwsh:rm -rf
*               任意工具
*:pattern       请求原因中包含 pattern 的任意工具
```

包含 `*` 或 `?` 的 pattern 会作为通配符匹配整个请求原因（如 `read:/etc/*`）；其他 pattern 按不区分大小写的子串匹配。

## 工作原理

1. **模式状态** — auto mode 即会话当前选中的 `permission/preset` 值 `'auto-mode'`。该预设本身捆绑 `workspace-write` sandbox 与核心合法的审批策略 `ask`。插件识别该预设并接管审批 answerer；它从不写入联合类型之外的 `approval/policy` 值，也从不补丁 DSH 核心服务。
2. **决策链** — 插件以 `prepend` 注册 `approval/request` answerer，因此 auto mode 下的请求会在 web UI answerer 之前被接管。审查模型返回三种结论之一：
   - `allow` — 无需提示直接放行；
   - `reject` — 审查模型认为该调用有害或违背用户利益。插件会明确告知模型这次阻止来自审查模型而非真人（工具层会把两种情况都报成 “the user rejected…”）；
   - `ask` — 影响较大但可能符合意图（安装软件、在工作区外写入、外发数据）：插件会显示确认对话框，提供三个选项——允许、拒绝、拒绝并输入期望做法。用户输入会直接注入会话（下一步模型即可见，绕过 inbox 调度）。没有 questions provider 时回落到普通审批链。
   在其他权限预设下，answerer 立即转交。
3. **审查调用** — 由会话派生消息加上待审操作构成，经 `ctx.llm` 流式调用（`temperature: 0`）；回复会被健壮解析（JSON 对象或 token 扫描）。审查提示词分为三个独立区块：用户的常设放行、常设拒绝与环境说明。
4. **模型感知** — 插件按 agent 覆盖核心 `approval:policy` 系统提示词上下文，使 auto-mode 会话被报告为 *auto* 而不是 *ask*，并把工具结果里的 “the user rejected…” 澄清为审查模型裁决而非真人否决。
5. **设置页** — `cordis.patch.yml` 在服务构造期以合法的 `ask` 审批值声明 `auto-mode` 预设，因此新会话默认选择器无需运行时提升或补丁服务即可展示该选项。

## 安全与隐私

auto mode 是便利模式，不是安全边界：

- 审查模型会读取最近对话记录与待审操作，并发送到配置的 LLM 路由（默认是会话模型）；
- 默认预设运行在 `workspace-write` sandbox 下，工作区外写入仍需要 sandbox 升级/审批路径；
- 工作区中的恶意内容（文件、工具结果）可能对审查模型发起提示注入——确定性的 deny 规则与预批准工具列表在模型之前执行，真正需要依赖的规则应写在这里；
- 如需审查失败时直接拒绝而不是弹窗，设置 `failClosed: true`。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json → lib/
npm test            # 纯逻辑 smoke tests
```

## License

MIT
