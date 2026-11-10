/**
 * ui-preview-edit 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { PreviewPaneEditContract } from "./contract.js";

export async function exampleUiPreviewEdit(contract: PreviewPaneEditContract): Promise<boolean> {
  return contract.confirmAllUnsavedSessions();
}
