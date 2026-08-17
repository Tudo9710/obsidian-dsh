const { prepareRuntimeHome, runHeadless } = require("../dsh-plugin/dsh-provider.js");
const os = require("os"), path = require("path"), fs = require("fs");

(async () => {
  const rt = path.join(os.tmpdir(), "dsh-rt-pluginsim-" + Date.now());
  const prep = prepareRuntimeHome({
    baseHome: path.join(os.homedir(), ".dsh"),
    runtimeHome: rt,
    selection: { provider: "opencode-go", model: "deepseek-v4-flash", reasoningEffort: "max" },
  });
  console.log("prep.ok =", prep.ok, "| home =", prep.home, prep.error || "");
  if (!prep.ok) return;

  // === 完全复刻 prepareAskBridge ===
  const pluginDir = "E:\\BaiduSyncdisk\\Brand Harness Engineering\\.obsidian\\plugins\\dsh";
  const bridgeFile = path.join(pluginDir, "ask-bridge.cjs");
  console.log("bridgeFile exists:", fs.existsSync(bridgeFile));
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
  console.log("patch written:", patchPath, "| fileUrl:", fileUrl);

  // === 启动 + 自动应答 ===
  const task = "用 ask_user_question 工具向我提问：要不要继续？必须给出 继续 / 停止 两个选项，然后等待我的选择。";
  const resP = runHeadless({
    cwd: process.cwd(),
    task,
    dshHome: rt,
    permissionMode: "workspace-write",
    timeoutMs: 90000,
    bridgePatchPath: patchPath,
    bridgeDir: dir,
  });
  const started = Date.now();
  const iv = setInterval(() => {
    const qf = path.join(dir, "question.json");
    if (fs.existsSync(qf)) {
      try {
        const q = JSON.parse(fs.readFileSync(qf, "utf8"));
        console.log("[sim] QUESTION FOUND:", JSON.stringify(q).slice(0, 400));
        fs.writeFileSync(path.join(dir, "answer-" + q.id + ".json"), JSON.stringify({ answers: (q.questions || []).map((x) => ({ id: x.id, selected: [(x.options && x.options[0] ? x.options[0].label : "继续")] })) }), "utf8");
        console.log("[sim] ANSWERED");
      } catch (e) { console.log("[sim] question parse err", e.message); }
    }
    if (Date.now() - started > 80000) { clearInterval(iv); console.log("[sim] timeout waiting question"); }
  }, 300);
  const res = await resP;
  clearInterval(iv);
  console.log("res.ok =", res.ok, "| stdout =", JSON.stringify((res.stdout || "").toString().slice(0, 300)));
  console.log("res.stderr =", JSON.stringify((res.stderr || "").toString().slice(0, 300)));
  try { fs.rmSync(rt, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
