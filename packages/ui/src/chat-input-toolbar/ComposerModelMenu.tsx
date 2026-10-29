import { useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import { DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";

export interface ComposerModelOptions {
  providerMenu?: {
    groups: readonly ComposerPlanGroup[];
    selectedKey?: string;
    pending: boolean;
    error: string | null;
    onSelect: (group: ComposerPlanGroup) => void;
  };
  providerLabel: string;
  modelsLabel: string;
  selectModelLabel: string;
}

export function ComposerModelMenu({
  groups,
  normalizedValue,
  options,
  renderItems,
  renderConnection,
  providerFooter,
  isItemLocked,
  onSelectModel,
}: {
  groups: readonly ModelSelectGroup[];
  normalizedValue: string;
  options: ComposerModelOptions;
  renderItems: (items: ModelSelectGroup["items"]) => ReactNode;
  renderConnection: (group: ModelSelectGroup) => ReactNode;
  providerFooter?: ReactNode;
  isItemLocked: (value: string) => boolean;
  onSelectModel: (value: string) => void;
}) {
  // 无可用模型的分组仍可浏览配置；实际选择始终由 Composer owner 回传。
  const [browse, setBrowse] = useState<{ key: string; selection: string } | null>(null);
  const menuGroups: readonly ComposerPlanGroup[] = options.providerMenu?.groups ?? groups;
  const selected =
    menuGroups.find((group) => group.key === options.providerMenu?.selectedKey) ??
    menuGroups.find((group) => group.items.some((item) => item.value === normalizedValue));
  const group =
    (browse?.selection === normalizedValue
      ? menuGroups.find((item) => item.key === browse.key)
      : undefined) ??
    selected ??
    menuGroups[0];
  // 思考档位展示与调整都收敛到独立思考控件；合并菜单只负责供应商与模型选择
  // （docs/composer-model-thinking.md「合并入口触发器不再显示思考档位」）。
  return (
    <ComposerProviderMenu
      groups={menuGroups}
      error={options.providerMenu?.error}
      disabled={options.providerMenu?.pending}
      loading={options.providerMenu?.pending}
      isDisabled={(candidate) => Boolean((candidate as ComposerPlanGroup).connection?.disabled)}
      separatorBeforeKey={
        options.providerMenu
          ? menuGroups.find(
              (candidate) =>
                !candidate.connection && !candidate.key.startsWith("registry-provider:account:"),
            )?.key
          : undefined
      }
      group={group}
      label={options.providerLabel}
      providerFooter={providerFooter}
      onSelect={(candidate) => {
        if (options.providerMenu) {
          options.providerMenu.onSelect(candidate as ComposerPlanGroup);
          return;
        }
        setBrowse({ key: candidate.key, selection: normalizedValue });
        // 复用唯一选择链路，供应商页只负责导航，不缓存模型状态。
        const model =
          candidate.items.find(
            (item) => item.value === normalizedValue && !isItemLocked(item.value),
          ) ?? candidate.items.find((item) => !isItemLocked(item.value));
        if (model && model.value !== normalizedValue) onSelectModel(model.value);
      }}
    >
      <DropdownMenuSeparator className="bg-border/50" />
      <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
        {options.modelsLabel}
      </DropdownMenuLabel>
      {group ? renderConnection(group) : null}
      <ScrollFadeViewport
        className="max-h-60 flex-initial"
        inert={options.providerMenu?.pending || undefined}
        data-composer-model-list
      >
        {group ? renderItems(group.items) : null}
      </ScrollFadeViewport>
    </ComposerProviderMenu>
  );
}
