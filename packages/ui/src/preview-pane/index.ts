export { PreviewPaneTextEditor } from "./PreviewPaneTextEditor.js";
export {
  confirmAllUnsavedSessions,
  hasUnsavedEdits,
  registerUnsavedEditSession,
  resetUnsavedEditGuardForTests,
} from "./unsavedEditGuard.js";
export type { UnsavedEditDecision, UnsavedEditSession } from "./unsavedEditGuard.js";
export type { PreviewPaneEditContract, PreviewPaneTextEditorProps } from "./contract.js";
