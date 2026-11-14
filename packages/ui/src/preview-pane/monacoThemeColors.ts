/**
 * Monaco 主题色值转换：纯函数，不依赖 monaco 运行时。
 * 独立成文件的目的是让单测可以直接导入，而不必静态加载 monacoEditorRuntime
 * （它静态 import monaco 与 ?worker，只能留在编辑态动态加载路径上）。
 */

const RGB_COLOR_PATTERN =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Monaco defineTheme 只接受 hex 色值（3/4/6/8 位），而 getComputedStyle 永远返回
 * rgb()/rgba() 格式；直接传入会在编辑器应用主题时抛
 * "Illegal value for token color: rgb(...)"，编辑区因此静默空白
 * （bugfix 依据：file:// 探针用 0.57.0 构建产物复现，见 docs/file-preview-inline-editing.md）。
 * 全透明（alpha 0）与解析失败都退回 fallback——透明没有可继承的色值，
 * 转成不透明黑会把编辑器底色错误地染黑。保证主题注册永不携带非法色值。
 */
export function toMonacoHexColor(cssColor: string | undefined, fallback: string): string {
  if (!cssColor) return fallback;
  const value = cssColor.trim();
  const rgbMatch = value.match(RGB_COLOR_PATTERN);
  if (rgbMatch) {
    if (rgbMatch[4] === "0") return fallback;
    const [red, green, blue] = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((component) =>
      Math.min(Number(component), 255).toString(16).padStart(2, "0"),
    );
    return `#${red}${green}${blue}`;
  }
  if (HEX_COLOR_PATTERN.test(value)) return value.toLowerCase();
  return fallback;
}
