// ============================================================
// Skills 列表格式（skills_listing 收集器使用）
// ============================================================

import { AGENT_SKILLS_INTRO, agentSkillAliasSuffix, agentSkillFileSuffix } from "@zcode/shared";
import type { SkillMetadata } from "@zcode/contracts";

export const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;

/** 列表公告正文：完整格式超过预算时，本次所有行降级为名称加路径。增量公告用同一规则。 */
export function buildSkillsContent(skills: readonly SkillMetadata[], budget: number): string {
  // 标题句与行内后缀沿用 fork 的中文载体（packages/shared/src/agent-prompt），
  // 列表改由 skills_listing 收集器渲染后，完整公告与增量公告都从这里取文案。
  const lines = [AGENT_SKILLS_INTRO, ""];
  const sortedSkills = sortSkillsForListing(skills);
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill));
  const full = [...lines, ...skillLines].join("\n");
  if (full.length <= budget) {
    return full;
  }

  const namesOnly = sortedSkills.map(
    (skill) =>
      `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)}${agentSkillFileSuffix(skill.path)}`,
  );
  return [...lines, ...namesOnly].join("\n");
}

/** 列表的固定顺序：按显示名比较。 */
export function sortSkillsForListing(skills: readonly SkillMetadata[]): SkillMetadata[] {
  return [...skills].sort((a, b) => skillDisplayName(a).localeCompare(skillDisplayName(b)));
}

/** 完整格式的一行；增量公告的指纹按这一行计算，不受预算降级影响。 */
export function formatSkillLine(
  skill: SkillMetadata,
  maxDescriptionChars = MAX_DESCRIPTION_CHARS,
): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)}${agentSkillFileSuffix(skill.path)}`;
}

export function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? agentSkillAliasSuffix(skill.name)
    : "";
}
