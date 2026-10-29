import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMUNICATION_PROMPTS,
  AGENT_CONTEXT_MANAGEMENT_PROMPTS,
  AGENT_HARD_TO_REVERSE_PROMPT,
  AGENT_SECURITY_NOTICE,
  agentDesktopContextCopy,
  buildAgentContextManagementBody,
  buildAgentDynamicBehaviorBody,
  buildAgentHarnessBlock,
  buildAgentIdentityBody,
} from "@zcode/shared";
import { createContextBuilder } from "../src/context/index.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

import { buildMemorySection } from "../src/context/sections/memory.js";
import {
  buildCliPrefixSection,
  buildEnvInfoSection,
  buildGitSystemContextSection,
  buildIdentitySection,
  buildSkillsSection,
} from "../src/context/index.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ContextBuildResult, ContextMetaUserAttachmentSource } from "../src/context/types.js";

const contextTestModel = createTestRuntimeModel({
  providerId: "openai",
  modelId: "gpt-5",
  generateText: async () => {
    throw new Error("context rendering must not execute the model");
  },
});

// 大段文案的唯一来源是 packages/shared/src/agent-prompt；这里引用同一份常量组装期望值，
// 测试锁定的是「builder 按什么顺序、以什么边界组装这些段」，文案逐字回归由 shared 侧测试负责。
const DEFAULT_COMMUNICATION_PROMPT = AGENT_COMMUNICATION_PROMPTS.default;

const EXPECTED_COMMUNICATION_PROMPT = [
  AGENT_COMMUNICATION_PROMPTS.beforeDefault,
  "",
  AGENT_COMMUNICATION_PROMPTS.default,
  AGENT_COMMUNICATION_PROMPTS.afterDefault,
].join("\n");

const DEFAULT_CONTEXT_MANAGEMENT_PROMPT = AGENT_CONTEXT_MANAGEMENT_PROMPTS.default;

const CONTEXT_MANAGEMENT_ADDITIONAL_PARAGRAPHS =
  AGENT_CONTEXT_MANAGEMENT_PROMPTS.additional.split("\n\n");
const ADDITIONAL_ACT_DONT_REDERIVE_PROMPT = CONTEXT_MANAGEMENT_ADDITIONAL_PARAGRAPHS[0] ?? "";
const AUTONOMY_APPENDIX_PROMPT =
  CONTEXT_MANAGEMENT_ADDITIONAL_PARAGRAPHS.slice(1).join("\n\n");

function metaAttachment(
  result: ContextBuildResult,
  source: ContextMetaUserAttachmentSource,
): string {
  return (
    result.metaUserAttachments.find((attachment) => attachment.source === source)?.content ?? ""
  );
}

