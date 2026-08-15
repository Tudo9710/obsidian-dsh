/**
 * test/stream-events-test.js — 验证 headless 会话事件可实时读取（思考过程的数据源）
 *
 * 做法：带 --patch（compression:none）跑 headless，运行中轮询 DSH_HOME/sessions
 * 下新出现的 .jsonl 文件，实时打印解析出的事件（thinking / tool / text）。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { findDshEntry } = require("../dsh-plugin/dsh-provider.js");

// 本地开发测试：需要本机有可用的 dsh（自动探测入口）与凭据
const DSH_HOME = path.join(__dirname, "..", ".dsh");
const ENTRY = findDshEntry();
if (!ENTRY) {
  console.error("未找到 dsh 安装（@deepseek-ai/dsh），请先安装。");
  process.exit(1);
}
const PATCH = path.join(DSH_HOME, "live.patch.yml");

fs.writeFileSync(PATCH, [
  "- id: session-persistence-jsonl",
  "  config:",
  "    root: !!js dshHomePath('sessions-live')",
  "    compression: none",
  "    writeBatchMaxDelayMs: 200",
].join("\n"));

// 记录任务开始前的会话文件（sessions-live 是独立的明文 root）
const sessRoot = path.join(DSH_HOME, "sessions-live");
const before = new Set();
(function scan(dir, acc) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p, acc);
      else if (/\.jsonl(\.zstd)?$/.test(e.name)) acc.add(p);
    }
  } catch (e) { /* ignore */ }
})(sessRoot, before);

const task = "请依次完成：1) 读取 README.md 的前几行；2) 读取 AGENTS.md 的标题；3) 结合两者写一句总结。不要修改文件。";
console.log("== 任务:", task.slice(0, 40), "…");
console.log("== 启动 headless（compression:none）…");

const child = spawn(process.execPath, [ENTRY, "--profile", "headless", "--patch", PATCH, task], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, DSH_HOME },
  windowsHide: true,
});

let targetFile = null;
const seenLines = new Set();
const t0 = Date.now();
const fmt = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const poll = setInterval(() => {
  // 找新文件
  if (!targetFile) {
    const now = new Set();
    (function scan(dir, acc) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) scan(p, acc);
          else if (/\.jsonl$/.test(e.name)) acc.add(p);
        }
      } catch (e) { /* ignore */ }
    })(sessRoot, now);
    for (const p of now) if (!before.has(p)) { targetFile = p; }
    if (targetFile) console.log(`[${fmt()}] 发现会话文件: ${targetFile}`);
  }
  if (!targetFile) return;
  // 增量读取新行
  try {
    const content = fs.readFileSync(targetFile, "utf8");
    for (const line of content.split("\n")) {
      const l = line.trim();
      if (!l || seenLines.has(l)) continue;
      seenLines.add(l);
      try {
        const ev = JSON.parse(l);
        const type = ev.type;
        if (type === "assistant/message") {
          const blocks = ev.data && ev.data.message && ev.data.message.content || [];
          for (const b of blocks) {
            if (b.type === "thinking") console.log(`[${fmt()}][思考] ${String(b.text || "").replace(/\n/g, " ").slice(0, 100)}`);
            else if (b.type === "text") console.log(`[${fmt()}][文本] ${String(b.text || "").replace(/\n/g, " ").slice(0, 80)}`);
            else console.log(`[${fmt()}][块:${b.type}]`);
          }
        } else if (type === "tool_use") {
          console.log(`[${fmt()}][工具] ${ev.data && ev.data.name}(${JSON.stringify((ev.data && ev.data.input) || {}).slice(0, 80)})`);
        } else if (type === "turn/start" || type === "turn/end") {
          console.log(`[${fmt()}][${type}]`);
        }
      } catch (e) { /* 非 JSON 行跳过 */ }
    }
  } catch (e) { /* ignore */ }
}, 300);

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (d) => process.stdout.write("[stdout] " + d));
child.stderr.on("data", (d) => process.stdout.write("[stderr] " + d));
child.on("close", (code) => {
  clearInterval(poll);
  console.log(`== 结束 code=${code} 总时长 ${fmt()} ==`);
  if (targetFile) {
    const size = fs.statSync(targetFile).size;
    console.log(`== 会话文件最终大小: ${size} bytes ==`);
  }
  process.exit(0);
});
child.on("error", (e) => { clearInterval(poll); console.error("spawn error", e); process.exit(1); });
