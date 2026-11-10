/**
 * file-text-edit 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { FileTextEditContract } from "./contract.js";

export async function exampleFileTextEdit(
  contract: FileTextEditContract,
  path: string,
  workspacePath: string,
): Promise<void> {
  const snapshot = await contract.readTextEditSnapshot({ path });
  // workspacePath 必传：它是 Prettier 配置发现的上界，缺省会读到 workspace 之外的全局配置。
  const capability = await contract.getTextFormatCapability({ path, workspacePath });
  const formatted = capability.formatter
    ? await contract.formatTextContent({ path, content: snapshot.content, workspacePath })
    : null;
  const result = await contract.writeTextFile({
    path,
    content: formatted?.content ?? snapshot.content,
    encoding: snapshot.encoding,
    lineEndings: snapshot.lineEndings,
    baseRevision: snapshot.revision,
  });
  if (!result.ok) {
    throw new Error(`write failed: ${result.code}`);
  }
}
