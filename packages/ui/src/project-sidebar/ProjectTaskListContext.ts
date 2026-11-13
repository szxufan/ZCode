import { createContext } from "react";
import type { ProjectTask } from "@/project-sidebar/contract.js";

/** 列表展示配置只来自侧栏 owner；不承载 Host 行集合或会话运行态。 */
export const ProjectTaskListContext = createContext<{
  activeWorkspaceKey?: string;
  mobileActiveTaskKey?: string | null;
  /** 手机远控模式下禁用行悬浮卡（上游字段；当前 fork 不写入，保持桌面行为）。 */
  isWebRemoteControl?: boolean;
  onOpenTaskFiles?: (task: ProjectTask, remoteSessionId?: string) => Promise<void>;
  onPin?: (task: ProjectTask, pinned: boolean, commit: () => Promise<unknown>) => Promise<void>;
}>({});
