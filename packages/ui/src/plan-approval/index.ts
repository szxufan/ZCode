// plan-approval 模块公开入口（spec：docs/specs/plan-approval-execution-model.md、
// docs/ui/plan-detail-side-pane.md）。调用方与单测只从这里拿组件、类型与纯函数，
// 避免测试和宿主深导入模块内部文件。
export type * from "@/plan-approval/contract.js";
export { PlanCopyButton } from "@/plan-approval/PlanCopyButton.js";
export { PlanExecutionModelField } from "@/plan-approval/PlanExecutionModelField.js";
export { PlanSaveButton } from "@/plan-approval/PlanSaveButton.js";
export {
  buildPlanSaveDirectoryCandidates,
  buildPlanSaveSuggestedName,
  extractPlanTitle,
  PLAN_SAVE_PLANS_DIRECTORY,
} from "@/plan-approval/planSave.js";
export {
  PLAN_SESSION_MODEL_VALUE,
  usePlanExecutionModelChoices,
} from "@/plan-approval/usePlanExecutionModelChoices.js";
export type {
  PlanExecutionModelChoicesInput,
  PlanExecutionModelFace,
} from "@/plan-approval/usePlanExecutionModelChoices.js";
