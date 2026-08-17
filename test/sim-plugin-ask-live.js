const { prepareRuntimeHome, runHeadless } = require("../dsh-plugin/dsh-provider.js");
const os = require("os"), path = require("path"), fs = require("fs");

(async () => {
  const rt = path.join(os.tmpdir(), "dsh-rt-pluginsim-live-" + Date.now());
  const prep = prepareRuntimeHome({
    baseHome: path.join(os.homedir(), ".dsh"),
    runtimeHome: rt,
    selection: { provider: "opencode-go", model: "deepseek-v4-flash", reasoningEffort: "max" },
  });
  if (!prep.ok) { console.log("prep fail", prep.error); return; }

  const pluginDir = "E:\\BaiduSyncdisk\\Brand Harness Engineering\\.obsidian\\plugins\\dsh";
  const bridgeFile = path.join(pluginDir, "ask-bridge.cjs");
  const patchPath = path.join(rt, "ask-bridge.patch.yml");
  const dir = path.join(rt, "ask-bridge");
  fs.mkdirSync(dir, { recursive: true });
  const fileUrl = "file:///" + bridgeFile.replace(/\\/g, "/");
  fs.writeFileSync(patchPath, [
    "- insert:",
    "    - id: ask-bridge-provider",
    "      name: " + fileUrl,
    "- insert:",
    "    - id: tool-ask-user",
    "      name: '@deepseek-ai/dsh-tool-ask-user'",
    "",
  ].join("\n"), "utf8");

  const task = "在开始前用 ask_user_question 工具问我：周报要不要包含数据表格？给出选项 包含 / 不包含，等我的回答。";
  let liveEvents = 0, reasons = 0, tools = 0, text = 0;
  const resP = runHeadless({
    cwd: process.cwd(),
    task,
    dshHome: rt,
    permissionMode: "workspace-write",
    timeoutMs: 90000,
    live: true,
    onEvent: (ev) => { liveEvents++; if (ev.type === "reasoning-chunks") reasons++; else if (ev.type === "tool-call-chunks" || ev.type === "tool/call") tools++; else if (ev.type === "text-chunks") text++; },
    bridgePatchPath: patchPath,
    bridgeDir: dir,
  });
  const started = Date.now();
  const iv = setInterval(() => {
    const qf = path.join(dir, "question.json");
    if (fs.existsSync(qf)) {
      try {
        const q = JSON.parse(fs.readFileSync(qf, "utf8"));
        console.log("[sim-live] QUESTION FOUND:", JSON.stringify(q).slice(0, 400));
        fs.writeFileSync(path.join(dir, "answer-" + q.id + ".json"), JSON.stringify({ answers: (q.questions || []).map((x) => ({ id: x.id, selected: ["包含"] })) }), "utf8");
        console.log("[sim-live] ANSWERED");
      } catch (e) { console.log("[sim-live] parse err", e.message); }
    }
    if (Date.now() - started > 80000) { clearInterval(iv); console.log("[sim-live] timeout waiting question"); }
  }, 300);
  const res = await resP;
  clearInterval(iv);
  console.log("liveEvents =", liveEvents, "| reasoning =", reasons, "| tool =", tools, "| text =", text);
  console.log("res.ok =", res.ok, "| stdout =", JSON.stringify((res.stdout || "").toString().slice(0, 300)));
  console.log("res.stderr =", JSON.stringify((res.stderr || "").toString().slice(0, 300)));
  try { fs.rmSync(rt, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
