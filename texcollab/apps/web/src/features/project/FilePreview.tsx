import { useQuery } from '@tanstack/react-query';
import { extensionOf, type TreeEntity } from '@texcollab/shared';
import { projectsApi } from '../../api/projects';
import { ErrorBanner, Spinner } from '../../components/ui';
import { formatBytes } from '../../lib/time';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Read-only view of a file: text, image, or a download link for other binaries. */
export function FilePreview({ projectId, entity }: { projectId: string; entity: TreeEntity }) {
  const text = useQuery({
    queryKey: ['project', projectId, 'text', entity.id, entity.updatedAt],
    queryFn: () => projectsApi.readText(projectId, entity.id),
    enabled: entity.kind === 'doc',
  });
  if (entity.kind === 'folder') return <div className="empty-state muted">{entity.name}</div>;
  if (entity.kind === 'doc') {
    if (text.isLoading) return <Spinner />;
    return (
      <>
        <ErrorBanner error={text.error} />
        <pre className="text-preview">{text.data?.text}</pre>
      </>
    );
  }
  const ext = extensionOf(entity.name);
  return (
    <div className="binary-preview">
      {IMAGE_EXTS.has(ext) && <img src={projectsApi.contentUrl(projectId, entity.id, true)} alt={entity.name} />}
      {ext === 'pdf' && <p className="muted">PDF file ({formatBytes(entity.size)})</p>}
      <p>
        <strong>{entity.name}</strong> <span className="muted">{formatBytes(entity.size)}</span>
      </p>
      <a className="btn" href={projectsApi.contentUrl(projectId, entity.id)} download>
        Download
      </a>
    </div>
  );
}
