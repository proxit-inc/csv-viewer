import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  onClose: () => void;
  schema: SQLNamespace;
}

// Loaded via dynamic import only once the user opens sql mode (see
// SearchBar.tsx) so the ~60-80KB gz CodeMirror cost is never paid by users
// who never touch it (docs/SEARCH_ARCHITECTURE.md §3-1).
export function SqlEditor({ value, onChange, onApply, onClose, schema }: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schemaCompartment = useRef(new Compartment());

  // Always-fresh refs so the keymap/change listener (captured once at mount)
  // never calls a stale closure from an earlier render.
  const onChangeRef = useRef(onChange);
  const onApplyRef = useRef(onApply);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onChangeRef.current = onChange;
    onApplyRef.current = onApply;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        closeBrackets(),
        autocompletion(),
        placeholder("SELECT * FROM csv_data WHERE ..."),
        // Default tooltip parenting is the editor's own DOM (`view.dom`), so
        // the completion popup inherits any clipped/constrained-height
        // ancestor — exactly the small fixed-height box this editor lives
        // in. Porting to document.body avoids that regardless of the
        // wrapper's own overflow/height.
        tooltips({ parent: document.body }),
        syntaxHighlighting(defaultHighlightStyle),
        schemaCompartment.current.of(sql({ schema })),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onApplyRef.current();
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              onCloseRef.current();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { fontSize: "12px", height: "100%" },
          "&.cm-focused": { outline: "none" },
          ".cm-content": {
            fontFamily: "var(--font-mono)",
            padding: "6px 8px",
            color: "var(--col-text)",
          },
          ".cm-gutters": { display: "none" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally mount-once: `value` changes from outside are pushed into
    // the live instance below instead of recreating it (which would reset
    // cursor position and undo history on every keystroke echoed back from
    // the parent's controlled-input-style state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes (e.g. switching tabs, or Reset clearing the
  // draft) into the existing editor without recreating it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Reconfigure completion when the available columns change (e.g. after
  // applying a filter narrows csv_result) without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: schemaCompartment.current.reconfigure(sql({ schema })) });
  }, [schema]);

  useEffect(() => {
    viewRef.current?.focus();
  }, []);

  return <div ref={containerRef} className="flex-1 overflow-auto" style={{ minHeight: 0 }} />;
}
