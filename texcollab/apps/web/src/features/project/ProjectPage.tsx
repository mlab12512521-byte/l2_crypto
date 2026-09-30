import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPILERS,
  type CompileDiagnostic,
  type Compiler,
  type ProjectSymbols,
  type TreeEntity,
} from '@texcollab/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../../api/client';
import { projectsApi } from '../../api/projects';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner, Spinner } from '../../components/ui';
import { useUploader } from '../../hooks/useUploader';
import { PresenceBar } from '../collab/PresenceBar';
import { useProjectConnection } from '../collab/useProjectConnection';
import { LogsPanel } from '../compile/LogsPanel';
import { useCompiler } from '../compile/useCompiler';
import type { DocumentSession, SaveStatus } from '../editor/document-session';
import { type EditorDiagnostic, EditorPane } from '../editor/EditorPane';
import { FileTree } from '../files/FileTree';
import { buildTree, pathIndex } from '../files/tree-model';
import { PdfViewer, type PdfViewerHandle } from '../pdf/PdfViewer';
import { membersKey, ShareDialog } from '../sharing/ShareDialog';
import { FilePreview } from './FilePreview';
import { useStoredLayout } from './layout';
import { useTabs } from './useTabs';

const NO_DIAGNOSTICS: EditorDiagnostic[] = [];

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, { s: SaveStatus; m?: string | undefined }>>({});
  const [wrap, setWrap] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  const [sharing, setSharing] = useState(false);
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => projectsApi.get(projectId) });
  const tree = useQuery({ queryKey: ['project', projectId, 'tree'], queryFn: () => projectsApi.tree(projectId) });
  const symbols = useQuery({
    queryKey: ['project', projectId, 'symbols'],
    queryFn: () => api.get<ProjectSymbols>(`/api/projects/${projectId}/symbols`),
    refetchInterval: 30_000,
  });
  const symbolsRef = useRef<ProjectSymbols | null>(null);
  symbolsRef.current = symbols.data ?? null;
  const layout = useStoredLayout('texcollab.layout.project');

  // Live editor sessions and views, by entity id.
  const sessions = useRef(new Map<string, DocumentSession>());
  const views = useRef(new Map<string, EditorView>());
  const pendingJump = useRef<{ id: string; line: number } | null>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);

  const flushAll = useCallback(async () => {
    await Promise.all([...sessions.current.values()].map((s) => s.flush()));
  }, []);
  const compiler = useCompiler(projectId, flushAll);

  const refreshTree = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['project', projectId, 'tree'] });
    void qc.invalidateQueries({ queryKey: ['project', projectId, 'symbols'] });
  }, [qc, projectId]);

  // Real-time connection: presence, notifications and collaborative documents.
  const live = useProjectConnection(projectId, me ? { id: me.id, displayName: me.displayName } : null, (event) => {
    if (event.type === 'tree') refreshTree();
    else if (event.type === 'project') void qc.invalidateQueries({ queryKey: ['project', projectId], exact: true });
    else if (event.type === 'compiled' && event.by !== me?.id) void compiler.refresh();
    else if (event.type === 'members') {
      // My own role may have changed.
      void qc.invalidateQueries({ queryKey: ['project', projectId], exact: true });
      void qc.invalidateQueries({ queryKey: membersKey(projectId) });
    }
  });
  const uploader = useUploader(projectId, refreshTree);
  const tabs = useTabs(projectId, tree.data?.entities, project.data?.mainFileId ?? null);
  useEffect(() => {
    live.connection?.setOpenFile(tabs.active);
  }, [live.connection, tabs.active]);
  const updateProject = useMutation({
    mutationFn: (patch: { mainFileId?: string; compiler?: Compiler }) => projectsApi.update(projectId, patch),
    onSuccess: (p) => qc.setQueryData(['project', projectId], p),
    onError: (e) => setError(e.message),
  });

  const { notifyEdited } = compiler;
  const onStatus = useCallback(
    (id: string, s: SaveStatus, m?: string) => {
      setStatus((x) => (x[id]?.s === s && x[id]?.m === m ? x : { ...x, [id]: { s, m } }));
      if (s === 'saved') {
        void qc.invalidateQueries({ queryKey: ['project', projectId, 'symbols'] });
        notifyEdited();
      }
    },
    [qc, projectId, notifyEdited],
  );

  // Warn before leaving the page while edits are not yet on the server.
  const hasUnsaved = Object.values(status).some(
    (x) => x.s === 'dirty' || x.s === 'saving' || x.s === 'offline' || x.s === 'error',
  );
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  const entities = tree.data?.entities;
  const byId = useMemo(() => new Map((entities ?? []).map((e) => [e.id, e])), [entities]);
  const paths = useMemo(
    () => (tree.data ? pathIndex(buildTree(tree.data.rootId, tree.data.entities)) : new Map<string, string>()),
    [tree.data],
  );

  // Other users' open files, for markers in the file tree.
  const presenceByFile = useMemo(() => {
    const m = new Map<string, Array<{ id: string; name: string; color: string }>>();
    for (const p of live.presence) {
      if (!p.openFile || p.user.id === me?.id) continue;
      const list = m.get(p.openFile) ?? [];
      if (!list.some((u) => u.id === p.user.id)) list.push({ id: p.user.id, name: p.user.name, color: p.user.color });
      m.set(p.openFile, list);
    }
    return m;
  }, [live.presence, me?.id]);

  // Compile diagnostics grouped per document for the editors.
  const diagnosticsByEntity = useMemo(() => {
    const m = new Map<string, EditorDiagnostic[]>();
    for (const d of compiler.result?.diagnostics ?? []) {
      if (!d.entityId || !d.line) continue;
      const list = m.get(d.entityId) ?? [];
      list.push({ line: d.line, severity: d.severity, message: d.message });
      m.set(d.entityId, list);
    }
    return m;
  }, [compiler.result]);

  const jumpTo = useCallback(
    (entityId: string, line: number) => {
      tabs.openTab(entityId);
      const view = views.current.get(entityId);
      if (!view) {
        pendingJump.current = { id: entityId, line };
        return;
      }
      const doc = view.state.doc;
      const pos = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    },
    [tabs.openTab],
  );

  const onView = useCallback((id: string, view: EditorView | null) => {
    if (view) {
      views.current.set(id, view);
      const jump = pendingJump.current;
      if (jump?.id === id) {
        pendingJump.current = null;
        const doc = view.state.doc;
        const pos = doc.line(Math.max(1, Math.min(jump.line, doc.lines))).from;
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
      }
    } else {
      views.current.delete(id);
    }
  }, []);

  const syncToPdf = async () => {
    const id = tabs.active;
    const buildId = compiler.pdfBuildId;
    const view = id ? views.current.get(id) : undefined;
    const path = id ? paths.get(id) : undefined;
    if (!buildId || !view || !path) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    try {
      const r = await projectsApi.syncToPdf(projectId, buildId, path, line);
      if (r.boxes.length) pdfRef.current?.highlight(r.boxes);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const syncToCode = async (page: number, x: number, y: number) => {
    const buildId = compiler.pdfBuildId;
    if (!buildId) return;
    try {
      const r = await projectsApi.syncToCode(projectId, buildId, page, x, y);
      if (r.location?.entityId) jumpTo(r.location.entityId, r.location.line);
    } catch {
      // No SyncTeX data (e.g. build failed early): ignore double-clicks.
    }
  };

  const openDiagnostic = (d: CompileDiagnostic) => {
    if (d.entityId) jumpTo(d.entityId, d.line ?? 1);
  };

  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <div className="page narrow stack">
        <h1>Project not found</h1>
        <p className="muted">It does not exist or has not been shared with you.</p>
        <Link to="/">Back to projects</Link>
      </div>
    );
  }
  if (project.isLoading || tree.isLoading) return <Spinner />;
  if (!project.data || !tree.data) return <ErrorBanner error={project.error ?? tree.error} />;
  const p = project.data;
  const readOnly = p.role === 'viewer';
  const activeStatus = tabs.active ? status[tabs.active] : undefined;
  const result = compiler.result;
  const errors = result?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const warnings = result?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0;

  return (
    <div className="project-page">
      <header className="project-header">
        <Link to="/" className="btn btn-ghost btn-small" title="Back to projects" aria-label="Back to projects">
          ←
        </Link>
        <h1 className="project-title">{p.name}</h1>
        {readOnly && <span className="badge">Read only</span>}
        <div className="compile-controls">
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => void compiler.compile()}
            disabled={compiler.compiling}
            title="Compile (Ctrl+S / Ctrl+Enter)"
          >
            {compiler.compiling ? 'Compiling…' : 'Recompile'}
          </button>
          <label className="checkbox small" title="Compile automatically after edits">
            <input
              type="checkbox"
              checked={compiler.autoCompile}
              onChange={(e) => compiler.setAutoCompile(e.target.checked)}
            />{' '}
            Auto
          </label>
          <select
            aria-label="LaTeX engine"
            value={p.compiler}
            disabled={readOnly}
            onChange={(e) => updateProject.mutate({ compiler: e.target.value as Compiler })}
          >
            {COMPILERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {result && (
            <button
              type="button"
              className={`btn btn-small compile-summary compile-${result.status}`}
              onClick={() => setShowLogs((v) => !v)}
              title="Show compiler messages"
            >
              {errors > 0 && <span className="count count-error">{errors}</span>}
              {warnings > 0 && <span className="count count-warning">{warnings}</span>}
              {errors === 0 && warnings === 0 && (result.status === 'success' ? '✓' : '!')} Logs
            </button>
          )}
        </div>
        <div className="project-header-right">
          {me && <PresenceBar presence={live.presence} meId={me.id} state={live.state} files={byId} />}
          <button type="button" className="btn btn-small" onClick={() => setSharing(true)}>
            Share
          </button>
          <a className="btn btn-small" href={projectsApi.exportUrl(p.id)} download>
            Download ZIP
          </a>
        </div>
      </header>
      {(error || compiler.error) && (
        <div className="banner banner-error project-error" role="alert">
          {error ?? compiler.error}
          <button type="button" className="btn btn-ghost btn-small" aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <Group
        orientation="horizontal"
        className="project-body"
        defaultLayout={layout.initial}
        onLayoutChanged={layout.save}
      >
        <Panel id="files" defaultSize="18%" minSize="160px" collapsible collapsedSize="0px" className="project-sidebar">
          <FileTree
            projectId={p.id}
            tree={tree.data}
            readOnly={readOnly}
            mainFileId={p.mainFileId}
            selectedId={tabs.active}
            onSelect={(e: TreeEntity) => e.kind !== 'folder' && tabs.openTab(e.id)}
            onChanged={refreshTree}
            onSetMain={(e) => updateProject.mutate({ mainFileId: e.id })}
            onError={setError}
            upload={uploader.enqueue}
            uploads={uploader.tasks}
            onClearUploads={uploader.clearFinished}
            presence={presenceByFile}
          />
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="editor" defaultSize="42%" minSize="240px" className="editor-column">
          <div className="tab-bar" role="tablist" aria-label="Open files">
            {tabs.open.map((id) => {
              const e = byId.get(id);
              if (!e) return null;
              const st = status[id]?.s;
              const nErr = diagnosticsByEntity.get(id)?.filter((d) => d.severity === 'error').length ?? 0;
              return (
                <div key={id} className={`tab${id === tabs.active ? ' active' : ''}`} title={paths.get(id) ?? e.name}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={id === tabs.active}
                    className="tab-label"
                    onClick={() => tabs.activate(id)}
                  >
                    {e.name}
                    {nErr > 0 && <span className="count count-error">{nErr}</span>}
                    {(st === 'dirty' || st === 'saving') && <span className="tab-dirty" title="Unsaved changes" />}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`Close ${e.name}`}
                    onClick={() => tabs.closeTab(id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="tab-bar-tools">
              <button
                type="button"
                className="btn btn-ghost btn-small"
                title="Show the cursor position in the PDF"
                onClick={() => void syncToPdf()}
                disabled={!compiler.pdfBuildId || !tabs.active}
              >
                → PDF
              </button>
              <label className="checkbox small" title="Soft-wrap long lines">
                <input type="checkbox" checked={wrap} onChange={(ev) => setWrap(ev.target.checked)} /> Wrap
              </label>
              {activeStatus && <SaveIndicator status={activeStatus.s} />}
            </div>
          </div>
          {activeStatus?.m &&
            (activeStatus.s === 'conflict' || activeStatus.s === 'error' || activeStatus.s === 'offline') && (
              <div className="banner banner-error editor-banner" role="alert">
                {activeStatus.m}
              </div>
            )}
          <div className="editor-stack">
            {tabs.open.length === 0 && <div className="empty-state muted">Open a file from the file tree.</div>}
            {tabs.open.map((id) => {
              const e = byId.get(id);
              if (!e) return null;
              if (e.kind === 'doc' && !live.connection) return null;
              if (e.kind !== 'doc') {
                return (
                  <div key={id} className="editor-pane" hidden={id !== tabs.active}>
                    <FilePreview projectId={p.id} entity={e} />
                  </div>
                );
              }
              return (
                <EditorPane
                  key={id}
                  createSession={() => {
                    const s = live.connection!.openDocument(id);
                    sessions.current.set(id, s);
                    const destroy = s.destroy.bind(s);
                    s.destroy = () => {
                      if (sessions.current.get(id) === s) sessions.current.delete(id);
                      destroy();
                    };
                    return s;
                  }}
                  readOnly={readOnly}
                  wrap={wrap}
                  visible={id === tabs.active}
                  diagnostics={diagnosticsByEntity.get(id) ?? NO_DIAGNOSTICS}
                  callbacks={{ symbols: () => symbolsRef.current, onCompile: () => void compiler.compile() }}
                  onStatus={(s, m) => onStatus(id, s, m)}
                  onView={(v) => onView(id, v)}
                />
              );
            })}
          </div>
          {showLogs && result && (
            <LogsPanel projectId={p.id} result={result} onOpen={openDiagnostic} onClose={() => setShowLogs(false)} />
          )}
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="pdf" defaultSize="40%" minSize="200px" collapsible collapsedSize="0px" className="pdf-column">
          <PdfViewer
            ref={pdfRef}
            url={compiler.pdfUrl}
            downloadUrl={
              compiler.pdfBuildId ? projectsApi.buildFileUrl(p.id, compiler.pdfBuildId, 'output.pdf', true) : null
            }
            onPageDoubleClick={(page, x, y) => void syncToCode(page, x, y)}
            placeholder={
              compiler.compiling ? (
                <Spinner label="Compiling…" />
              ) : result ? (
                <div className="muted">
                  <p>{result.message ?? 'No PDF was produced.'}</p>
                  <button type="button" className="btn btn-small" onClick={() => setShowLogs(true)}>
                    Show messages
                  </button>
                </div>
              ) : (
                <div className="muted">
                  <p>Compile the project to see the PDF here.</p>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => void compiler.compile()}>
                    Compile
                  </button>
                </div>
              )
            }
          />
        </Panel>
      </Group>
      {sharing && me && <ShareDialog project={p} meId={me.id} onClose={() => setSharing(false)} />}
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const text: Record<SaveStatus, string> = {
    loading: 'Loading…',
    saved: 'Saved',
    dirty: 'Unsaved',
    saving: 'Saving…',
    error: 'Save failed',
    conflict: 'Conflict',
    offline: 'Offline',
  };
  return <span className={`save-indicator save-${status}`}>{text[status]}</span>;
}
