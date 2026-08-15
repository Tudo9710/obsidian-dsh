/**
 * test/provider-test.js — 独立验证 dsh-provider 调用链路（不需要 Obsidian）
 *
 * 用法：
 *   node test/provider-test.js [task]
 * 默认以本仓库根目录为工作目录跑一个读文件任务。
 */
"use strict";

const path = require("path");
const { runHeadless, describeTarget, resolveSpawnTarget } = require("../dsh-plugin/dsh-provider.js");

const VAULT = path.join(__dirname, "..");
const testTask = process.argv.slice(2).join(" ") ||
  "当前工作目录是一个 Obsidian 库。请读取 README.md 的第一行，然后用一句话告诉我这个库是做什么的。不要修改任何文件。";

(async () => {
  console.log("== 1) 目标解析 ==");
  const t = resolveSpawnTarget("");
  console.log("source:", t.source, "| command:", t.command, "| prefix:", t.argsPrefix);

  console.log("\n== 2) 带换行/引号/中文的复杂任务（验证 argv 传递）==");
  const tricky = '你好 DSH。\n请回答：什么是 "Obsidian"？\n用一行中文回复。';
  const r1 = await runHeadless({ cwd: process.cwd(), task: tricky, timeoutMs: 180000 });
  console.log("ok =", r1.ok, "| code =", r1.code, "| 耗时 =", r1.durationMs + "ms");
  console.log("stdout:", JSON.stringify(r1.stdout));

  console.log("\n== 3) vault 为 cwd 的读文件任务 ==");
  const r2 = await runHeadless({ cwd: VAULT, task: testTask, timeoutMs: 240000 });
  console.log("ok =", r2.ok, "| code =", r2.code, "| 耗时 =", r2.durationMs + "ms");
  if (r2.stdout) console.log("--- 回答 ---\n" + r2.stdout.trim());
  if (r2.stderr) console.log("--- stderr ---\n" + r2.stderr.trim());
  if (!r2.ok) process.exit(1);

  console.log("\n== 4) describeTarget（设置页展示用）==");
  console.log(describeTarget("").line);

  console.log("\n== 5) 取消令牌（启动后立即取消）==");
  const token = { cancelled: false };
  const r3p = runHeadless({ cwd: process.cwd(), task: "请写一篇500字的中文短文。", timeoutMs: 120000, cancelToken: token });
  setTimeout(() => { token.cancelled = true; if (token.cancel) token.cancel(); }, 1500);
  const r3 = await r3p;
  console.log("cancelled =", r3.cancelled, "| ok =", r3.ok, "| 耗时 =", r3.durationMs + "ms");

  console.log("\n== 6) extraArgs 解析（--patch C:/x.yml 与带空格路径）==");
  const { parseArgsTokens } = require("../dsh-plugin/dsh-provider.js");
  console.log(JSON.stringify(parseArgsTokens('--patch "C:/My Path/extra.yml" --profile web')));

  console.log("\n== 7) runtime home + 模型/思考强度切换（headless 自报模型）==");
  const { prepareRuntimeHome } = require("../dsh-plugin/dsh-provider.js");
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const runtimeHome = path.join(os.tmpdir(), "dsh-plugin-test-home-" + Date.now());
  const prep = prepareRuntimeHome({
    baseHome: path.join(os.homedir(), ".dsh"),
    runtimeHome,
    selection: { model: "deepseek-v4-pro", reasoningEffort: "max" },
  });
  console.log("prep.ok =", prep.ok, "| home =", prep.home);
  if (!prep.ok) { console.error("❌ runtime home 准备失败:", prep.error); process.exit(1); }
  const settingsText = fs.readFileSync(path.join(runtimeHome, "settings.yaml"), "utf8");
  console.log("settings.yaml 含 agent-default-model =", /agent-default-model:\s*\n\s*provider: deepseek-official\s*\n\s*model: deepseek-v4-pro\s*\n\s*reasoningEffort: max/.test(settingsText));
  const r4 = await runHeadless({
    cwd: process.cwd(),
    task: "你被描述为哪个模型驱动的 agent？只回答模型名。",
    dshHome: runtimeHome,
    timeoutMs: 180000,
  });
  console.log("模型自报 =", JSON.stringify((r4.stdout || "").trim()), "| ok =", r4.ok);
  try { fs.rmSync(runtimeHome, { recursive: true, force: true }); } catch (e) {}
  if (!r4.ok || !/(deepseek-v4-pro)/i.test(r4.stdout || "")) {
    console.error("❌ 模型切换验证失败");
    process.exit(1);
  }

  console.log("\n== 8) 模型扫描（scanModels：settings.yaml 自定义模型 / 默认回退 / 凭据）==");
  const { scanModels } = require("../dsh-plugin/dsh-provider.js");
  const fakeHome = path.join(os.tmpdir(), "dsh-plugin-scan-home-" + Date.now());
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(path.join(fakeHome, "settings.yaml"), [
    "ui-onboarding:",
    "  welcomeNoticeVersion: x",
    "agent-presets:",
    "  default: cordis",
    "agent-default-model:",
    "  provider: deepseek-official",
    "  model: private-reasoner",
    "  reasoningEffort: max",
    "llm-deepseek:",
    "  models:",
    "    - id: deepseek-v4-flash",
    "      name: DeepSeek-V4-Flash",
    "    - id: deepseek-v4-pro",
    "      name: DeepSeek-V4-Pro",
    "    - id: private-reasoner",
    "      name: 私有推理模型",
    "      contextWindow: 512000",
  ].join("\n"));
  fs.writeFileSync(path.join(fakeHome, ".credentials.yaml"), "DEEPSEEK_API_" + "KEY: unit-test-dummy-key\n");
  const sc = scanModels({ baseHome: fakeHome });
  console.log("source =", sc.source, "| models =", JSON.stringify(sc.models), "| default =", sc.defaultModel, "| effort =", sc.defaultEffort, "| cred =", sc.credentialOk);
  if (!sc.ok || sc.models.length !== 3 || sc.models[2].id !== "private-reasoner" || sc.defaultModel !== "private-reasoner" || sc.defaultEffort !== "max" || !sc.credentialOk) {
    console.error("❌ 扫描结果不符合预期");
    process.exit(1);
  }
  // 无 settings.yaml 的 home → 默认回退
  const emptyHome = path.join(os.tmpdir(), "dsh-plugin-empty-" + Date.now());
  fs.mkdirSync(emptyHome, { recursive: true });
  const sc2 = scanModels({ baseHome: emptyHome });
  console.log("空 home 回退:", JSON.stringify(sc2.models), "| default =", sc2.defaultModel, "| cred =", sc2.credentialOk);
  if (sc2.models.length !== 2 || sc2.models[0].id !== "deepseek-v4-flash") { console.error("❌ 默认回退失败"); process.exit(1); }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (e) {}

  console.log("\n== 9) 实时事件流（live:true → reasoning/tool/text 事件）==");
  const liveHome = path.join(os.tmpdir(), "dsh-plugin-live-home-" + Date.now());
  fs.mkdirSync(liveHome, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), ".dsh", ".credentials.yaml"), path.join(liveHome, ".credentials.yaml"));
  fs.copyFileSync(path.join(os.homedir(), ".dsh", "settings.yaml"), path.join(liveHome, "settings.yaml"));
  let evCount = 0, reasonCount = 0, toolCount = 0;
  const r5 = await runHeadless({
    cwd: process.cwd(),
    task: "读取 README.md 前三行，然后用一句话总结。不要修改文件。",
    dshHome: liveHome,
    timeoutMs: 120000,
    live: true,
    onEvent: (ev) => {
      evCount++;
      if (ev.type === "reasoning-chunks") reasonCount++;
      if (ev.type === "tool-call-chunks" || ev.type === "tool/call") toolCount++;
    },
  });
  console.log("ok =", r5.ok, "| 事件总数 =", evCount, "| reasoning =", reasonCount, "| tool =", toolCount, "| 耗时 =", r5.durationMs + "ms");
  try { fs.rmSync(liveHome, { recursive: true, force: true }); } catch (e) {}
  if (!r5.ok || evCount === 0 || reasonCount === 0) {
    console.error("❌ 实时事件流验证失败");
    process.exit(1);
  }

  console.log("\n[provider-test] 全部通过 ✓");
})().catch((e) => {
  console.error("[provider-test] 失败:", e);
  process.exit(1);
});
