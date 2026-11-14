/**
 * Monaco 编辑态运行时：只在进入编辑态时被动态 import。
 * 只引入 editor.api 与少量 basic language，不引入 index.js（其内置 LSP client）。
 */
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { toMonacoHexColor } from "./monacoThemeColors.js";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/lua/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/php/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/ruby/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";

interface MonacoEnvironment {
  getWorker: () => Worker;
}

(globalThis as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const THEME_NAME = "zcode-editor";

function readCssValue(property: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  return value || fallback;
}

function applyTheme(dark: boolean): void {
  const bodyStyle = typeof document === "undefined" ? null : getComputedStyle(document.body);
  // body 背景透明（rgba(0, 0, 0, 0)）时没有可继承的底色，沿用与 base 主题一致的默认值。
  const fallbackBackground = dark ? "#1e1e1e" : "#ffffff";
  const backgroundFromStyle =
    bodyStyle?.backgroundColor && bodyStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? toMonacoHexColor(bodyStyle.backgroundColor, fallbackBackground)
      : fallbackBackground;
  monaco.editor.defineTheme(THEME_NAME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": backgroundFromStyle,
      "editor.foreground": toMonacoHexColor(bodyStyle?.color, dark ? "#e5e5e5" : "#1a1a1a"),
      "editorLineNumber.foreground": dark ? "#6b7280" : "#9ca3af",
      "editorLineNumber.activeForeground": dark ? "#d1d5db" : "#374151",
      "editor.selectionBackground": dark ? "#264f78" : "#add6ff",
      "editorWidget.border": dark ? "#333333" : "#e5e7eb",
      "editorCursor.foreground": dark ? "#e5e5e5" : "#1a1a1a",
    },
  });
}

export function resolveMonacoLanguage(path: string | undefined): string {
  if (!path) return "plaintext";
  const normalized = path.toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((extension) => normalized.endsWith(extension.toLowerCase()))) {
      return language.id;
    }
  }
  return "plaintext";
}

export interface TextEditorHandle {
  setValue(value: string): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  dispose(): void;
}

/**
 * 用整段替换的 edit operation 写回文本，而不是 `editor.setValue()`：
 * 后者会重建 model 内容，清空撤销栈并把光标弹到文件开头，
 * 保存/格式化后用户就无法撤销，也丢失当前阅读位置。
 */
function replaceFullValue(editor: monaco.editor.IStandaloneCodeEditor, value: string): void {
  const model = editor.getModel();
  if (!model || model.getValue() === value) {
    return;
  }
  // pushEditOperations 在 readOnly 下会被 Monaco 忽略，而保存中/冲突待决策期间编辑器正是 readOnly，
  // 且写回恰好发生在这两个状态里；临时解锁写完再恢复，避免保存后编辑器内容与磁盘不一致。
  const wasReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
  if (wasReadOnly) {
    editor.updateOptions({ readOnly: false });
  }
  // executeEdits 保留 undo 栈；source 传 null 表示这次编辑不来自某个具名扩展，
  // endCursorState 省略表示交给 Monaco 依编辑范围收敛光标。
  editor.executeEdits(null, [{ range: model.getFullModelRange(), text: value }]);
  if (wasReadOnly) {
    editor.updateOptions({ readOnly: true });
  }
}

export function createTextEditor(options: {
  container: HTMLElement;
  value: string;
  language: string;
  dark: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}): TextEditorHandle {
  applyTheme(options.dark);
  const editor = monaco.editor.create(options.container, {
    value: options.value,
    language: options.language,
    theme: THEME_NAME,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineHeight: 20,
    tabSize: 2,
    insertSpaces: true,
    renderWhitespace: "selection",
    wordWrap: "off",
    contextmenu: false,
    fontFamily: readCssValue("--font-mono", "Menlo, Consolas, monospace"),
    // 无语言服务：只保留本地词法建议，不注册 LSP/diagnostics。
    suggest: { showWords: true, showSnippets: false },
  });

  const changeSubscription = editor.onDidChangeModelContent(() => {
    options.onChange(editor.getValue());
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    options.onSave();
  });

  return {
    setValue(value: string) {
      replaceFullValue(editor, value);
    },
    setReadOnly(readOnly: boolean) {
      editor.updateOptions({ readOnly });
    },
    focus() {
      editor.focus();
    },
    dispose() {
      changeSubscription.dispose();
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
    },
  };
}

export function setEditorTheme(dark: boolean): void {
  applyTheme(dark);
  monaco.editor.setTheme(THEME_NAME);
}
