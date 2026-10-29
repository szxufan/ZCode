import { useMemo } from "react";
import {
  AGENT_PROMPT_BUILTIN_PROFILE_ID,
  type AgentPromptProfile,
} from "@zcode/shared";
import { TID_CHAT_PROMPT_PROFILE_SWITCH } from "@zcode/shared/test-ids";
import { ChevronDownIcon, ScrollTextIcon, Settings2Icon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

/**
 * composer 左下工具条的提示词配置档快速切换器（规格：
 * docs/specs/agent-system-prompt-chinese-and-profiles.md §3）。
 *
 * 配置档与本机共享设置走本机 Host 服务（与 SettingsPage 同边界），不用当前 workspace
 * 的上下文服务——远端 workspace 上下文里切换也不能把设置写进远端。切换即
 * useSettings().update({ agentPromptActiveProfileId })：本地即时反映，热更新由
 * useSettingService 的同步分支推给活跃会话，新会话由 runtime-materialization 偏好注入。
 */

export function PromptProfileSwitchControl({ disabled = false }: { disabled?: boolean }) {
  const { intl } = useZCodeIntl();
  // 共享设置属于本机 Host；固定本机服务，避免远端 workspace 上下文写入远端 setting。
  const localHostServices = useBaseWorkspaceServices();
  const { settings, update } = useSettings({ services: localHostServices });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);

  const profiles: readonly AgentPromptProfile[] = useMemo(
    () => settings?.agentPromptProfiles ?? [],
    [settings],
  );
  const activeProfileId = settings?.agentPromptActiveProfileId;
  const isBuiltinActive = !activeProfileId || activeProfileId === AGENT_PROMPT_BUILTIN_PROFILE_ID;
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);

  const currentLabel = isBuiltinActive
    ? intl.formatMessage({ id: "chat.toolbar.promptProfile.builtin" })
    : activeProfile?.name ?? intl.formatMessage({ id: "chat.toolbar.promptProfile.builtin" });

  const activateProfile = (profileId: string) => {
    void update({ agentPromptActiveProfileId: profileId }).catch((error: unknown) => {
      logger.warn("[PromptProfileSwitchControl] 切换提示词配置档失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const openManage = () => {
    setPendingSettingsSectionIntent("agentPrompt");
    openSettingsTab();
  };

  return (
    <DropdownMenu>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.promptProfile.label" })}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-lg pl-2 pr-1.5 text-ui-base"
            disabled={disabled}
            data-testid={TID_CHAT_PROMPT_PROFILE_SWITCH}
            aria-label={intl.formatMessage({ id: "chat.toolbar.promptProfile.label" })}
          >
            <ScrollTextIcon className="size-4 text-current" />
            <span className="hidden min-w-0 whitespace-nowrap @xl/composer:inline-flex">
              {currentLabel}
            </span>
            <ChevronDownIcon className="size-3.5 text-current opacity-60" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuCheckboxItem
          checked={isBuiltinActive}
          onCheckedChange={() => activateProfile(AGENT_PROMPT_BUILTIN_PROFILE_ID)}
        >
          {intl.formatMessage({ id: "chat.toolbar.promptProfile.builtin" })}
        </DropdownMenuCheckboxItem>
        {profiles.map((profile) => (
          <DropdownMenuCheckboxItem
            key={profile.id}
            checked={profile.id === activeProfileId}
            onCheckedChange={() => activateProfile(profile.id)}
          >
            {profile.name}
          </DropdownMenuCheckboxItem>
        ))}
        {profiles.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={openManage}>
          <Settings2Icon className="size-4" />
          {intl.formatMessage({ id: "chat.toolbar.promptProfile.manage" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