function memoryFixture(
  name: "main-memory-default-index.md" | "main-memory-index.md" | "main-memory-semantic-recall.md",
): string {
  const content = readFileSync(new URL(`./fixtures/memory/${name}`, import.meta.url), "utf8");
  // Windows 检出可能带 CRLF；builder 输出一律是 LF，先归一再去尾部换行。
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

describe("ContextBuilder meta user context", () => {
  it("renders CLI prefix, stable body, and dynamic system sections as separate system messages", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["Read", "Edit", "Bash", "Agent", "TodoWrite", "AskUserQuestion"],
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.systemMessages.map((message) => String(message.content).endsWith("\n"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(result.systemMessages[0]?.content).toBe("你是 ZCode，一个交互式编码智能体");

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).not.toContain("你是 ZCode，一个交互式编码智能体");
    expect(stableBody).toContain("# 运行时框架（Harness）");
    expect(stableBody).not.toContain("# 会话专项指导");
    expect(stableBody).not.toContain("# 环境");
    expect(stableBody).not.toContain("# 上下文管理");
    expect(stableBody).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(stableBody).not.toContain("对难以逆转或对外");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");
    expect(stableBody).not.toContain("## Current Environment");

    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    expect(dynamicSystem.startsWith(`\n\n${EXPECTED_COMMUNICATION_PROMPT}`)).toBe(true);
    expect(dynamicSystem).toContain(
      `${EXPECTED_COMMUNICATION_PROMPT}\n\n${AGENT_HARD_TO_REVERSE_PROMPT}`,
    );
    expect(dynamicSystem.split(DEFAULT_COMMUNICATION_PROMPT)).toHaveLength(2);
    expect(result.systemMessages[2]?.content).toContain("对难以逆转或对外的操作");
    expect(
      result.systemMessages[2]?.content.indexOf("对难以逆转或对外"),
    ).toBeLessThan(result.systemMessages[2]?.content.indexOf("# 环境") ?? -1);
    expect(result.systemMessages[2]?.content).not.toContain("# 会话专项指导");
    expect(result.systemMessages[2]?.content).not.toContain("`! <command>`");
    expect(result.systemMessages[2]?.content).not.toContain(
      "Use the Agent tool with specialized agents when the task at hand matches the agent's description.",
    );
    expect(result.systemMessages[2]?.content).not.toContain(
      "spawn Agent with subagent_type=Explore",
    );
    expect(result.systemMessages[2]?.content).toContain("# 环境");
    expect(result.systemMessages[2]?.content).toContain("# 上下文管理");
    expect(result.systemMessages[2]?.content).not.toContain("# Language");
    expect(result.systemMessages[2]?.content).not.toContain("# Function Result Clearing");
    expect(result.systemMessages[2]?.content).not.toContain("# Summarize Tool Results");
    expect(result.systemMessages[2]?.content).not.toContain("# Session Guidance");
    expect(result.systemMessages[2]?.content).not.toContain("# Agent Identity");
  });

  it("appends the exact act and autonomy prompts after context management", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    const contextManagement = result.sections.find(
      (section) => section.source === "context_management",
    );
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(contextManagement?.content).toBe(
      `${DEFAULT_CONTEXT_MANAGEMENT_PROMPT}\n\n${ADDITIONAL_ACT_DONT_REDERIVE_PROMPT}\n\n${AUTONOMY_APPENDIX_PROMPT}`,
    );
    expect(dynamicSystem.endsWith(AUTONOMY_APPENDIX_PROMPT)).toBe(true);
    expect(dynamicSystem.split(ADDITIONAL_ACT_DONT_REDERIVE_PROMPT)).toHaveLength(2);
    expect(dynamicSystem.split(AUTONOMY_APPENDIX_PROMPT)).toHaveLength(2);
  });

  it("injects the stable ZCode Desktop Context before dynamic behavior", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      presentationSurface: "zcode_desktop",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    const desktopSections = result.sections.filter(
      (section) => section.source === "desktop_context",
    );
    expect(desktopSections).toHaveLength(1);
    expect(desktopSections[0]).toMatchObject({
      name: "ZCode Desktop Context",
      source: "desktop_context",
      injectionTarget: "system",
      cacheHint: "stable",
    });
    expect(desktopSections[0]?.content).toBe(agentDesktopContextCopy(undefined));

    const desktopIndex = result.sections.findIndex(
      (section) => section.source === "desktop_context",
    );
    const dynamicBehaviorIndex = result.sections.findIndex(
      (section) => section.source === "dynamic_behavior",
    );
    expect(desktopIndex).toBeGreaterThan(-1);
    expect(desktopIndex).toBeLessThan(dynamicBehaviorIndex);

    expect(result.systemMessages).toHaveLength(3);
    expect(result.systemMessages[1]?.content).toContain("# ZCode Desktop 上下文");
    expect(result.systemMessages[2]?.content).not.toContain("# ZCode Desktop 上下文");
  });

  it("does not inject the Desktop context for the default terminal surface", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.sections.some((section) => section.source === "desktop_context")).toBe(false);
    expect(
      result.systemMessages.some((message) =>
        String(message.content).includes("# ZCode Desktop 上下文"),
      ),
    ).toBe(false);
  });

  it("keeps the CLI prefix fixed even if legacy config passes an override", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      cliPrefixPrompt: "legacy override",
    } as any).build();

    expect(result.systemMessages[0]?.content).toBe("你是 ZCode，一个交互式编码智能体");
  });

  it("covers default body safety, runtime, and tool-guidance semantic anchors", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["AskUserQuestion", "Agent", "TodoWrite", "Read", "Edit", "Bash"],
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(stableBody).toContain("软件工程任务");
    expect(stableBody).toContain("会话中途的 system turn");
    expect(stableBody).toContain("Hook 可能拦截工具调用");
    expect(stableBody).toContain("能用专用文件/搜索工具时优先使用它们");
    expect(stableBody).toContain("相互独立的工具调用可以在同一次响应中并行发出");
    expect(stableBody).toContain("引用代码时使用 `file_path:line_number` 格式");
    expect(stableBody).not.toContain("match local style, naming, patterns, and comment density");
    expect(stableBody).not.toContain("对难以逆转或对外");
    expect(stableBody).not.toContain("把内容发送到外部服务即等于公开发布");
    expect(stableBody).not.toContain("删除或覆盖前先查看目标内容");
    expect(stableBody).not.toContain("如实报告结果");
    expect(stableBody).not.toContain("`! <command>`");
    expect(stableBody).not.toContain("当用户输入 `/<skill-name>` 时");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");

    expect(dynamicSystem).toMatch(/^\n\n# 与用户沟通/);
    expect(dynamicSystem).toContain("保持一致的注释密度、命名风格和惯用写法");
    expect(dynamicSystem).toContain("对难以逆转或对外的操作");
    expect(dynamicSystem).toContain("把内容发送到外部服务即等于公开发布");
    expect(dynamicSystem).toContain("删除或覆盖前先查看目标内容");
    expect(dynamicSystem).toContain("如实报告结果");
    expect(dynamicSystem.indexOf("对难以逆转或对外")).toBeLessThan(
      dynamicSystem.indexOf("# 环境"),
    );
    expect(dynamicSystem).not.toContain("# 会话专项指导");
    expect(dynamicSystem).not.toContain("`! <command>`");
    expect(dynamicSystem).not.toContain("Use the Agent tool with specialized agents");
    expect(dynamicSystem).not.toContain("当用户输入 `/<skill-name>` 时");
    expect(dynamicSystem).not.toContain("Use AskUserQuestion");
    expect(dynamicSystem).not.toContain("spawn Agent with subagent_type=Explore");
    expect(dynamicSystem).not.toContain("Use TodoWrite");
    expect(dynamicSystem).not.toContain("Prefer Read");
    expect(dynamicSystem).not.toContain("Prefer dedicated edit/write tools");
    expect(dynamicSystem).not.toContain("Use Bash");
    expect(dynamicSystem).not.toContain("Call independent tools in parallel in a single response");
    expect(dynamicSystem).toContain("# 环境");
    expect(dynamicSystem).toContain("# 上下文管理");
    expect(dynamicSystem).not.toContain("不是 Git 仓库");
    expect(dynamicSystem).not.toContain("- **Git**:");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    expect(dynamicSystem).not.toContain("# Session Guidance");
  });

  it("uses customSystemPrompt as a custom prompt without default system sections", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      presentationSurface: "zcode_desktop",
      customSystemPrompt: "You are concise for this task.",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
        gitBranch: "main",
        gitStatus: "dirty",
        gitStatusLines: [" M package.json"],
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          test: "vitest",
        },
      },
      currentDate: "2026-06-04",
      language: "Chinese",
      outputStyle: {
        name: "Terse",
        prompt: "Keep responses short.",
        keepCodingInstructions: false,
      },
      compact: {
        enabled: true,
        microcompact: {
          enabled: true,
          keepRecentToolResults: 3,
        },
      },
      guidanceToolNames: ["Read", "Edit", "Bash", "TodoWrite"],
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "Project instruction should stay as userContext.",
        bytesRead: 47,
        sizeBytes: 47,
        truncated: false,
      },
    }).build();

    expect(result.sections.some((section) => section.source === "desktop_context")).toBe(false);

    expect(result.systemMessages.map((message) => message.role)).toEqual(["system", "system"]);
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "context_prefix",
    ]);
    expect(result.systemMessages[0]?.content).toBe("你是 ZCode，一个交互式编码智能体");
    expect(result.systemMessages[1]?.content).toBe("\nYou are concise for this task.");
    const meta = metaAttachment(result, "context_prefix");
    expect(meta).not.toContain("<system-reminder>");
    expect(meta).toContain("Project instruction should stay as userContext.");
    expect(meta).toContain("以下是代码库与用户指令。");
    expect(meta).toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain("以下是 /workspace/AGENTS.md 的内容（工作区指令）：");
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("- Package manager: pnpm");
    expect(meta).not.toContain("- `test`: vitest");
    expect(meta).toContain("# currentDate");
    const providerText = [
      ...result.systemMessages.map((message) => message.content),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");
    expect(providerText).not.toContain("# Session Guidance");
    expect(providerText).not.toContain("# 会话专项指导");
    expect(providerText).not.toContain("## Memory");
    expect(providerText).not.toContain("# 记忆（Memory）");
    expect(providerText).not.toContain("## Current Environment");
    expect(providerText).not.toContain("# 环境");
    expect(providerText).not.toContain("# 上下文管理");
    expect(providerText).not.toContain("# Language");
    expect(providerText).not.toContain("# 输出风格：Terse");
    expect(providerText).not.toContain("# Function Result Clearing");
    expect(providerText).not.toContain("# Summarize Tool Results");
    expect(providerText).not.toContain("M package.json");
    expect(providerText).not.toContain("## 项目信息");
    expect(providerText).not.toContain("# user_instructions");
  });

  it("renders first-batch dynamic system sections in reference relative order", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      language: "Chinese",
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
        keepCodingInstructions: true,
      },
      compact: {
        enabled: true,
        microcompact: {
          enabled: true,
          keepRecentToolResults: 3,
        },
      },
      memoryRoot: "/workspace/.zcode/memory",
      guidanceToolNames: ["AskUserQuestion", "Agent", "Skill", "TodoWrite", "Read", "Edit", "Bash"],
    }).build();

    const stable = String(result.systemMessages[1]?.content ?? "");
    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(stable).not.toContain("# 会话专项指导");
    expect(stable).not.toContain("# 记忆（Memory）");
    expect(stable).not.toContain("# 环境");
    expect(stable).not.toContain("# 上下文管理");
    expect(stable).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(stable).not.toContain("对难以逆转或对外");
    expect(dynamic).toMatch(/^\n\n# 与用户沟通/);
    expect(dynamic.indexOf("对难以逆转或对外")).toBeLessThan(dynamic.indexOf("# 记忆（Memory）"));
    expect(dynamic).not.toContain("# 会话专项指导");
    expect(dynamic).not.toContain("`! <command>`");
    expect(dynamic).not.toContain("spawn Agent with subagent_type=Explore");
    expect(dynamic.indexOf("# 记忆（Memory）")).toBeLessThan(dynamic.indexOf("# 环境"));
    expect(dynamic.indexOf("# 环境")).toBeLessThan(dynamic.indexOf("# 输出风格：Learning"));
    expect(dynamic).not.toContain("# Session Guidance");
    expect(dynamic.indexOf("# 输出风格：Learning")).toBeLessThan(dynamic.indexOf("# 上下文管理"));
    expect(dynamic).toContain("# 输出风格：Learning\nExplain tradeoffs while solving the task.");
    expect(dynamic).not.toContain("# 输出风格：Learning\n\n");
    expect(dynamic).not.toContain("# Language");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
    expect(dynamic).not.toContain("Respond in the primary language of the user's current prompt");
    expect(dynamic).not.toContain("old tool results may be cleared");
    expect(dynamic).not.toContain("compactable tool results");
  });

  it("renders the Memory section exactly as the frozen provider fixture", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryRoot: rootDir,
    }).build();

    const expected = memoryFixture("main-memory-default-index.md").replace(
      "<MEMORY_ROOT>",
      rootDir,
    );
    const memorySection = result.sections.find((section) => section.source === "memory");
    expect(memorySection?.content).toBe(expected);
    expect(
      String(result.systemMessages[2]?.content ?? "").match(/# 记忆（Memory）/g),
    ).toHaveLength(1);
  });

  it("renders the two project Memory retrieval prompts from the same branch contract", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const defaultContent = buildMemorySection(rootDir, "default-index")?.content;
    const semanticContent = buildMemorySection(rootDir, "semantic-recall")?.content;
    const pointerParagraph =
      "写完文件后，在 `MEMORY.md` 中加一行指针（`- [标题](file.md) — 钩子`）。`MEMORY.md` 是每次会话载入上下文的索引——每条记忆一行，没有 frontmatter，永远不要把记忆正文放进去。";

    expect(defaultContent).toBe(
      memoryFixture("main-memory-default-index.md").replace("<MEMORY_ROOT>", rootDir),
    );
    expect(semanticContent).toBe(
      memoryFixture("main-memory-semantic-recall.md").replace("<MEMORY_ROOT>", rootDir),
    );
    expect(defaultContent?.replace(`\n${pointerParagraph}\n`, "")).toBe(semanticContent);
  });

  it("renders the Main MEMORY.md index as the exact provider-visible user context source", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-07-22",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryIndexContent:
        "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
      memoryRoot: rootDir,
    }).build();

    const expected = memoryFixture("main-memory-index.md").replace(
      "<MEMORY_INDEX_PATH>",
      join(rootDir, "MEMORY.md"),
    );
    const contextPrefix = metaAttachment(result, "context_prefix");
    expect(contextPrefix).toContain(expected);
    expect(contextPrefix.match(/# agentsMd/gu)).toHaveLength(1);
    expect(contextPrefix).not.toContain("# claudeMd");
    expect(contextPrefix.indexOf("# agentsMd")).toBeLessThan(contextPrefix.indexOf("以下是 "));
    expect(contextPrefix.indexOf(expected)).toBeLessThan(contextPrefix.indexOf("# currentDate"));
    expect(contextPrefix.match(/用户自动记忆，跨会话持久保存/g)).toHaveLength(1);
  });

  it("removes leading frontmatter and top-level HTML comments from Main MEMORY.md", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-07-22",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryIndexContent: [
        "---",
        "internal: hidden-index-metadata",
        "---",
        "<!-- hidden top-level note -->",
        "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
        "  <!-- nested list comment remains -->",
        "- [Deployment policy](deployment-policy.md) — approval is required",
        "Keep this inline marker <!-- inline comment remains --> in the index.",
        "```markdown",
        "<!-- fenced comment remains -->",
        "```",
        "",
      ].join("\n"),
      memoryRoot: rootDir,
    }).build();

    const contextPrefix = metaAttachment(result, "context_prefix");
    expect(contextPrefix).not.toContain("hidden-index-metadata");
    expect(contextPrefix).not.toContain("hidden top-level note");
    expect(contextPrefix).toContain(
      "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
    );
    expect(contextPrefix).toContain("  <!-- nested list comment remains -->");
    expect(contextPrefix).toContain("Keep this inline marker <!-- inline comment remains -->");
    expect(contextPrefix).toContain("```markdown\n<!-- fenced comment remains -->\n```");
  });

  it("renders git snapshot inside the dynamic org-cache system block after context management", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      model: contextTestModel,
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
        gitBranch: "feature/alignment",
        gitMainBranch: "main",
        gitUser: "ZCode Tester <tester@example.com>",
        gitStatus: "dirty",
        gitStatusLines: [" M package.json"],
        recentCommits: ["abc123 test commit"],
      },
      language: "Chinese",
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);

    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    const stableBody = String(result.systemMessages[1]?.content ?? "");

    expect(stableBody).not.toContain("# 环境");
    expect(stableBody).not.toContain("**Current model**: openai/gpt-5");
    expect(stableBody).not.toContain("**是否 Git 仓库**: 是");
    expect(stableBody).not.toContain("# 上下文管理");
    expect(stableBody).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(stableBody).not.toContain("对难以逆转或对外");
    expect(dynamicSystem).not.toContain("## Current Environment");
    expect(dynamicSystem).toMatch(/^\n\n# 与用户沟通/);
    expect(dynamicSystem).toContain("对难以逆转或对外的操作");
    expect(dynamicSystem).toContain("# 环境");
    expect(dynamicSystem).toContain("- 你由名为 openai/gpt-5 的模型驱动。");
    expect(dynamicSystem).toContain("- 是否 Git 仓库: 是");
    expect(dynamicSystem).toContain("# 上下文管理");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    expect(dynamicSystem).toContain("gitStatus:");
    expect(dynamicSystem.indexOf("# 上下文管理")).toBeLessThan(
      dynamicSystem.indexOf(ADDITIONAL_ACT_DONT_REDERIVE_PROMPT),
    );
    expect(dynamicSystem.indexOf(ADDITIONAL_ACT_DONT_REDERIVE_PROMPT)).toBeLessThan(
      dynamicSystem.indexOf(AUTONOMY_APPENDIX_PROMPT),
    );
    expect(dynamicSystem.indexOf(AUTONOMY_APPENDIX_PROMPT)).toBeLessThan(
      dynamicSystem.indexOf("gitStatus:"),
    );
    expect(dynamicSystem).toContain("这是会话开始时的 git 状态");
    expect(dynamicSystem).toContain("当前分支: feature/alignment");
    expect(dynamicSystem).toContain("主分支（通常用于发 PR）: main");
    expect(dynamicSystem).toContain("Git 用户: ZCode Tester <tester@example.com>");
    expect(dynamicSystem).toContain("状态:\n M package.json");
    expect(dynamicSystem).toContain("最近提交:\nabc123 test commit");
  });

  it("changes stable intro framing when an output style is active", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
        keepCodingInstructions: true,
      },
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toContain("依据下方生效的输出风格");
    expect(stableBody).not.toContain("你是一个交互式 ZCode 智能体");
    expect(stableBody).toContain("# 运行时框架（Harness）");
    expect(stableBody).not.toContain("# 会话专项指导");
    expect(stableBody).not.toContain("# 环境");
    expect(stableBody).not.toContain("# 上下文管理");
    expect(stableBody).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(stableBody).not.toContain("对难以逆转或对外");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    expect(dynamicSystem).toMatch(/^\n\n# 与用户沟通/);
    expect(dynamicSystem).toContain("对难以逆转或对外的操作");
    expect(dynamicSystem).not.toContain("# 会话专项指导");
    expect(dynamicSystem).toContain("# 环境");
    expect(dynamicSystem).toContain("# 上下文管理");
  });

  it("keeps the stable harness and communication when an output style replaces coding instructions", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      outputStyle: {
        name: "Custom",
        prompt: "Use the custom response style.",
        keepCodingInstructions: false,
      },
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(stableBody).toContain("# 运行时框架（Harness）");
    expect(stableBody).toContain("工具运行在用户选择的权限模式之后");
    expect(dynamicSystem.startsWith(`\n\n${EXPECTED_COMMUNICATION_PROMPT}`)).toBe(true);
    expect(dynamicSystem).toContain("对难以逆转或对外的操作");
    expect(dynamicSystem).toContain("# 输出风格：Custom\nUse the custom response style.");
    expect(dynamicSystem).not.toContain("# 输出风格：Custom\n\n");
    expect(dynamicSystem.indexOf(EXPECTED_COMMUNICATION_PROMPT)).toBeLessThan(
      dynamicSystem.indexOf("# 输出风格：Custom"),
    );
  });

  it("does not render legacy language guidance in the default dynamic block", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      language: "日本語",
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Language");
    expect(dynamic).not.toContain("Respond in the primary language of the user's current prompt");
    expect(dynamic).not.toContain("Respond in 日本語");
    expect(dynamic).not.toContain("Respond in English");
    expect(dynamic).not.toContain("Respond in Chinese");
  });

  it("does not render legacy compact guidance when global compact is disabled", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      compact: { enabled: false },
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
  });

  it("does not render legacy compact guidance when only microcompact is disabled", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      compact: { enabled: true, microcompact: { enabled: false } },
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
  });

  it("renders stable system sections before dynamic sections and emits meta user context after system", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "local AGENTS payload",
        bytesRead: 20,
        sizeBytes: 20,
        truncated: false,
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          test: "vitest",
        },
      },
    }).build();

    expect(result.systemMessages).toHaveLength(3);
    expect(result.systemMessages[0]?.role).toBe("system");
    expect(result.systemMessages[0]?.cacheControl).toBeUndefined();
    expect(result.systemMessages[1]?.role).toBe("system");
    expect(result.systemMessages[1]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(result.systemMessages[2]?.role).toBe("system");
    expect(result.systemMessages[2]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "context_prefix",
    ]);

    const cliPrefix = result.systemMessages[0]?.content ?? "";
    const stableBody = result.systemMessages[1]?.content ?? "";
    const dynamicSystem = result.systemMessages[2]?.content ?? "";
    const meta = metaAttachment(result, "context_prefix");
    expect(cliPrefix).toBe("你是 ZCode，一个交互式编码智能体");
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(stableBody).not.toContain("你是 ZCode，一个交互式编码智能体");
    expect(stableBody).toContain("# 运行时框架（Harness）");
    expect(stableBody).not.toContain("# 会话专项指导");
    expect(stableBody).not.toContain("# 环境");
    expect(stableBody).not.toContain("# 上下文管理");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");
    expect(stableBody).not.toContain("## Current Environment");
    expect(dynamicSystem).not.toContain("## Current Environment");
    expect(dynamicSystem).toMatch(/^\n\n# 与用户沟通/);
    expect(dynamicSystem).toContain("对难以逆转或对外的操作");
    expect(dynamicSystem).not.toContain("# 会话专项指导");
    expect(dynamicSystem).toContain("# 环境");
    expect(dynamicSystem).toContain("# 上下文管理");
    expect(stableBody).not.toContain("local AGENTS payload");
    expect(meta).not.toContain("<system-reminder>");
    expect(meta).toContain("以下是代码库与用户指令。");
    expect(meta).toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).toContain("local AGENTS payload");
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("Project type: Node.js");
    expect(meta).not.toContain("Package manager: pnpm");
    expect(meta).not.toContain("`test`: vitest");
    expect(meta).not.toContain("## 项目信息");
    expect(meta).toContain("# currentDate");
    expect(meta).toContain("今天是 2026-05-04。");
    expect(meta).not.toContain("</system-reminder>");
    expect(meta.indexOf("以下是代码库与用户指令")).toBeLessThan(meta.indexOf("# currentDate"));

    const sectionTargets = result.sections.map((section) => ({
      name: section.name,
      injectionTarget: section.injectionTarget,
      cacheHint: section.cacheHint,
    }));
    expect(sectionTargets.slice(0, 4)).toEqual([
      { name: "CLI Prefix", injectionTarget: "system", cacheHint: "stable" },
      { name: "Agent Identity", injectionTarget: "system", cacheHint: "stable" },
      { name: "Dynamic Behavior", injectionTarget: "system", cacheHint: "dynamic" },
      { name: "Environment Info", injectionTarget: "system", cacheHint: "dynamic" },
    ]);
    expect(sectionTargets).toEqual(
      expect.arrayContaining([
        { name: "Environment Info", injectionTarget: "system", cacheHint: "dynamic" },
        { name: "Context Management", injectionTarget: "system", cacheHint: "dynamic" },
        { name: "Request User Context", injectionTarget: "meta_user", cacheHint: "dynamic" },
        { name: "Current Date", injectionTarget: "meta_user", cacheHint: "dynamic" },
      ]),
    );
  });

  it("renders merged user default and workspace instructions in request user context", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "default instructions\n\nworkspace instructions",
        bytesRead: 43,
        sizeBytes: 43,
        truncated: false,
        sources: [
          {
            scope: "user",
            filePath: "/Users/test/.zcode/AGENTS.md",
            fileName: "AGENTS.md",
            content: "default instructions",
            bytesRead: 20,
            sizeBytes: 20,
            truncated: false,
          },
          {
            scope: "workspace",
            filePath: "/workspace/AGENTS.md",
            fileName: "AGENTS.md",
            content: "workspace instructions",
            bytesRead: 22,
            sizeBytes: 22,
            truncated: false,
          },
        ],
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).toContain("以下是代码库与用户指令。");
    expect(meta.match(/# agentsMd/gu)).toHaveLength(1);
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain("以下是 /Users/test/.zcode/AGENTS.md 的内容（用户默认指令）：");
    expect(meta).toContain("以下是 /workspace/AGENTS.md 的内容（工作区指令）：");
    expect(meta.indexOf("default instructions")).toBeLessThan(
      meta.indexOf("workspace instructions"),
    );
    expect(meta.indexOf("# agentsMd")).toBeLessThan(meta.indexOf("default instructions"));
    expect(meta.indexOf("以下是代码库与用户指令")).toBeLessThan(meta.indexOf("# currentDate"));
  });

  it("renders only currentDate when request user context has no content", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "context_prefix",
    ]);
    const meta = metaAttachment(result, "context_prefix");
    expect(meta).toContain("# currentDate");
    expect(meta).toContain("今天是 2026-05-04。");
    expect(meta).toContain("\n\n      重要：这些上下文可能与你的任务无关。");
    expect(meta).not.toContain("\n\n重要：这些上下文可能与你的任务无关。");
    expect(meta).not.toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).not.toContain("Project context:");
  });

  it("does not render projectContext-only content without user instructions", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          build: "pnpm build",
        },
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).not.toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("Project type: Node.js");
    expect(meta).not.toContain("Package manager: pnpm");
    expect(meta).not.toContain("`build`: pnpm build");
    expect(meta).not.toContain("的内容（");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).not.toContain("## 项目信息");
    expect(meta).toContain("# currentDate");
  });

  it("renders a resolved instruction source under agentsMd", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/CLAUDE.md",
        fileName: "CLAUDE.md",
        content: "Workspace resolved instruction payload",
        bytesRead: 35,
        sizeBytes: 35,
        truncated: false,
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).toContain("以下是代码库与用户指令。");
    expect(meta).toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain("以下是 /workspace/CLAUDE.md 的内容（工作区指令）：");
    expect(meta).toContain("Workspace resolved instruction payload");
    expect(meta).not.toContain("# user_instructions");
    expect(meta.indexOf("以下是代码库与用户指令")).toBeLessThan(meta.indexOf("# currentDate"));
  });

  it("does not emit an empty meta user message", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments).toEqual([]);
    expect(result.systemMessages[0]?.content).toBe("你是 ZCode，一个交互式编码智能体");
    expect(result.systemMessages[1]?.content).not.toContain("# Agent Identity");
    expect(result.systemMessages[1]?.content).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(result.systemMessages[1]?.content).toContain("# 运行时框架（Harness）");
    expect(result.systemMessages[1]?.content).not.toContain("# 会话专项指导");
    expect(result.systemMessages[1]?.content).not.toContain("# 环境");
    expect(result.systemMessages[1]?.content).not.toContain("# 上下文管理");
    expect(result.systemMessages[1]?.content).not.toContain("# Communication Style");
    expect(result.systemMessages[1]?.content).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(result.systemMessages[1]?.content).not.toContain("对难以逆转或对外");
    expect(result.systemMessages[2]?.content).toMatch(/^\n\n# 与用户沟通/);
    expect(result.systemMessages[2]?.content).toContain("对难以逆转或对外的操作");
    expect(result.systemMessages[2]?.content).not.toContain("# 会话专项指导");
    expect(result.systemMessages[2]?.content).not.toContain("# Language");
    expect(result.systemMessages[2]?.content).not.toContain("# Function Result Clearing");
    expect(result.systemMessages[2]?.content).not.toContain("# Summarize Tool Results");
    expect(result.systemMessages[2]?.content).not.toContain("## Current Environment");
    expect(result.systemMessages[2]?.content).toContain("# 环境");
    expect(result.systemMessages[2]?.content).toContain("# 上下文管理");
  });

  it("does not mirror registered tools into prompt context", () => {
    const registry = createToolRegistry();
    registry.register(readToolEntry);

    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    })
      .setToolRegistry(registry)
      .build();

    const promptContext = [
      ...result.systemMessages.map((message) => String(message.content ?? "")),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");

    expect(result.sections.map((section) => section.source)).not.toContain("tools");
    expect(promptContext).not.toContain("## Available Tools");
    expect(promptContext).not.toContain("### Read");
    expect(promptContext).not.toContain("Read-only:");
  });

  it("renders skills as a separate meta user system reminder", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["Skill"],
      skills: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "demo-skill",
            description: "Use this for demos",
            path: "/workspace/.zcode/skills/demo/SKILL.md",
            directory: "/workspace/.zcode/skills/demo",
            rootPath: "/workspace/.zcode/skills",
            scope: "project",
            source: "zcode",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "skills_listing",
      "context_prefix",
    ]);
    expect(result.systemMessages[0]?.content).not.toContain("demo-skill");
    expect(result.systemMessages[2]?.content).toContain("# 会话专项指导");
    expect(result.systemMessages[2]?.content).toContain("当用户输入 `/<skill-name>` 时");
    expect(result.systemMessages[2]?.content).not.toContain("`! <command>`");
    expect(result.systemMessages[2]?.content).not.toContain(
      "spawn Agent with subagent_type=Explore",
    );
    expect(result.systemMessages[2]?.content).not.toContain(
      "Use the Agent tool with specialized agents",
    );
    expect(metaAttachment(result, "skills_listing")).not.toContain("<system-reminder>");
    expect(metaAttachment(result, "skills_listing")).toContain("以下技能可通过 Skill 工具使用");
    expect(metaAttachment(result, "skills_listing")).toContain("demo-skill");
    expect(metaAttachment(result, "context_prefix")).toContain("# currentDate");
  });

  it("does not mirror available subagents into meta user context", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      agentProfiles: [
        {
          name: "zcode-reviewer",
          description: "检查实现边界。",
          source: "user",
          systemPrompt: "只输出中文。",
          tools: ["Read"],
        },
      ],
    }).build();

    const providerContextText = [
      ...result.systemMessages.map((message) => String(message.content)),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");

    expect(result.metaUserAttachments.map((attachment) => attachment.source)).not.toContain(
      "subagents" as ContextMetaUserAttachmentSource,
    );
    expect(providerContextText).not.toContain("Available agent types");
    expect(providerContextText).not.toContain("zcode-reviewer");
  });

  it("lists additional directory paths immediately after the primary working directory", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      additionalDirectories: ["/work/backend", "C:\\work\\shared folder"],
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "v24",
      },
    }).build();

    const environment = result.sections.find((section) => section.source === "env_info");
    expect(environment?.content).toContain(
      "- 主工作目录: /workspace\n- 附加目录:\n  - /work/backend\n  - C:\\work\\shared folder\n- 是否 Git 仓库:",
    );
    expect(
      result.systemMessages.some((message) =>
        String(message.content).includes(environment!.content),
      ),
    ).toBe(true);
  });

  it("keeps the environment prompt unchanged for an absent or empty additional directory list", () => {
    const config = {
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "v24",
      },
    };
    const original = createContextBuilder(config).build();
    const empty = createContextBuilder({ ...config, additionalDirectories: [] }).build();

    expect(empty).toEqual(original);
    expect(
      original.sections.find((section) => section.source === "env_info")?.content,
    ).not.toContain("附加目录");
  });

  it("renders environment info copy in Chinese", () => {
    const section = buildEnvInfoSection(
      {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
        gitBranch: "main",
        gitMainBranch: "main",
        gitUser: "ZCode Tester <tester@example.com>",
        gitStatus: "clean",
        gitStatusLines: [],
        recentCommits: ["abc123 test commit"],
      },
      contextTestModel,
    );

    expect(section.content).toContain("# 环境");
    expect(section.content).toContain("- 主工作目录: /workspace");
    expect(section.content).not.toContain("Node version");
    expect(section.content).toContain("- 你由名为 openai/gpt-5 的模型驱动。");
    expect(section.content).toContain("- 是否 Git 仓库: 是");
    expect(section.content).not.toContain("**Git status snapshot**");
    expect(section.content).not.toContain("**Main branch**: main");
    expect(section.content).not.toContain("**Git user**");
    expect(section.content).not.toContain("### Recent commits");
    expect(section.content).not.toContain("当前环境");

    const nonGitSection = buildEnvInfoSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: false,
    });
    expect(nonGitSection.content).toContain("- 是否 Git 仓库: 否");
    expect(nonGitSection.content).not.toContain("不是 Git 仓库");
    expect(nonGitSection.content).not.toContain("- **Git**:");
  });

  it("renders git snapshot copy as systemContext", () => {
    const section = buildGitSystemContextSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory",
      gitMainBranch: "staging",
      gitUser: "Dev User",
      gitStatus: "dirty",
      gitStatusLines: [
        "M docs/notes/prompt-assembly-notes.md",
        " M docs/notes/tool-descriptions-notes.md",
        " M packages/contracts/src/tools/ask-user-question.ts",
        "?? docs/plan/tool-prompt-plan.md",
      ],
      recentCommits: [
        "ed2cac59d Merge branch 'feat/trajectory' of https://git.example.invalid/codegeex/z-code into feat/trajectory",
        "07957b58c chore: update doc",
      ],
    });

    expect(section?.content).toBe(
      [
        "gitStatus: 这是会话开始时的 git 状态。注意该状态是某一时刻的快照，不会在会话过程中更新。",
        "",
        "当前分支: feat/trajectory",
        "",
        "主分支（通常用于发 PR）: staging",
        "",
        "Git 用户: Dev User",
        "",
        "状态:\nM docs/notes/prompt-assembly-notes.md\n M docs/notes/tool-descriptions-notes.md\n M packages/contracts/src/tools/ask-user-question.ts\n?? docs/plan/tool-prompt-plan.md",
        "",
        "最近提交:\ned2cac59d Merge branch 'feat/trajectory' of https://git.example.invalid/codegeex/z-code into feat/trajectory\n07957b58c chore: update doc",
      ].join("\n"),
    );
    expect(
      buildGitSystemContextSection({
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
      })?.content,
    ).toContain("状态:\n（未知）");
    expect(
      buildGitSystemContextSection({
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
        isGitRepository: false,
        gitStatus: "not_repo",
      }),
    ).toBeNull();
  });

  it("renders an empty recent commits block without placeholder text", () => {
    const section = buildGitSystemContextSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory",
      gitMainBranch: "main",
      gitStatus: "clean",
      gitStatusLines: [],
      recentCommits: [],
    });

    expect(section?.content).toContain("最近提交:\n");
    expect(section?.content).not.toContain("最近提交:\n(none)");
  });

  it("renders the fixed ZCode CLI prefix and identity body without duplication", () => {
    const prefixSection = buildCliPrefixSection();
    const identitySection = buildIdentitySection();

    expect(prefixSection.content).toBe("你是 ZCode，一个交互式编码智能体");
    expect(identitySection.content).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(identitySection.content).not.toContain("# Agent Identity");
    expect(identitySection.content).not.toContain("你是 ZCode，一个交互式编码智能体");
    expect(`${prefixSection.content}\n${identitySection.content}`).not.toContain("${");
    expect(`${prefixSection.content}\n${identitySection.content}`).not.toContain("an AI assistant");
  });

  it("includes compact stable body boundaries", () => {
    const section = buildIdentitySection();

    expect(section.content).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(section.content).not.toContain("# Agent Identity");
    expect(section.content).toContain("# 运行时框架（Harness）");
    expect(section.content).toContain("重要：");
    expect(section.content).toContain("已获授权的安全测试");
    expect(section.content).toContain("工具运行在用户选择的权限模式之后");
    expect(section.content).toContain(
      "系统可能通过会话中途的 system turn 发送更新、提醒或规则修改。这些内容由系统控制，不同于函数结果。Hook 可能拦截工具调用；请把 hook 输出当作用户反馈。",
    );
    expect(section.content).not.toContain(
      "<system-reminder> tags in messages and tool results are injected by the harness",
    );
    expect(section.content).not.toContain(DEFAULT_COMMUNICATION_PROMPT);
    expect(section.content).not.toContain("对难以逆转或对外");
    expect(section.content).not.toContain("Report results plainly");
    expect(section.content).not.toContain("# 会话专项指导");
    expect(section.content).not.toContain("`! <command>`");
    expect(section.content).not.toContain("`/<skill-name>`");
    expect(section.content).not.toContain("# Task Behavior");
    expect(section.content).not.toContain("# Risky Actions");
    expect(section.content).not.toContain("# Communication Style");
  });

  it("includes slash skill guidance in the available-skills metadata", () => {
    const section = buildSkillsSection({
      outcome: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "demo-skill",
            description: "Use this for demos",
            path: "/workspace/.zcode/skills/demo/SKILL.md",
            directory: "/workspace/.zcode/skills/demo",
            rootPath: "/workspace/.zcode/skills",
            scope: "project",
            source: "zcode",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    });

    expect(section?.content).not.toContain("`/<skill-name>`");
    expect(section?.content).not.toContain("Do not guess missing skill names.");
  });

  it("shows plugin-qualified skill names in the available-skills metadata", () => {
    const section = buildSkillsSection({
      outcome: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "test-driven-development",
            description: "Use this for TDD workflows",
            pluginName: "superpowers",
            qualifiedName: "superpowers:test-driven-development",
            path: "/plugins/superpowers/skills/test-driven-development/SKILL.md",
            directory: "/plugins/superpowers/skills/test-driven-development",
            rootPath: "/plugins/superpowers/skills",
            scope: "system",
            source: "plugin",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    });

    expect(section?.content).toContain("superpowers:test-driven-development");
    expect(section?.content).toContain("也可用 test-driven-development 加载");
  });
});

