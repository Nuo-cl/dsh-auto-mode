# dsh-auto-mode 端到端验证清单

重启 DSH（`dsh web`）后按此清单验证。每步的记录都通过 DSH 日志中的
`auto-mode` logger 输出（`ctx.logger('auto-mode')`）。

## 已知 UI 刷新机制（重要）

composer 权限选择器的选项来自 host 投影，client 端按 `seq` 规则缓存：
**已存在会话的选项列表不会自动刷新**（localStorage 持久化旧 rows，`seq <= row.seq`
不更新）。要让 Auto mode 出现：
- 切换一次任意权限模式（如 workspace-write → read-only → 回来），或
- 新开一个会话（新日志 seq 从头开始）

## 诊断命令

重启后先跑 `/auto-status`，输出形如：
`auto-mode=true; permissionPreset=auto-mode; approvalPolicy=ask; permissionPresets=present; presets=[read-only, workspace-write, danger-full-access, auto-mode]`

- `presets` 中没有 `auto-mode` → bundle patch 未生效，检查
  `dsh-auto-mode/cordis.patch.yml` 是否随插件包安装，以及 profile patch
  是否覆盖了 `permission` entry；
- `auto-mode=true` 但 composer 无选项 → UI 缓存问题，按上面的刷新机制处理。

## 前置确认（重启后）

1. 插件加载无报错：Web GUI 设置 → 插件 列表中出现 `dsh-auto-mode`，状态为运行中；
   或启动日志中无 `auto-mode` 相关 error。
2. 左下角权限选择器出现 **Auto mode** 选项（由 bundle patch 声明在
   `permissionPresets` 表中）。选中后写入的是：
   - `permission/preset: auto-mode`
   - `sandbox/mode: workspace-write`
   - `approval/policy: ask`（当当前策略不是 ask 时）
   不会出现任何非法的 `approval/policy: auto` 事件。

## 场景 A：Auto mode 下分类器自动决策

1. 权限选择器切换到 **Auto mode**（sandbox 应为 workspace-write）。
2. 向 agent 提问，使其执行一个**需要审批的工具调用**，例如：
   - 让 agent 请求 sandbox 升级（写 workspace 之外的文件，如 `C:\Users\...`）
   - 或执行 `pwsh` 高权限命令
3. 预期：
   - **无审批弹窗**（answerer 已短路 UI）
   - 日志出现 `auto-mode: classifying <tool> (...) via <provider>/<model>`
   - 随后 `auto-mode: classifier verdict: allow|reject — <reason>`
4. 验证 allowlist 快路径：让 agent 执行 `read`/`glob`/`grep`（默认 allowlist），
   日志应为 `allowlist fast path → approve <tool>`，**无 classifier 调用**。
5. 验证 deny/allow 规则：在插件配置中加
   `rules.deny: ["pwsh:rm -rf"]`、`rules.allow: ["read:/workspace/*"]` 后重试，
   日志应分别出现 `deny rule ... → reject` / `allow rule ... → approve`。

## 场景 B：非 auto 时回落人工审批

1. 权限选择器切回 **workspace-write**（ask）或 **danger-full-access**（never）。
2. 再次触发需要审批的工具调用。
3. 预期：**恢复人工弹窗**（workspace-write），或直接拒绝（danger-full-access）；
   日志中无 `auto-mode` 决策记录（answerer 直接 `next()`）。

## 场景 C：分类器失败回落

1. 配置 `classifier.provider: "nonexistent-route"`（无效路由）+ `failClosed: false`。
2. 触发需要分类器的调用（不在 allowlist）。
3. 预期：日志出现
   `classifier produced no verdict ... falling back to the approval chain`，
   UI 弹人工审批窗。
4. 改 `failClosed: true` 重试：应直接拒绝（`rejecting (failClosed)`），无弹窗。

## 场景 D：系统提示词正确性（可选）

1. Auto mode 下让 agent 自我描述当前权限策略。
2. 预期 agent 回答中包含 "approval policy: auto" 或等价描述（来自
   `approval:policy` context 的 shadow 文本，order 115），而不是 "ask"。
   同时 `/auto-status` 中的底层 `approvalPolicy` 仍为 `ask`——这是设计使然。

## 观测位置

- DSH 启动终端 stdout/stderr（logger exporter 默认输出）
- `~/.dsh/profiles/web/` 下的日志文件（如有配置）

## 代码改动后的重载

profile 的依赖是 `link:` junction 指向 `E:\Project\Interests\dsh-auto-mode`，
重新 `npm run build` 后**重启 DSH 即生效**，无需重新 `dsh plugin add`。
