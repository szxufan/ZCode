import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PlanCopyButtonProps } from "./contract.js";

/**
 * 「复制计划」：只复制这一份计划原文。计划卡片与详情侧栏共用；
 * 成功只改变按钮的可访问名称与图标，不出 toast（docs/ui/plan-detail-side-pane.md）。
 */
export function PlanCopyButton({ markdown, testId }: PlanCopyButtonProps) {
  const { intl } = useZCodeIntl();
  const [copiedMarkdown, setCopiedMarkdown] = useState<string | null>(null);
  const copied = copiedMarkdown === markdown;

  const label = intl.formatMessage({
    id: copied ? "planTool.panel.copied" : "planTool.panel.copy",
  });

  const handleCopy = () => {
    if (!markdown || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(markdown).then(
      () => setCopiedMarkdown(markdown),
      () => setCopiedMarkdown(null),
    );
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        handleCopy();
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}
