import { EditorView } from "@codemirror/view";

/** 行首的 `[]`，前面可以有缩进，也可以已经有列表符号（`-`、`*`、`+`、`1.`）。 */
const LEADING_BRACKET = /^(\s*)(?:([-*+]|\d+[.)])\s+)?\[\]$/;

/**
 * 输入 `[]` 后接空格时，把行首替换成 Markdown 复选框 `- [ ] `。
 * 已有列表符号时保留符号，保留缩进；行中间的 `[]` 不处理。
 * enabled 用函数传入，这样设置里切换后不用重启插件。
 */
export function bracketToCheckbox(enabled: () => boolean) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " " || from !== to || !enabled()) return false;
    const line = view.state.doc.lineAt(from);
    const match = LEADING_BRACKET.exec(line.text.slice(0, from - line.from));
    if (!match) return false;
    const indent = match[1] ?? "";
    const marker = match[2] ? `${match[2]} ` : "- ";
    const head = `${indent}${marker}[ ] `;
    view.dispatch({
      changes: { from: line.from, to: from, insert: head },
      selection: { anchor: line.from + head.length },
      userEvent: "input.type",
    });
    return true;
  });
}
