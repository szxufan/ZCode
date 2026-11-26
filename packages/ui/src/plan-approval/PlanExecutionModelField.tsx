import { useMemo } from "react";
import { TID_PLAN_APPROVAL_EXECUTION_MODEL_TRIGGER } from "@zcode/shared/test-ids";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PlanExecutionModelFieldProps } from "./contract.js";
import { usePlanExecutionModelChoices } from "./usePlanExecutionModelChoices.js";

const NEVER_LOCKED = () => false;

/**
 * 审批弹窗里的「执行模型」（docs/specs/plan-approval-execution-model.md）：清单与 composer 同源，
 * 「会话模型」排第一。选中值由弹窗宿主持有，不写草稿、不写 workspace default；
 * 只有批准时才经既有会话模型切换路径生效。
 */
export function PlanExecutionModelField({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionModel,
  value,
  onChange,
  disabled = false,
}: PlanExecutionModelFieldProps) {
  const { intl } = useZCodeIntl();
  const choices = usePlanExecutionModelChoices({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionModel,
  });
  const current = choices.describe(value);
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用。
  const leadingItems = useMemo(() => [choices.sessionItem], [choices.sessionItem]);
  if (choices.noCatalog) return null;

  return (
    <div className="flex flex-col gap-1" data-testid="plan-approval-execution-model">
      <div className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "chat.elicitation.planApproval.executionModel" })}
      </div>
      <ModelConfigSelect
        modelGroups={choices.groups}
        normalizedValue={current.value}
        triggerLabel={current.label}
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={NEVER_LOCKED}
        onValueChange={(next) => onChange(choices.pick(next))}
        leadingItems={leadingItems}
        // 弹窗在会话底部停靠：菜单向上展开；关闭后不把焦点还给被隐藏的 composer。
        contentSide="top"
        contentAlign="start"
        focusSelectorOnClose={null}
        labelVisibilityClassName="inline-flex min-w-0"
        triggerClassName="h-7 w-full min-w-0 justify-between rounded-lg border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
        triggerTestId={TID_PLAN_APPROVAL_EXECUTION_MODEL_TRIGGER}
        disabled={disabled || choices.loading}
      />
      {value.kind === "model" ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "chat.elicitation.planApproval.executionModelHint" },
            { model: current.label },
          )}
        </p>
      ) : null}
    </div>
  );
}
