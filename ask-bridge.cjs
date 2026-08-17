/**
 * ask-bridge.cjs — DSH 运行时内的「用户问答桥」插件（由 main.js 通过 --patch 注入 headless profile）。
 *
 * 职责：为 ctx.userQuestions 能力缝合一个文件式 UI provider：模型调用
 * ask_user_question 工具时，把问题写成 <bridgeDir>/question.json，然后轮询
 * <bridgeDir>/answer-<id>.json；Obsidian 插件侧读到问题后弹出选项框，把回答
 * 写回 answer 文件，provider 随即返回给 agent 循环。
 *
 * 纯 CJS、零依赖；通过 file:// URL 被 DSH 装载器按插件加载（inject userQuestions）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = {
  name: "dsh-ask-bridge",
  inject: ["userQuestions"],
  apply(ctx) {
    const bridgeDir = process.env.DSH_ASK_BRIDGE_DIR || path.join(os.tmpdir(), "dsh-obsidian-ask-bridge");
    try { fs.mkdirSync(bridgeDir, { recursive: true }); } catch (e) { /* ignore */ }

    const provider = {
      /** 模型请求提问：写问题文件，等待插件侧的答案文件 */
      ask(request) {
        return new Promise((resolve, reject) => {
          const id = "q-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
          const questionFile = path.join(bridgeDir, "question.json");
          const answerFile = path.join(bridgeDir, "answer-" + id + ".json");
          const payload = {
            id,
            questions: request.questions || [],
            sessionId: request.agent && request.agent.id,
            askedAt: Date.now(),
          };
          try {
            // 原子写问题文件（插件侧用 rename 认领）
            const tmp = questionFile + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
            fs.renameSync(tmp, questionFile);
          } catch (e) { reject(e); return; }

          let settled = false;
          const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            if (timer) clearInterval(timer);
            try { fn(arg); } catch (e) { /* ignore */ }
          };
          const onAbort = () => {
            try { fs.unlinkSync(questionFile); } catch (e) { /* ignore */ }
            reject(new Error("ask_user_question aborted"));
          };
          if (request.signal) {
            if (request.signal.aborted) { onAbort(); return; }
            request.signal.addEventListener("abort", onAbort, { once: true });
          }
          let timer = null;
          timer = setInterval(() => {
            if (!fs.existsSync(answerFile)) return;
            let data;
            try {
              data = JSON.parse(fs.readFileSync(answerFile, "utf8"));
            } catch (e) { finish(reject, e); return; }
            finish(() => resolve(data));
            // 清理（问题文件可能已被插件重命名为 question.active.json）
            try { fs.unlinkSync(answerFile); } catch (e) { /* ignore */ }
          }, 300);
        });
      },
    };

    const dispose = ctx.userQuestions.registerProvider(provider);
    ctx.effect(() => () => dispose());
  },
};