// ── 用户系统提示词覆盖（docs/specs/agent-system-prompt-chinese-and-profiles.md §1.4）──
//
// systemPromptOverride 只替换交互身份与行为规范段（identity / Dynamic Behavior /
// Session Guidance / Context Management），保留 cli-prefix、desktop、Environment/Git、
// Memory、Output Style 等运行时事实段；customSystemPrompt（工作流子代理）语义不变。
describe("context builder — system prompt override", () => {
  const envInfo = {
    cwd: "/workspace",
    platform: "linux",
    shell: "bash",
    osVersion: "Linux 6.6.0",
    nodeVersion: "v24.14.0",
  } as const;

  it("replaces identity and behavior sections while keeping runtime fact sections", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      presentationSurface: "zcode_desktop",
      envInfo,
      memoryRoot: "/workspace/.zcode/memory",
      outputStyle: {
        name: "Terse",
        prompt: "Keep responses short.",
        keepCodingInstructions: false,
      },
      systemPromptOverride: "你是这个工作区的领域专家助手。",
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody.startsWith("\n你是这个工作区的领域专家助手。")).toBe(true);
    // Desktop Context 是 stable 缓存段，与覆盖正文同处 stable system message。
    expect(stableBody).toContain("# ZCode Desktop 上下文");

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    // 替换段不再出现。
    expect(dynamic).not.toContain("你是一个交互式 ZCode 智能体");
    expect(dynamic).not.toContain(AGENT_SECURITY_NOTICE);
    expect(dynamic).not.toContain(buildAgentHarnessBlock());
    expect(dynamic).not.toContain("# 与用户沟通");
    expect(dynamic).not.toContain("# 会话专项指导");
    expect(dynamic).not.toContain("# 上下文管理");
    expect(dynamic).not.toContain(buildAgentDynamicBehaviorBody());
    // 保留段照常输出。
    expect(stableBody).toContain("# ZCode Desktop 上下文");
    expect(dynamic).toContain("# 环境");
    expect(dynamic).toContain("# 记忆（Memory）");
    expect(dynamic).toContain("# 输出风格：Terse");
  });

  it("keeps the git snapshot when an override is active", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        ...envInfo,
        isGitRepository: true,
        gitBranch: "feature/alignment",
        gitMainBranch: "main",
        gitUser: "ZCode Tester <tester@example.com>",
        gitStatus: "dirty",
        gitStatusLines: [" M package.json"],
        recentCommits: ["abc123 test commit"],
      },
      systemPromptOverride: "你是这个工作区的领域专家助手。",
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).toContain("gitStatus: 这是会话开始时的 git 状态");
    expect(dynamic).toContain("当前分支: feature/alignment");
    expect(dynamic).not.toContain(buildAgentContextManagementBody());
  });

  it("prefers the workflow actor identity over the override", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      workflowActor: { name: "judge" },
      systemPromptOverride: "你是这个工作区的领域专家助手。",
    }).build();

    const text = result.systemMessages
      .map((message) => String(message.content))
      .join("\n");
    expect(text).toContain("你是动态工作流 run 内的子代理");
    expect(text).not.toContain("你是这个工作区的领域专家助手。");
  });

  it("ignores blank overrides and falls back to the built-in identity", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      systemPromptOverride: "   ",
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toMatch(/^\n?你是一个交互式 ZCode 智能体/);
    expect(String(result.systemMessages[2]?.content ?? "")).toContain("# 与用户沟通");
  });

  it("composes the editable default body from the same shared copy", () => {
    // composeDefaultAgentPromptBody 是设置页「载入内置提示词」的数据源；
    // 这里锁定它与 builder 内置段落的组装一致性（顺序 + 空行边界）。
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      guidanceToolNames: ["Skill"],
      skills: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "demo-skill",
            description: "Demo skill",
            path: "/workspace/.zcode/skills/demo/SKILL.md",
            directory: "/workspace/.zcode/skills/demo",
            rootPath: "/workspace/.zcode/skills",
            scope: "project",
            source: "zcode",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    }).build();

    const expected = [
      buildAgentIdentityBody(false),
      buildAgentDynamicBehaviorBody(),
      buildAgentContextManagementBody(),
    ].join("\n\n");
    const actual = [
      result.sections.find((section) => section.source === "identity")?.content,
      result.sections.find((section) => section.source === "dynamic_behavior")?.content,
      result.sections.find((section) => section.source === "context_management")?.content,
    ].join("\n\n");
    expect(actual).toBe(expected);
  });
});

