import { useRef, useState, type ReactNode } from "react";
import { CircleXIcon, SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";

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
  const { intl } = useZCodeIntl();
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
  const [search, setSearch] = useState({ groupKey: group?.key, query: "" });
  if (search.groupKey !== group?.key) setSearch({ groupKey: group?.key, query: "" });
  const query = search.groupKey === group?.key ? search.query : "";
  const filteredItems =
    group?.items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())) ??
    [];
  const modelListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
        setSearch({ groupKey: candidate.key, query: "" });
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
      <div role="separator" className="-mx-1 my-1 h-px shrink-0 bg-border/50" />
      {/* 搜索栏重复的右内边距会比模型行多缩进 8px；右侧直接复用面板内边距。 */}
      <div className="flex items-center gap-2 pl-2 py-1">
        <span
          data-composer-model-heading
          className="shrink-0 py-1.5 text-ui-sm font-normal text-foreground-subtle"
        >
          {options.modelsLabel}
        </span>
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest"
          />
          <Input
            size="sm"
            ref={searchRef}
            // 原生 search 在聚焦且有文字时绘制蓝色清除按钮；用统一的主题控件承载清除操作。
            type="text"
            role="searchbox"
            value={query}
            data-testid="composer-model-search"
            aria-label={intl.formatMessage({ id: "chat.toolbar.model.searchPlaceholder" })}
            placeholder={intl.formatMessage({ id: "chat.toolbar.model.searchPlaceholder" })}
            className="rounded-full border-transparent bg-transparent pl-7 pr-7 text-ui-sm hover:border-border focus-visible:border-border focus-visible:bg-transparent compact-web:text-mobile-input-safe"
            onChange={(event) => setSearch({ groupKey: group?.key, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                modelListRef.current
                  ?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')
                  ?.focus();
              }
            }}
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="composer-model-search-clear"
              aria-label={intl.formatMessage({ id: "chat.toolbar.model.clearSearch" })}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-foreground-subtlest hover:bg-transparent hover:text-foreground-subtle focus-visible:border-border"
              onClick={() => {
                setSearch({ groupKey: group?.key, query: "" });
                searchRef.current?.focus();
              }}
            >
              <CircleXIcon aria-hidden="true" className="size-3.5 fill-current stroke-menu" />
            </Button>
          ) : null}
        </div>
      </div>
      {group ? renderConnection(group) : null}
      <ScrollFadeViewport
        ref={modelListRef}
        className="max-h-60 flex-initial"
        inert={options.providerMenu?.pending || undefined}
        data-composer-model-list
      >
        {filteredItems.length > 0 ? (
          renderItems(filteredItems)
        ) : (
          <div role="status" className="px-2 py-3 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolbar.model.empty" })}
          </div>
        )}
      </ScrollFadeViewport>
    </ComposerProviderMenu>
  );
}
