export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

// keyring 需要按目标平台加载原生模块，不能被 esbuild 展开成所有平台的 .node 文件。
export const REMOTE_SERVER_NATIVE_EXTERNALS = ["@napi-rs/keyring"];

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;
// prettier 及其语言插件由 @zcode/services 的精确版本依赖随 Host 发放；
// 远端只上传单个 zcode-server.cjs，残留裸 prettier 运行时导入说明打包时被外部化。
const unresolvedPrettierRuntimeImportPattern =
  /\b(?:require|import)\d*\(["']prettier(?:\/[^"']*)?["']\)/;

export function validateRemoteServerBundle({ source }: RemoteServerBundleValidationInput): void {
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // remote deploy 只会上传单个 zcode-server.cjs 到 ~/.zcode/server/。
    // 只有 bundle 里残留裸 undici 运行时导入才说明远端还依赖 node_modules；
    // 若当前代码已经不使用 undici，则不应把“无依赖”误判成“未内联”。
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }

  if (unresolvedPrettierRuntimeImportPattern.test(source)) {
    // 远端没有 node_modules，动态解析 prettier 插件会在格式化时直接抛错；
    // 这里在构建期拦截，避免把"能启动但保存即失败"的远端产物发出去。
    throw new Error(
      'Remote server bundle must inline prettier. Found unresolved runtime dependency "prettier".',
    );
  }
}
