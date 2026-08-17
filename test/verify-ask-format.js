const { prepareRuntimeHome, runHeadless } = require("../dsh-plugin/dsh-provider.js");
const os = require("os"), path = require("path"), fs = require("fs");

async function runCase(name, answerShape) {
  const rt = path.join(os.tmpdir(), "dsh-rt-verify-" + Date.now() + "-" + name);
  const prep = prepareRuntimeHome({ baseHome: path.join(os.homedir(), ".dsh"), runtimeHome: rt, selection: { provider: "opencode-go", model: "deepseek-v4-flash", reasoningEffort: "max" } });
  if (!prep.ok) { console.log(name, "prep fail", prep.error); return; }
  const pkgDir = __dirname + "/../dsh-plugin";
  const src = fs.readFileSync(path.join(pkgDir, "ask-bridge.cjs"), "utf8");
  const bridgeFile = path.join(rt, "ask-bridge.cjs");
  fs.writeFileSync(bridgeFile, src, "utf8");
  const dir = path.join(rt, "ask-bridge"); fs.mkdirSync(dir, { recursive: true });
  const patchPath = path.join(rt, "ask-bridge.patch.yml");
  fs.writeFileSync(patchPath, [
    "- insert:", "    - id: ask-bridge-provider", "      name: file:///" + bridgeFile.replace(/\\/g, "/"),
    "- insert:", "    - id: tool-ask-user", "      name: '@deepseek-ai/dsh-tool-ask-user'", "",
  ].join("\n"), "utf8");
  const resP = runHeadless({ cwd: process.cwd(), task: "用 ask_user_question 问我：要 A 还是 B？选项 A / B，等回答。", dshHome: rt, permissionMode: "workspace-write", timeoutMs: 45000, bridgePatchPath: patchPath, bridgeDir: dir });
  const started = Date.now();
  const answeredIds = new Set();
  const iv = setInterval(() => {
    const qf = path.join(dir, "question.json");
    if (fs.existsSync(qf)) {
      try {
        const q = JSON.parse(fs.readFileSync(qf, "utf8"));
        if (answeredIds.has(q.id)) return; // 只答一次
        answeredIds.add(q.id);
        const answers = (q.questions || []).map((x) => ({ id: x.id, ...answerShape(x) }));
        fs.writeFileSync(path.join(dir, "answer-" + q.id + ".json"), JSON.stringify({ answers }), "utf8");
        console.log("[" + name + "] answered:", JSON.stringify({ answers }));
      } catch (e) { console.log("[" + name + "] err", e.message); }
    }
    if (Date.now() - started > 40000) { clearInterval(iv); console.log("[" + name + "] timeout"); }
  }, 300);
  const res = await resP; clearInterval(iv);
  console.log("[" + name + "] ok=", res.ok, "| stdout=", JSON.stringify((res.stdout || "").toString().trim().slice(0, 120)), "| stderr=", JSON.stringify((res.stderr || "").toString().trim().slice(0, 200)));
  try { fs.rmSync(rt, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  // 形态1：正常 selected
  await runCase("normal", (x) => ({ selected: ["A"] }));
  // 形态2：空 selected + custom
  await runCase("custom", (x) => ({ selected: [], custom: "自定义答复" }));
  console.log("DONE");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
