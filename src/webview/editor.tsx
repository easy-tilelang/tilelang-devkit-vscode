import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import type { Language } from '../shared/model';

interface Props {
  text: string;
  language: Language;
  before?: string;
  beforeLanguage?: Language;
  diff: boolean;
  wrap: boolean;
  narrow: boolean;
  label: string;
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--code-bg)', fontSize: 'var(--vscode-editor-font-size, 12px)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vscode-editor-font-family, "SFMono-Regular", Consolas, "Liberation Mono", monospace)', lineHeight: '1.8' },
  '.cm-content': { padding: '16px 0' },
  '.cm-line': { padding: '0 20px' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--muted)', border: 'none', padding: '0 4px 0 10px' },
  '.cm-gutterElement': { padding: '0 8px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '&.cm-focused': { outline: 'none' },
});

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.meta], color: 'var(--syntax-comment)' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: 'var(--syntax-function)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--text)' },
]);

function extensions(language: Language, wrap: boolean): Extension[] {
  const nonce = document.body.dataset.nonce ?? document.querySelector<HTMLMetaElement>('meta[name="nonce"]')?.content ?? '';
  return [
    EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': '只读代码' }),
    EditorView.cspNonce.of(nonce), lineNumbers(), highlightSpecialChars(), drawSelection(), bracketMatching(),
    syntaxHighlighting(codeHighlight), editorTheme,
    language === 'python' ? python() : language === 'cpp' ? cpp() : [],
    wrap ? EditorView.lineWrapping : [],
  ];
}

export function CodeEditor(props: Props) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!parent.current) return;
    let view: EditorView | MergeView;
    if (props.diff && props.before !== undefined && !props.narrow) {
      view = new MergeView({
        parent: parent.current,
        a: { doc: props.before, extensions: extensions(props.beforeLanguage ?? props.language, props.wrap) },
        b: { doc: props.text, extensions: extensions(props.language, props.wrap) },
        highlightChanges: true, gutter: true,
        diffConfig: { scanLimit: 1000, timeout: 150 },
      });
    } else {
      view = new EditorView({
        parent: parent.current,
        doc: props.text,
        extensions: [
          ...extensions(props.language, props.wrap),
          props.diff && props.before !== undefined ? unifiedMergeView({ original: props.before, highlightChanges: true, gutter: true, mergeControls: false, diffConfig: { scanLimit: 1000, timeout: 150 } }) : [],
        ],
      });
    }
    return () => view.destroy();
  }, [props.text, props.before, props.language, props.beforeLanguage, props.wrap, props.diff, props.narrow]);
  return <div className="editor-mount" ref={parent} aria-label={props.label} data-testid="code-editor" />;
}
