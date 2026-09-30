import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectSymbols, TreeEntity } from '@texcollab/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../../api/client';
import { projectsApi } from '../../api/projects';
import { ErrorBanner, Spinner } from '../../components/ui';
import { useUploader } from '../../hooks/useUploader';
import { RestDocumentSession, type SaveStatus } from '../editor/document-session';
import { EditorPane } from '../editor/EditorPane';
import { FileTree } from '../files/FileTree';
import { FilePreview } from './FilePreview';
import { useStoredLayout } from './layout';
import { useTabs } from './useTabs';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, { s: SaveStatus; m?: string | undefined }>>({});
  const [wrap, setWrap] = useState(true);
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

  const refreshTree = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['project', projectId, 'tree'] });
    void qc.invalidateQueries({ queryKey: ['project', projectId, 'symbols'] });
  }, [qc, projectId]);
  const uploader = useUploader(projectId, refreshTree);
  const tabs = useTabs(projectId, tree.data?.entities, project.data?.mainFileId ?? null);
  const setMain = useMutation({
    mutationFn: (e: TreeEntity) => projectsApi.update(projectId, { mainFileId: e.id }),
    onSuccess: (p) => qc.setQueryData(['project', projectId], p),
    onError: (e) => setError(e.message),
  });

  // Warn before leaving the page while edits are not yet on the server.
  const hasUnsaved = Object.values(status).some(
    (x) => x.s === 'dirty' || x.s === 'saving' || x.s === 'offline' || x.s === 'error',
  );
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  const byId = useMemo(() => new Map((tree.data?.entities ?? []).map((e) => [e.id, e])), [tree.data]);
  const onStatus = useCallback(
    (id: string, s: SaveStatus, m?: string) => {
      setStatus((x) => ({ ...x, [id]: { s, m } }));
      // New labels / bibliography entries become available to autocompletion after each save.
      if (s === 'saved') void qc.invalidateQueries({ queryKey: ['project', projectId, 'symbols'] });
    },
    [qc, projectId],
  );

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
  const activeEntity = tabs.active ? byId.get(tabs.active) : undefined;
  const activeStatus = tabs.active ? status[tabs.active] : undefined;

  return (
    <div className="project-page">
      <header className="project-header">
        <Link to="/" className="btn btn-ghost btn-small" title="Back to projects" aria-label="Back to projects">
          ←
        </Link>
        <h1 className="project-title">{p.name}</h1>
        {readOnly && <span className="badge">Read only</span>}
        <div className="project-header-right">
          <a className="btn btn-small" href={projectsApi.exportUrl(p.id)} download>
            Download ZIP
          </a>
        </div>
      </header>
      {error && (
        <div className="banner banner-error project-error" role="alert">
          {error}
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
            onSelect={(e) => e.kind !== 'folder' && tabs.openTab(e.id)}
            onChanged={refreshTree}
            onSetMain={(e) => setMain.mutate(e)}
            onError={setError}
            upload={uploader.enqueue}
            uploads={uploader.tasks}
            onClearUploads={uploader.clearFinished}
          />
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="editor" defaultSize="42%" minSize="240px" className="editor-column">
          <div className="tab-bar" role="tablist" aria-label="Open files">
            {tabs.open.map((id) => {
              const e = byId.get(id);
              if (!e) return null;
              const st = status[id]?.s;
              return (
                <div key={id} className={`tab${id === tabs.active ? ' active' : ''}`} title={e.name}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={id === tabs.active}
                    className="tab-label"
                    onClick={() => tabs.activate(id)}
                  >
                    {e.name}
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
                  createSession={() => new RestDocumentSession(p.id, id)}
                  readOnly={readOnly}
                  wrap={wrap}
                  visible={id === tabs.active}
                  diagnostics={EMPTY}
                  callbacks={{ symbols: () => symbolsRef.current }}
                  onStatus={(s, m) => onStatus(id, s, m)}
                />
              );
            })}
          </div>
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="pdf" defaultSize="40%" minSize="200px" collapsible collapsedSize="0px" className="pdf-column">
          <div className="pdf-placeholder muted">
            {activeEntity ? 'Compile the project to see the PDF here.' : 'PDF preview'}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

const EMPTY: never[] = [];

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
