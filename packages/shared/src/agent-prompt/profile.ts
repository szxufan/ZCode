// ============================================================
// 系统提示词配置档（prompt profile）类型与常量
// ============================================================
//
// 存储与唯一所有者：Host 的 ISettingService（~/.zcode/v2/setting.json）。
// 内置中文提示词不落盘；active id 缺省 / "default" / 指向已删除配置档时回落内置。
// 协议与 CLI 只感知解析后的覆盖文本（agentSystemPromptOverride），不感知配置档存储。

export interface AgentPromptProfile {
  /** 稳定 id（生成后不变，重命名只改 name）。 */
  id: string;
  name: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 内置中文提示词的保留 id。 */
export const AGENT_PROMPT_BUILTIN_PROFILE_ID = "default";

export const AGENT_PROMPT_PROFILES_MAX = 20;
export const AGENT_PROMPT_PROFILE_NAME_MAX = 100;
export const AGENT_PROMPT_PROFILE_CONTENT_MAX = 100_000;

/**
 * 解析"当前生效的覆盖文本"：active id 缺省、为内置 id、或指向不存在的配置档时返回
 * undefined（= 使用内置提示词）。Host 在会话创建注入与热同步前统一走本函数。
 */
export function resolveAgentPromptOverride(
  settings: Pick<AppSettingsShape, "agentPromptProfiles" | "agentPromptActiveProfileId">,
): string | undefined {
  const activeId = settings.agentPromptActiveProfileId?.trim();
  if (!activeId || activeId === AGENT_PROMPT_BUILTIN_PROFILE_ID) {
    return undefined;
  }
  const profile = settings.agentPromptProfiles?.find((entry) => entry.id === activeId);
  const content = profile?.content.trim();
  return content ? content : undefined;
}

/** 避免 agent-prompt 模块反向依赖完整 AppSettings 类型；由 protocol.ts 结构兼容传入。 */
interface AppSettingsShape {
  agentPromptProfiles?: AgentPromptProfile[];
  agentPromptActiveProfileId?: string;
}
