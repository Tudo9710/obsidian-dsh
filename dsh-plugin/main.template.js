/**
 * main.js — DSH（DeepSeek Harness）Obsidian 插件
 *
 * 参考 Claudian（yishentu/claudian / oh-my-claudian）的交互与数据约定，魔改为
 * 「只有一个 agent = DSH」的单代理版：
 *   - 聊天面板：每条消息 spawn `dsh --profile headless <任务>`（vault 为工作目录）
 *   - 会话历史：存于 <vault>/.dsh/sessions/conv-*.json
 *   - 上下文：自动附带当前笔记（<linked_note>）与编辑器选区（<editor_selection>）
 *   - 设置页：dsh 命令 / node 路径 / DSH_HOME / 额外参数（--patch）/ 系统提示 / 超时
 *
 * 纯 CommonJS + 无构建：直接拷入 .obsidian/plugins/dsh 即可。
 */
"use strict";

const { Plugin, PluginSettingTab, ItemView, MarkdownView, MarkdownRenderer, Notice, Setting, setIcon } = require("obsidian");
const path = require("path");
/*__INLINE_PROVIDER__*/

const VIEW_TYPE = "dsh-chat-view";
const DATA_SUBDIR = [".dsh", "sessions"];
const MAX_TRANSCRIPT_TURNS = 20;

const EFFORT_OPTS = [
  { value: "off", label: "关闭" },
  { value: "high", label: "高" },
  { value: "max", label: "最高" },
];
const PERM_OPTS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "读写库内" },
  { value: "danger-full-access", label: "完全放行" },
];

const DEFAULT_SETTINGS = {
  dshCommand: "",        // 留空自动检测；可填 node 入口 / .cmd 路径 / 命令
  nodePath: "",          // 留空自动检测系统 node
  dshHome: "",           // 留空继承（默认 ~/.dsh，含 .credentials.yaml）
  permissionMode: "workspace-write", // read-only / workspace-write / danger-full-access（默认，可在聊天栏切换）
  models: "deepseek-v4-flash, deepseek-v4-pro", // 模型下拉列表（逗号分隔）
  defaultModel: "deepseek-v4-flash",
  defaultEffort: "high", // off / high / max（思考强度，聊天栏可切换）
  extraArgs: "",         // 额外 launcher 参数，如 --patch C:/path/extra.yml
  customPrompt: "",      // 附加系统提示（追加在内置提示之后）
  timeoutSec: 600,
  autoAttachNote: true,
  autoAttachSelection: true,
  enterToSend: true,
  showSessionList: true,
  showThinking: true, // 实时显示思考过程（推理文本 + 工具调用）
};

const BUILTIN_PROMPT = [
  "你是 DSH（DeepSeek Harness），运行在用户的 Obsidian 库中。当前工作目录就是 Obsidian 库根目录。",
  "约定：",
  "- 库内文件均为 Markdown；尊重 YAML frontmatter、[[wikilink]]、#标签 与 dataview 代码块，不主动破坏。",
  "- 回复中提及库内文件时使用 [[wikilink]] 形式（可点击）；展示图片用 ![[文件名.png]]。",
  "- 涉及库内路径一律用相对库根的相对路径，不要使用盘符绝对路径。",
  "- 用户消息 = 查询在前，其后可能跟随 XML 上下文标签：<linked_note path=\"...\"/>、<editor_selection path=\"...\" lines=\"a-b\"> 等；标签内文本是用户原文，按字面理解。",
  "- 涉及文件操作前先读取相关文件；不确定的事实与数字须说明来源或标注缺口，禁止编造。",
  "- 默认使用中文回复，输出紧凑、可直接执行。",
  "- \"对话记录\" 中的历史轮次供你维持上下文，不要重复提问已确认的信息。",
].join("\n");

function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}

/* ============================ 插件主体 ============================ */

class DSHPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.installErrorLog();

    this.registerView(VIEW_TYPE, (leaf) => new DSHChatView(leaf, this));

    this.addRibbonIcon("bot", "打开 DSH 聊天", () => this.activateView());
    this.addCommand({
      id: "open-dsh-chat",
      name: "打开 DSH 聊天",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "new-dsh-session",
      name: "新建 DSH 会话",
      callback: () => {
        const view = this.getChatView();
        if (view) view.newSession();
        else this.activateView();
      },
    });

    this.addSettingTab(new DSHSettingsTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* ---------- 错误日志（排查卡死/异常用，写到插件目录 error.log） ---------- */

  pluginDir() {
    try {
      if (this.manifest && this.manifest.dir) return this.manifest.dir;
      const base = this.vaultBasePath();
      if (base) return path.join(base, ".obsidian", "plugins", this.manifest && this.manifest.id || "dsh");
    } catch (e) { /* ignore */ }
    return "";
  }

  logError(tag, err) {
    try {
      const fs = require("fs");
      const dir = this.pluginDir();
      if (!dir) return;
      fs.mkdirSync(dir, { recursive: true });
      const line = "[" + new Date().toISOString() + "] " + tag + ": " + String((err && (err.stack || err.message)) || err) + "\n";
      fs.appendFileSync(path.join(dir, "error.log"), line);
    } catch (e) { /* ignore */ }
  }

  installErrorLog() {
    if (typeof process !== "undefined" && process.on) {
      process.on("unhandledRejection", (e) => this.logError("unhandledRejection", e));
      process.on("uncaughtException", (e) => this.logError("uncaughtException", e));
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("error", (e) => this.logError("window.error", (e && e.error) || (e && e.message)));
    }
  }

  /** saveData 的防挂起包装：3 秒写不进就放弃等待（设置仍在内存生效） */
  async saveSettings() {
    await Promise.race([
      this.saveData(this.settings),
      new Promise((res) => setTimeout(res, 3000)),
    ]);
  }

  getChatView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  vaultBasePath() {
    try {
      const adapter = this.app.vault.adapter;
      if (adapter && typeof adapter.getBasePath === "function") return adapter.getBasePath();
      if (adapter && adapter.basePath) return adapter.basePath;
    } catch (e) { /* ignore */ }
    return this.app.vault.getRoot ? "/" : process.cwd();
  }

  /* ---------- Runtime home（模型/思考强度切换） ---------- */

  baseDshHome() {
    return (this.settings.dshHome && this.settings.dshHome.trim())
      ? this.settings.dshHome.trim()
      : path.join(require("os").homedir(), ".dsh");
  }

  runtimeHomePath() {
    return path.join(require("os").tmpdir(), "dsh-obsidian-runtime-home");
  }

  /**
   * 确保 runtime home 存在（凭据 + settings 基底），并按所选模型/思考强度
   * 重写 settings.yaml 的 agent-default-model 段。返回 { ok, home, error? }。
   */
  async applyAgentSelection(model, effort) {
    const res = provider.prepareRuntimeHome({
      baseHome: this.baseDshHome(),
      runtimeHome: this.runtimeHomePath(),
      selection: { provider: "deepseek-official", model, reasoningEffort: effort },
    });
    return res;
  }

  /** 扫描本机 dsh 配置（模型目录 + 默认模型/思考强度 + 凭据状态） */
  scanMachine() {
    return provider.scanModels({ baseHome: this.baseDshHome() });
  }

  /**
   * 扫描并把结果写入设置（模型列表 / 默认模型 / 默认思考强度）。
   * 同时刷新已打开的聊天视图的模型下拉。返回 scan 结果。
   */
  async scanAndApplyModels() {
    const scan = this.scanMachine();
    if (scan.ok) {
      this.settings.models = scan.models.map((m) => m.id).join(", ");
      this.settings.defaultModel = scan.defaultModel || this.settings.defaultModel;
      this.settings.defaultEffort = scan.defaultEffort || this.settings.defaultEffort;
      await this.saveSettings();
      // 刷新打开的聊天视图模型下拉（保留当前选择）
      const view = this.getChatView();
      if (view && view.refreshModelOptions) view.refreshModelOptions();
    }
    return scan;
  }

  /**
   * 一键自动配置：检测 dsh 入口 / node / 凭据，扫描模型并写入设置（模型列表 /
   * 默认模型 / 默认思考强度）。不跑模型调用，秒级完成。
   * @param {(step:{phase:string,text:string})=>void} [onStep] 分步进度回调
   */
  async autoConfigure(onStep) {
    const step = (phase, text) => { if (typeof onStep === "function") onStep({ phase, text }); };

    step("detect", "检测 dsh 入口与 node…");
    const t = provider.describeTarget(this.settings.dshCommand, this.settings.nodePath);

    step("scan", "扫描模型并写入默认值…");
    const scan = await this.scanAndApplyModels();

    return {
      dshFound: t.found,
      dshLine: t.line,
      credentialOk: scan.credentialOk,
      source: scan.source,
      models: scan.models,
      defaultModel: scan.defaultModel,
      defaultEffort: scan.defaultEffort,
      baseHome: scan.baseHome,
      error: scan.error || null,
    };
  }

  /* ---------- 会话存储（<vault>/.dsh/sessions/） ---------- */

  sessionsDir() {
    const path = require("path");
    return path.join(this.vaultBasePath(), ...DATA_SUBDIR);
  }

  async saveSession(session) {
    const fs = require("fs");
    const path = require("path");
    const dir = this.sessionsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    session.lastActivityAt = Date.now();
    await fs.promises.writeFile(
      path.join(dir, session.id + ".json"),
      JSON.stringify(session, null, 2),
      "utf8"
    );
  }

  async listSessions() {
    const fs = require("fs");
    const path = require("path");
    const dir = this.sessionsDir();
    const out = [];
    try {
      const names = await fs.promises.readdir(dir);
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        try {
          const s = JSON.parse(await fs.promises.readFile(path.join(dir, n), "utf8"));
          if (s && s.id && Array.isArray(s.messages)) out.push(s);
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    out.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    return out;
  }

  async deleteSession(id) {
    const fs = require("fs");
    const path = require("path");
    try { await fs.promises.unlink(path.join(this.sessionsDir(), id + ".json")); } catch (e) { /* ignore */ }
  }

  newSessionRecord(query) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let r = "";
    for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
    const now = Date.now();
    return {
      id: "conv-" + now + "-" + r,
      title: truncate(query, 30) || "新会话",
      createdAt: now,
      lastActivityAt: now,
      messages: [],
    };
  }

  /* ---------- 任务文本组装（参考 Claudian 的上下文标签格式） ---------- */

  buildTaskText(session, query, ctx) {
    const parts = [];
    parts.push(this.settings.customPrompt
      ? BUILTIN_PROMPT + "\n\n" + this.settings.customPrompt.trim()
      : BUILTIN_PROMPT);

    const prev = (session.messages || []).slice(-MAX_TRANSCRIPT_TURNS * 2);
    if (prev.length > 0) {
      const lines = prev.map((m) => (m.role === "user" ? "用户：" : m.role === "assistant" ? "DSH：" : "错误：") + String(m.content).replace(/\n/g, "\n  "));
      parts.push("## 对话记录\n" + lines.join("\n"));
    }

    parts.push("## 本轮请求\n" + query);
    if (ctx && ctx.blocks) parts.push(ctx.blocks);
    return parts.join("\n\n");
  }
}

/* ============================ 聊天视图 ============================ */

class DSHChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.session = null;
    this.running = false;
    this.disposed = false;
    this.sessionsOpen = !!plugin.settings.showSessionList;
    this.cancelToken = null;
    this.statusTimer = null;
    this.statusStart = 0;
    this.live = null;
    this._pendingThinking = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.session && this.session.title ? "DSH · " + this.session.title : "DSH"; }
  getIcon() { return "bot"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("dsh-view");

    /* 头部 */
    this.headerEl = root.createDiv({ cls: "dsh-header" });
    this.titleEl = this.headerEl.createDiv({ cls: "dsh-header-title", text: "DSH" });
    const actions = this.headerEl.createDiv({ cls: "dsh-header-actions" });
    this.sessionsToggleBtn = actions.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "会话列表", title: "会话列表" } });
    setIcon(this.sessionsToggleBtn, "list");
    this.sessionsToggleBtn.addEventListener("click", () => { this.sessionsOpen = !this.sessionsOpen; this.renderSessionPanel(); });
    this.newBtn = actions.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "新会话", title: "新会话" } });
    setIcon(this.newBtn, "plus");
    this.newBtn.addEventListener("click", () => this.newSession());

    /* 会话列表（可折叠） */
    this.sessionsPanel = root.createDiv({ cls: "dsh-sessions-panel dsh-hidden" });
    this.sessionsListEl = this.sessionsPanel.createDiv({ cls: "dsh-sessions-list" });

    /* 消息区 */
    this.messagesEl = root.createDiv({ cls: "dsh-messages" });

    /* 状态条 */
    this.statusEl = root.createDiv({ cls: "dsh-status dsh-hidden" });

    /* 输入区：选择器（模型/强度/权限）与发送同一排 */
    const inputWrap = root.createDiv({ cls: "dsh-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", { cls: "dsh-input", attr: { placeholder: "给 DSH 下达任务…（Enter 发送，Shift+Enter 换行）", rows: "3" } });
    const toolbar = inputWrap.createDiv({ cls: "dsh-input-toolbar" });
    const selects = toolbar.createDiv({ cls: "dsh-toolbar-selects" });
    this.modelSel = this.makeSelect(selects, this.modelOptions(), this.currentModel(), "模型");
    this.effortSel = this.makeSelect(selects, EFFORT_OPTS, this.currentEffort(), "强度");
    this.permSel = this.makeSelect(selects, PERM_OPTS, this.currentPerm(), "权限");
    this.sendBtn = toolbar.createEl("button", { cls: "dsh-send-btn", text: "发送" });
    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // 中文输入法组词中的 Enter 不触发发送
      if (e.key === "Enter" && !e.shiftKey && this.plugin.settings.enterToSend) {
        e.preventDefault();
        this.send();
      }
    });

    this.syncSelectionRow();
    this.renderSessionPanel();
    this.renderMessages();
    this.updateHeader();
  }

  onClose() {
    this.disposed = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (this.cancelToken && this.cancelToken.cancel) {
      this.cancelToken.cancelled = true;
      this.cancelToken.cancel();
    }
  }

  /* ---------- 选择器（模型/强度/权限） ---------- */

  modelOptions() {
    const raw = String(this.plugin.settings.models || "deepseek-v4-flash").split(",");
    const list = [];
    for (const m of raw) {
      const v = m.trim();
      if (v) list.push({ value: v, label: v });
    }
    return list;
  }

  currentModel() {
    if (this.session && this.session.model) return this.session.model;
    return this.plugin.settings.defaultModel || "deepseek-v4-flash";
  }
  currentEffort() {
    if (this.session && this.session.effort) return this.session.effort;
    return this.plugin.settings.defaultEffort || "high";
  }
  currentPerm() {
    if (this.session && this.session.permission) return this.session.permission;
    return this.plugin.settings.permissionMode || "workspace-write";
  }

  makeSelect(container, opts, value, label) {
    const wrap = container.createDiv({ cls: "dsh-select-wrap" });
    const lab = wrap.createSpan({ cls: "dsh-select-label", text: label });
    lab.setAttribute("title", label);
    const sel = wrap.createEl("select", { cls: "dsh-select" });
    for (const o of opts) {
      const opt = sel.createEl("option", { text: o.label, value: o.value });
      if (o.value === value) opt.selected = true;
    }
    return sel;
  }

  syncSelectionRow() {
    if (!this.modelSel) return;
    this.modelSel.value = this.currentModel();
    this.effortSel.value = this.currentEffort();
    this.permSel.value = this.currentPerm();
  }

  /** 扫描模型后刷新模型下拉（保留当前选择） */
  refreshModelOptions() {
    if (!this.modelSel || !this.modelSel.parentElement) return;
    const keep = this.modelSel.value || this.currentModel();
    const opts = this.modelOptions();
    while (this.modelSel.firstChild) this.modelSel.removeChild(this.modelSel.firstChild);
    for (const o of opts) {
      const opt = this.modelSel.createEl("option", { text: o.label, value: o.value });
      if (o.value === keep) opt.selected = true;
    }
  }

  selectionSnapshot() {
    return {
      model: this.modelSel ? this.modelSel.value : this.currentModel(),
      effort: this.effortSel ? this.effortSel.value : this.currentEffort(),
      permission: this.permSel ? this.permSel.value : this.currentPerm(),
    };
  }

  /* ---------- 会话面板 ---------- */

  renderSessionPanel() {
    this.sessionsPanel.toggleClass("dsh-hidden", !this.sessionsOpen);
    if (!this.sessionsOpen) return;
    this.renderSessionList();
  }

  async renderSessionList() {
    this.sessionsListEl.empty();
    const sessions = await this.plugin.listSessions();
    if (sessions.length === 0) {
      this.sessionsListEl.createDiv({ cls: "dsh-sessions-empty", text: "暂无会话" });
      return;
    }
    for (const s of sessions.slice(0, 100)) {
      const item = this.sessionsListEl.createDiv({ cls: "dsh-session-item" + (this.session && this.session.id === s.id ? " is-active" : "") });
      const main = item.createDiv({ cls: "dsh-session-main" });
      main.createDiv({ cls: "dsh-session-title", text: s.title || "未命名" });
      main.createDiv({ cls: "dsh-session-time", text: fmtTime(s.lastActivityAt) });
      item.addEventListener("click", (e) => {
        if (e.target.closest(".dsh-session-del")) return;
        this.loadSession(s);
      });
      const del = item.createEl("button", { cls: "dsh-icon-btn dsh-session-del", attr: { "aria-label": "删除", title: "删除会话" } });
      setIcon(del, "trash");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.deleteSession(s.id);
        if (this.session && this.session.id === s.id) this.newSession();
        this.renderSessionList();
      });
    }
  }

  async loadSession(s) {
    this.session = s;
    this.renderMessages();
    this.updateHeader();
    this.syncSelectionRow();
    this.renderSessionList();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  newSession() {
    if (this.running) return;
    this.session = null;
    this.renderMessages();
    this.updateHeader();
    this.syncSelectionRow();
    this.renderSessionList();
  }

  /* ---------- 消息渲染 ---------- */

  renderMessageEl(m) {
    const wrap = this.messagesEl.createDiv({ cls: "dsh-message dsh-message-" + (m.role === "user" ? "user" : m.role === "error" ? "error" : "assistant") });
    const head = wrap.createDiv({ cls: "dsh-message-head" });
    head.createSpan({ cls: "dsh-message-role", text: m.role === "user" ? "我" : m.role === "error" ? "错误" : "DSH" });
    head.createSpan({ cls: "dsh-message-time", text: fmtTime(m.ts) });
    const body = wrap.createDiv({ cls: "dsh-message-body" });
    if (m.role === "user") {
      body.createDiv({ text: m.content || "" });
    } else if (m.role === "error") {
      const pre = body.createEl("pre", { cls: "dsh-error-pre" });
      pre.setText(m.content || "未知错误");
    } else {
      const content = (m.content || "").trim();
      if (!content) {
        body.createDiv({ cls: "dsh-empty-reply", text: "（空回复）" });
      } else {
        MarkdownRenderer.renderMarkdown(content, body, "", this);
      }
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return wrap;
  }

  /** 渲染折叠的思考面板（用于 assistant 消息上方；确定性重建，不依赖 DOM 存活） */
  renderThinkingPanel(thinking) {
    const hasContent = thinking && (thinking.reasoning || (thinking.tools && thinking.tools.length > 0));
    if (!hasContent) return null;
    const panel = this.messagesEl.createDiv({ cls: "dsh-thinking-summary" });
    const head = panel.createDiv({ cls: "dsh-thinking-head" });
    head.createSpan({ cls: "dsh-thinking-emoji", text: "🧠" });
    head.createSpan({ cls: "dsh-thinking-time", text: "思考过程 · " + thinking.seconds + "s · " + (thinking.tools ? thinking.tools.length : 0) + " 步工具" });
    const body = panel.createDiv({ cls: "dsh-thinking-body dsh-hidden" });
    if (thinking.reasoning) body.createDiv({ cls: "dsh-thinking-reason", text: thinking.reasoning });
    if (thinking.tools && thinking.tools.length > 0) {
      const t = body.createDiv({ cls: "dsh-thinking-tools" });
      for (const line of thinking.tools) t.createDiv({ cls: "dsh-thinking-tool", text: line });
    }
    head.addEventListener("click", () => {
      const hidden = body.classList.contains("dsh-hidden");
      if (hidden) body.classList.remove("dsh-hidden");
      else body.classList.add("dsh-hidden");
    });
    return panel;
  }

  renderMessages() {
    this.messagesEl.empty();
    const messages = this.session ? this.session.messages : [];
    if (messages.length === 0) {
      const g = this.messagesEl.createDiv({ cls: "dsh-greeting" });
      g.createDiv({ cls: "dsh-greeting-title", text: "我是 DSH（DeepSeek Harness）" });
      g.createEl("ul").innerHTML = [
        "<li>直接下达任务：我会在 vault 根目录里读取文件、检索资料并回答</li>",
        "<li>会自动附带当前笔记与编辑器选区作为上下文</li>",
        "<li>历史会话保存在 <code>.dsh/sessions/</code>，可随时切换</li>",
      ].join("");
      return;
    }
    for (const m of messages) {
      // assistant/error 消息携带思考记录时，先渲染折叠面板
      if ((m.role === "assistant" || m.role === "error") && m.thinking) {
        this.renderThinkingPanel(m.thinking);
      }
      this.renderMessageEl(m);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /* ---------- 发送 ---------- */

  async getContextBlocks() {
    const out = { blocks: "", notePath: null, selectionText: null };
    const s = this.plugin.settings;
    const file = this.app.workspace.getActiveFile();
    let notePath = null;
    let selection = null;
    if (s.autoAttachNote && file) notePath = file.path;
    if (s.autoAttachSelection) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.editor) {
        const selText = view.editor.getSelection();
        if (selText) {
          const sels = view.editor.listSelections();
          const a = sels[0] ? sels[0].anchor : null;
          const h = sels[0] ? sels[0].head : null;
          const from = a ? Math.min(a.line, h ? h.line : a.line) : 0;
          const to = h ? Math.max(a.line, h.line) : from;
          selection = {
            path: file ? file.path : "",
            fromLine: from + 1,
            toLine: to + 1,
            text: selText,
          };
        }
      }
    }
    const parts = [];
    if (notePath) parts.push('<linked_note path="' + notePath + '" />');
    if (selection) {
      parts.push(
        '<editor_selection path="' + selection.path + '" lines="' + selection.fromLine + "-" + selection.toLine + '">\n<![CDATA[\n' +
        selection.text + "\n]]>\n</editor_selection>"
      );
    }
    out.blocks = parts.join("\n\n");
    out.notePath = notePath;
    out.selectionText = selection ? selection.text : null;
    return out;
  }

  async send() {
    if (this.running || this.disposed) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    this.running = true;
    this.updateRunningUI(true);

    try {
      if (!this.session) {
        this.session = this.plugin.newSessionRecord(query);
      }
      const sel = this.selectionSnapshot();
      this.session.model = sel.model;
      this.session.effort = sel.effort;
      this.session.permission = sel.permission;
      this.session.lastActivityAt = Date.now();

      // 按所选模型/思考强度准备 runtime home（每次启动重读 settings.yaml）
      const homeRes = await this.plugin.applyAgentSelection(sel.model, sel.effort);
      if (!homeRes.ok) {
        this.session.messages.push({
          role: "error",
          content: "无法准备 DSH runtime home：" + (homeRes.error || "未知错误"),
          ts: Date.now(),
        });
        await this.plugin.saveSession(this.session);
        this.renderMessages();
        this.updateHeader();
        return;
      }

      const ctx = await this.getContextBlocks();
      const taskText = this.plugin.buildTaskText(this.session, query, ctx);

      this.session.messages.push({ role: "user", content: query, ts: Date.now(), notePath: ctx.notePath || undefined, selection: ctx.selectionText || undefined });
      this.inputEl.value = "";
      this.renderMessages();
      this.updateHeader();

      this.cancelToken = { cancelled: false };
      this.statusStart = Date.now();
      this.startThinking(sel);
      if (!this.live) {
        this.statusEl.setText("DSH 思考中… [" + sel.model + (sel.effort !== "high" ? " / " + sel.effort : "") + "]");
        this.startStatusTimer();
      }

      const res = await provider.runHeadless({
        cwd: this.plugin.vaultBasePath(),
        task: taskText,
        dshCommand: this.plugin.settings.dshCommand,
        nodePath: this.plugin.settings.nodePath,
        dshHome: homeRes.home,
        permissionMode: sel.permission,
        extraArgs: this.plugin.settings.extraArgs,
        timeoutMs: (this.plugin.settings.timeoutSec || 600) * 1000,
        cancelToken: this.cancelToken,
        live: this.live,
        onEvent: (ev) => this.handleLiveEvent(ev),
      });

      if (this.disposed) return;

      if (this.live) this.finishThinking();

      const thinking = this._pendingThinking || null;
      this._pendingThinking = null;
      if (res.ok) {
        const answer = (res.stdout || "").trim();
        this.session.messages.push({ role: "assistant", content: answer, ts: Date.now(), thinking });
      } else {
        const detail = (res.stderr || "").trim() || "未知错误";
        this.session.messages.push({
          role: "error",
          content: detail + "\n\n（若为启动失败：请到 设置 → DSH → 测试连接 检查 dsh 安装；若为凭据缺失：请确认 DSH_HOME 下存在 .credentials.yaml）",
          ts: Date.now(),
          thinking,
        });
      }
      this.session.lastActivityAt = Date.now();
      await this.plugin.saveSession(this.session);
      this.renderMessages();
      this.updateHeader();
      if (this.sessionsOpen) this.renderSessionList();
    } finally {
      this.running = false;
      this.updateRunningUI(false);
    }
  }

  updateRunningUI(running) {
    this.inputEl.disabled = running;
    this.sendBtn.disabled = running;
    this.sendBtn.setText(running ? "思考中…" : "发送");
    if (!running) {
      this.stopStatusTimer();
      this.statusEl.addClass("dsh-hidden");
      this.statusEl.setText("");
    }
  }

  startStatusTimer() {
    this.stopStatusTimer();
    this.statusEl.removeClass("dsh-hidden");
    this.statusTimer = setInterval(() => {
      if (this.disposed) return;
      const sec = Math.round((Date.now() - this.statusStart) / 1000);
      this.statusEl.setText("DSH 思考中… " + sec + "s（超时 " + (this.plugin.settings.timeoutSec || 600) + "s）");
    }, 1000);
  }

  stopStatusTimer() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  /* ---------- 思考过程（实时推理 + 工具调用 + 文本流） ---------- */

  startThinking(sel) {
    this.live = this.plugin.settings.showThinking ? { reasoning: "", tools: [], text: "", collapsed: false, steps: 0 } : null;
    this._pendingThinking = null;
    if (!this.live) return;
    const wrap = this.messagesEl.createDiv({ cls: "dsh-live" });
    const head = wrap.createDiv({ cls: "dsh-thinking-head", attr: { title: "点击展开/收起" } });
    head.createSpan({ cls: "dsh-thinking-emoji", text: "🧠" });
    this.thinkingTimeEl = head.createSpan({ cls: "dsh-thinking-time", text: "思考过程 · 0s" });
    this.liveHead = head;
    const body = wrap.createDiv({ cls: "dsh-thinking-body" });
    this.thinkingReasonEl = body.createDiv({ cls: "dsh-thinking-reason" });
    this.thinkingToolsEl = body.createDiv({ cls: "dsh-thinking-tools" });
    this.liveBody = body;
    this.liveWrap = wrap;
    head.addEventListener("click", () => {
      if (!this.liveBody) return;
      if (this.liveBody.classList.contains("dsh-hidden")) this.liveBody.classList.remove("dsh-hidden");
      else this.liveBody.classList.add("dsh-hidden");
    });
    // 计时
    this.stopStatusTimer();
    this.statusTimer = setInterval(() => {
      if (this.disposed || !this.live) return;
      const sec = Math.round((Date.now() - this.statusStart) / 1000);
      this.thinkingTimeEl.setText("思考过程 · " + sec + "s");
    }, 1000);
  }

  handleLiveEvent(ev) {
    if (!this.live || this.disposed) return;
    try {
      const d = ev.data || {};
      if (ev.type === "reasoning-chunks" && Array.isArray(d.texts)) {
        this.live.reasoning += d.texts.join("");
        if (this.thinkingReasonEl) this.thinkingReasonEl.setText(this.live.reasoning.trimEnd());
        this.live.steps += 1;
      } else if (ev.type === "tool-call-chunks" && d.name) {
        const args = (Array.isArray(d.args) ? d.args.join("") : String(d.args || "")).replace(/\s+/g, " ").slice(0, 90);
        this.live.tools.push("⚙ " + d.name + (args ? "  " + args : ""));
        if (this.thinkingToolsEl) {
          const line = this.thinkingToolsEl.createDiv({ cls: "dsh-thinking-tool", text: this.live.tools[this.live.tools.length - 1] });
          line.setAttribute("title", this.live.tools[this.live.tools.length - 1]);
        }
        this.live.steps += 1;
      } else if (ev.type === "tool/call" && d.name) {
        // 去重（tool-call-chunks 已展示过同一 id 时不重复）
        if (this.live.tools.some((t) => t.indexOf(d.name) >= 0)) return;
        const args = String(d.arguments || "").replace(/\s+/g, " ").slice(0, 90);
        this.live.tools.push("⚙ " + d.name + (args ? "  " + args : ""));
        if (this.thinkingToolsEl) {
          const line = this.thinkingToolsEl.createDiv({ cls: "dsh-thinking-tool", text: this.live.tools[this.live.tools.length - 1] });
          line.setAttribute("title", this.live.tools[this.live.tools.length - 1]);
        }
        this.live.steps += 1;
      } else if (ev.type === "text-chunks" && Array.isArray(d.texts)) {
        this.live.text += d.texts.join("");
      }
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } catch (e) { /* ignore */ }
  }

  finishThinking() {
    if (!this.live) return;
    const sec = Math.round((Date.now() - this.statusStart) / 1000);
    // 思考内容存入会话消息（renderMessages 时确定性重建折叠面板，不可能消失）
    this._pendingThinking = {
      reasoning: this.live.reasoning.trim().slice(0, 6000),
      tools: this.live.tools.slice(0, 40),
      seconds: sec,
    };
    // 折叠运行中的实时面板
    try {
      if (this.liveBody) this.liveBody.addClass("dsh-hidden");
      if (this.thinkingTimeEl) this.thinkingTimeEl.setText("思考过程 · " + sec + "s · " + this.live.tools.length + " 步工具（点击展开）");
    } catch (e) { /* ignore */ }
    this.live = null;
  }

  updateHeader() {
    const t = this.session ? this.session.title : "新会话";
    this.titleEl.setText("DSH · " + t);
  }
}

/* ============================ 设置页 ============================ */

class DSHSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DSH 设置" });
    containerEl.createEl("p", { cls: "dsh-settings-desc", text: "DSH（DeepSeek Harness）是唯一接入的 agent。每条消息以 vault 为工作目录运行 dsh --profile headless，会话记录保存在 <vault>/.dsh/sessions/。" });

    /* ---------- 模型与默认值（参考原版 codex 面板：Discover 异步加载目录） ---------- */
    new Setting(containerEl).setName("模型与默认值").setHeading();

    new Setting(containerEl)
      .setName("模型列表")
      .setDesc("聊天栏「模型」下拉候选项。点「发现模型」从本机 dsh 配置读取（settings.yaml 的 llm-deepseek.models，缺省为 V4 Flash + V4 Pro）。")
      .addText((t) => {
        this._modelsInput = t;
        t.setPlaceholder("deepseek-v4-flash, deepseek-v4-pro").setValue(this.plugin.settings.models).onChange(async (v) => {
          this.plugin.settings.models = v;
          await this.plugin.saveSettings();
        });
      })
      .addButton((b) => b.setButtonText("发现模型").onClick(() => this.discoverModels(b)));

    this.discoverStatusEl = containerEl.createDiv({ cls: "dsh-discover-status dsh-hidden" });

    new Setting(containerEl)
      .setName("默认模型")
      .setDesc("新会话使用的模型（provider 固定为 deepseek-official）。")
      .addDropdown((dd) => {
        this._defaultModelDd = dd;
        const ids = String(this.plugin.settings.models || "deepseek-v4-flash").split(",").map((s) => s.trim()).filter(Boolean);
        const cur = this.plugin.settings.defaultModel || "deepseek-v4-flash";
        if (!ids.includes(cur)) ids.unshift(cur);
        for (const id of ids) dd.addOption(id, id);
        dd.setValue(cur).onChange(async (v) => {
          this.plugin.settings.defaultModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认思考强度")
      .setDesc("off = 关闭思考 / high = 高（默认）/ max = 最高。聊天栏可随时切换。")
      .addDropdown((dd) => dd
        .addOption("off", "off（关闭）")
        .addOption("high", "high（高，默认）")
        .addOption("max", "max（最高）")
        .setValue(this.plugin.settings.defaultEffort || "high")
        .onChange(async (v) => {
          this.plugin.settings.defaultEffort = v;
          await this.plugin.saveSettings();
        }));

    /* ---------- 运行 ---------- */
    new Setting(containerEl).setName("运行").setHeading();

    new Setting(containerEl)
      .setName("dsh 命令 / 入口")
      .setDesc("留空自动检测（npx 缓存 / 全局 npm / ~/bin 下的 @deepseek-ai/dsh）。可填 node 入口（…/lib/bin.js）、.cmd 包装器或自定义命令。")
      .addText((t) => t.setPlaceholder("自动检测").setValue(this.plugin.settings.dshCommand).onChange(async (v) => {
        this.plugin.settings.dshCommand = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Node.js 路径")
      .setDesc("留空自动检测（Program Files / PATH）。Obsidian 内置的 Electron 不是 node，这里需要系统 node。")
      .addText((t) => t.setPlaceholder("自动检测").setValue(this.plugin.settings.nodePath).onChange(async (v) => {
        this.plugin.settings.nodePath = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("DSH_HOME 覆盖")
      .setDesc("留空继承默认（~/.dsh，凭据 .credentials.yaml 在那里）。一般不需要改。")
      .addText((t) => t.setPlaceholder("留空 = ~/.dsh").setValue(this.plugin.settings.dshHome).onChange(async (v) => {
        this.plugin.settings.dshHome = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("审批权限")
      .setDesc("对应 dsh 的 DSH_PERMISSION_MODE：read-only 只读；workspace-write 可读写 vault（默认）；danger-full-access 完全放行（谨慎）。")
      .addDropdown((dd) => dd
        .addOption("read-only", "read-only（只读）")
        .addOption("workspace-write", "workspace-write（读写 vault，默认）")
        .addOption("danger-full-access", "danger-full-access（完全放行）")
        .setValue(this.plugin.settings.permissionMode)
        .onChange(async (v) => {
          this.plugin.settings.permissionMode = v;
          await this.plugin.saveSettings();
        }));

    /* ---------- 高级 ---------- */
    new Setting(containerEl).setName("高级").setHeading();

    new Setting(containerEl)
      .setName("额外 launcher 参数")
      .setDesc("透传给 dsh 的额外参数，例如 --patch C:/path/extra.yml（覆盖 headless profile 的权限/配置）。支持引号。")
      .addText((t) => t.setPlaceholder("如 --patch C:/path/extra.yml").setValue(this.plugin.settings.extraArgs).onChange(async (v) => {
        this.plugin.settings.extraArgs = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("超时（秒）")
      .setDesc("单次任务最长等待时间，超时自动终止。")
      .addText((t) => t.setValue(String(this.plugin.settings.timeoutSec)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) {
          this.plugin.settings.timeoutSec = n;
          await this.plugin.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName("附加系统提示")
      .setDesc("追加在默认系统提示之后（默认已包含 Obsidian 库约定、wikilink、相对路径等）。")
      .addTextArea((t) => t.setPlaceholder("例如：你是我的工作助理，先读 AGENTS.md 再干活。").setValue(this.plugin.settings.customPrompt).onChange(async (v) => {
        this.plugin.settings.customPrompt = v;
        await this.plugin.saveSettings();
      }));

    /* ---------- 界面 ---------- */
    new Setting(containerEl).setName("界面").setHeading();

    new Setting(containerEl)
      .setName("自动附带当前笔记")
      .setDesc("发送时把当前打开的笔记以 <linked_note> 附加给 DSH。")
      .addToggle((t) => t.setValue(this.plugin.settings.autoAttachNote).onChange(async (v) => {
        this.plugin.settings.autoAttachNote = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("自动附带编辑器选区")
      .setDesc("发送时把当前选中文本以 <editor_selection> 附加给 DSH。")
      .addToggle((t) => t.setValue(this.plugin.settings.autoAttachSelection).onChange(async (v) => {
        this.plugin.settings.autoAttachSelection = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Enter 发送")
      .setDesc("Enter 发送消息，Shift+Enter 换行。关闭后 Enter 换行、Ctrl+Enter 发送。")
      .addToggle((t) => t.setValue(this.plugin.settings.enterToSend).onChange(async (v) => {
        this.plugin.settings.enterToSend = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("默认显示会话列表")
      .setDesc("打开聊天面板时展开会话列表（也可用头部按钮随时切换）。")
      .addToggle((t) => t.setValue(this.plugin.settings.showSessionList).onChange(async (v) => {
        this.plugin.settings.showSessionList = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("显示思考过程")
      .setDesc("回答过程中实时显示推理文本与工具调用（会话明文 JSONL 流式读取）。关闭后恢复为底部「DSH 思考中…」提示。")
      .addToggle((t) => t.setValue(this.plugin.settings.showThinking !== false).onChange(async (v) => {
        this.plugin.settings.showThinking = v;
        await this.plugin.saveSettings();
      }));

    this.maybeAutoDiscover();
  }

  /* ---------- 发现模型（原版 Discover 模式：异步加载目录 + 状态反馈 + 10s 超时） ---------- */

  async discoverModels(btn) {
    const setStatus = (text, cls) => {
      try {
        if (!this.discoverStatusEl) return;
        this.discoverStatusEl.setText(text || "");
        if (text) this.discoverStatusEl.removeClass("dsh-hidden");
        else this.discoverStatusEl.addClass("dsh-hidden");
        if (cls) {
          this.discoverStatusEl.removeClass("dsh-ac-ok dsh-ac-bad dsh-ac-warn");
          this.discoverStatusEl.addClass(cls);
        }
      } catch (e) { /* ignore */ }
    };
    try { if (btn) { btn.setDisabled(true); btn.setButtonText("发现中…"); } } catch (e) { /* ignore */ }
    setStatus("⏳ 正在扫描本机 dsh 模型目录…", "dsh-ac-warn");
    try {
      const r = await Promise.race([
        this.plugin.scanAndApplyModels(),
        new Promise((res) => setTimeout(() => res({ __timeout: true }), 10000)),
      ]);
      if (r && r.__timeout) {
        setStatus("✗ 扫描超时（10 秒）——请稍后重试", "dsh-ac-bad");
        new Notice("扫描超时", 5000);
        return;
      }
      if (r && r.ok) {
        // 就地刷新模型输入框与默认模型下拉，不重建整个设置页
        try {
          if (this._modelsInput) this._modelsInput.setValue(r.models.map((m) => m.id).join(", "));
          if (this._defaultModelDd) {
            this._defaultModelDd.selectEl.empty();
            const ids = r.models.map((m) => m.id);
            const cur = this.plugin.settings.defaultModel || r.defaultModel || "deepseek-v4-flash";
            if (!ids.includes(cur)) ids.unshift(cur);
            for (const id of ids) this._defaultModelDd.addOption(id, id);
            this._defaultModelDd.setValue(cur);
          }
        } catch (e) { this.plugin.logError("discover-refresh", e); }
        setStatus("✓ 发现 " + r.models.length + " 个模型：" + r.models.map((m) => m.name).join("、") + "（默认 " + this.plugin.settings.defaultModel + "）", "dsh-ac-ok");
        new Notice("✅ 已发现 " + r.models.length + " 个模型", 4000);
      } else {
        setStatus("✗ 扫描失败：" + ((r && r.error) || "未知错误"), "dsh-ac-bad");
      }
    } catch (e) {
      this.plugin.logError("discover", e);
      setStatus("✗ 扫描异常：" + String((e && e.message) || e), "dsh-ac-bad");
    } finally {
      try { if (btn) { btn.setDisabled(false); btn.setButtonText("发现模型"); } } catch (e) { /* ignore */ }
    }
  }

  /* 首次打开设置页且模型列表为空时，自动异步发现一次（loadCatalogOnRender 模式） */
  maybeAutoDiscover() {
    if (!String(this.plugin.settings.models || "").trim()) {
      setTimeout(() => this.discoverModels(null), 300);
    }
  }
}

module.exports = DSHPlugin;
