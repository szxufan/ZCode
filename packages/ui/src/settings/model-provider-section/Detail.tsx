import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { SavePersonalModelDraftInput } from "@zcode/provider";
import type { ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import { ModelProviderLoadingCard } from "./StatusCards.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ModelProviderSectionDetail({
  selectedNavItem,
  navLoading = false,
  settingsRevision,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onOpenApiKeyUrl,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navLoading?: boolean;
  settingsRevision?: number;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onOpenApiKeyUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const loadingLabel = intl.formatMessage({ id: "common.loading" });

  if (!selectedNavItem) {
    // 智谱账号分组移除后，自定义供应商为空是合法初始态：loading 显示加载卡，否则提示去添加。
    if (navLoading) {
      return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
    }
    return (
      <div className="bg-background/50 rounded-2xl p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.empty" })}
      </div>
    );
  }

  if (!selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  const customProvider = selectedNavItem.provider;
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // 仅展示预设模板声明的入口，不根据地址猜测自定义 Provider 的 Key 控制台。
    <InlineEditableProviderCard
      provider={customProvider}
      settingsRevision={settingsRevision}
      onSave={onSave}
      onAddPersonalModel={onAddPersonalModel}
      onSavePersonalModelDraft={onSavePersonalModelDraft}
      onSetPersonalModelEnabled={onSetPersonalModelEnabled}
      onDeletePersonalModel={onDeletePersonalModel}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}
