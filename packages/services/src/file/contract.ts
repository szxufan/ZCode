import type {
  FileTextEditSnapshot,
  TextFormatCapability,
  TextFormatResult,
  WriteTextFileParams,
  WriteTextFileResult,
} from "@zcode/shared";

/**
 * file-text-edit 对外契约。
 * 所有方法以绝对路径为输入；目标必须是普通文件，软链接拒绝写入。
 */
export interface FileTextEditContract {
  /** 读取完整文本快照；内容统一为 LF。不可无损编辑时抛错，不返回部分结果。 */
  readTextEditSnapshot(params: { path: string }): Promise<FileTextEditSnapshot>;
  /** 锁内校验 baseRevision（内容哈希）后原子写回；冲突等失败以结果返回，不抛异常。 */
  writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResult>;
  /**
   * 只读项目静态 Prettier 配置；无配置时 formatter 为 null。
   * `workspacePath` 是配置发现上界，缺省时可能读到 workspace 之外的全局配置。
   */
  getTextFormatCapability(params: {
    path: string;
    workspacePath?: string;
  }): Promise<TextFormatCapability>;
  /** 格式化失败返回 error；调用方继续用原文保存，不阻塞写入。 */
  formatTextContent(params: {
    path: string;
    content: string;
    workspacePath?: string;
  }): Promise<TextFormatResult>;
}
