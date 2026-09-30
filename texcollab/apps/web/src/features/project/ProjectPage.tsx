import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TreeEntity } from '@texcollab/shared';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectsApi } from '../../api/projects';
import { ErrorBanner, Spinner } from '../../components/ui';
import { useUploader } from '../../hooks/useUploader';
import { FileTree } from '../files/FileTree';
import { FilePreview } from './FilePreview';

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<TreeEntity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => projectsApi.get(projectId) });
  const tree = useQuery({ queryKey: ['project', projectId, 'tree'], queryFn: () => projectsApi.tree(projectId) });
  const refreshTree = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['project', projectId, 'tree'] });
  }, [qc, projectId]);
  const uploader = useUploader(projectId, refreshTree);
  const setMain = useMutation({
    mutationFn: (e: TreeEntity) => projectsApi.update(projectId, { mainFileId: e.id }),
    onSuccess: (p) => qc.setQueryData(['project', projectId], p),
    onError: (e) => setError(e.message),
  });

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
  const current = selected ? (tree.data.entities.find((e) => e.id === selected.id) ?? null) : null;

  return (
    <div className="project-page">
      <header className="project-header">
        <Link to="/" className="btn btn-ghost btn-small" title="Back to projects">
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
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <div className="project-body">
        <aside className="project-sidebar">
          <FileTree
            projectId={p.id}
            tree={tree.data}
            readOnly={readOnly}
            mainFileId={p.mainFileId}
            selectedId={current?.id ?? null}
            onSelect={setSelected}
            onChanged={refreshTree}
            onSetMain={(e) => setMain.mutate(e)}
            onError={setError}
            upload={uploader.enqueue}
            uploads={uploader.tasks}
            onClearUploads={uploader.clearFinished}
          />
        </aside>
        <main className="project-main">
          {current ? (
            <FilePreview projectId={p.id} entity={current} />
          ) : (
            <div className="empty-state muted">Select a file to view it.</div>
          )}
        </main>
      </div>
    </div>
  );
}
