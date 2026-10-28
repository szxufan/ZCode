import { useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import {
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import "@/chat-input-toolbar/composer-thought-meter.css";

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
  /** 仅用于触发器展示当前档位；调整入口是独立思考控件，不在合并菜单内写入。 */
  levels: readonly { value: string; label: string }[];
  value: string;
}

export function getComposerThoughtDisplay(options: ComposerModelOptions) {
  const current = options.levels.find((level) => level.value === options.value);
  const thinking = options.levels.filter((level) => !isNoThoughtLevel(level));
  const progress =
    current && !isNoThoughtLevel(current)
      ? ((thinking.findIndex((level) => level.value === current.value) + 1) / thinking.length) * 100
      : 0;
  return { label: current?.label ?? "—", progress };
}

export function isGlmHighspeedModel(name: string) {
  // GLM FlashX 与 Highspeed 共用视觉；只按显示名称判定，避免误命中其他品牌。
  return /glm/i.test(name) && /highspeed|flashx/i.test(name);
}

export function ComposerThoughtIndicator({
  options,
  highspeed = false,
}: {
  options: ComposerModelOptions;
  highspeed?: boolean;
}) {
  const { label, progress } = getComposerThoughtDisplay(options);
  return (
    <>
      <span
        className="shrink-0 text-foreground-subtle group-data-[composer-compact=true]/combined:hidden"
        data-composer-thought-label
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-testid="composer-thought-meter"
        data-highspeed={highspeed}
        data-progress={progress}
        className="relative hidden h-4 w-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 group-data-[composer-compact=true]/combined:block"
      >
        <span
          className="composer-thought-meter-fill absolute bottom-0 left-0 w-full rounded-full bg-success"
          style={{ height: `${progress}%` }}
        />
      </span>
    </>
  );
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
  // 思考档位调整已收敛到独立思考控件；合并菜单只负责供应商与模型选择，
  // 触发器上的档位文字/竖条仅展示当前值（docs/composer-model-thinking.md）。
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
