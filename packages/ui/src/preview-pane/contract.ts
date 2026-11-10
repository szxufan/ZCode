import type {
  FileStat,
  FileTextEditSnapshot,
  FileWatchEvent,
  TextFormatCapability,
  TextFormatResult,
  WriteTextFileParams,
  WriteTextFileResult,
} from "@zcode/shared";

/** UI 层只依赖本模块声明的端口，不直接依赖 services 实现。 */
export interface PreviewPaneFilePort {
  readTextEditSnapshot(params: { path: string }): Promise<FileTextEditSnapshot>;
  writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResult>;
  /** workspacePath 是配置发现上界，避免读到 workspace 之外的全局 Prettier 配置。 */
  getTextFormatCapability(params: {
    path: string;
    workspacePath?: string;
  }): Promise<TextFormatCapability>;
  formatTextContent(params: {
    path: string;
    content: string;
    workspacePath?: string;
  }): Promise<TextFormatResult>;
  stat(params: { path: string }): Promise<FileStat>;
}

export interface PreviewPaneDisposable {
  dispose(): void;
}

export interface PreviewPaneFileWatcherPort {
  watch(params: { path: string }): Promise<{ id: string }>;
  unwatch(params: { id: string }): Promise<void>;
  onDynamicChange(id: string): (handler: (event: FileWatchEvent) => void) => PreviewPaneDisposable;
}

/** 编辑会话对 PreviewPane 暴露的最小契约。 */
export interface PreviewPaneTextEditorProps {
  path: string;
  /** 会话唯一 id；同一文件在多个 tab 并存时用于区分各自的脏状态。 */
  sessionId: string;
  /** 编辑目标所属 workspace，作为 Prettier 配置发现的上界。 */
  workspacePath?: string;
  fileService: PreviewPaneFilePort;
  fileWatcherService: PreviewPaneFileWatcherPort;
  dark: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit: () => void;
}

export interface PreviewPaneEditContract {
  /** 依次确认所有脏会话；返回 false 表示用户取消，调用方不得销毁会话。 */
  confirmAllUnsavedSessions(): Promise<boolean>;
  /** 同步脏检查，供无法 await 确认的调用点（如工作区切换 effect）判断是否需要确认。 */
  hasUnsavedEdits(): boolean;
}
