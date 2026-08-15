/**
 * scripts/build-plugin.js — 生成单文件 main.js
 *
 * 把 dsh-provider.js 内联进 main.template.js（替换模板中的 __INLINE_PROVIDER__ 占位标记），
 * 输出 dsh-plugin/main.js。原因：Obsidian 插件加载器对插件目录内的相对 require
 * （require("./xxx.js")）支持不可靠（论坛常见 "Cannot find module" 加载失败），
 * 单文件 main.js 与 realclaudian 等官方/社区插件一致，最稳妥。
 *
 * 用法：node scripts/build-plugin.js
 * 之后把 dsh-plugin/ 整个目录（manifest.json + main.js + styles.css）拷入
 * <vault>/.obsidian/plugins/dsh/。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "dsh-plugin");
const PROVIDER = path.join(PLUGIN_DIR, "dsh-provider.js");
const TEMPLATE = path.join(PLUGIN_DIR, "main.template.js");
const OUT = path.join(PLUGIN_DIR, "main.js");

const MARKER = "/*__INLINE_PROVIDER__*/";

function main() {
  let providerSrc = fs.readFileSync(PROVIDER, "utf8");

  // 1) 去掉自测块及其注释
  providerSrc = providerSrc.replace(/\/\*\* 简易自测：[\s\S]*?\*\/\n/, "");
  providerSrc = providerSrc.replace(/\nif \(require\.main === module\) \{[\s\S]*?\n\}\n/, "\n");

  // 2) 去掉尾部 module.exports
  providerSrc = providerSrc.replace(
    /\nmodule\.exports = \{ runHeadless, resolveSpawnTarget, describeTarget, findDshEntry, resolveNodePath, parseArgsTokens, prepareRuntimeHome, scanModels, parseYamlSection, DEFAULT_MODEL_PROVIDER \};\s*$/,
    "\n"
  );

  // 3) 包成 IIFE，赋给 provider
  const iife =
    "/* ============================================================\n" +
    " * dsh-provider（内联自 dsh-provider.js，保持单文件以便 Obsidian 加载）\n" +
    " * 修改 dsh-provider.js 后请重新运行：node scripts/build-plugin.js\n" +
    " * ============================================================ */\n" +
    "const provider = (() => {\n" +
    providerSrc.replace(/^/gm, "  ").trimEnd() +
    "\n  return { runHeadless, resolveSpawnTarget, describeTarget, findDshEntry, resolveNodePath, parseArgsTokens, prepareRuntimeHome, scanModels, parseYamlSection, DEFAULT_MODEL_PROVIDER };\n" +
    "})();";

  const template = fs.readFileSync(TEMPLATE, "utf8");
  if (!template.includes(MARKER)) {
    console.error("模板中未找到占位标记，中止。");
    process.exit(1);
  }
  const out = template.replace(MARKER, iife);
  fs.writeFileSync(OUT, out, "utf8");
  console.log("已生成:", OUT, "(", out.length, "bytes )");
}

main();
