# DSH — Claudian 魔改版（单 agent = DSH）

把 **DSH（DeepSeek Harness）** 作为**唯一** AI agent 嵌入你的 Obsidian 库。参考 [Claudian](https://github.com/yishentu/claudian)（及其多 agent 分支 oh-my-claudian）的交互与数据约定魔改：原版内置 Claude / Codex / Grok / OpenCode / Pi 五个 agent，本版只保留一个 —— 你自己（DSH）。

```
你的一句话需求
      │
      ▼
DSH（dsh --profile headless，vault 为工作目录）
      │  读文件 / 检索知识库 / 产出 Markdown 交付物
      ▼
<vault>/.dsh/sessions/conv-*.json  （会话历史，随库走）
```

## 特性

- **聊天面板**：侧边栏打开，Enter 发送（Shift+Enter 换行）。
- **单 agent**：每条消息在 vault 根目录运行 `dsh --profile headless <任务>`，一次一问一答，进程用完即走。
- **思考过程（实时）**：回答时在聊天区显示「🧠 思考过程」面板——**推理文本流式滚动 + 工具调用实时列出**（⚙ 工具名 + 参数摘要），头部带计时；完成后折叠成摘要留在答案上方，点击可展开回看。实现：给 headless 追加 `--patch`（会话明文 JSONL 写入独立 `sessions-live` 目录）并实时 tail 事件流（`reasoning-chunks` / `tool-call-chunks` / `text-chunks`）。设置里可关闭（恢复底部「DSH 思考中…」提示）。
- **聊天栏选择器**：输入区与「发送」同一排，随时切换**模型**（默认 deepseek-v4-flash / deepseek-v4-pro）、**思考强度**（off / high / max）、**审批权限**（只读 / 读写库内 / 完全放行），按会话记忆。
- **会话历史**：存放在 `<vault>/.dsh/sessions/`（参考 `.claudian/sessions/` 的约定），支持列表切换、继续、删除、新建。
- **上下文自动附带**：发送时自动把当前笔记（`<linked_note>`）与编辑器选区（`<editor_selection>`）附加给 DSH，参考 Claudian 的上下文标签格式。
- **多轮记忆**：同一会话内自动携带最近 20 轮对话记录，无需手动粘贴。
- **设置页**（参考原版 Claudian 的 codex 面板布局）：**模型与默认值**（模型列表 + **发现模型**按钮 + 默认模型/默认思考强度下拉）→ **运行**（dsh 命令 / node 路径 / DSH_HOME / 审批权限）→ **高级**（额外参数 / 超时 / 附加系统提示）→ **界面**（上下文与发送开关）。
- **发现模型**：像原版 codex 面板的 Discover 一样，异步从本机 `~/.dsh/settings.yaml` 读取模型目录（`llm-deepseek.models`，缺省 V4 Flash + V4 Pro），带「⏳ 发现中… / ✓ 发现 N 个 / ✗ 失败原因」状态行，10 秒超时兜底；首次打开设置页且模型列表为空时自动发现一次。
- **纯 JS 免构建**：无 TypeScript、无打包，拷进 `.obsidian/plugins/` 即用。

## 安装

1. 把本目录下的 `dsh-plugin/` 整个文件夹复制到你的 vault 插件目录：

   ```
   <你的vault>/.obsidian/plugins/dsh/
   ```

2. Obsidian 设置 → 第三方插件（或「社区插件」）→ 找到 **DSH** → 启用。
3. 左侧工具栏会出现机器人图标，或命令面板搜「打开 DSH 聊天」。

> 前置条件：机器上已安装 DSH（`dsh` 命令或 npx 缓存中的 `@deepseek-ai/dsh`），且默认 DSH_HOME（`~/.dsh`）下存在 `.credentials.yaml`（内含 `DEEPSEEK_API_KEY`）。首次打开聊天后可在 设置 → DSH → 发现模型 验证。

## 使用

- **发送任务**：直接输入即可，例如「帮我整理今天的会议笔记」「从我的资料库中总结一下这个主题」。
- **带上下文**：打开某篇笔记、选中一段文字后再发送，DSH 会自动收到笔记路径与选区内容。
- **切换会话**：聊天面板头部「☰」按钮展开会话列表；「＋」新建会话；垃圾桶删除。
- **模型 / 思考强度 / 审批权限**：输入区与发送按钮同一排的三个下拉，随时切换；同一会话记住选择，新会话用设置里的默认值。模型 provider 固定 `deepseek-official`，模型名与思考强度写进 runtime home 的 `settings.yaml`（`agent-default-model`），每次运行生效。
- **权限**：默认 `workspace-write` —— DSH 可读写 vault 内文件；需要更大权限时切到 `danger-full-access`（谨慎）；`read-only` 用于只问答不动文件。对应 `DSH_PERMISSION_MODE` 环境变量。

## 设置项速查

| 设置 | 说明 |
|---|---|
| 显示思考过程 | 回答时实时显示推理文本与工具调用（默认开）；关闭后恢复底部状态条提示 |
| 发现模型 | 模型列表旁的按钮：异步读取本机 `~/.dsh/settings.yaml` 的 `llm-deepseek.models`（缺省 V4 Flash + V4 Pro），状态行反馈，10s 超时兜底 |
| 模型列表 | 聊天栏「模型」下拉候选项，逗号分隔；可手改或由「发现模型」填充 |
| 默认模型 | 下拉选择（来自模型列表），对应本机 `agent-default-model` |
| 默认思考强度 | off（关闭）/ high（高，默认）/ max（最高） |
| dsh 命令 / 入口 | 留空自动检测（npx 缓存 / 全局 npm / `~/bin` 下的 `@deepseek-ai/dsh`）；可手填 node 入口 `…/lib/bin.js`、`.cmd` 包装器或自定义命令 |
| Node.js 路径 | 留空自动检测（Program Files / PATH）。Obsidian 内置 Electron **不是** node，必须用系统 node |
| DSH_HOME 覆盖 | 留空 = `~/.dsh`（凭据在那里）。模型/强度切换由插件自建的 runtime home（`%TEMP%/dsh-obsidian-runtime-home`）承担，不污染真实 home |
| 权限模式 | 聊天栏可切换的默认值：read-only / workspace-write（默认）/ danger-full-access |
| 额外 launcher 参数 | 透传给 dsh，如 `--patch C:/path/extra.yml` 可覆盖 headless profile 的配置 |
| 附加系统提示 | 追加在默认提示之后（默认已含 Obsidian 库约定、wikilink、相对路径等） |
| 超时（秒） | 单次任务上限，默认 600s |
| 上下文开关 | 自动附带当前笔记 / 编辑器选区 / Enter 发送 / 默认显示会话列表 |

## 工作原理

- 每条消息 = 一次 `spawn`：`node <dsh入口> --profile headless <组装好的任务文本>`，cwd = vault 根目录。
- 任务文本 = 系统提示（Obsidian 约定 + 可选附加）+ 最近 20 轮对话记录 + 本轮请求 + 上下文标签。
- 会话文件：`conv-<时间戳>-<随机串>.json`，含 `title / createdAt / lastActivityAt / messages[]`。

## 开发与自测（不需要 Obsidian）

```bash
node scripts/build-plugin.js      # 重新生成单文件 main.js（修改模板/provider 后）
node test/load-test.js            # mock Obsidian 加载测试：模块求值/onload/视图 onOpen
node test/provider-test.js        # provider 链路：目标解析/复杂 argv/vault 读取/取消/参数解析
node test/integration-test.js     # 完整消息流：对话记录 + linked_note + editor_selection 标签
node --check dsh-plugin/main.js   # 语法校验
```

> 在受限 shell 里跑 provider/integration 测试若报 EPERM，是沙箱禁止 Node 捕获子进程管道输出，Obsidian 内不受此限。

## 加载失败排查（如果 Obsidian 提示「加载失败」）

1. **完全退出并重开 Obsidian**（不是关窗口，是退出托盘/进程，或 Ctrl+R 重载）。
2. 打开开发者控制台：`Ctrl+Shift+I` → Console 标签，找到红色报错，把错误文本发给我。
3. 常见原因与对策：
   - 插件目录内相对 require（`require("./xxx.js")`）→ 本版已内联为单文件 main.js，应已解决；
   - 插件是插件启用前拷到一半 → 重新拷贝完整目录后重启；
   - 沙盒/受限模式开启 → 关闭「受限模式」。

## 与 Claudian 的对照

| | Claudian (realclaudian 2.1.3) | 本魔改版 DSH |
|---|---|---|
| agent | Claude / Codex / Grok / OpenCode / Pi 五选多 | **DSH 唯一** |
| 工作目录 | vault 根 | vault 根 |
| 会话数据 | `<vault>/.claudian/sessions/` | `<vault>/.dsh/sessions/` |
| 上下文标签 | `<linked_note>` / `<editor_selection>` 等 | 同左（沿用） |
| 运行方式 | 常驻 CLI 进程（warm agent） | 每消息一次 headless 进程（用完即走） |
| 权限模型 | safeMode / permissionMode | DSH_PERMISSION_MODE（只读 / workspace-write / 完全放行，聊天栏可切换） |
| 模型 / 思考强度 | 各 agent 自带模型选择与 effort | 聊天栏切换模型 + 思考强度（off/high/max），写 runtime home settings.yaml |
| 模型 | 各 agent 自带（本机走 deepseek-v4-flash） | 由 `~/.dsh/settings.yaml` 的 `agent-default-model` 决定 |

## 已知局限（v1）

- 每轮都要冷启动一次 headless（约 2–6 秒：启动 ~0.8s + 模型响应；复杂任务更久），不做流式输出；回复为最终消息。dsh headless 为一次性进程设计（无常驻/管道模式），这是其语义约束。
- headless 模式下需要用户确认的操作（如写 vault 外路径）会失败——属预期，切换权限模式或使用 `--patch` 调整。
- 会话内上下文上限为最近 20 轮，超长对话建议开新会话。
- 暂不支持图片/文件拖入、子代理分发（后续可按需加）。

## 目录结构

```
dsh-obsidian/
├── dsh-plugin/              # 插件本体（拷贝此目录到 .obsidian/plugins/）
│   ├── manifest.json
│   ├── main.js              # 单文件插件（provider 已内联，避免 Obsidian 相对 require 加载失败）
│   ├── main.template.js     # 插件源码模板（含 __INLINE_PROVIDER__ 占位）
│   ├── dsh-provider.js      # provider 源码（可独立测试；构建时内联进 main.js）
│   └── styles.css
├── scripts/
│   └── build-plugin.js      # node scripts/build-plugin.js → 重新生成单文件 main.js
└── test/                    # 自测脚本（node 直接跑）
```

> 改动 `main.template.js` / `dsh-provider.js` 后，重新运行 `node scripts/build-plugin.js` 生成新的 `main.js`，再覆盖到 vault。
