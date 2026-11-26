/**
 * plan-approval 标准调用示例：计划卡片与详情侧栏挂保存按钮；审批弹窗挂执行模型字段。
 * 执行模型的选中值由弹窗宿主持有，批准时才交给既有的会话模型切换路径。
 */
import { createElement } from "react";
import { PlanExecutionModelField } from "@/plan-approval/PlanExecutionModelField.js";
import { PlanSaveButton } from "@/plan-approval/PlanSaveButton.js";
import type {
  PlanExecutionModelChoice,
  PlanSaveButtonProps,
  PlanSaveScope,
} from "@/plan-approval/contract.js";

export function examplePlanSaveButton(scope: PlanSaveScope) {
  const props: PlanSaveButtonProps = {
    markdown: "# 登录超时修复计划\n\n## Context",
    scope,
  };
  return createElement(PlanSaveButton, props);
}

export function examplePlanExecutionModelField(
  onChange: (choice: PlanExecutionModelChoice) => void,
) {
  return createElement(PlanExecutionModelField, {
    workspacePath: "/workspace/app",
    sessionModel: { providerId: "zai", modelId: "glm-5.4" },
    value: { kind: "session" },
    onChange,
  });
}
