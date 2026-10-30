/**
 * scheduled-send 标准调用示例：composer 在发送键右侧只挂载一次，
 * 成功后通过 onScheduled 清空草稿；是否可定时由 enabled/hasNonTextContext 决定。
 */
import { createElement } from "react";
import { ComposerScheduledSend } from "@/v4/scheduled-send/ComposerScheduledSend.js";
import type { ComposerScheduledSendProps } from "@/v4/scheduled-send/contract.js";

export function exampleComposerScheduledSend(
  agentService: ComposerScheduledSendProps["agentService"],
) {
  const props: ComposerScheduledSendProps = {
    draftText: "整理今天的待办",
    hasNonTextContext: false,
    enabled: true,
    agentService,
    workspacePath: "/workspace/app",
    sessionId: "session-1",
    onScheduled: () => {},
  };
  return createElement(ComposerScheduledSend, props);
}
