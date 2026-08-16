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
    this.queue = [];
    this.interjectQuery = null;
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
    if (this.running) this.cancel();
    else this.onSend();
  }

  async onSend() {
    if (this.disposed) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    if (this.running) {
      // 运行中：加入排队
      this.queue.push(query);
      this.inputEl.value = "";
      this.renderQueue();
      new Notice("已加入排队（" + this.queue.length + " 条），当前任务完成后自动运行");
      return;
    }
    this.inputEl.value = "";
    await this.runOne(query);
  }

  /** 插话：中断当前任务，立即带着上下文处理新消息（优先于排队） */
  onInterject() {
    if (this.disposed) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    this.inputEl.value = "";
    if (this.running) {
      this.cancel(); // 中断当前并清空排队
      this.interjectQuery = query;
      new Notice("已插话，正在中断当前任务…");
    } else {
      this.interjectQuery = query;
      this.runNext();
    }
  }

  /** 处理下一个任务：插话 > 排队 > 无 */
  async runNext() {
    if (this.disposed) return;
    if (this.interjectQuery != null) {
      const q = this.interjectQuery;
      this.interjectQuery = null;
      this.renderQueue();
      await this.runOne(q);
    } else if (this.queue.length > 0) {
      const q = this.queue.shift();
      this.renderQueue();
      await this.runOne(q);
    } else {
      this.renderQueue();
    }
  }

  cancel() {
    if (!this.running || !this.cancelToken) return;
    this.cancelToken.cancelled = true;
    if (this.cancelToken.cancel) this.cancelToken.cancel();
    this.queue.length = 0; // 清空排队
    this.interjectQuery = null;
    this.renderQueue();
    new Notice("正在停止…");
  }

  /** 排队栏：每条排队项带「重新编辑 / 取消排队 / 插话发送」按钮 */
  renderQueue() {
    if (!this.queueEl) return;
    this.queueEl.empty();
    if (this.queue.length === 0) {
      this.queueEl.addClass("dsh-hidden");
      return;
    }
    this.queueEl.removeClass("dsh-hidden");
    this.queueEl.createDiv({ cls: "dsh-queue-header", text: "排队中 " + this.queue.length + " 条（完成后自动运行）" });
    this.queue.forEach((q, idx) => {
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
    const q = this.queue.splice(idx, 1)[0];
    if (q == null) return;
    this.inputEl.value = q;
    this.renderQueue();
    this.inputEl.focus();
  }

  queueRemove(idx) {
    this.queue.splice(idx, 1);
    this.renderQueue();
  }

  /** 把某条排队项立刻插话发送：中断当前，立即处理它 */
  queueInterject(idx) {
    const q = this.queue.splice(idx, 1)[0];
    if (q == null) return;
    if (this.running) {
      this.cancel(); // 中断当前并清空其余排队
      this.interjectQuery = q;
      new Notice("已插话发送…");
    } else {
      this.interjectQuery = q;
      this.runNext();
    }
  }

  async runOne(query) {
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
      if (res.cancelled) {
        const partial = (res.stdout || "").trim();
        this.session.messages.push({ role: "assistant", content: partial ? partial + "\n\n（已取消）" : "（已取消）", ts: Date.now(), thinking });
      } else if (res.ok) {
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
    // 处理下一个：插话优先，其次排队
    await this.runNext();
  }

  updateRunningUI(running) {
    // 输入框保持可用（运行中可继续输入，Enter 入队）
    this.sendBtn.setText(running ? "停止" : "发送");
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
      this.scrollToBottomIfNear();
    } catch (e) { /* ignore */ }
  }

  /** 智能滚动：仅当用户本来就贴近底部时才自动跟滚，手动上翻查看历史时不打扰 */
  scrollToBottomIfNear() {
    const el = this.messagesEl;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 60) el.scrollTop = el.scrollHeight;
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
