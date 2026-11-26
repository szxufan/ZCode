import { useCallback, useMemo } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import type { PlanExecutionModelChoice } from "./contract.js";

/** 清单里「会话模型」那一项的值：落在 encodeCustomModelValue 的值域之外，不会与真实模型相撞。 */
export const PLAN_SESSION_MODEL_VALUE = "plan-approval:session-model";

export interface PlanExecutionModelChoicesInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 会话当前模型：首项与默认值。 */
  sessionModel: { providerId: string; modelId: string };
}

/** 一个选择在屏幕上的样子。 */
export interface PlanExecutionModelFace {
  /** 菜单值（会话模型是占位值）。 */
  value: string;
  /** 触发器与提示里显示的名字。 */
  label: string;
}

/**
 * 审批弹窗「执行模型」的清单：与 composer 模型菜单同一份构建块，目标工作区 Host 提供候选，
 * 「会话模型」排第一。清单逻辑对齐工作流「配置」弹层的 useWorkflowSettingsModelChoices，
 * 但不跨模块引用，避免两处互相牵制。
 */
export function usePlanExecutionModelChoices(input: PlanExecutionModelChoicesInput) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useModelSelectionView(
    input.workspacePath,
    input.remoteSessionId,
    input.workspaceIdentity,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups: ModelSelectGroup[] = useMemo(
    () =>
      view === null
        ? []
        : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: format("settings.modelProvider.apiKey"),
            apiKeyBadgeLabel: format("settings.modelProvider.connectionMode.apiKeyBadge"),
            codingPlanLabel: format("settings.modelProvider.connectionMode.codingPlan"),
            codingPlanBadgeLabel: format("settings.modelProvider.connectionMode.codingPlanBadge"),
            startPlanLabel: format("settings.modelProvider.connectionMode.startPlan"),
            startPlanBadgeLabel: format("settings.modelProvider.connectionMode.startPlanBadge"),
            teamPlanBadgeLabel: format("settings.modelProvider.connectionMode.teamPlanBadge"),
            teamPlanFallbackLabel: format("settings.modelProvider.connectionMode.teamPlan"),
          }),
    [format, view],
  );
  const providerName = useCallback(
    (providerId: string) =>
      view?.providers.find((provider) => provider.providerId === providerId)?.providerName ??
      undefined,
    [view],
  );
  const sessionLabel = formatProviderModelLabel(
    input.sessionModel.providerId,
    providerName(input.sessionModel.providerId),
    input.sessionModel.modelId,
  );
  const sessionBadge = format("chat.elicitation.planApproval.executionModel.session");
  // ModelConfigSelect 是 memo 组件：这一项只在文案真变了时换引用。
  const sessionItem: ModelSelectGroupItem = useMemo(
    () => ({
      key: "plan-approval:session-model",
      value: PLAN_SESSION_MODEL_VALUE,
      name: sessionLabel,
      badgeLabel: sessionBadge,
    }),
    [sessionBadge, sessionLabel],
  );

  const describe = useCallback(
    (choice: PlanExecutionModelChoice): PlanExecutionModelFace =>
      choice.kind === "session"
        ? { value: PLAN_SESSION_MODEL_VALUE, label: sessionLabel }
        : {
            value: encodeCustomModelValue(choice.providerId, choice.modelId),
            label: formatProviderModelLabel(
              choice.providerId,
              providerName(choice.providerId),
              choice.modelId,
            ),
          },
    [providerName, sessionLabel],
  );

  /** 菜单选中一项 → 新的执行模型选择。换模型即取它在注册表里的默认思考档，与 composer 一致。 */
  const pick = useCallback(
    (value: string): PlanExecutionModelChoice => {
      if (value === PLAN_SESSION_MODEL_VALUE) return { kind: "session" };
      const picked = parseModelPickerValue(value);
      // 完整的执行选择必须带思考档；清单还没读好时无法补齐，按保持会话模型处理。
      const reasoningLevel =
        view === null
          ? undefined
          : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
      return reasoningLevel === undefined
        ? { kind: "session" }
        : {
            kind: "model",
            providerId: picked.providerId,
            modelId: picked.modelId,
            reasoningLevel,
          };
    },
    [view],
  );

  return {
    /** 清单还没读好（读好之前触发器禁用）。 */
    loading: view === null,
    /** 清单读好了却一个模型都没有：没有可换的，整个字段不渲染。 */
    noCatalog: view !== null && groups.length === 0,
    groups,
    sessionItem,
    describe,
    pick,
  };
}
