import { describe, expect, it } from "vitest";
import {
  buildPlanSaveDirectoryCandidates,
  buildPlanSaveSuggestedName,
  extractPlanTitle,
} from "@/plan-approval/index.js";

// 计划另存为的文件名与目录候选（docs/ui/plan-detail-side-pane.md「保存计划」）：
// 文件名 = 本地日期 + 标题（Markdown 首个 H1，否则首个非空行，否则 plan）。

describe("extractPlanTitle", () => {
  it("取首个一级标题", () => {
    expect(extractPlanTitle("前言\n\n# Git 提交信息生成重做实施计划\n\n## Context")).toBe(
      "Git 提交信息生成重做实施计划",
    );
  });

  it("忽略代码块里的 # 行", () => {
    expect(extractPlanTitle("```\n# not a heading\n```\n# 真正的标题")).toBe("真正的标题");
  });

  it("没有一级标题时取首个非空行，去掉井号与列表符号", () => {
    expect(extractPlanTitle("\n\n### 重做提交信息生成\n\n1. 第一步")).toBe("重做提交信息生成");
    expect(extractPlanTitle("- 修复登录超时")).toBe("修复登录超时");
  });

  it("没有可用标题时返回 undefined", () => {
    expect(extractPlanTitle("")).toBeUndefined();
    expect(extractPlanTitle("\n\n  \n")).toBeUndefined();
  });
});

describe("buildPlanSaveSuggestedName", () => {
  const now = new Date(2026, 10, 26);

  it("本地日期 + 标题 + .md", () => {
    expect(buildPlanSaveSuggestedName({ markdown: "# 修复登录超时", now })).toBe(
      "2026-11-26-修复登录超时.md",
    );
  });

  it("路径非法字符与空白折叠为连字符", () => {
    expect(buildPlanSaveSuggestedName({ markdown: '# a/b:c*d?e"f<g>h|i', now })).toBe(
      "2026-11-26-a-b-c-d-e-f-g-h-i.md",
    );
    expect(buildPlanSaveSuggestedName({ markdown: "# 修复  登录\t超时", now })).toBe(
      "2026-11-26-修复-登录-超时.md",
    );
  });

  it("标题最长 80 个字符", () => {
    expect(buildPlanSaveSuggestedName({ markdown: `# ${"标".repeat(100)}`, now })).toBe(
      `2026-11-26-${"标".repeat(80)}.md`,
    );
  });

  it("没有可用标题时用 plan", () => {
    expect(buildPlanSaveSuggestedName({ markdown: "", now })).toBe("2026-11-26-plan.md");
    expect(buildPlanSaveSuggestedName({ markdown: "# ???\n\n正文", now })).toBe(
      "2026-11-26-plan.md",
    );
  });
});

describe("buildPlanSaveDirectoryCandidates", () => {
  it("本地工作区：plans 目录优先，其次工作区根目录", () => {
    expect(
      buildPlanSaveDirectoryCandidates({ workspacePath: "/work/app/", remote: false }),
    ).toEqual(["/work/app/docs/superpowers/plans", "/work/app"]);
  });

  it("远程工作区或没有路径时不给候选", () => {
    expect(
      buildPlanSaveDirectoryCandidates({ workspacePath: "/remote/app", remote: true }),
    ).toBeUndefined();
    expect(buildPlanSaveDirectoryCandidates({ remote: false })).toBeUndefined();
  });
});
