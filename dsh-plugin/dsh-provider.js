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
  const re = new RegExp("^" + sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:");
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
 * 扫描 settings.yaml 里所有 llm-* 段的模型目录（支持嵌套 providers）：
 *   - 平铺：llm-deepseek.models: [ - id: x, name: y ]
 *   - 嵌套：llm-pi-ai.providers.<route>.models: [ - id: x, name: y ]
 * 每条模型记录 provider 字段 = 运行时要写入 agent-default-model.provider 的路由
 * （嵌套结构取 provider 键名，如 opencode-go；平铺结构取段内 provider 子键或默认）。
 * @param {string} yamlText
 * @returns {Array<{id:string,name:string,provider:string}>}
 */
function scanModelCatalog(yamlText) {
  const lines = String(yamlText || "").split(/\r?\n/);
  const models = [];
  let section = null;
  let provider = null;
  let inModelsList = false;
  let inProvidersMap = false;
  let modelItem = null;

  const flush = () => {
    if (modelItem && modelItem.id) {
      models.push({
        id: modelItem.id,
        name: modelItem.name || modelItem.id,
        provider: modelItem.provider || provider || DEFAULT_MODEL_PROVIDER,
      });
    }
    modelItem = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const mTop = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!/^\s/.test(line)) {
      flush();
      section = (mTop && mTop[1].startsWith("llm-")) ? mTop[1] : null;
      provider = null; inModelsList = false; inProvidersMap = false;
      continue;
    }
    if (!section) continue;
    const itemLine = line.match(/^\s*-\s*id\s*:\s*(.+)$/);
    const kv = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (itemLine && inModelsList) {
      flush();
      modelItem = { id: itemLine[1].trim().replace(/^['"]|['"]$/g, ""), name: null };
      continue;
    }
    if (!kv) continue;
    const key = kv[2];
    const val = kv[3].trim().replace(/^['"]|['"]$/g, "");
    const keyInd = kv[1].length;
    if (key === "providers") { flush(); inProvidersMap = true; inModelsList = false; continue; }
    if (key === "models") { flush(); inModelsList = true; continue; }
    if (modelItem) {
      if (key === "name") modelItem.name = val;
      else if (key === "provider") modelItem.provider = val;
      continue;
    }
    if (!val && inProvidersMap && keyInd >= 4) { provider = key; inModelsList = false; continue; }
    if (!val && keyInd <= 2) { inProvidersMap = false; continue; }
    if (val && key === "provider") { provider = val; }
  }
  flush();
  return models;
}

/**
 * 扫描本机 dsh 配置，得到可用模型目录与默认选择（「一键自动配置」的数据源）。
 * 模型来源：真实 DSH_HOME/settings.yaml 里所有 llm-* 段的 models
 * （llm-deepseek 平铺，或 llm-pi-ai 等嵌套 providers）；若都为空用默认（V4 Flash + V4 Pro）。
 * 默认模型/思考强度：settings.yaml 的 agent-default-model。
 * @param {object} opts
 * @param {string} opts.baseHome 真实 DSH_HOME
 * @returns {{ok:boolean, baseHome:string, models:Array<{id:string,name:string,provider:string}>, defaultModel:string, defaultEffort:string, provider:string, credentialOk:boolean, source:string, error?:string}}
 */
function scanModels(opts) {
  try {
    const baseHome = opts.baseHome || path.join(homedir(), ".dsh");
    let yaml = "";
    const settingsPath = path.join(baseHome, "settings.yaml");
    try { if (fs.existsSync(settingsPath)) yaml = fs.readFileSync(settingsPath, "utf8"); } catch (e) { /* ignore */ }

    const adm = parseYamlSection(yaml, "agent-default-model").sub;
    const provider = adm.provider || DEFAULT_MODEL_PROVIDER;
    const defaultModel = adm.model || "deepseek-v4-flash";
    const rawEffort = adm.reasoningEffort;
    const defaultEffort = (rawEffort === "off" || rawEffort === "high" || rawEffort === "max") ? rawEffort : "high";

    let models = scanModelCatalog(yaml);
    if (models.length === 0) {
      models = [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", provider: DEFAULT_MODEL_PROVIDER },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", provider: DEFAULT_MODEL_PROVIDER },
      ];
    }

    let credentialOk = false;
    try {
      const cred = fs.readFileSync(path.join(baseHome, ".credentials.yaml"), "utf8");
      credentialOk = /^\s*[A-Za-z0-9_]+\s*:\s*\S+/m.test(cred); // 任意一个凭据键非空
    } catch (e) { /* ignore */ }

    return {
      ok: true,
      baseHome,
      models,
      defaultModel,
      defaultEffort,
      provider,
      credentialOk,
      source: models.length ? "settings" : "defaults",
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
 *  2. 每次都从 baseHome 刷新 .credentials.yaml 与 settings.yaml（用户改配置后
 *     立即生效，避免 runtime 里的旧拷贝过期）；
 *  3. 用所选模型/思考强度/路由重写 settings.yaml 的 agent-default-model 段。
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

    // 凭据：每次都从 baseHome 刷新
    const credDst = path.join(runtimeHome, ".credentials.yaml");
    const credSrc = path.join(baseHome, ".credentials.yaml");
    try {
      if (fs.existsSync(credSrc)) fs.copyFileSync(credSrc, credDst);
    } catch (e) { /* ignore */ }

    // settings.yaml 基底：每次都从 baseHome 刷新（保留用户的 llm-* 等全部配置）
    const settingsPath = path.join(runtimeHome, "settings.yaml");
    const src = path.join(baseHome, "settings.yaml");
    try {
      if (fs.existsSync(src)) fs.copyFileSync(src, settingsPath);
    } catch (e) { /* ignore */ }

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

/** 简易自测：node dsh-provider.js <task> */
if (require.main === module) {
  const task = process.argv.slice(2).join(" ") || "用一句话回答：2+2等于几？";
  const t = resolveSpawnTarget("");
  console.log("[dsh-provider] 解析结果:", t ? JSON.stringify(t) : "null");
  runHeadless({ cwd: process.cwd(), task, timeoutMs: 180000 })
    .then((r) => {
      console.log("\n[dsh-provider] ok =", r.ok, "| code =", r.code, "| 耗时 =", r.durationMs + "ms");
      if (r.stdout) console.log("----- stdout -----\n" + r.stdout);
      if (r.stderr) console.log("----- stderr -----\n" + r.stderr);
      process.exit(r.ok ? 0 : 1);
    });
}

module.exports = { runHeadless, resolveSpawnTarget, describeTarget, findDshEntry, resolveNodePath, parseArgsTokens, prepareRuntimeHome, scanModels, scanModelCatalog, parseYamlSection, DEFAULT_MODEL_PROVIDER };
