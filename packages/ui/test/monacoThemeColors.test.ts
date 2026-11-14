import { describe, expect, it } from "vitest";

import { toMonacoHexColor } from "@/preview-pane/monacoThemeColors.js";

// 回归背景：Monaco defineTheme 只接受 hex；getComputedStyle 返回 rgb()/rgba()
// 曾被直接传入，编辑器应用主题时抛 "Illegal value for token color"，
// 编辑区静默空白（docs/file-preview-inline-editing.md 的就地编辑功能）。
describe("toMonacoHexColor", () => {
  it("把 rgb() 计算值转换为 6 位 hex", () => {
    expect(toMonacoHexColor("rgb(0, 0, 0)", "#1a1a1a")).toBe("#000000");
    expect(toMonacoHexColor("rgb(26, 26, 26)", "#1a1a1a")).toBe("#1a1a1a");
    expect(toMonacoHexColor("rgb(255, 255, 255)", "#ffffff")).toBe("#ffffff");
  });

  it("把 rgba() 计算值的不透明分量转换为 hex（丢弃 alpha）", () => {
    expect(toMonacoHexColor("rgba(16, 185, 129, 1)", "#ffffff")).toBe("#10b981");
    expect(toMonacoHexColor("rgba(16, 185, 129, 0.5)", "#ffffff")).toBe("#10b981");
  });

  it("已经是 Monaco 可接受的 hex 时原样返回并归一为小写", () => {
    expect(toMonacoHexColor("#1A1A1A", "#000000")).toBe("#1a1a1a");
    expect(toMonacoHexColor("#add6ff", "#000000")).toBe("#add6ff");
    expect(toMonacoHexColor("#fff", "#000000")).toBe("#fff");
  });

  it("透明背景等无法解析的输入退回 fallback，不产生非法色值", () => {
    expect(toMonacoHexColor("rgba(0, 0, 0, 0)", "#1e1e1e")).toBe("#1e1e1e");
    expect(toMonacoHexColor(undefined, "#1a1a1a")).toBe("#1a1a1a");
    expect(toMonacoHexColor("", "#e5e5e5")).toBe("#e5e5e5");
    expect(toMonacoHexColor("light-dark(black, white)", "#1a1a1a")).toBe("#1a1a1a");
  });

  it("越界分量按 255 钳制（getComputedStyle 实际不会产出越界值，钳制兜底）", () => {
    expect(toMonacoHexColor("rgb(300, 0, 0)", "#1a1a1a")).toBe("#ff0000");
  });
});
