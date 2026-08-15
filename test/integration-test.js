/**
 * test/integration-test.js — 模拟插件完整消息流（不依赖 Obsidian）
 *
 * 复刻 main.js 中 buildTaskText 的组装逻辑 + getContextBlocks 的标签格式，
 * 用真实 headless 调用验证：
 *  1. 多轮对话记录能维持上下文
 *  2. <linked_note> 与 <editor_selection> 标签被 agent 理解
 */
"use strict";

const path = require("path");
const { runHeadless } = require("../dsh-plugin/dsh-provider.js");

const VAULT = path.join(__dirname, "..");

// 与 main.js BUILTIN_PROMPT 保持一致（此处为验证用副本）
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

const MAX_TRANSCRIPT_TURNS = 20;

function buildTaskText(customPrompt, messages, query, ctx) {
  const parts = [];
  parts.push(customPrompt ? BUILTIN_PROMPT + "\n\n" + customPrompt.trim() : BUILTIN_PROMPT);
  const prev = (messages || []).slice(-MAX_TRANSCRIPT_TURNS * 2);
  if (prev.length > 0) {
    const lines = prev.map((m) => (m.role === "user" ? "用户：" : m.role === "assistant" ? "DSH：" : "错误：") + String(m.content).replace(/\n/g, "\n  "));
    parts.push("## 对话记录\n" + lines.join("\n"));
  }
  parts.push("## 本轮请求\n" + query);
  if (ctx && ctx.blocks) parts.push(ctx.blocks);
  return parts.join("\n\n");
}

(async () => {
  // 前两轮对话（模拟会话历史）
  const messages = [
    { role: "user", content: "你好，接下来我们一起整理项目文档。" },
    { role: "assistant", content: "好的。请告诉我要整理哪些内容。" },
  ];

  // 上下文：链接笔记 + 编辑器选区（AGENTS.md 前 10 行，通用内容）
  const selectionText = [
    "# 项目工作台 — 总控说明",
    "",
    "本文件是这套项目工作台的「总控规则」。Agent 在本目录工作时，先按本文件统一口径，再读取对应的角色说明书、知识库、工作流与模板。",
    "",
    "## 1. 项目身份",
    "- 服务对象：项目团队。",
    "- 工作载体：Agent 主入口 + 子代理分发 + Obsidian/Markdown 知识库。",
    "- 当前第一目标：快速产出可交付的成果。",
  ].join("\n");

  const ctx = {
    blocks:
      '<linked_note path="README.md" />\n\n' +
      '<editor_selection path="AGENTS.md" lines="1-10">\n<![CDATA[\n' + selectionText + '\n]]>\n</editor_selection>',
  };

  const query = "我选中了 AGENTS.md 的开头部分。请用两句话告诉我：这份文件规定了什么？我们之前约定了要一起整理项目文档，接下来第一步该做什么？";

  const taskText = buildTaskText("", messages, query, ctx);

  console.log("== 任务文本（前 400 字符）==");
  console.log(taskText.slice(0, 400) + "\n…\n");

  const res = await runHeadless({ cwd: VAULT, task: taskText, timeoutMs: 240000 });
  console.log("ok =", res.ok, "| 耗时 =", res.durationMs + "ms");
  if (res.stdout) console.log("--- DSH 回答 ---\n" + res.stdout.trim());
  if (res.stderr) console.log("--- stderr ---\n" + res.stderr.trim());

  const out = res.stdout || "";
  const checks = {
    "理解选区内容（提到 项目/总控/说明）": /项目|总控|说明|文档/.test(out),
    "理解对话历史（提到整理项目文档）": /整理项目文档|项目文档/.test(out),
  };
  console.log("\n== 校验 ==");
  for (const [k, v] of Object.entries(checks)) console.log((v ? "✓" : "✗") + " " + k);

  if (!res.ok || Object.values(checks).some((v) => !v)) process.exit(1);
  console.log("\n[integration-test] 通过 ✓");
})().catch((e) => {
  console.error("[integration-test] 失败:", e);
  process.exit(1);
});
