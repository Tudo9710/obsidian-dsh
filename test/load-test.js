/**
 * test/load-test.js — 模拟 Obsidian 加载插件：模块求值 + 实例化 + onload() + 视图 onOpen
 *
 * 用 mock 的 "obsidian" 模块与 app 对象，在纯 Node 里执行 main.js，
 * 复现 Obsidian 的「加载失败」：module eval 异常、onload 抛错、视图构造失败。
 */
"use strict";

const path = require("path");
const fs = require("fs");

// ---- mock "obsidian" ----
class MockSetting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addText(fn) { fn({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
  addTextArea(fn) { fn({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
  addToggle(fn) { fn({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addDropdown(fn) { fn({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
  addButton(fn) { fn({ setButtonText() { return this; }, setDisabled() { return this; }, setCta() { return this; }, onClick(f) { f(); return this; } }); return this; }
}

function makeEl() {
  const el = {
    children: [],
    cls: new Set(),
    listeners: {},
    parentElement: null,
    empty() { this.children = []; },
    addClass(c) { this.cls.add(c); },
    removeClass(c) { this.cls.delete(c); },
    toggleClass(c, on) { on ? this.cls.add(c) : this.cls.delete(c); },
    hasClass(c) { return this.cls.has(c); },
    setText(t) { this.text = t; },
    setAttribute() {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    createDiv(opts) { const c = makeEl(); c.opts = opts; if (opts && opts.cls) String(opts.cls).split(" ").forEach((k) => k && c.cls.add(k)); this.children.push(c); c.parentElement = this; return c; },
    createSpan(opts) { return this.createDiv(opts); },
    createEl(tag, opts) { const c = this.createDiv(opts); c.tag = tag; return c; },
    insertBefore(node, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(node);
      else this.children.splice(i, 0, node);
      node.parentElement = this;
    },
    get classList() {
      const elRef = this;
      return {
        contains(c) { return elRef.cls.has(c); },
        add(c) { elRef.cls.add(c); },
        remove(c) { elRef.cls.delete(c); },
      };
    },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    appendChild() {},
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop; },
    get scrollHeight() { return 0; },
  };
  return el;
}

class MockItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = makeEl();
    this.app = leaf && leaf.app;
  }
  onClose() {}
}

class MockPlugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.settings = {}; this._viewFactory = null; }
  async loadData() { return undefined; }
  async saveData() {}
  async saveSettings() {}
  logError() {}
  registerView(type, factory) { this._viewFactory = factory; }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab(tab) { this._settingsTab = tab; }
  onunload() {}
}

const obsidianStub = {
  Plugin: MockPlugin,
  PluginSettingTab: class {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = makeEl(); }
  },
  ItemView: MockItemView,
  MarkdownView: class {},
  MarkdownRenderer: { renderMarkdown() {} },
  Notice: class { constructor(msg) { console.log("[Notice]", msg); } },
  Setting: MockSetting,
  setIcon() {},
};

// 拦截 require("obsidian")
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "obsidian") return path.join(__dirname, "_obsidian-stub.js");
  return origResolve.call(this, request, ...rest);
};
fs.writeFileSync(path.join(__dirname, "_obsidian-stub.js"),
  "module.exports = global.__obsidianStub;");
global.__obsidianStub = obsidianStub;

const mockApp = () => ({
  workspace: {
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    getLeaf: () => ({ setViewState: async () => {} }),
    revealLeaf: () => {},
    detachLeavesOfType: () => {},
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
  },
  vault: {
    adapter: { getBasePath: () => path.join(__dirname, ".vault-mock") },
  },
});

(async () => {
  console.log("== 1) 模块求值 ==");
  let DSHPlugin;
  try {
    DSHPlugin = require("../dsh-plugin/main.js");
    console.log("模块求值成功, export =", typeof DSHPlugin, "| name =", DSHPlugin && DSHPlugin.name);
  } catch (e) {
    console.error("❌ 模块求值失败（Obsidian 会显示加载失败）:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("== 2) 实例化 + onload() ==");
  try {
    const plugin = new DSHPlugin(mockApp(), { id: "dsh", name: "DSH", version: "1.0.0" });
    await plugin.onload();
    console.log("✅ onload() 成功");
  } catch (e) {
    console.error("❌ onload() 抛错（Obsidian 会显示加载失败）:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("== 3) 视图构造 + onOpen() ==");
  try {
    const plugin = new DSHPlugin(mockApp(), { id: "dsh", name: "DSH", version: "1.0.0" });
    await plugin.onload();
    const leaf = { app: plugin.app };
    const view = plugin._viewFactory(leaf);
    await view.onOpen();
    view.onClose();
    console.log("✅ 视图 onOpen() 成功（DOM 构建正常）");
  } catch (e) {
    console.error("❌ 视图 onOpen() 抛错:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("== 4) 设置页 display() + 发现模型（Discover）冒烟 ==");
  try {
    const plugin = new DSHPlugin(mockApp(), { id: "dsh", name: "DSH", version: "1.0.0" });
    await plugin.onload();
    const tab = plugin._settingsTab;
    tab.display();
    await tab.discoverModels(null); // 走真实 scan（读 ~/.dsh）
    // 断言发现确实成功（防止异常被吞掉）
    const statusText = tab.discoverStatusEl ? tab.discoverStatusEl.text || "" : "";
    const modelsOk = String(plugin.settings.models || "").includes("deepseek-v4-flash");
    if (!modelsOk) {
      console.error("❌ 发现模型未生效（settings.models 为空）; 状态行:", JSON.stringify(statusText));
      process.exit(1);
    }
    if (!statusText.startsWith("✓")) {
      console.error("❌ 发现模型状态行异常:", JSON.stringify(statusText));
      process.exit(1);
    }
    console.log("✅ 设置页渲染 + 发现模型冒烟成功（状态行: " + statusText.slice(0, 60) + "…）");
    tab.display(); // 再渲染一次（下拉选项更新后）
  } catch (e) {
    console.error("❌ 设置页渲染/发现模型抛错:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("== 5) 思考面板：折叠后点击可展开/收起（renderThinkingPanel）==");
  try {
    const plugin = new DSHPlugin(mockApp(), { id: "dsh", name: "DSH", version: "1.0.0" });
    await plugin.onload();
    const leaf = { app: plugin.app };
    const view = plugin._viewFactory(leaf);
    await view.onOpen();
    view.session = {
      id: "conv-test-1",
      title: "测试",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messages: [
        { role: "user", content: "hi", ts: Date.now() },
        { role: "assistant", content: "hello", ts: Date.now(), thinking: { reasoning: "思考中…", tools: ["⚙ read {...}"], seconds: 5 } },
      ],
    };
    view.renderMessages();
    const panel = view.messagesEl.children.find((c) => c.opts && String(c.opts.cls || "").includes("dsh-thinking-summary"));
    if (!panel) { console.error("❌ 未找到思考面板"); process.exit(1); }
    const head = panel.children[0];
    const body = panel.children[1];
    if (!body.classList.contains("dsh-hidden")) { console.error("❌ 面板初始应为折叠"); process.exit(1); }
    head.listeners.click();
    const opened = !body.classList.contains("dsh-hidden");
    head.listeners.click();
    const closed = body.classList.contains("dsh-hidden");
    if (!opened || !closed) { console.error(`❌ 折叠展开失效 opened=${opened} closed=${closed}`); process.exit(1); }
    console.log("✅ 面板折叠/展开切换正常");
  } catch (e) {
    console.error("❌ 面板切换测试抛错:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("== 6) 真实流程：startThinking → 事件 → finishThinking → 思考存入消息 → renderMessages 重建面板 ==");
  try {
    const plugin = new DSHPlugin(mockApp(), { id: "dsh", name: "DSH", version: "1.0.0" });
    await plugin.onload();
    const leaf = { app: plugin.app };
    const view = plugin._viewFactory(leaf);
    await view.onOpen();
    view.session = {
      id: "conv-test-2",
      title: "测试2",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messages: [{ role: "user", content: "hi", ts: Date.now() }],
    };
    view.statusStart = Date.now();
    view.startThinking({ model: "deepseek-v4-flash", effort: "high" });
    view.handleLiveEvent({ type: "reasoning-chunks", data: { texts: ["The", " user", " wants"] } });
    view.handleLiveEvent({ type: "tool-call-chunks", data: { name: "read", args: ["{", "\"file_path\"", ": \"README.md\"}"] } });
    view.finishThinking();
    const thinking = view._pendingThinking;
    view.session.messages.push({ role: "assistant", content: "答案", ts: Date.now(), thinking });
    // 再 renderMessages 两次，模拟重建/重载——面板必须每次都出现
    for (let pass = 1; pass <= 2; pass++) {
      view.renderMessages();
      const panels = view.messagesEl.children.filter((c) => c.opts && String(c.opts.cls || "").includes("dsh-thinking-summary"));
      if (panels.length !== 1) { console.error(`❌ 第 ${pass} 次渲染面板数=${panels.length}（应为 1，面板消失复现）`); process.exit(1); }
      const pHead = panels[0].children[0];
      const pBody = panels[0].children[1];
      if (!pBody.classList.contains("dsh-hidden")) { console.error("❌ 面板应折叠"); process.exit(1); }
      pHead.listeners.click();
      if (pBody.classList.contains("dsh-hidden")) { console.error("❌ 点击后应展开"); process.exit(1); }
    }
    console.log("✅ 思考存入消息，重复渲染面板稳定出现且可展开（内容=" + JSON.stringify(thinking) + "）");
  } catch (e) {
    console.error("❌ 真实流程复现抛错:");
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log("\n[load-test] 全部通过 —— 代码在 mock 环境可正常加载");
  // 诊断：哪些句柄让进程不退出（测试脚本，直接退出即可）
  try {
    const handles = process._getActiveHandles().map((x) => x.constructor.name);
    console.log("[load-test] 残留句柄:", handles.join(", ") || "无");
  } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error("[load-test] 失败:", e);
  process.exit(1);
});
