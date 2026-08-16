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

const { Plugin, PluginSettingTab, ItemView, MarkdownView, MarkdownRenderer, Notice, Setting, setIcon, TFolder, TFile, Menu, Modal } = require("obsidian");
const path = require("path");
/* ============================================================
 * dsh-provider（内联自 dsh-provider.js，保持单文件以便 Obsidian 加载）
 * 修改 dsh-provider.js 后请重新运行：node scripts/build-plugin.js
 * ============================================================ */
const provider = (() => {
  /**
   * dsh-provider.js — DSH 提供器（纯 Node.js，无 Obsidian 依赖，可独立测试）
   *
   * 职责：
   *  1. 定位 dsh 的 node 入口（优先 npx 缓存 / 全局 npm / ~/bin 下的 @deepseek-ai/dsh 包，
   *     用系统 node 直接跑 lib/bin.js，避开 Windows .cmd 包装器的引号问题）。
   *  2. 以 vault 为工作目录 spawn `node <entry> --profile headless <task>`，收集 stdout/stderr。
   *  3. 支持超时、取消令牌、额外 launcher 参数（如 --patch）、DSH_HOME 覆盖。
   *
   * 注意：在 Obsidian（Electron）内运行时，process.execPath 指向 Obsidian.exe，
   * 因此系统 node 必须单独解析（PATH / Program Files / 设置覆盖）。
   */
  "use strict";
  
  const { spawn } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  
  function homedir() {
    return os.homedir();
  }
  
  /** 常见 node 可执行文件候选（按优先级） */
  function nodeCandidates(override) {
    const list = [];
    if (override && override.trim()) list.push(override.trim());
    const pf = process.env.ProgramFiles;
    if (pf) {
      list.push(path.join(pf, "nodejs", "node.exe"));
    }
    const pf86 = process.env["ProgramFiles(x86)"];
    if (pf86) list.push(path.join(pf86, "nodejs", "node.exe"));
    list.push("C:\\Program Files\\nodejs\\node.exe");
    list.push("node"); // PATH 兜底（Windows 下 CreateProcess 会搜索 PATH）
    return list;
  }
  
  /** 解析可用的系统 node 路径，返回 { command, isPath } */
  function resolveNodePath(override) {
    for (const c of nodeCandidates(override)) {
      if (c === "node") return { command: "node", isPath: false };
      try {
        if (fs.existsSync(c)) return { command: c, isPath: true };
      } catch (e) { /* ignore */ }
    }
    return { command: "node", isPath: false };
  }
  
  /** 常见 dsh 安装根（含 node_modules 的目录） */
  function candidateRoots() {
    const home = homedir();
    const roots = [];
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
    roots.push(path.join(home, "bin", "node_modules"));
    roots.push(path.join(home, ".local", "bin", "node_modules"));
    const npxCache = path.join(home, "AppData", "Local", "npm-cache", "_npx");
    try {
      if (fs.existsSync(npxCache)) {
        for (const d of fs.readdirSync(npxCache)) roots.push(path.join(npxCache, d, "node_modules"));
      }
    } catch (e) { /* ignore */ }
    if (process.env.DSH_PACKAGE_ROOT) roots.push(path.resolve(process.env.DSH_PACKAGE_ROOT));
    return roots;
  }
  
  /** 找到 @deepseek-ai/dsh 的 node 入口绝对路径 */
  function findDshEntry() {
    for (const root of candidateRoots()) {
      const entry = path.join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
      try {
        if (fs.existsSync(entry)) return entry;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  
  /** 从 .cmd/.ps1 包装器路径推导 node 入口（如 _npx/<hash>/node_modules/.bin/dsh.cmd） */
  function deriveEntryFromWrapper(wrapperPath) {
    try {
      const binDir = path.dirname(path.resolve(wrapperPath)); // .../node_modules/.bin
      const entry = path.join(path.dirname(binDir), "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(entry)) return entry;
    } catch (e) { /* ignore */ }
    return null;
  }
  
  /** 把一段文本拆成 argv token（支持双引号/单引号） */
  function parseArgsTokens(str) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|[^\s]+/g;
    let m;
    while ((m = re.exec(str || "")) !== null) {
      out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[0]);
    }
    return out;
  }
  
  /** Windows cmd 参数加引号 */
  function quoteForCmd(arg) {
    const s = String(arg);
    if (s === "") return '""';
    return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
  }
  
  /**
   * 解析最终 spawn 目标。
   * @param {string} userCommand 设置里的 dshCommand（可空）
   * @param {string} userNodePath 设置里的 nodePath（可空）
   * @returns {{ command:string, argsPrefix:string[], useCmd:boolean, cmdName:string, source:string }}
   */
  function resolveSpawnTarget(userCommand, userNodePath) {
    const cmd = (userCommand || "").trim();
    if (cmd) {
      const lower = cmd.toLowerCase();
      if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1")) {
        const entry = deriveEntryFromWrapper(cmd);
        if (entry) {
          const node = resolveNodePath(userNodePath);
          return { command: node.command, argsPrefix: [entry], useCmd: false, cmdName: "", source: "wrapper-derived" };
        }
        return { command: "cmd.exe", argsPrefix: [], useCmd: true, cmdName: cmd, source: "user-cmd" };
      }
      if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
        const node = resolveNodePath(userNodePath);
        return { command: node.command, argsPrefix: [cmd], useCmd: false, cmdName: "", source: "user-js-entry" };
      }
      return { command: cmd, argsPrefix: [], useCmd: false, cmdName: "", source: "user" };
    }
    const entry = findDshEntry();
    if (entry) {
      const node = resolveNodePath(userNodePath);
      return { command: node.command, argsPrefix: [entry], useCmd: false, cmdName: "", source: "auto-node-entry" };
    }
    return null; // 未找到，由调用方给出明确错误
  }
  
  /**
   * 运行一次 headless 任务。
   * @param {object} opts
   * @param {string} opts.cwd 工作目录（vault 根）
   * @param {string} opts.task 任务文本
   * @param {string} [opts.dshCommand] 用户指定 dsh 命令
   * @param {string} [opts.nodePath] 用户指定 node 路径
   * @param {string} [opts.dshHome] DSH_HOME 覆盖（留空继承）
   * @param {string} [opts.permissionMode] DSH_PERMISSION_MODE 覆盖（read-only / workspace-write / danger-full-access）
   * @param {string} [opts.extraArgs] 额外 launcher 参数文本（如 --patch C:/x.yml）
   * @param {number} [opts.timeoutMs] 超时毫秒，默认 600000
   * @param {{cancelled:boolean, cancel?:()=>void}} [opts.cancelToken] 取消令牌
   * @param {(line:string)=>void} [opts.onStderr] stderr 逐行回调
   * @param {boolean} [opts.live] 开启实时事件流（会话明文 JSONL 到独立 root 并 tail）
   * @param {(ev:object)=>void} [opts.onEvent] 实时事件回调（reasoning-chunks / tool-call-chunks / text-chunks / tool/call …）
   * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null, durationMs:number, target:object|null, cancelled:boolean}>}
   */
  function runHeadless(opts) {
    return new Promise((resolvePromise) => {
      const cwd = opts.cwd || process.cwd();
      const task = String(opts.task || "");
      const timeoutMs = opts.timeoutMs || 600000;
      const token = opts.cancelToken || { cancelled: false };
      const target = resolveSpawnTarget(opts.dshCommand || "", opts.nodePath || "");
      const extraTokens = parseArgsTokens(opts.extraArgs || "");
  
      let child = null;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const startedAt = Date.now();
  
      const finish = (ok, code, cancelled) => {
        if (settled) return;
        settled = true;
        if (token.cancel) token.cancel = null;
        resolvePromise({
          ok,
          stdout,
          stderr,
          code,
          durationMs: Date.now() - startedAt,
          target,
          cancelled: !!cancelled,
        });
      };
  
      if (!target) {
        stderr += "[dsh-provider] 未找到 dsh 安装：请在插件设置中填写 dshCommand（如 dsh 命令、node 入口或 .cmd 路径）。";
        finish(false, null, false);
        return;
      }
  
      // ---- 实时事件流：给 headless 加 --patch（会话明文 JSONL 到独立 root），随后 tail ----
      let tailTimer = null;
      let liveRoot = "";
      const seenFiles = new Set();
      const offsets = new Map();
      const LIVE_PATCH = [
        "- id: session-persistence-jsonl",
        "  config:",
        "    root: !!js dshHomePath('sessions-live')",
        "    compression: none",
        "    writeBatchMaxDelayMs: 200",
        "",
      ].join("\n");
  
      const scanLiveRoot = (root, set) => {
        try {
          for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            const p = path.join(root, e.name);
            if (e.isDirectory()) scanLiveRoot(p, set);
            else if (e.name.endsWith(".jsonl")) set.add(p);
          }
        } catch (e) { /* ignore */ }
      };
  
      const stopTail = () => {
        if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
      };
  
      const tailOnce = () => {
        if (!opts.onEvent) return;
        try {
          const cur = new Set();
          scanLiveRoot(liveRoot, cur);
          for (const p of cur) {
            if (!seenFiles.has(p)) { seenFiles.add(p); offsets.set(p, 0); }
          }
          for (const [p, off] of Array.from(offsets.entries())) {
            try {
              const st = fs.statSync(p);
              if (st.size <= off) continue;
              const fd = fs.openSync(p, "r");
              const buf = Buffer.alloc(st.size - off);
              fs.readSync(fd, buf, 0, buf.length, off);
              fs.closeSync(fd);
              offsets.set(p, st.size);
              for (const line of buf.toString("utf8").split("\n")) {
                const l = line.trim();
                if (!l) continue;
                try { opts.onEvent(JSON.parse(l)); } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      };
  
      let livePatchArg = [];
      if (opts.live && opts.onEvent && opts.dshHome) {
        try {
          fs.mkdirSync(opts.dshHome, { recursive: true });
          const patchPath = path.join(opts.dshHome, "live.patch.yml");
          fs.writeFileSync(patchPath, LIVE_PATCH, "utf8");
          liveRoot = path.join(opts.dshHome, "sessions-live");
          scanLiveRoot(liveRoot, seenFiles);
          livePatchArg = ["--patch", patchPath];
          tailTimer = setInterval(tailOnce, 250);
        } catch (e) {
          stderr += (stderr ? "\n" : "") + "[dsh-provider] 实时事件流初始化失败（降级为无思考过程）: " + String(e && e.message || e);
          stopTail();
        }
      }
  
      try {
        const env = { ...process.env };
        if (opts.dshHome) env.DSH_HOME = opts.dshHome;
        if (opts.permissionMode) env.DSH_PERMISSION_MODE = opts.permissionMode;
  
        if (target.useCmd) {
          // 用户手填的 .cmd 且无法推导入口：交给 cmd.exe 执行（对参数做引号处理）
          const cmdLine = [target.cmdName, "--profile", "headless", ...livePatchArg.map(quoteForCmd), ...extraTokens.map(quoteForCmd), quoteForCmd(task)].join(" ");
          child = spawn("cmd.exe", ["/c", cmdLine], { cwd, env, windowsHide: true });
        } else {
          const args = [...target.argsPrefix, "--profile", "headless", ...livePatchArg, ...extraTokens, task];
          child = spawn(target.command, args, { cwd, env, windowsHide: true });
        }
      } catch (err) {
        stopTail();
        stderr += `[dsh-provider] 启动失败: ${err.message}`;
        finish(false, null, false);
        return;
      }
  
      token.cancel = () => {
        try { if (child && child.pid) child.kill("SIGKILL"); } catch (e) { /* ignore */ }
      };
  
      const timer = setTimeout(() => {
        stopTail();
        try { if (child && child.pid) child.kill("SIGKILL"); } catch (e) { /* ignore */ }
        stderr += (stderr ? "\n" : "") + `[dsh-provider] 超时（${Math.round(timeoutMs / 1000)}s），已终止进程。`;
        finish(false, null, false);
      }, timeoutMs);
  
      if (child.stdout) child.stdout.setEncoding("utf8");
      if (child.stderr) child.stderr.setEncoding("utf8");
      if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
      if (child.stderr) child.stderr.on("data", (d) => {
        stderr += d;
        if (opts.onStderr) opts.onStderr(String(d));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        stopTail();
        stderr += (stderr ? "\n" : "") + `[dsh-provider] 无法启动 ${target.command}: ${err.message}`;
        finish(false, null, false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        stopTail();
        tailOnce(); // 最后一次补读
        if (token.cancelled) {
          stderr += (stderr ? "\n" : "") + "[dsh-provider] 已取消。";
          finish(false, null, true);
        } else {
          finish(code === 0, code, false);
        }
      });
    });
  }
  
  /** 供设置页展示的解析结果 */
  function describeTarget(userCommand, userNodePath) {
    const t = resolveSpawnTarget(userCommand || "", userNodePath || "");
    if (!t) return { found: false, line: "未找到 dsh（请在设置中填写 dshCommand）" };
    const head = t.useCmd ? t.cmdName : [t.command, ...t.argsPrefix].join(" ");
    return { found: true, source: t.source, line: head + " --profile headless <任务>" };
  }
  
  /* ============================================================
   * Runtime home：dsh 的模型 / 思考强度没有环境变量开关，只能通过
   * DSH_HOME/settings.yaml 的 agent-default-model 段配置（headless 每次
   * 启动都会重读）。为避免污染用户的真实 ~/.dsh，插件维护一个独立的
   * runtime home（含 .credentials.yaml + 每次按所选模型/强度重写的
   * settings.yaml），并以 DSH_HOME 指向它。
   * ============================================================ */
  
  const DEFAULT_MODEL_PROVIDER = "deepseek-official";
  
  /** 读取简单 YAML 文本，返回 { raw, agentDefaultModel: {provider, model, reasoningEffort} | null } */
  function readAgentDefaultModel(yamlText) {
    const lines = String(yamlText || "").split(/\r?\n/);
    let inSection = false;
    let section = null;
    for (const line of lines) {
      if (/^agent-default-model\s*:/.test(line)) { inSection = true; section = {}; continue; }
      if (inSection) {
        if (/^\S/.test(line)) { inSection = false; break; } // 回到顶层键
        const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (m && section) section[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
      }
    }
    return section;
  }
  
  /**
   * 通用 YAML 顶层段解析：返回 { sub: {键:值}, list: [{键:值}, ...] }
   * sub 收集「键: 值」；list 收集段内「- 键: 值」列表项（如 llm-deepseek.models）。
   */
  function parseYamlSection(yamlText, sectionName) {
    const lines = String(yamlText || "").split(/\r?\n/);
    const out = { sub: {}, list: [] };
    let inSection = false;
    let curItem = null;
    const re = new RegExp("^" + sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\/*__INLINE_PROVIDER__*/") + "\\s*:");
    for (const line of lines) {
      if (re.test(line)) { inSection = true; continue; }
      if (!inSection) continue;
      if (/^\S/.test(line)) break; // 下一个顶层键
      const itemMatch = line.match(/^\s*-\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (itemMatch) {
        curItem = {};
        curItem[itemMatch[1]] = itemMatch[2].trim().replace(/^['"]|['"]$/g, "");
        out.list.push(curItem);
        continue;
      }
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        const val = kv[2].trim().replace(/^['"]|['"]$/g, "");
        if (curItem && (kv[1] === "id" || kv[1] === "name" || kv[1] === "description" || kv[1] === "contextWindow")) {
          curItem[kv[1]] = val;
        } else if (curItem) {
          curItem[kv[1]] = val;
        } else {
          out.sub[kv[1]] = val;
        }
      }
    }
    return out;
  }
  
  /**
   * 扫描本机 dsh 配置，得到可用模型目录与默认选择（「一键自动配置」的数据源）。
   * 模型来源：真实 DSH_HOME/settings.yaml 的 llm-deepseek.models（若配置），
   * 否则用 dsh-llm-deepseek 的默认（V4 Flash + V4 Pro）。
   * 默认模型/思考强度：settings.yaml 的 agent-default-model。
   * @param {object} opts
   * @param {string} opts.baseHome 真实 DSH_HOME
   * @returns {{ok:boolean, baseHome:string, models:Array<{id:string,name:string}>, defaultModel:string, defaultEffort:string, provider:string, credentialOk:boolean, source:string, error?:string}}
   */
  function scanModels(opts) {
    try {
      const baseHome = opts.baseHome || path.join(homedir(), ".dsh");
      let yaml = "";
      const settingsPath = path.join(baseHome, "settings.yaml");
      try { if (fs.existsSync(settingsPath)) yaml = fs.readFileSync(settingsPath, "utf8"); } catch (e) { /* ignore */ }
  
      const adm = parseYamlSection(yaml, "agent-default-model").sub;
      const llm = parseYamlSection(yaml, "llm-deepseek");
      const provider = adm.provider || DEFAULT_MODEL_PROVIDER;
      const defaultModel = adm.model || "deepseek-v4-flash";
      const rawEffort = adm.reasoningEffort;
      const defaultEffort = (rawEffort === "off" || rawEffort === "high" || rawEffort === "max") ? rawEffort : "high";
  
      let models = [];
      if (llm.list && llm.list.length > 0) {
        models = llm.list.map((it) => ({ id: it.id, name: it.name || it.id })).filter((m) => m && m.id);
      }
      if (models.length === 0) {
        models = [
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
        ];
      }
  
      let credentialOk = false;
      try {
        const cred = fs.readFileSync(path.join(baseHome, ".credentials.yaml"), "utf8");
        credentialOk = /DEEPSEEK_API_KEY\s*:\s*\S+/.test(cred);
      } catch (e) { /* ignore */ }
  
      return {
        ok: true,
        baseHome,
        models,
        defaultModel,
        defaultEffort,
        provider,
        credentialOk,
        source: llm.list.length ? "settings" : "defaults",
      };
    } catch (e) {
      return { ok: false, baseHome: opts.baseHome || "", models: [], defaultModel: "deepseek-v4-flash", defaultEffort: "high", provider: DEFAULT_MODEL_PROVIDER, credentialOk: false, source: "", error: String(e && e.message || e) };
    }
  }
  
  /**
   * 在 runtime home 的 settings.yaml 中写入/更新 agent-default-model 段，
   * 保留文件其余内容（ui-onboarding、agent-presets 等）。
   * @param {string} yamlText 现有 settings.yaml 文本（可为空）
   * @param {{provider:string, model:string, reasoningEffort:string}} sel
   * @returns {string} 新文本
   */
  function writeAgentDefaultModel(yamlText, sel) {
    const lines = String(yamlText || "").split(/\r?\n/);
    const out = [];
    let replaced = false;
    let inSection = false;
    for (const line of lines) {
      if (/^agent-default-model\s*:/.test(line)) {
        inSection = true;
        replaced = true;
        out.push("agent-default-model:");
        out.push("  provider: " + (sel.provider || DEFAULT_MODEL_PROVIDER));
        out.push("  model: " + sel.model);
        if (sel.reasoningEffort) out.push("  reasoningEffort: " + sel.reasoningEffort);
        continue;
      }
      if (inSection) {
        if (/^\S/.test(line)) { inSection = false; } // 遇到下一个顶层键，先处理该行
        else continue; // 丢弃旧的子键
      }
      out.push(line);
    }
    if (!replaced) {
      out.push("agent-default-model:");
      out.push("  provider: " + (sel.provider || DEFAULT_MODEL_PROVIDER));
      out.push("  model: " + sel.model);
      if (sel.reasoningEffort) out.push("  reasoningEffort: " + sel.reasoningEffort);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  
  /**
   * 准备 runtime home：
   *  1. 确保目录存在；
   *  2. 缺 .credentials.yaml 时从 baseHome 复制（凭据跟随真实 home）；
   *  3. 缺 settings.yaml 时从 baseHome 复制一份做基底；
   *  4. 用所选模型/思考强度重写 settings.yaml 的 agent-default-model 段。
   * @param {object} opts
   * @param {string} opts.baseHome 真实 DSH_HOME（默认 ~/.dsh）
   * @param {string} opts.runtimeHome 独立 runtime home 目录
   * @param {{model:string, reasoningEffort:string, provider?:string}} opts.selection
   * @returns {{ok:boolean, home:string, error?:string}}
   */
  function prepareRuntimeHome(opts) {
    try {
      const baseHome = opts.baseHome || path.join(homedir(), ".dsh");
      const runtimeHome = opts.runtimeHome;
      if (!runtimeHome) return { ok: false, home: "", error: "runtimeHome 未指定" };
      fs.mkdirSync(runtimeHome, { recursive: true });
  
      // 凭据
      const credDst = path.join(runtimeHome, ".credentials.yaml");
      if (!fs.existsSync(credDst)) {
        const credSrc = path.join(baseHome, ".credentials.yaml");
        if (fs.existsSync(credSrc)) fs.copyFileSync(credSrc, credDst);
      }
  
      // settings.yaml 基底
      const settingsPath = path.join(runtimeHome, "settings.yaml");
      if (!fs.existsSync(settingsPath)) {
        const src = path.join(baseHome, "settings.yaml");
        if (fs.existsSync(src)) fs.copyFileSync(src, settingsPath);
      }
  
      // 重写 agent-default-model 段
      const current = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
      const sel = {
        provider: opts.selection && opts.selection.provider || DEFAULT_MODEL_PROVIDER,
        model: (opts.selection && opts.selection.model) || "deepseek-v4-flash",
        reasoningEffort: (opts.selection && opts.selection.reasoningEffort) || "high",
      };
      const next = writeAgentDefaultModel(current, sel);
      if (next !== current) fs.writeFileSync(settingsPath, next, "utf8");
  
      return { ok: true, home: runtimeHome };
    } catch (e) {
      return { ok: false, home: opts.runtimeHome || "", error: String(e && e.message || e) };
    }
  }
  return { runHeadless, resolveSpawnTarget, describeTarget, findDshEntry, resolveNodePath, parseArgsTokens, prepareRuntimeHome, scanModels, parseYamlSection, DEFAULT_MODEL_PROVIDER };
})();

const VIEW_TYPE = "dsh-chat-view";
const SESSION_MANAGER_VIEW = "dsh-session-manager-view";
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
    this.registerView(SESSION_MANAGER_VIEW, (leaf) => new DSHSessionManagerView(leaf, this));

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
    this.addCommand({
      id: "open-dsh-session-manager",
      name: "打开 DSH 会话管理器",
      callback: () => this.activateSessionManager(),
    });

    /* 代码块内嵌聊天：```agent-client ``` 在笔记里直接对话（参考 agent-client 的嵌入块） */
    this.registerMarkdownCodeBlockProcessor("agent-client", (source, el, ctx) => {
      try {
        const host = el.createDiv({ cls: "agent-client-code-block-host" });
        const chat = host.createDiv({ cls: "agent-client-code-block-chat" });
        const header = chat.createDiv({ cls: "agent-client-embedded-header" });
        const inline = header.createDiv({ cls: "agent-client-inline-header" });
        const main = inline.createDiv({ cls: "agent-client-inline-header-main" });
        main.createSpan({ cls: "agent-client-agent-label", text: "DSH" });
        const messagesContainer = chat.createDiv({ cls: "agent-client-embedded-messages-container" });
        const panel = messagesContainer.createDiv({ cls: "agent-client-embedded-chat-panel" });
        const fakeLeaf = { app: this.app };
        const view = new DSHChatView(fakeLeaf, this);
        view.floating = true;
        view.mountTo(panel).catch((e) => this.logError("embedded-mount", e));
        ctx.addChild({ onunload: () => { try { view.onClose(); view.disposed = true; } catch (e) { /* ignore */ } } });
      } catch (e) {
        this.logError("code-block", e);
        el.createDiv({ cls: "agent-client-code-block-error", text: "DSH 内嵌聊天初始化失败：" + String((e && e.message) || e) });
      }
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

  /** 打开会话管理器视图 */
  async activateSessionManager() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SESSION_MANAGER_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false) || workspace.getLeaf(true);
      await leaf.setViewState({ type: SESSION_MANAGER_VIEW, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** 从会话管理器/历史里打开某个会话到聊天视图 */
  async openSessionById(id) {
    const sessions = await this.listSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const view = this.getChatView();
    if (view) {
      view.loadSession(s);
      this.app.workspace.revealLeaf(view.leaf);
    } else {
      await this.activateView();
      const v2 = this.getChatView();
      if (v2) v2.loadSession(s);
    }
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
    this.floating = false; // 内嵌（代码块）模式：无侧栏头部
    this.sessionCache = new Map(); // id -> session（保证多会话/切换时对象一致）
    this.runs = new Map();         // id -> runState（每个会话独立的运行状态）
  }

  /** 挂载到任意容器（浮动窗复用同一视图类） */
  async mountTo(containerEl) {
    this.contentEl = containerEl;
    return this.onOpen();
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
    this.updateAutoMentionChip();
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.session && this.session.title ? "DSH · " + this.session.title : "DSH"; }
  getIcon() { return "bot"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("dsh-view");

    const container = root.createDiv({ cls: "agent-client-chat-view-container" });

    /* 头部（仅侧栏模式；浮动窗自带 inline header） */
    if (!this.floating) {
      const header = container.createDiv({ cls: "nav-header agent-client-chat-view-header" });
      const navBtns = header.createDiv({ cls: "nav-buttons-container" });
      this.titleEl = navBtns.createSpan({ cls: "agent-client-chat-view-header-title", text: "DSH" });
      this.newBtn = this.navActionBtn(navBtns, "plus", "新会话", () => this.newSession());
      this.historyBtn = this.navActionBtn(navBtns, "history", "会话历史", () => this.openHistoryModal());
      this.exportBtn = this.navActionBtn(navBtns, "save", "导出为 Markdown", () => this.exportChat());
      this.moreBtn = this.navActionBtn(navBtns, "more-vertical", "更多", (e) => this.showHeaderMenu(e));
    }

    /* 消息区 */
    this.messagesEl = container.createDiv({ cls: "agent-client-chat-view-messages" });
    // 回到底部按钮（sticky，上翻查看历史时出现）
    this.scrollBtn = this.messagesEl.createEl("button", { cls: "agent-client-scroll-to-bottom dsh-hidden", attr: { "aria-label": "滚动到底部", title: "滚动到底部" } });
    setIcon(this.scrollBtn, "chevron-down");
    this.scrollBtn.addEventListener("click", () => { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; this.updateScrollBtn(); });
    this.messagesEl.addEventListener("scroll", () => this.updateScrollBtn());
    // 内部链接（[[wikilink]] → a[data-href]）点击导航
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
    this.statusEl = container.createDiv({ cls: "dsh-status dsh-hidden" });

    /* 排队提示条 */
    this.queueEl = container.createDiv({ cls: "dsh-queue dsh-hidden" });

    /* 输入区：文本框 + 底部工具栏（模型/强度/权限 + 发送/停止） */
    const inputContainer = container.createDiv({ cls: "agent-client-chat-input-container" });
    const inputBox = inputContainer.createDiv({ cls: "agent-client-chat-input-box" });
    this.inputBoxEl = inputBox;
    // 自动附带当前笔记的提示 chip（点击可切换本会话的自动附带）
    this.autoMentionEl = inputBox.createEl("button", { cls: "agent-client-auto-mention-inline dsh-hidden", attr: { title: "发送时自动附带当前笔记与选区；点击切换" } });
    this.autoMentionBadge = this.autoMentionEl.createSpan({ cls: "agent-client-mention-badge" });
    this.autoMentionIcon = this.autoMentionEl.createSpan({ cls: "agent-client-auto-mention-toggle-icon" });
    setIcon(this.autoMentionIcon, "link");
    this.autoMentionEl.addEventListener("click", () => {
      if (!this.session) return;
      const cur = this.session.autoAttach !== false;
      this.session.autoAttach = !cur;
      this.updateAutoMentionChip();
    });
    this.inputEl = inputBox.createEl("textarea", { cls: "agent-client-chat-input-textarea", attr: { placeholder: "给 DSH 下达任务…（Enter 发送 · Shift+Enter 换行 · Ctrl+Enter 插话 · @ 提及笔记）", rows: "3" } });
    const actions = inputBox.createDiv({ cls: "agent-client-chat-input-actions" });
    this.modelBtn = this.toolbarDropdown(actions, "模型", this.modelOptions(), this.currentModel(), (v) => { if (this.session) this.session.model = v; });
    this.effortBtn = this.toolbarDropdown(actions, "强度", EFFORT_OPTS, this.currentEffort(), (v) => { if (this.session) this.session.effort = v; });
    this.permBtn = this.toolbarDropdown(actions, "权限", PERM_OPTS, this.currentPerm(), (v) => { if (this.session) this.session.permission = v; });
    this.sendBtn = actions.createEl("button", { cls: "agent-client-chat-send-button", attr: { title: "发送" } });
    setIcon(this.sendBtn, "send-horizontal");
    this.sendBtn.addEventListener("click", () => this.onSendButton());

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // 中文输入法组词中的 Enter 不触发发送
      // @提及弹层打开时：方向键/回车/Tab/ESC 优先交给弹层
      if (this.mentionPopupOpen()) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.moveMention(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.moveMention(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.selectMention(); return; }
        if (e.key === "Escape") { this.closeMentionPopup(); return; }
      }
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
    // 自动调整文本框高度 + 同步发送按钮图标状态 + @提及弹层
    this.inputEl.addEventListener("input", () => { this.autoGrowInput(); this.updateSendIcon(); this.openMentionPopup(); });

    this.syncSelectionRow();
    this.renderMessages();
    this.updateHeader();
    this.updateAutoMentionChip();
    // 切换笔记时刷新自动附带提示
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateAutoMentionChip()));
  }

  /** 自动附带提示 chip：显示当前笔记名 + 可点击切换 */
  updateAutoMentionChip() {
    if (!this.autoMentionEl || !this.autoMentionBadge) return;
    const on = this.session ? this.session.autoAttach !== false : true;
    const file = this.app.workspace.getActiveFile();
    const s = this.plugin.settings;
    if (!on || !file || !s.autoAttachNote) {
      this.autoMentionEl.addClass("dsh-hidden");
      return;
    }
    this.autoMentionEl.removeClass("dsh-hidden");
    const seg = s.autoAttachSelection ? "（含选区）" : "";
    this.autoMentionBadge.setText("自动附加：@" + file.basename + seg);
    this.autoMentionBadge.classList.toggle("agent-client-disabled", false);
  }

  /** 头部导航按钮（与 Obsidian 侧栏按钮一致的 icon 按钮） */
  navActionBtn(parent, icon, label, onClick) {
    const btn = parent.createEl("div", { cls: "clickable-icon nav-action-button", attr: { "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** 更多菜单 */
  showHeaderMenu(ev) {
    const menu = new Menu();
    menu.addItem((it) => it.setTitle("新建会话").setIcon("plus").onClick(() => this.newSession()));
    menu.addItem((it) => it.setTitle("打开会话管理器").setIcon("history").onClick(() => this.plugin.activateSessionManager()));
    menu.addItem((it) => it.setTitle("清空当前会话").setIcon("trash").onClick(() => { if (this.session) { this.session.messages = []; this.plugin.saveSession(this.session); this.renderMessages(); } }));
    menu.addItem((it) => it.setTitle("打开设置").setIcon("settings").onClick(() => { try { this.app.setting.open(); this.app.setting.openTabById("dsh"); } catch (e) { /* ignore */ } }));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle("导出为 Markdown").setIcon("save").onClick(() => this.exportChat()));
    menu.showAtMouseEvent(ev);
  }

  /** 会话历史弹窗（参考 agent-client 的 SessionHistoryModal） */
  openHistoryModal() {
    const modal = new DSHSessionHistoryModal(this.app, this.plugin, (s) => this.loadSession(s));
    modal.open();
  }

  /** 底部工具栏下拉（用 Obsidian Menu，参考 agent-client 的 ToolbarDropdown） */
  toolbarDropdown(parent, label, opts, value, onChange) {
    const btn = parent.createEl("button", { cls: "agent-client-toolbar-dropdown", attr: { title: label } });
    const area = btn.createSpan({ cls: "agent-client-toolbar-dropdown-label-area" });
    for (const o of opts) area.createSpan({ cls: "agent-client-toolbar-dropdown-sizer", text: o.label });
    const lab = area.createSpan({ cls: "agent-client-toolbar-dropdown-label", text: value != null ? (opts.find((o) => o.value === value) || {}).label || label : label });
    const chev = btn.createSpan({ cls: "agent-client-toolbar-dropdown-chevron" });
    setIcon(chev, "chevron-down");
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const menu = new Menu();
      menu.addItem((it) => it.setTitle(label).setIsLabel(true));
      for (const o of opts) {
        menu.addItem((it) => it.setTitle(o.label).setChecked(o.value === btn.__value).onClick(() => {
          btn.__value = o.value;
          lab.setText(o.label);
          onChange(o.value);
        }));
      }
      menu.showAtMouseEvent(e);
    });
    // 存储当前值以便 syncSelectionRow 刷新 label
    btn.__value = value;
    btn.__opts = opts;
    btn.__label = label;
    return btn;
  }

  autoGrowInput() {
    if (!this.inputEl) return;
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 300) + "px";
  }

  /* ---------- @提及笔记（参考 agent-client 的 Mention 弹层） ---------- */

  mentionPopupOpen() {
    return !!(this.mentionPopupEl && !this.mentionPopupEl.classList.contains("dsh-hidden"));
  }

  /** 输入框光标前的 @query → 打开/刷新弹层 */
  openMentionPopup() {
    if (!this.inputEl || !this.inputBoxEl) return;
    const text = this.inputEl.value || "";
    const caret = this.inputEl.selectionStart != null ? this.inputEl.selectionStart : text.length;
    const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
    const before = text.slice(lineStart, caret);
    const atIdx = before.lastIndexOf("@");
    if (atIdx < 0) { this.closeMentionPopup(); return; }
    const q = before.slice(atIdx + 1);
    if (q.length > 40 || q.indexOf(" ") >= 0) { this.closeMentionPopup(); return; }
    if (this.mentionQuery === q && this.mentionPopupEl && !this.mentionPopupEl.classList.contains("dsh-hidden")) return;
    this.mentionQuery = q;
    this.mentionInsertPos = lineStart + atIdx + 1;
    this.renderMentionPopup(this.searchNotes(q));
  }

  searchNotes(q) {
    const files = this.app.vault.getMarkdownFiles();
    const ql = String(q || "").toLowerCase();
    const scored = [];
    for (const f of files) {
      const name = f.basename.toLowerCase();
      const path = f.path.toLowerCase();
      let score = -1;
      if (!ql) score = 0;
      else if (name.startsWith(ql)) score = 0;
      else if (name.includes(ql)) score = 1;
      else if (path.includes(ql)) score = 2;
      if (score >= 0) scored.push({ file: f, score });
    }
    scored.sort((a, b) => (a.score - b.score) || a.file.basename.localeCompare(b.file.basename));
    return scored.slice(0, 20);
  }

  renderMentionPopup(items) {
    if (!this.mentionPopupEl) {
      this.mentionPopupEl = this.inputBoxEl.createDiv({ cls: "agent-client-mention-dropdown dsh-hidden" });
    }
    this.mentionPopupEl.empty();
    this.mentionItems = items;
    this.mentionIndex = 0;
    if (items.length === 0) {
      this.mentionPopupEl.createDiv({ cls: "agent-client-mention-dropdown-item agent-client-mention-dropdown-empty", text: "无匹配笔记" });
    } else {
      for (const it of items) {
        const item = this.mentionPopupEl.createDiv({ cls: "agent-client-mention-dropdown-item" });
        item.createDiv({ cls: "agent-client-mention-dropdown-item-name", text: it.file.basename });
        item.createDiv({ cls: "agent-client-mention-dropdown-item-path", text: it.file.path });
        item.addEventListener("click", () => this.insertMention(it));
      }
    }
    this.mentionPopupEl.removeClass("dsh-hidden");
    this.highlightMention();
  }

  highlightMention() {
    const kids = (this.mentionPopupEl && this.mentionPopupEl.children) || [];
    kids.forEach((el, i) => {
      if (el.classList && el.classList.toggle) el.classList.toggle("agent-client-selected", i === this.mentionIndex);
    });
  }

  moveMention(delta) {
    const n = (this.mentionItems || []).length;
    if (!n) return;
    this.mentionIndex = (this.mentionIndex + delta + n) % n;
    this.highlightMention();
  }

  selectMention() {
    const it = (this.mentionItems || [])[this.mentionIndex];
    if (it) this.insertMention(it);
  }

  insertMention(it) {
    if (!this.inputEl) return;
    const pos = this.mentionInsertPos != null ? this.mentionInsertPos : (this.inputEl.selectionStart || 0);
    const before = this.inputEl.value.slice(0, pos);
    const after = this.inputEl.value.slice(pos);
    const mention = "@[[" + it.file.basename + "]]";
    this.inputEl.value = before + mention + after;
    this.inputEl.focus();
    const newPos = pos + mention.length;
    this.inputEl.selectionStart = this.inputEl.selectionEnd = newPos;
    this.closeMentionPopup();
    this.autoGrowInput();
    this.updateSendIcon();
  }

  closeMentionPopup() {
    if (this.mentionPopupEl) this.mentionPopupEl.addClass("dsh-hidden");
    this.mentionItems = [];
    this.mentionQuery = null;
  }

  /** 从文本里提取 @[[笔记名]] 提及 */
  parseMentions(text) {
    const out = [];
    const re = /@\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(String(text || "")))) out.push(m[1]);
    return out;
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

  /** 刷新工具栏下拉的当前值 + label */
  setToolbarValue(btn, value) {
    if (!btn) return;
    btn.__value = value;
    const labelEl = btn.querySelector(".agent-client-toolbar-dropdown-label");
    if (labelEl) {
      const o = (btn.__opts || []).find((x) => x.value === value);
      labelEl.setText(o ? o.label : (btn.__label || ""));
    }
  }

  syncSelectionRow() {
    this.setToolbarValue(this.modelBtn, this.currentModel());
    this.setToolbarValue(this.effortBtn, this.currentEffort());
    this.setToolbarValue(this.permBtn, this.currentPerm());
  }

  /** 扫描模型后刷新模型下拉（保留当前选择） */
  refreshModelOptions() {
    if (!this.modelBtn) return;
    const keep = this.currentModel();
    const opts = this.modelOptions();
    this.modelBtn.__opts = opts;
    this.modelBtn.__value = keep;
    const area = this.modelBtn.querySelector(".agent-client-toolbar-dropdown-label-area");
    if (area) {
      area.empty();
      for (const o of opts) area.createSpan({ cls: "agent-client-toolbar-dropdown-sizer", text: o.label });
      area.createSpan({ cls: "agent-client-toolbar-dropdown-label", text: (opts.find((o) => o.value === keep) || {}).label || "模型" });
    }
  }

  selectionSnapshot() {
    return {
      model: this.modelBtn ? this.modelBtn.__value : this.currentModel(),
      effort: this.effortBtn ? this.effortBtn.__value : this.currentEffort(),
      permission: this.permBtn ? this.permBtn.__value : this.currentPerm(),
    };
  }

  /* ---------- 会话 ---------- */

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
    const isUser = m.role === "user";
    const wrap = this.messagesEl.createDiv({ cls: "agent-client-message-renderer agent-client-message-" + (isUser ? "user" : "assistant") });
    if (m.role === "user") {
      const txt = wrap.createDiv({ cls: "agent-client-text-with-mentions" });
      this.renderMentionsText(txt, m.content || "");
      // 自动附带的当前笔记/选区：显示为可点击的 @[[笔记]] 提及
      if (m.notePath) {
        const name = String(m.notePath).split("/").pop().replace(/\.md$/i, "");
        const chip = txt.createSpan({ cls: "agent-client-text-mention", text: "@" + name });
        chip.setAttribute("title", m.notePath + (m.selection ? "（含选区）" : ""));
        chip.addEventListener("click", () => this.openInternalLink(m.notePath));
      }
    } else if (m.role === "error") {
      const pre = wrap.createEl("pre", { cls: "dsh-error-pre" });
      pre.setText(m.content || "未知错误");
    } else {
      const content = (m.content || "").trim();
      if (!content) {
        wrap.createDiv({ cls: "agent-client-chat-empty-state", text: "（空回复）" });
      } else {
        const md = wrap.createDiv({ cls: "agent-client-markdown-text-renderer" });
        MarkdownRenderer.renderMarkdown(content, md, "", this);
      }
    }
    // 悬停操作：复制按钮（回复内容本身可鼠标选中复制）
    if (!isUser) {
      const actions = wrap.createDiv({ cls: "agent-client-message-actions" });
      const copyBtn = actions.createEl("button", { cls: "clickable-icon agent-client-message-action-button", attr: { "aria-label": "复制", title: "复制" } });
      setIcon(copyBtn, "copy");
      copyBtn.addEventListener("click", () => {
        try {
          navigator.clipboard.writeText(m.content || "").then(() => new Notice("已复制"));
        } catch (e) { /* ignore */ }
      });
    }
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

  /** 把 @[[笔记]] 渲染成可点击的提及 chip */
  renderMentionsText(container, text) {
    const re = /@\[\[([^\]]+)\]\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) container.createSpan({ text: text.slice(last, m.index) });
      const chip = container.createSpan({ cls: "agent-client-text-mention", text: "@" + m[1] });
      chip.addEventListener("click", () => this.openInternalLink(m[1]));
      last = m.index + m[0].length;
    }
    if (last < text.length) container.createSpan({ text: text.slice(last) });
  }

  /** 渲染折叠的思考面板（assistant 消息上方；无论有无内容都显示，永不消失） */
  renderThinkingPanel(thinking) {
    const tools = thinking && Array.isArray(thinking.tools) ? thinking.tools : [];
    const hasReasoning = !!(thinking && thinking.reasoning);
    const hasTools = tools.length > 0;
    const panel = this.messagesEl.createDiv({ cls: "agent-client-collapsible-thought" });
    const head = panel.createDiv({ cls: "agent-client-collapsible-thought-header" });
    head.createSpan({ text: "思考过程 · " + (thinking ? thinking.seconds : 0) + "s" + (tools.length ? " · " + tools.length + " 步工具" : "") });
    const icon = head.createSpan({ cls: "agent-client-collapsible-thought-icon" });
    setIcon(icon, "chevron-down");
    const body = panel.createDiv({ cls: "agent-client-collapsible-thought-content dsh-hidden" });
    if (!hasReasoning && !hasTools) {
      body.createDiv({ text: "（本次没有推理/工具记录——可能是思考强度为关闭，或任务简单无需调用工具）" });
    } else {
      if (hasReasoning) body.createDiv({ cls: "agent-client-markdown-text-renderer", text: thinking.reasoning });
      if (hasTools) {
        for (const line of tools) {
          const t = body.createDiv({ cls: "agent-client-message-tool-call" });
          t.createDiv({ cls: "agent-client-message-tool-call-title", text: line });
        }
      }
    }
    head.addEventListener("click", () => {
      const hidden = body.classList.toggle("dsh-hidden");
      setIcon(icon, hidden ? "chevron-down" : "chevron-up");
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
    this.updateScrollBtn();
  }

  /* ---------- 发送 ---------- */

  async getContextBlocks(query) {
    const out = { blocks: "", notePath: null, selectionText: null };
    const s = this.plugin.settings;
    const attach = this.session ? this.session.autoAttach !== false : true; // 会话级开关
    const file = this.app.workspace.getActiveFile();
    let notePath = null;
    let selection = null;
    if (s.autoAttachNote && attach && file) notePath = file.path;
    if (s.autoAttachSelection && attach) {
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
    // @[[笔记]] 提及：附加对应笔记的路径 + 内容
    const mentions = this.parseMentions(query);
    for (const m of mentions) {
      let f = null;
      try {
        f = this.app.metadataCache.getFirstLinkpathDest(m, "") || this.app.vault.getAbstractFileByPath(m);
      } catch (e) { /* ignore */ }
      if (f && f instanceof TFile) {
        parts.push('<linked_note path="' + f.path + '" />');
        try {
          const content = await this.app.vault.cachedRead(f);
          parts.push('<note_content path="' + f.path + '">\n<![CDATA[\n' + String(content).slice(0, 30000) + "\n]]>\n</note_content>");
        } catch (e) { /* ignore */ }
      }
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

      const ctx = await this.getContextBlocks(query);
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
      }
    } finally {
      run.running = false;
      if (this.session && this.session.id === session.id) this.updateRunningUI(false);
    }
    await this.runNextFor(session, run);
  }

  updateRunningUI(running) {
    if (!this.sendBtn) return;
    setIcon(this.sendBtn, running ? "square" : "send-horizontal");
    this.sendBtn.setAttribute("title", running ? "停止生成" : "发送消息");
    this.updateSendIcon();
    if (!running) {
      this.stopStatusTimer();
      this.statusEl.addClass("dsh-hidden");
      this.statusEl.setText("");
    }
  }

  /** 发送/停止按钮图标状态：运行中=红方块；有输入=主题色；空输入=灰色 */
  updateSendIcon() {
    if (!this.sendBtn) return;
    const running = !!(this.activeRun && this.activeRun.running);
    const svg = this.sendBtn.querySelector("svg");
    if (!svg) return;
    svg.classList.remove("agent-client-icon-sending", "agent-client-icon-active", "agent-client-icon-inactive");
    svg.classList.add(running ? "agent-client-icon-sending" : (this.inputEl && this.inputEl.value.trim() ? "agent-client-icon-active" : "agent-client-icon-inactive"));
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
    const wrap = this.messagesEl.createDiv({ cls: "agent-client-collapsible-thought" });
    const head = wrap.createDiv({ cls: "agent-client-collapsible-thought-header", attr: { title: "点击展开/收起" } });
    const sec = Math.round((Date.now() - run.statusStart) / 1000);
    this.thinkingTimeEl = head.createSpan({ text: "思考过程 · " + sec + "s（点击展开）" });
    const icon = head.createSpan({ cls: "agent-client-collapsible-thought-icon" });
    setIcon(icon, "chevron-down");
    const body = wrap.createDiv({ cls: "agent-client-collapsible-thought-content dsh-hidden" });
    this.thinkingReasonEl = body.createDiv({ cls: "agent-client-markdown-text-renderer", text: (run.live && run.live.reasoning) || "" });
    this.thinkingToolsEl = body.createDiv();
    if (run.live && run.live.tools) {
      for (const t of run.live.tools) this.addLiveToolLine(t);
    }
    this.liveBody = body;
    this.liveIcon = icon;
    head.addEventListener("click", () => {
      if (!this.liveBody) return;
      const hidden = this.liveBody.classList.toggle("dsh-hidden");
      setIcon(this.liveIcon, hidden ? "chevron-down" : "chevron-up");
    });
    // 实时回复文本（思考面板下方，流式追加）
    const textWrap = this.messagesEl.createDiv({ cls: "agent-client-message-renderer agent-client-message-assistant" });
    this.liveTextEl = textWrap.createDiv({ cls: "agent-client-markdown-text-renderer", text: (run.live && run.live.text) || "" });
    if (run.statusTimer) clearInterval(run.statusTimer);
    run.statusTimer = setInterval(() => {
      if (this.disposed || !run.running || !run.live) return;
      if (this.session && this.session.id === run.sessionId && this.thinkingTimeEl) {
        const s2 = Math.round((Date.now() - run.statusStart) / 1000);
        this.thinkingTimeEl.setText("思考过程 · " + s2 + "s（点击展开）");
      }
    }, 1000);
  }

  /** 追加一行工具调用块（实时流式） */
  addLiveToolLine(line) {
    if (!this.thinkingToolsEl) return;
    const t = this.thinkingToolsEl.createDiv({ cls: "agent-client-message-tool-call" });
    t.createDiv({ cls: "agent-client-message-tool-call-title", text: line });
    t.setAttribute("title", line);
    return t;
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
        if (isActive) this.addLiveToolLine(run.live.tools[run.live.tools.length - 1]);
        run.live.steps += 1;
      } else if (ev.type === "tool/call" && d.name) {
        // 去重（tool-call-chunks 已展示过同一 id 时不重复）
        if (run.live.tools.some((t) => t.indexOf(d.name) >= 0)) return;
        const args = String(d.arguments || "").replace(/\s+/g, " ").slice(0, 90);
        run.live.tools.push("⚙ " + d.name + (args ? "  " + args : ""));
        if (isActive) this.addLiveToolLine(run.live.tools[run.live.tools.length - 1]);
        run.live.steps += 1;
      } else if (ev.type === "text-chunks" && Array.isArray(d.texts)) {
        run.live.text += d.texts.join("");
        if (isActive && this.liveTextEl) this.liveTextEl.setText(run.live.text);
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
    this.updateScrollBtn();
  }

  /** 回到底部按钮：离开底部超过 120px 时显示 */
  updateScrollBtn() {
    if (!this.scrollBtn || !this.messagesEl) return;
    const el = this.messagesEl;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 120) this.scrollBtn.removeClass("dsh-hidden");
    else this.scrollBtn.addClass("dsh-hidden");
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
    if (!this.titleEl) return;
    const t = this.session ? this.session.title : "新会话";
    this.titleEl.setText(t);
    const leaf = this.leaf;
    if (leaf && typeof leaf.updateHeader === "function") {
      try { leaf.updateHeader(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- 导出为 Markdown（参考 agent-client 的 ChatExport） ---------- */

  async exportChat() {
    const session = this.session;
    if (!session || !session.messages || session.messages.length === 0) {
      new Notice("当前没有可导出的对话");
      return;
    }
    const date = new Date();
    const stamp = pad(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes());
    const safeTitle = (session.title || "会话").replace(/[\\/:*?"<>|]/g, "_");
    const fname = "DSH 对话 " + safeTitle + " " + stamp + ".md";
    const lines = [];
    lines.push("---");
    lines.push("title: " + (session.title || "DSH 对话"));
    lines.push("date: " + date.toISOString());
    lines.push("agent: DSH (DeepSeek Harness)");
    lines.push("model: " + (session.model || "") );
    lines.push("---");
    lines.push("");
    for (const m of session.messages) {
      lines.push("## " + (m.role === "user" ? "我" : m.role === "error" ? "错误" : "DSH") + " · " + fmtTime(m.ts));
      lines.push("");
      if (m.role === "user") {
        lines.push(String(m.content || ""));
      } else if (m.role === "error") {
        lines.push("> [!error] 错误\n> " + String(m.content || "").replace(/\n/g, "\n> "));
      } else {
        lines.push(String(m.content || ""));
      }
      lines.push("");
    }
    const content = lines.join("\n");
    try {
      const file = await this.app.vault.create(fname, content);
      new Notice("已导出：" + fname);
      this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      // 重名则尝试加序号
      try {
        for (let i = 2; i <= 99; i++) {
          const alt = "DSH 对话 " + safeTitle + " " + stamp + "-" + i + ".md";
          try {
            const file = await this.app.vault.create(alt, content);
            new Notice("已导出：" + alt);
            this.app.workspace.getLeaf(false).openFile(file);
            return;
          } catch (e2) { /* try next */ }
        }
      } catch (e2) { /* ignore */ }
      this.plugin.logError("exportChat", e);
      new Notice("导出失败：" + (e && e.message ? e.message : String(e)));
    }
  }
}

/* ============================ 会话管理器视图 ============================ */

class DSHSessionManagerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return SESSION_MANAGER_VIEW; }
  getDisplayText() { return "DSH 会话管理器"; }
  getIcon() { return "history"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("dsh-view");
    this.listEl = this.contentEl.createDiv({ cls: "agent-client-session-manager" });
    await this.renderList();
    // 会话变化时刷新（聊天视图保存/删除后）
    this.registerEvent(this.app.workspace.on("layout-change", () => this.renderList()));
  }

  async renderList() {
    this.listEl.empty();
    let sessions = [];
    try { sessions = await this.plugin.listSessions(); } catch (e) { /* ignore */ }
    if (sessions.length === 0) {
      this.listEl.createDiv({ cls: "agent-client-session-manager-empty", text: "暂无会话——打开 DSH 聊天面板开始对话" });
      return;
    }
    for (const s of sessions.slice(0, 200)) {
      const item = this.listEl.createDiv({ cls: "tree-item" });
      const self = item.createDiv({ cls: "tree-item-self" });
      const icon = self.createDiv({ cls: "agent-client-session-status-icon agent-client-session-status-ready" });
      setIcon(icon, "message-square");
      const text = self.createDiv({ cls: "agent-client-session-item-text" });
      text.createDiv({ cls: "agent-client-session-item-title", text: s.title || "未命名" });
      text.createDiv({ cls: "agent-client-session-item-agent", text: (s.messages ? s.messages.length : 0) + " 条消息 · " + fmtTime(s.lastActivityAt) });
      self.addEventListener("click", () => this.plugin.openSessionById(s.id));
      const more = item.createEl("button", { cls: "clickable-icon agent-client-session-item-more", attr: { "aria-label": "删除", title: "删除会话" } });
      setIcon(more, "trash");
      more.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.deleteSession(s.id);
        this.renderList();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
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

/* ============================ 会话历史弹窗 ============================ */

class DSHSessionHistoryModal extends Modal {
  constructor(app, plugin, onSelect) {
    super(app);
    this.plugin = plugin;
    this.onSelect = onSelect;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "会话历史" });
    this.filterEl = contentEl.createEl("input", {
      cls: "agent-client-session-history-filter",
      attr: { placeholder: "搜索会话标题…", type: "text" },
    });
    this.listEl = contentEl.createDiv({ cls: "agent-client-session-history-list" });
    this.filterEl.addEventListener("input", () => this.render());
    this.filterEl.focus();
    await this.render();
  }

  async render() {
    this.listEl.empty();
    const q = (this.filterEl ? this.filterEl.value : "").toLowerCase().trim();
    let sessions = [];
    try { sessions = await this.plugin.listSessions(); } catch (e) { /* ignore */ }
    const filtered = q ? sessions.filter((s) => String(s.title || "").toLowerCase().includes(q)) : sessions;
    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "agent-client-session-history-empty", text: "暂无会话" });
      return;
    }
    for (const s of filtered.slice(0, 100)) {
      const item = this.listEl.createDiv({ cls: "agent-client-session-history-item" });
      const content = item.createDiv({ cls: "agent-client-session-history-item-content" });
      content.createDiv({ cls: "agent-client-session-history-item-title", text: s.title || "未命名" });
      const meta = content.createDiv({ cls: "agent-client-session-history-item-metadata" });
      meta.createSpan({ cls: "agent-client-session-history-item-timestamp", text: (s.messages ? s.messages.length : 0) + " 条消息 · " + fmtTime(s.lastActivityAt) });
      const actions = item.createDiv({ cls: "agent-client-session-history-item-actions" });
      const open = actions.createEl("div", { cls: "clickable-icon agent-client-session-history-action-icon agent-client-session-history-restore-icon", attr: { "aria-label": "打开", title: "打开" } });
      setIcon(open, "arrow-right");
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onSelect(s);
        this.close();
      });
      const del = actions.createEl("div", { cls: "clickable-icon agent-client-session-history-action-icon", attr: { "aria-label": "删除", title: "删除" } });
      setIcon(del, "trash");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.deleteSession(s.id);
        this.render();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = DSHPlugin;
