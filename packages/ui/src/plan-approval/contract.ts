// plan-approval 模块契约：只放类型；运行时实现经 index.ts 暴露。
//
// 两件事都挂在 ExitPlanMode 的审批与展示链路上（docs/specs/plan-approval-execution-model.md、
// docs/ui/plan-detail-side-pane.md）：把计划原文另存为文件，以及在审批弹窗里选择执行模型。

/** 执行模型的选择：「session」表示保持会话当前模型，不换模。 */
export type PlanExecutionModelChoice =
  | { kind: "session" }
  | {
      kind: "model";
      providerId: string;
      modelId: string;
      /** 完整的执行选择必须带思考档；换模型即取新模型在注册表里的默认档。 */
      reasoningLevel: string;
    };

export interface PlanExecutionModelFieldProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 会话当前模型：清单首项与默认值。 */
  sessionModel: { providerId: string; modelId: string };
  value: PlanExecutionModelChoice;
  onChange: (choice: PlanExecutionModelChoice) => void;
  disabled?: boolean;
}

export interface PlanSaveScope {
  /** 本机工作区根目录；远程工作区不给。 */
  workspacePath?: string;
  remote: boolean;
}

export interface PlanSaveButtonProps {
  /** 计划原文（Markdown），原样写入文件。 */
  markdown: string;
  scope: PlanSaveScope;
  /** 外部禁用（如计划仍在流式增长）。 */
  disabled?: boolean;
  /** 缺省用共享 test-id（卡片与详情侧栏各自一个）。 */
  testId?: string;
}

export interface PlanCopyButtonProps {
  /** 计划原文（Markdown）；为空时点击不做事。 */
  markdown: string;
  /** 缺省不带 test-id；详情侧栏传共享的 test-id。 */
  testId?: string;
}
