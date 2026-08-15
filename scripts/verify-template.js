/**
 * scripts/verify-template.js — 校验模板：编码正常 + 顶层 path 引入 + 无裸用
 */
"use strict";
const fs = require("fs");
const path = require("path");
const TPL = path.join(__dirname, "..", "dsh-plugin", "main.template.js");
const t = fs.readFileSync(TPL, "utf8");

const ok = [];
const bad = [];
if (t.includes("main.js — DSH")) ok.push("头部中文正常");
else bad.push("头部中文异常（编码可能被破坏）");
const hasTopPath = /const path = require\("path"\);/.test(t);
if (hasTopPath) ok.push("顶层 path 已引入");
else bad.push("顶层缺少 path 引入");
// 模板部分（__INLINE_PROVIDER__ 之后）的 path. 使用——有顶层引入时合法；无顶层引入时报错
const afterMarker = t.split("/*__INLINE_PROVIDER__*/")[1] || "";
const bareLines = afterMarker.split("\n").map((l, i) => ({ l, i }))
  .filter((x) => /[^.\w]path\./.test(x.l) && !/const path = require/.test(x.l) && !/^\s*\/\//.test(x.l));
if (!hasTopPath && bareLines.length > 0) {
  bad.push("顶层缺少 path 引入且模板部分有裸用：" + bareLines.map((x) => x.i + 1).join(","));
} else if (bareLines.length > 0) {
  ok.push("模板部分 path 使用 " + bareLines.length + " 处（由顶层引入覆盖）");
} else {
  ok.push("模板部分无 path 使用");
}

for (const m of ok) console.log("✓", m);
for (const m of bad) console.log("✗", m);
process.exit(bad.length ? 1 : 0);
