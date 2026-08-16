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

const { Plugin, PluginSettingTab, ItemView, MarkdownView, MarkdownRenderer, Notice, Setting, setIcon, TFolder, TFile } = require("obsidian");
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
    this.disposed = false;
    this.sessionsOpen = !!plugin.settings.showSessionList;
    this.sessionCache = new Map(); // id -> session（保证多会话/切换时对象一致）
    this.runs = new Map();         // id -> runState（每个会话独立的运行状态）
  }

  /* ---------- 多会话运行状态 ---------- */

  getRun(sessionId) {
    if (!this.runs.has(sessionId)) {
      this.runs.set(sessionId, {
        running: false,
        cancelToken: null,
        live: null,
        pendingThinking: null,
        queue: [],
        interjectQuery: null,
        statusStart: 0,
        statusTimer: null,
      });
    }
    return this.runs.get(sessionId);
  }

  get activeRun() {
    return this.session ? this.getRun(this.session.id) : null;
  }

  rememberSession(s) {
    if (s && s.id) this.sessionCache.set(s.id, s);
  }

  /** 切换当前会话（旧会话的 run 继续后台运行） */
  setActiveSession(s) {
    this.session = s;
    this.rememberSession(s);
    this.renderMessages();
    this.renderLivePanelIfRunning();
    this.updateHeader();
    this.syncSelectionRow();
    this.updateRunningUI(!!(this.activeRun && this.activeRun.running));
    this.renderQueue();
    this.renderSessionList();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
    // 内部链接（[[wikilink]] → a[data-href]）点击导航：自定义视图里手动接管跳转
    this.registerDomEvent(this.messagesEl, "click", (e) => {
      const a = e.target && e.target.closest ? e.target.closest("a.internal-link, a[data-href]") : null;
      if (!a) return;
      const href = a.getAttribute("data-href") || a.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      this.openInternalLink(href);
    });

    /* 状态条 */
    this.statusEl = root.createDiv({ cls: "dsh-status dsh-hidden" });

    /* 输入区：选择器（模型/强度/权限）与发送同一排 */
    const inputWrap = root.createDiv({ cls: "dsh-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", { cls: "dsh-input", attr: { placeholder: "给 DSH 下达任务…（Enter 发送；运行中 Enter 排队）", rows: "3" } });
    // 排队提示条
    this.queueEl = inputWrap.createDiv({ cls: "dsh-queue dsh-hidden" });
    const toolbar = inputWrap.createDiv({ cls: "dsh-input-toolbar" });
    const selects = toolbar.createDiv({ cls: "dsh-toolbar-selects" });
    this.modelSel = this.makeSelect(selects, this.modelOptions(), this.currentModel(), "模型");
    this.effortSel = this.makeSelect(selects, EFFORT_OPTS, this.currentEffort(), "强度");
    this.permSel = this.makeSelect(selects, PERM_OPTS, this.currentPerm(), "权限");
    this.sendBtn = toolbar.createEl("button", { cls: "dsh-send-btn", text: "发送" });
    this.sendBtn.addEventListener("click", () => this.onSendButton());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // 中文输入法组词中的 Enter 不触发发送
      if (e.key === "Enter") {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.onInterject();
        } else if (!e.shiftKey && this.plugin.settings.enterToSend) {
          e.preventDefault();
          this.onSend();
        }
      }
    });

    this.syncSelectionRow();
    this.renderSessionPanel();
    this.renderMessages();
    this.updateHeader();
  }

  onClose() {
    this.disposed = true;
    // 停止所有会话的运行
    for (const run of this.runs.values()) {
      if (run.statusTimer) clearInterval(run.statusTimer);
      run.statusTimer = null;
      if (run.cancelToken && run.cancelToken.cancel) {
        run.cancelToken.cancelled = true;
        run.cancelToken.cancel();
      }
    }
    this.runs.clear();
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
    // 用缓存覆盖磁盘（运行中的会话可能比磁盘新），并补上缓存里有但磁盘还没有的新会话
    const merged = sessions.map((s) => this.sessionCache.get(s.id) || s);
    for (const [id, s] of this.sessionCache) {
      if (!merged.some((m) => m.id === id)) merged.push(s);
    }
    merged.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    if (merged.length === 0) {
      this.sessionsListEl.createDiv({ cls: "dsh-sessions-empty", text: "暂无会话" });
      return;
    }
    for (const s of merged.slice(0, 100)) {
      const running = !!(this.getRun(s.id).running);
      const item = this.sessionsListEl.createDiv({ cls: "dsh-session-item" + (this.session && this.session.id === s.id ? " is-active" : "") });
      const main = item.createDiv({ cls: "dsh-session-main" });
      main.createDiv({ cls: "dsh-session-title", text: (running ? "⏳ " : "") + (s.title || "未命名") });
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
    const sess = (s && this.sessionCache.get(s.id)) || s;
    // 点的是当前正在运行的会话：不重载，避免清掉实时面板
    if (this.session && sess && this.session.id === sess.id && this.activeRun && this.activeRun.running) return;
    this.setActiveSession(sess);
  }

  newSession() {
    // 运行中也可新建：旧会话的 run 继续后台运行
    this.setActiveSession(null);
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

  /** 打开内部链接：目标是文件夹就在文件树里展开定位，是笔记就正常跳转 */
  async openInternalLink(linktext) {
    try {
      const vault = this.app.vault;
      let target = vault.getAbstractFileByPath(linktext);
      if (!target) {
        target = this.app.metadataCache.getFirstLinkpathDest(linktext, "");
      }
      if (!target) {
        const name = String(linktext).split("/").pop().replace(/\.md$/i, "");
        target = this.findFolderByName(name);
      }
      if (target instanceof TFolder) {
        await this.revealFolder(target);
      } else {
        this.app.workspace.openLinkText(linktext, "", false);
      }
    } catch (e) {
      this.plugin.logError("openInternalLink", e);
      this.app.workspace.openLinkText(linktext, "", false);
    }
  }

  findFolderByName(name) {
    if (!name) return null;
    let found = null;
    const walk = (folder) => {
      if (found) return;
      for (const child of folder.children) {
        if (child instanceof TFolder && child.name === name) { found = child; return; }
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    return found;
  }

  findFirstFile(folder) {
    for (const child of folder.children) {
      if (child instanceof TFile) return child;
      if (child instanceof TFolder) {
        const f = this.findFirstFile(child);
        if (f) return f;
      }
    }
    return null;
  }

  /** 在文件资源管理器里展开并定位文件夹 */
  async revealFolder(folder) {
    let leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false) || this.app.workspace.getLeaf(true);
      if (leaf) await leaf.setViewState({ type: "file-explorer" });
    }
    const fe = (this.app.workspace.getLeavesOfType("file-explorer")[0] || {}).view;
    if (!fe) return;
    if (typeof fe.expandFolder === "function") {
      fe.expandFolder(folder);
      return;
    }
    const child = this.findFirstFile(folder);
    if (child && typeof fe.revealInFolder === "function") {
      fe.revealInFolder(child);
    }
  }

  /** 渲染折叠的思考面板（assistant 消息上方；无论有无内容都显示，永不消失） */
  renderThinkingPanel(thinking) {
    const tools = thinking && Array.isArray(thinking.tools) ? thinking.tools : [];
    const hasReasoning = !!(thinking && thinking.reasoning);
    const hasTools = tools.length > 0;
    const panel = this.messagesEl.createDiv({ cls: "dsh-thinking-summary" });
    const head = panel.createDiv({ cls: "dsh-thinking-head" });
    head.createSpan({ cls: "dsh-thinking-emoji", text: "🧠" });
    head.createSpan({ cls: "dsh-thinking-time", text: "思考过程 · " + (thinking ? thinking.seconds : 0) + "s · " + tools.length + " 步工具" });
    const body = panel.createDiv({ cls: "dsh-thinking-body dsh-hidden" });
    if (!hasReasoning && !hasTools) {
      body.createDiv({ cls: "dsh-thinking-reason", text: "（本次没有推理/工具记录——可能是思考强度为关闭，或任务简单无需调用工具）" });
    } else {
      if (hasReasoning) body.createDiv({ cls: "dsh-thinking-reason", text: thinking.reasoning });
      if (hasTools) {
        const t = body.createDiv({ cls: "dsh-thinking-tools" });
        for (const line of tools) t.createDiv({ cls: "dsh-thinking-tool", text: line });
      }
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
    let lastPanelEl = null;
    for (const m of messages) {
      // assistant/error 消息携带思考记录时，先渲染折叠面板（sticky 定位，始终可见）
      if ((m.role === "assistant" || m.role === "error") && m.thinking) {
        lastPanelEl = this.renderThinkingPanel(m.thinking);
      }
      this.renderMessageEl(m);
    }
    // 滚动到底部即可：思考面板为 sticky 定位，滚动时钉在顶部，不会消失
    void lastPanelEl;
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

  /* ---------- 发送 / 排队 / 中断 ---------- */

  onSendButton() {
    if (this.activeRun && this.activeRun.running) this.cancel();
    else this.onSend();
  }

  async onSend() {
    if (this.disposed) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    if (!this.session) {
      this.session = this.plugin.newSessionRecord(query);
      this.rememberSession(this.session);
      this.updateHeader();
    }
    const session = this.session;
    const snap = this.selectionSnapshot();
    session.model = snap.model;
    session.effort = snap.effort;
    session.permission = snap.permission;
    const run = this.getRun(session.id);
    this.inputEl.value = "";
    if (run.running) {
      run.queue.push(query);
      this.renderQueue();
      new Notice("已加入排队（" + run.queue.length + " 条），当前任务完成后自动运行");
      return;
    }
    await this.runOne(session, query);
  }

  /** 插话：中断当前任务，立即带着上下文处理新消息（优先于排队） */
  onInterject() {
    if (this.disposed) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    if (!this.session) {
      this.session = this.plugin.newSessionRecord(query);
      this.rememberSession(this.session);
      this.updateHeader();
    }
    const session = this.session;
    const snap = this.selectionSnapshot();
    session.model = snap.model;
    session.effort = snap.effort;
    session.permission = snap.permission;
    const run = this.getRun(session.id);
    this.inputEl.value = "";
    if (run.running) {
      this.cancel(); // 中断当前并清空排队
      run.interjectQuery = query;
      new Notice("已插话，正在中断当前任务…");
    } else {
      run.interjectQuery = query;
      this.runNextFor(session, run);
    }
  }

  /** 处理下一个任务：插话 > 排队 > 无 */
  async runNextFor(session, run) {
    if (this.disposed) return;
    if (run.interjectQuery != null) {
      const q = run.interjectQuery;
      run.interjectQuery = null;
      await this.runOne(session, q);
    } else if (run.queue.length > 0) {
      const q = run.queue.shift();
      await this.runOne(session, q);
    }
    if (this.session && this.session.id === session.id) this.renderQueue();
  }

  cancel() {
    const run = this.activeRun;
    if (!run || !run.running || !run.cancelToken) return;
    run.cancelToken.cancelled = true;
    if (run.cancelToken.cancel) run.cancelToken.cancel();
    run.queue.length = 0; // 清空排队
    run.interjectQuery = null;
    this.renderQueue();
    new Notice("正在停止…");
  }

  /** 排队栏：每条排队项带「重新编辑 / 取消排队 / 插话发送」按钮 */
  renderQueue() {
    if (!this.queueEl) return;
    this.queueEl.empty();
    const run = this.activeRun;
    if (!run || run.queue.length === 0) {
      this.queueEl.addClass("dsh-hidden");
      return;
    }
    this.queueEl.removeClass("dsh-hidden");
    this.queueEl.createDiv({ cls: "dsh-queue-header", text: "排队中 " + run.queue.length + " 条（完成后自动运行）" });
    run.queue.forEach((q, idx) => {
      const item = this.queueEl.createDiv({ cls: "dsh-queue-item" });
      const text = item.createDiv({ cls: "dsh-queue-text", text: q });
      text.setAttribute("title", q);
      const actions = item.createDiv({ cls: "dsh-queue-actions" });

      const editBtn = actions.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "重新编辑", title: "重新编辑" } });
      setIcon(editBtn, "pencil");
      editBtn.addEventListener("click", () => this.queueEdit(idx));

      const cancelBtn = actions.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "取消排队", title: "取消排队" } });
      setIcon(cancelBtn, "x");
      cancelBtn.addEventListener("click", () => this.queueRemove(idx));

      const zapBtn = actions.createEl("button", { cls: "dsh-icon-btn dsh-queue-zap", attr: { "aria-label": "插话发送", title: "插话发送" } });
      setIcon(zapBtn, "zap");
      zapBtn.addEventListener("click", () => this.queueInterject(idx));
    });
  }

  queueEdit(idx) {
    const run = this.activeRun;
    if (!run) return;
    const q = run.queue.splice(idx, 1)[0];
    if (q == null) return;
    this.inputEl.value = q;
    this.renderQueue();
    this.inputEl.focus();
  }

  queueRemove(idx) {
    const run = this.activeRun;
    if (!run) return;
    run.queue.splice(idx, 1);
    this.renderQueue();
  }

  /** 把某条排队项立刻插话发送：中断当前，立即处理它 */
  queueInterject(idx) {
    const run = this.activeRun;
    const session = this.session;
    if (!run || !session) return;
    const q = run.queue.splice(idx, 1)[0];
    if (q == null) return;
    if (run.running) {
      this.cancel(); // 中断当前并清空其余排队
      run.interjectQuery = q;
      new Notice("已插话发送…");
    } else {
      run.interjectQuery = q;
      this.runNextFor(session, run);
    }
  }

  async runOne(session, query) {
    const run = this.getRun(session.id);
    run.sessionId = session.id;
    run.running = true;
    if (this.session && this.session.id === session.id) this.updateRunningUI(true);

    try {
      // 使用会话自身记录的选择（发送/插话时已固化）；后台会话运行时不读当前活动会话的选择器
      const sel = {
        model: session.model || this.plugin.settings.defaultModel || "deepseek-v4-flash",
        effort: session.effort || this.plugin.settings.defaultEffort || "high",
        permission: session.permission || this.plugin.settings.permissionMode || "workspace-write",
      };
      session.model = sel.model;
      session.effort = sel.effort;
      session.permission = sel.permission;
      session.lastActivityAt = Date.now();

      // 按所选模型/思考强度准备 runtime home（每次启动重读 settings.yaml）
      const homeRes = await this.plugin.applyAgentSelection(sel.model, sel.effort);
      if (!homeRes.ok) {
        session.messages.push({
          role: "error",
          content: "无法准备 DSH runtime home：" + (homeRes.error || "未知错误"),
          ts: Date.now(),
        });
        await this.plugin.saveSession(session);
        if (this.session && this.session.id === session.id) { this.renderMessages(); this.updateHeader(); }
        return;
      }

      const ctx = await this.getContextBlocks();
      const taskText = this.plugin.buildTaskText(session, query, ctx);

      session.messages.push({ role: "user", content: query, ts: Date.now(), notePath: ctx.notePath || undefined, selection: ctx.selectionText || undefined });
      await this.plugin.saveSession(session); // 立即持久化用户消息
      if (this.session && this.session.id === session.id) { this.renderMessages(); this.updateHeader(); }

      run.cancelToken = { cancelled: false };
      run.statusStart = Date.now();
      if (this.session && this.session.id === session.id) this.startThinking(run);
      if (!run.live && this.session && this.session.id === session.id) {
        this.statusEl.setText("DSH 思考中… [" + sel.model + (sel.effort !== "high" ? " / " + sel.effort : "") + "]");
        this.startStatusTimer(run);
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
        cancelToken: run.cancelToken,
        live: !!run.live,
        onEvent: (ev) => this.handleLiveEvent(session, run, ev),
      });

      if (this.disposed) return;

      if (run.live) this.finishThinking(run);
      const thinking = run.pendingThinking || null;
      run.pendingThinking = null;

      if (res.cancelled) {
        const partial = (res.stdout || "").trim();
        session.messages.push({ role: "assistant", content: partial ? partial + "\n\n（已取消）" : "（已取消）", ts: Date.now(), thinking });
      } else if (res.ok) {
        const answer = (res.stdout || "").trim();
        session.messages.push({ role: "assistant", content: answer, ts: Date.now(), thinking });
      } else {
        const detail = (res.stderr || "").trim() || "未知错误";
        session.messages.push({
          role: "error",
          content: detail + "\n\n（若为启动失败：请到 设置 → DSH → 测试连接 检查 dsh 安装；若为凭据缺失：请确认 DSH_HOME 下存在 .credentials.yaml）",
          ts: Date.now(),
          thinking,
        });
      }
      session.lastActivityAt = Date.now();
      await this.plugin.saveSession(session);
      if (this.session && this.session.id === session.id) {
        this.renderMessages();
        this.updateHeader();
        if (this.sessionsOpen) this.renderSessionList();
      } else {
        this.renderSessionList(); // 后台会话完成：更新列表
      }
    } finally {
      run.running = false;
      if (this.session && this.session.id === session.id) this.updateRunningUI(false);
    }
    await this.runNextFor(session, run);
  }

  updateRunningUI(running) {
    this.sendBtn.setText(running ? "停止" : "发送");
    if (!running) {
      this.stopStatusTimer();
      this.statusEl.addClass("dsh-hidden");
      this.statusEl.setText("");
    }
  }

  startStatusTimer(run) {
    const r = run || this.activeRun;
    if (!r) return;
    this.stopStatusTimer();
    this.statusEl.removeClass("dsh-hidden");
    r.statusTimer = setInterval(() => {
      if (this.disposed) return;
      const sec = Math.round((Date.now() - r.statusStart) / 1000);
      this.statusEl.setText("DSH 思考中… " + sec + "s（超时 " + (this.plugin.settings.timeoutSec || 600) + "s）");
    }, 1000);
  }

  stopStatusTimer() {
    const r = this.activeRun;
    if (r && r.statusTimer) { clearInterval(r.statusTimer); r.statusTimer = null; }
  }

  /* ---------- 思考过程（实时推理 + 工具调用 + 文本流） ---------- */

  startThinking(run) {
    run.live = this.plugin.settings.showThinking ? { reasoning: "", tools: [], text: "", steps: 0 } : null;
    run.pendingThinking = null;
    if (!run.live) return;
    this.renderLivePanel(run);
  }

  /** 重建实时思考面板 DOM（开始运行时 & 切回运行中会话时共用） */
  renderLivePanel(run) {
    const wrap = this.messagesEl.createDiv({ cls: "dsh-live" });
    const head = wrap.createDiv({ cls: "dsh-thinking-head", attr: { title: "点击展开/收起" } });
    head.createSpan({ cls: "dsh-thinking-emoji", text: "🧠" });
    const sec = Math.round((Date.now() - run.statusStart) / 1000);
    this.thinkingTimeEl = head.createSpan({ cls: "dsh-thinking-time", text: "思考过程 · " + sec + "s（点击展开）" });
    const body = wrap.createDiv({ cls: "dsh-thinking-body dsh-hidden" });
    this.thinkingReasonEl = body.createDiv({ cls: "dsh-thinking-reason", text: (run.live && run.live.reasoning) || "" });
    this.thinkingToolsEl = body.createDiv({ cls: "dsh-thinking-tools" });
    if (run.live && run.live.tools) {
      for (const t of run.live.tools) this.thinkingToolsEl.createDiv({ cls: "dsh-thinking-tool", text: t });
    }
    this.liveBody = body;
    head.addEventListener("click", () => {
      if (!this.liveBody) return;
      if (this.liveBody.classList.contains("dsh-hidden")) this.liveBody.classList.remove("dsh-hidden");
      else this.liveBody.classList.add("dsh-hidden");
    });
    if (run.statusTimer) clearInterval(run.statusTimer);
    run.statusTimer = setInterval(() => {
      if (this.disposed || !run.running || !run.live) return;
      if (this.session && this.session.id === run.sessionId && this.thinkingTimeEl) {
        const s2 = Math.round((Date.now() - run.statusStart) / 1000);
        this.thinkingTimeEl.setText("思考过程 · " + s2 + "s（点击展开）");
      }
    }, 1000);
  }

  renderLivePanelIfRunning() {
    const run = this.activeRun;
    if (!run || !run.running || !run.live) return;
    this.renderLivePanel(run);
  }

  handleLiveEvent(session, run, ev) {
    if (this.disposed || !run || !run.live) return;
    const isActive = !!(this.session && this.session.id === session.id);
    try {
      const d = ev.data || {};
      if (ev.type === "reasoning-chunks" && Array.isArray(d.texts)) {
        run.live.reasoning += d.texts.join("");
        if (isActive && this.thinkingReasonEl) this.thinkingReasonEl.setText(run.live.reasoning.trimEnd());
        run.live.steps += 1;
      } else if (ev.type === "tool-call-chunks" && d.name) {
        const args = (Array.isArray(d.args) ? d.args.join("") : String(d.args || "")).replace(/\s+/g, " ").slice(0, 90);
        run.live.tools.push("⚙ " + d.name + (args ? "  " + args : ""));
        if (isActive && this.thinkingToolsEl) {
          const line = this.thinkingToolsEl.createDiv({ cls: "dsh-thinking-tool", text: run.live.tools[run.live.tools.length - 1] });
          line.setAttribute("title", run.live.tools[run.live.tools.length - 1]);
        }
        run.live.steps += 1;
      } else if (ev.type === "tool/call" && d.name) {
        // 去重（tool-call-chunks 已展示过同一 id 时不重复）
        if (run.live.tools.some((t) => t.indexOf(d.name) >= 0)) return;
        const args = String(d.arguments || "").replace(/\s+/g, " ").slice(0, 90);
        run.live.tools.push("⚙ " + d.name + (args ? "  " + args : ""));
        if (isActive && this.thinkingToolsEl) {
          const line = this.thinkingToolsEl.createDiv({ cls: "dsh-thinking-tool", text: run.live.tools[run.live.tools.length - 1] });
          line.setAttribute("title", run.live.tools[run.live.tools.length - 1]);
        }
        run.live.steps += 1;
      } else if (ev.type === "text-chunks" && Array.isArray(d.texts)) {
        run.live.text += d.texts.join("");
      }
      if (isActive) this.scrollToBottomIfNear();
    } catch (e) { /* ignore */ }
  }

  /** 智能滚动：仅当用户本来就贴近底部时才自动跟滚，手动上翻查看历史时不打扰 */
  scrollToBottomIfNear() {
    const el = this.messagesEl;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 60) el.scrollTop = el.scrollHeight;
  }

  finishThinking(run) {
    if (!run || !run.live) return;
    const sec = Math.round((Date.now() - run.statusStart) / 1000);
    // 思考内容存入会话消息（renderMessages 时确定性重建折叠面板）
    run.pendingThinking = {
      reasoning: run.live.reasoning.trim().slice(0, 6000),
      tools: run.live.tools.slice(0, 40),
      seconds: sec,
    };
    try {
      if (this.session && this.session.id === run.sessionId) {
        if (this.liveBody) this.liveBody.addClass("dsh-hidden");
        if (this.thinkingTimeEl) this.thinkingTimeEl.setText("思考过程 · " + sec + "s · " + run.live.tools.length + " 步工具（点击展开）");
      }
    } catch (e) { /* ignore */ }
    run.live = null;
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
