import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { TID_PLAN_CARD_SAVE } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { PlanSaveButtonProps } from "./contract.js";
import { buildPlanSaveDirectoryCandidates, buildPlanSaveSuggestedName } from "./planSave.js";

/**
 * 「保存计划」：把计划原文另存为本机 Markdown（docs/ui/plan-detail-side-pane.md）。
 * 计划卡片与详情侧栏共用。只读取调用方给的正文并发起平台另存为，不发送 task command；
 * 没有另存为能力的平台（本 fork 的 Web 端）不渲染。
 */
export function PlanSaveButton({
  markdown,
  scope,
  disabled = false,
  testId = TID_PLAN_CARD_SAVE,
}: PlanSaveButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "planTool.panel.save" });
  if (!platform.saveFile) return null;

  const save = async () => {
    if (!markdown || !platform.saveFile || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const candidates = buildPlanSaveDirectoryCandidates(scope);
      const result = await platform.saveFile({
        data: new TextEncoder().encode(markdown).buffer,
        suggestedName: buildPlanSaveSuggestedName({ markdown }),
        ...(candidates ? { defaultDirectoryCandidates: candidates } : {}),
      });
      // 取消另存为是用户改变主意，不是失败：不产生文件，也不提示。
      if (!result.success && !result.canceled) throw new Error(result.error || "save_failed");
      // 与 file-menu 的 fileSaveSuccessMessageId 同一规则：桌面已写入文件，Web 只表示已交给浏览器下载。
      const messageId =
        result.success && !result.canceled
          ? platform.canOpenLocalFiles
            ? "fileActions.saved"
            : "fileActions.downloadStarted"
          : null;
      if (messageId) toast(intl.formatMessage({ id: messageId }));
    } catch (error) {
      logger.warn("[plan-approval] 保存计划失败", { error: String(error) });
      toast(
        intl.formatMessage({
          id:
            error instanceof Error && error.message === "file_too_large"
              ? "fileActions.saveAsTooLarge"
              : "fileActions.saveAsFailed",
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled || saving || !markdown}
      data-testid={testId}
      onClick={() => void save()}
    >
      <DownloadIcon className="size-3.5" />
    </Button>
  );
}
