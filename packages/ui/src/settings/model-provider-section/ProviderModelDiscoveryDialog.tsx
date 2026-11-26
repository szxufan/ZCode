import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  ImportDiscoveredProviderModelsInput,
  ProviderModelDiscoveryCandidate,
} from "@zcode/provider";
import {
  TID_MODEL_DISCOVERY_CONFIRM_BUTTON,
  TID_MODEL_DISCOVERY_DIALOG,
  TID_MODEL_DISCOVERY_MODEL_CHECKBOX,
  TID_MODEL_DISCOVERY_SEARCH_INPUT,
  TID_MODEL_DISCOVERY_SELECT_ALL,
  testId,
} from "@zcode/shared/test-ids";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";

export type ProviderModelDiscoveryCandidateView = ProviderModelDiscoveryCandidate;

export function ProviderModelDiscoveryDialog({
  open,
  providerId,
  connectionFingerprint,
  candidates,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  providerId: string;
  connectionFingerprint: string;
  candidates: readonly ProviderModelDiscoveryCandidateView[];
  onOpenChange: (open: boolean) => void;
  onImport: (input: ImportDiscoveredProviderModelsInput) => Promise<unknown>;
}) {
  const { intl } = useZCodeIntl();
  const [searchValue, setSearchValue] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(searchValue);

  const importableCandidates = useMemo(
    () => candidates.filter((candidate) => !candidate.existing && candidate.chatCapable),
    [candidates],
  );
  const filteredImportable = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return importableCandidates;
    return importableCandidates.filter((candidate) =>
      candidate.modelId.toLowerCase().includes(query),
    );
  }, [deferredSearch, importableCandidates]);

  const selectableIds = useMemo(
    () => new Set(filteredImportable.map((candidate) => candidate.modelId)),
    [filteredImportable],
  );
  const selectedInFilter = useMemo(
    () => filteredImportable.filter((candidate) => selectedIds.has(candidate.modelId)).length,
    [filteredImportable, selectedIds],
  );
  const allChecked = selectableIds.size > 0 && selectedInFilter === selectableIds.size;
  const someChecked = selectedInFilter > 0 && !allChecked;

  const toggleSelection = useCallback((modelId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  const setFilterSelection = useCallback(
    (checked: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of selectableIds) {
          if (checked) {
            next.add(id);
          } else {
            next.delete(id);
          }
        }
        return next;
      });
    },
    [selectableIds],
  );

  // 确认时再次计算选中 ∩ 候选 ∩ 非已有，只提交该子集。
  const selectedModels = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          !candidate.existing && candidate.chatCapable && selectedIds.has(candidate.modelId),
      ),
    [candidates, selectedIds],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // 导入期间阻止关闭/重开，避免旧请求结束掉重开的新草稿。
      if (importing) return;
      if (!nextOpen) {
        setSearchValue("");
        setSelectedIds(new Set());
        setImportError(null);
      }
      onOpenChange(nextOpen);
    },
    [importing, onOpenChange],
  );

  const handleImport = useCallback(async (): Promise<boolean> => {
    if (importing || selectedModels.length === 0) return false;
    setImporting(true);
    setImportError(null);
    try {
      await onImport({
        providerId,
        connectionFingerprint,
        models: selectedModels.map((model) => ({
          modelId: model.modelId,
          config: structuredClone(model.config),
        })),
      });
      setSearchValue("");
      setSelectedIds(new Set());
      // 成功后由弹窗主动关闭；open 是父级受控状态，仅清空选择不会收起弹窗。
      onOpenChange(false);
      return true;
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setImporting(false);
    }
  }, [connectionFingerprint, importing, onImport, onOpenChange, providerId, selectedModels]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[min(48rem,calc(100vh-4rem))] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
        data-testid={TID_MODEL_DISCOVERY_DIALOG}
        data-no-model-drag="true"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({ id: "settings.modelProvider.discoveryDialogTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.discoveryDialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div inert={importing} className="min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1">
          <SettingsSearchInput
            data-testid={TID_MODEL_DISCOVERY_SEARCH_INPUT}
            value={searchValue}
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.discoverySearchPlaceholder",
            })}
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={testId(TID_MODEL_DISCOVERY_SEARCH_INPUT, "clear")}
            onChange={(event) => setSearchValue(event.target.value)}
            onClear={() => setSearchValue("")}
          />
          {candidates.length === 0 ? (
            <PluginSearchEmptyState
              label={intl.formatMessage({ id: "settings.modelProvider.discoveryEmpty" })}
            />
          ) : filteredImportable.length === 0 && importableCandidates.length > 0 ? (
            <PluginSearchEmptyState
              label={intl.formatMessage({ id: "settings.modelProvider.discoverySearchEmpty" })}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-input-border bg-input">
              <div className="flex items-center gap-3 border-b border-input-border px-3 py-2">
                <Checkbox
                  data-testid={TID_MODEL_DISCOVERY_SELECT_ALL}
                  aria-label={intl.formatMessage({
                    id: "settings.modelProvider.discoverySelectAll",
                  })}
                  disabled={selectableIds.size === 0}
                  checked={allChecked ? true : someChecked ? "indeterminate" : false}
                  onCheckedChange={(checked) => setFilterSelection(checked === true)}
                />
                <span className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.discoverySelectAll" })}
                </span>
                <Badge variant="secondary" className="shrink-0 font-mono text-ui-xs">
                  {intl.formatMessage(
                    { id: "settings.modelProvider.discoverySelectedCount" },
                    { count: selectedIds.size },
                  )}
                </Badge>
              </div>
              <div className="divide-y divide-input-border">
                {filteredImportable.map((candidate) => (
                  <ProviderModelDiscoveryRow
                    key={candidate.modelId}
                    candidate={candidate}
                    checked={selectedIds.has(candidate.modelId)}
                    disabled={importing}
                    onToggle={() => toggleSelection(candidate.modelId)}
                  />
                ))}
                {candidates
                  .filter((candidate) => candidate.existing || !candidate.chatCapable)
                  .filter((candidate) => {
                    const query = deferredSearch.trim().toLowerCase();
                    return !query || candidate.modelId.toLowerCase().includes(query);
                  })
                  .map((candidate) => (
                    <ProviderModelDiscoveryRow
                      key={candidate.modelId}
                      candidate={candidate}
                      checked={false}
                      disabled
                      onToggle={() => undefined}
                    />
                  ))}
              </div>
            </div>
          )}
          {importError ? (
            <div
              role="alert"
              className="rounded-lg bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
            >
              {intl.formatMessage(
                { id: "settings.modelProvider.discoveryImportFailure" },
                { error: importError },
              )}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            disabled={importing}
            onClick={() => handleOpenChange(false)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid={TID_MODEL_DISCOVERY_CONFIRM_BUTTON}
            disabled={importing || selectedModels.length === 0}
            onClick={() => void handleImport()}
          >
            {importing ? (
              <LoaderCircle
                className="size-4 animate-spin"
                data-icon="inline-start"
                aria-hidden="true"
              />
            ) : null}
            {intl.formatMessage({
              id: importing
                ? "settings.modelProvider.discoveryImporting"
                : "settings.modelProvider.discoveryConfirm",
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderModelDiscoveryRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  candidate: ProviderModelDiscoveryCandidateView;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { intl } = useZCodeIntl();
  const contextLabel = candidate.config.properties?.contextWindow
    ? formatModelContextWindowLabel(candidate.config.properties.contextWindow)
    : null;
  const modalities: string[] = [];
  const inputFormat = candidate.config.properties?.inputFormat;
  if (inputFormat?.supportsImage) modalities.push("Image");
  if (inputFormat?.supportsVideo) modalities.push("Video");
  return (
    <label
      className={`flex min-w-0 items-center gap-3 px-3 py-2 text-ui-sm ${
        candidate.existing || !candidate.chatCapable
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-surface-hover"
      }`}
    >
      <Checkbox
        data-testid={testId(TID_MODEL_DISCOVERY_MODEL_CHECKBOX, candidate.modelId)}
        checked={candidate.existing || !candidate.chatCapable ? false : checked}
        disabled={disabled || candidate.existing || !candidate.chatCapable}
        onCheckedChange={() => onToggle()}
      />
      <span className="min-w-0 flex-1 truncate font-mono">{candidate.modelId}</span>
      {candidate.existing ? (
        <Badge variant="secondary" className="shrink-0 text-ui-xs">
          {intl.formatMessage({ id: "settings.modelProvider.discoveryExisting" })}
        </Badge>
      ) : !candidate.chatCapable ? (
        <Badge variant="secondary" className="shrink-0 text-ui-xs">
          {intl.formatMessage({ id: "settings.modelProvider.discoveryNotChatCapable" })}
        </Badge>
      ) : null}
      {contextLabel ? (
        <Badge variant="outline" className="shrink-0 font-mono text-ui-xs">
          {contextLabel}
        </Badge>
      ) : null}
      {modalities.length > 0 ? (
        <span className="shrink-0 text-foreground-subtlest text-ui-xs">
          {modalities.join(" · ")}
        </span>
      ) : null}
    </label>
  );
}
