# file-text-edit

文件预览就地编辑的 Host 侧能力，覆盖完整读取快照、无损写回与项目配置格式化。

- 层：adapters。允许依赖 `services` 基础能力与 `shared` 协议类型，不依赖 UI。
- 对外入口：`index.ts`（工厂与类型）、`contract.ts`（调用语义）。
- 不变量：
  - 编码以"解码后再编码等于原始字节"为可编辑门槛，混合换行拒绝编辑；
  - 文本读取上限单一来源为 `@zcode/shared` 的 `FILE_TEXT_MAX_BYTES`，与 renderer 的可编辑判定同源；
  - 写回复用 `fs/atomicFileUtils.ts` 的 `atomicWriteText`（不另起原子写路径），保留原文件权限位，拒绝写软链接，并继承其 Windows rename 重试与残留临时文件清理；
  - 版本校验在文件锁内完成，rename 前再按内容哈希复查一次，冲突以结构化结果返回；
  - 格式化只读静态配置白名单，不执行 `prettier.config.js` 等可运行配置；配置发现以 `workspacePath` 为上界，不读 workspace 之外的全局配置。
