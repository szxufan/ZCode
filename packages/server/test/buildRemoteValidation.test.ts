import { describe, expect, it } from "vitest";

import { validateRemoteServerBundle } from "../buildRemoteValidation.js";

function validate(source: string): void {
  validateRemoteServerBundle({ bundledInputs: [], source });
}

describe("validateRemoteServerBundle", () => {
  it("允许没有运行时依赖的产物", () => {
    expect(() => validate('const bundled = require("./prettier-inlined.cjs");')).not.toThrow();
    expect(() => validate('const name = "prettier/plugins/babel";')).not.toThrow();
  });

  it("拦截未内联的 undici", () => {
    expect(() => validate('require("undici")')).toThrow(/inline undici/);
  });

  it("拦截未内联的 prettier 及其语言插件", () => {
    expect(() => validate('require("prettier")')).toThrow(/inline prettier/);
    expect(() => validate('import("prettier/plugins/babel")')).toThrow(/inline prettier/);
  });
});