// ── 工作流子代理身份（docs/dynamic-workflow/authoring.md「The system prompt」）──
//
// persona 不再整段替换子代理的系统提示：基座段（CLI prefix、安全行、Harness、memory）保留，
// 交互式身份换成工作流子代理契约，persona 叠加其上；面向「与用户对话」的三段（desktop、
// Dynamic Behavior、session guidance）跳过。
describe("context builder — workflow actor identity", () => {
  const envInfo = {
    cwd: "/workspace",
    platform: "linux",
    shell: "bash",
    osVersion: "Linux 6.6.0",
    nodeVersion: "v24.14.0",
  } as const;

  function systemText(config: Parameters<typeof createContextBuilder>[0]): string {
    return createContextBuilder(config)
      .build()
      .systemMessages.map((message) => String(message.content))
      .join("\n");
  }

  it("stacks the persona on the harness contract instead of replacing the base prompt", () => {
    const text = systemText({
      workingDirectory: "/workspace",
      envInfo,
      presentationSurface: "zcode_desktop",
      guidanceToolNames: ["Skill", "Read"],
      workflowActor: { name: "reviewer", persona: "You are a strict reviewer." },
    });

    // 开场句 → persona → 安全行 → Harness → 契约，且顺序固定。
    const opening = text.indexOf("你是动态工作流 run 内的子代理，名为“reviewer”。");
    const persona = text.indexOf("You are a strict reviewer.");
    const security = text.indexOf("重要：可协助已获授权的安全测试");
    const harness = text.indexOf("# 运行时框架（Harness）");
    const contract = text.indexOf("# 工作流内的契约");
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(opening).toBeLessThan(persona);
    expect(persona).toBeLessThan(security);
    expect(security).toBeLessThan(harness);
    expect(harness).toBeLessThan(contract);

    // 基座里保住的纪律。
    expect(text).toContain("引用代码时使用 `file_path:line_number` 格式");
    expect(text).toContain("如实报告结果");
    expect(text).toContain("调用 `escalate`");
    expect(text).toContain("`submit_result`");

    // 交互式身份与面向用户对话的三段不在。
    expect(text).not.toContain("交互式 ZCode 智能体");
    expect(text).not.toContain("# 与用户沟通");
    expect(text).not.toContain("对难以逆转或对外");
    expect(text).not.toContain("# 会话专项指导");
    expect(text).not.toContain("ZCode Desktop");
    // 后续段照常。
    expect(text).toContain("# 环境");
  });

  it("omits the named clause and the persona block when the actor has neither", () => {
    const text = systemText({
      workingDirectory: "/workspace",
      envInfo,
      workflowActor: {},
    });
    expect(text).toContain("你是动态工作流 run 内的子代理。脚本创建了你");
    expect(text).not.toContain("名为“");
    expect(text).toContain("# 工作流内的契约");
    expect(text).not.toContain("交互式 ZCode 智能体");
  });

  // 产物（docs/dynamic-workflow/authoring.md「The system prompt」）：子代理仍然没有任何产物工具
  // （只有脚本能发布），但被指名输出路径时必须写到那里并把路径交回来——脚本据此发布给用户。
  it("routes a named output path back through the result instead of forbidding files outright", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo, workflowActor: {} });

    expect(text).toContain(
      "不要自作主张写报告或总结文件；发现写进结果。ask 指名了输出路径时，恰好写到那里并在结果中返回该路径——脚本会把它发布给用户。",
    );
    // 旧句子（无条件劝阻）不得残留：它与「按 ask 指名的路径写文件」直接冲突。
    expect(text).not.toContain("Do not write report or summary files unless the ask tells you to");
    // 子代理仍然没有产物工具：提示里不出现任何 `artifact.*` 的调用面。
    expect(text).not.toContain("artifact.file");
    expect(text).not.toContain("PublishArtifact");
  });

  // 2026-09-05 追记（docs/dynamic-workflow/authoring.md）：实盘零工具的子代理被
  // 「每个论断都要有依据」逼去找它没有的工具，发出 `escalate("placeholder")`。修法：先说死
  // 工具面，再说证据从哪来。2026-09-12 起 persona 没有工具档位（docs/dynamic-workflow/authoring.md），
  // 契约只有一份文本。
  it("drops the interactive CLI prefix: the subagent identity is the first system line", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      workflowActor: { name: "judge" },
    }).build();
    const first = String(result.systemMessages[0]?.content);
    expect(first.startsWith("你是动态工作流 run 内的子代理，名为“judge”。")).toBe(true);
    expect(result.sections.map((section) => section.source)).not.toContain("cli_prefix");
    expect(result.systemMessages.map((m) => String(m.content)).join("\n")).not.toContain(
      "你是 ZCode，一个交互式编码智能体",
    );
  });

  it("states the tool surface and the read-or-ran standard for every actor", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo, workflowActor: {} });
    expect(text).toContain("你拥有常规工作工具");
    expect(text).toContain("没有任何工具能向人提问。");
    expect(text).toContain(
      "每个论断都要有依据：来自你在本会话读过或运行过的东西，或 ask 自带的材料，并说明依据是哪种",
    );
    expect(text).toContain("只有你在这里实际执行过的检查才算通过");
    // 2026-09-08 追记：跑 ask 点名的检查，不拿更快的替身顶替。
    expect(text).toContain("ask 点名了某个检查就按点名的来，不要用更快的替代品");
    // 档位时代的两句不得残留（docs/dynamic-workflow/authoring.md）。
    expect(text).not.toContain("read-only");
    expect(text).not.toContain("a capability your tools do not give you");
  });

  it("lists skills only when the Skill tool is actually registered", () => {
    const skills = {
      skills: [
        {
          name: "demo-skill",
          description: "Demo skill",
          path: "/workspace/.zcode/skills/demo/SKILL.md",
          directory: "/workspace/.zcode/skills/demo",
          rootPath: "/workspace/.zcode/skills",
          scope: "project" as const,
          source: "zcode" as const,
          safeToAutoLoad: true,
          frontmatterKeys: [],
          policy: { allowImplicitInvocation: true },
        },
      ],
      diagnostics: [],
      totalDiscovered: 1,
    };
    const sources = (guidanceToolNames: readonly string[] | undefined) =>
      createContextBuilder({
        workingDirectory: "/workspace",
        envInfo,
        skills: skills as never,
        workflowActor: { name: "judge" },
        ...(guidanceToolNames === undefined ? {} : { guidanceToolNames }),
      })
        .build()
        .metaUserAttachments.map((attachment) => attachment.source);

    // 工具表里没有 Skill → 不列技能（列了只会让它相信自己有一个没有的工具）。
    expect(sources(["submit_result", "escalate"])).not.toContain("skills_listing");
    // Skill 在表里 → 照列。
    expect(sources(["Skill", "submit_result", "escalate"])).toContain("skills_listing");
    // 工具表缺席（旧调用方 / 测试）→ 维持旧行为。
    expect(sources(undefined)).toContain("skills_listing");
  });

  it("refuses workflowActor together with customSystemPrompt", () => {
    expect(() =>
      createContextBuilder({
        workingDirectory: "/workspace",
        envInfo,
        customSystemPrompt: "You are concise.",
        workflowActor: { persona: "You review." },
      }).build(),
    ).toThrow(/mutually exclusive/);
  });

  it("leaves the interactive identity byte-identical after the shared-helper refactor", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo });
    expect(text).toContain(
      "\n你是一个交互式 ZCode 智能体，帮助用户完成软件工程任务。\n\n重要：可协助已获授权的安全测试",
    );
    expect(text).toContain("\n\n# 运行时框架（Harness）\n- 你在工具调用之外输出的文本");
  });
});
