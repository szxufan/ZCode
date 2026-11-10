/**
 * file-text-edit 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const fileTextEditModule = {
  id: "file-text-edit",
  requires: ["services", "shared"],
  provides: ["file-text-edit"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
