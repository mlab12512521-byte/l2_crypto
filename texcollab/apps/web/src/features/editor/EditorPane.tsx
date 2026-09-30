import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../../components/ui';
import type { DocumentSession, SaveStatus } from './document-session';
import { baseExtensions, type EditorCallbacks, readOnlyCompartment, showDiagnostics, wrapCompartment } from './setup';

export interface EditorDiagnostic {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface EditorPaneProps {
  /** Creates the session for this pane; called once per mount. */
  createSession: () => DocumentSession;
  readOnly: boolean;
  wrap: boolean;
  visible: boolean;
  callbacks: EditorCallbacks;
  diagnostics: EditorDiagnostic[];
  onStatus: (s: SaveStatus, message?: string) => void;
  /** Receives the view once created (for commands such as "go to line"). */
  onView?: (view: EditorView | null) => void;
}

/** One CodeMirror instance bound to one document session. Kept mounted while its tab is open. */
export function EditorPane({
  createSession,
  readOnly,
  wrap,
  visible,
  callbacks,
  diagnostics,
  onStatus,
  onView,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Callbacks change identity on every render; read them through a ref inside the editor.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per mount; readOnly/wrap are applied via compartments below
  useEffect(() => {
    let cancelled = false;
    const session = createSession();
    const off = session.onStatus((s, m) => statusRef.current(s, m));
    session
      .open()
      .then(({ text, extensions }) => {
        if (cancelled || !host.current) return;
        const stable: EditorCallbacks = {
          onCompile: () => cbRef.current.onCompile?.(),
          symbols: () => cbRef.current.symbols(),
        };
        const view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [baseExtensions(stable, { readOnly, wrap, collaborative: session.collaborative }), extensions],
          }),
        });
        viewRef.current = view;
        onView?.(view);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      off();
      onView?.(null);
      viewRef.current?.destroy();
      viewRef.current = null;
      session.destroy();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        readOnlyCompartment.reconfigure([
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
        ]),
        wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []),
      ],
    });
  }, [readOnly, wrap]);

  useEffect(() => {
    // Re-applied once the editor has finished loading (`loading` flips to false).
    if (viewRef.current && !loading) showDiagnostics(viewRef.current, diagnostics);
  }, [diagnostics, loading]);

  useEffect(() => {
    if (visible) viewRef.current?.requestMeasure();
  }, [visible]);

  return (
    <div className="editor-pane" hidden={!visible}>
      {loading && <Spinner label="Opening file…" />}
      {error && <div className="banner banner-error">{error}</div>}
      <div ref={host} className="editor-host" />
    </div>
  );
}
