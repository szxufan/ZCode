// ============================================================
// Workflow Actor Identity Section Builder
// ============================================================
//
// 动态工作流子代理（workflow child）的身份段。
//
// 它替换的是交互式的 Agent Identity：子代理的读者是脚本，不是人。它**不**替换基座的
// 其他段——安全 IMPORTANT 行与 Harness 块从 shared 文案逐字复用，memory / skills /
// 项目指令由 builder 照常追加。作者写的 persona 叠加在开场句之后、契约之前：角色比
// 通用规则更靠前、更醒目，但开场句先把「你是谁的谁、输出给谁」说死，persona 不能推翻它。
//
// 契约曾按 persona 的工具档位分支；实盘里零工具的 GLM 子代理被
// 「每个论断都要有依据」逼着去读目录、跑命令，而它没有这些工具，
// 于是发出一个退化的 `escalate("placeholder")`。修法是**把工具面说死**：子代理先知道自己有什么，
// 再被告知证据从哪来。工具档位退场后，
// 每个子代理都有完整工作工具集，契约回到一份文本；「说死工具面」的原则不变。

import type { ContextSection, WorkflowActorContext } from "../types.js";
import { estimateTokens } from "../utils.js";
import { buildHarnessBlock, buildSecurityNotice } from "./identity.js";

/** 工具面的自述：一句「有什么」+ 一句「没有什么」，让模型不去猜。 */
const TOOL_SURFACE =
  "你拥有常规工作工具——读取、搜索、编辑、运行命令——外加 `submit_result` 与 `escalate`。没有任何工具能向人提问。";

/** 证据标准：引用读过/跑过的东西，ask 自带材料时引用材料；跑过才算过，按 ask 点名的尺度跑。 */
const EVIDENCE_RULE =
  // 「跑过才算过」管的是诚实，不管尺度——
  // 实盘子代理拿一个测试文件、一次 build 顶替 ask 点名的整套件。补一句管尺度。
  "每个论断都要有依据：来自你在本会话读过或运行过的东西，或 ask 自带的材料，并说明依据是哪种。代码引用写作 `path:line`。只有你在这里实际执行过的检查才算通过；没能运行的检查要如实报告为未运行。ask 点名了某个检查就按点名的来，不要用更快的替代品，并准确说明你运行了哪条命令。";

function buildWorkflowContract(): string {
  return [
    "# 工作流内的契约",
    `- ${TOOL_SURFACE}`,
    "- 每个 ask 说明要做什么。ask 附带结果 schema 时，最后调用 `submit_result` 提交符合 schema 的值；否则你的最后一条消息就是结果。",
    `- ${EVIDENCE_RULE}`,
    "- 如实报告结果。任务中无法完成、超出范围、或与你发现的事实矛盾的部分，直接在结果里说明，不要用貌似合理的猜测填字段。绝不为了迎合指令伪造通过的结果。",
    "- 当你被能力范围之外的东西阻塞——无法通过的 gate、互相矛盾的指令、只有 run 的所有者知道的事实——调用 `escalate`。用散文写的问题没有人能收到。",
    // 产物条款把「子代理写下的文件」从既被劝阻、又不被追踪，
    // 变成一条有出口的通道：子代理仍然没有任何产物工具（只有脚本能发布，信任边界不动），但
    // 当 ask 指名了输出路径时，写到那里并把路径交回来，脚本会把它发布给用户。
    "- 不要自作主张写报告或总结文件；发现写进结果。ask 指名了输出路径时，恰好写到那里并在结果中返回该路径——脚本会把它发布给用户。",
  ].join("\n");
}

function buildWorkflowActorIdentityPrompt(actor: WorkflowActorContext): string {
  const name = actor.name?.trim();
  const named = name ? `，名为“${name}”` : "";
  const opening = [
    `你是动态工作流 run 内的子代理${named}。脚本创建了你并把工作逐个 ask 交给你；消费你返回内容的是脚本，不是人。本次对话中没有用户可对话。`,
  ];
  const persona = actor.persona?.trim();
  // 不再有 CLI prefix 走在前面，所以这一段就是 system 的第一行，不再以空行起头。
  const parts = [
    opening.join("\n"),
    ...(persona ? ["", persona] : []),
    "",
    buildSecurityNotice(),
    "",
    buildHarnessBlock(),
    "",
    buildWorkflowContract(),
  ];
  return parts.join("\n");
}

export function buildWorkflowActorIdentitySection(actor: WorkflowActorContext): ContextSection {
  const content = buildWorkflowActorIdentityPrompt(actor);
  return {
    name: "Workflow Actor Identity",
    source: "workflow_actor_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
