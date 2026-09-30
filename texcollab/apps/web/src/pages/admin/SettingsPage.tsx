import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ErrorBanner, Spinner } from '../../components/ui';

export function SettingsPage() {
  const qc = useQueryClient();
  const registration = useQuery({
    queryKey: ['admin', 'settings', 'registration'],
    queryFn: () => api.get<{ enabled: boolean }>('/api/admin/settings/registration'),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put('/api/admin/settings/registration', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'settings', 'registration'] }),
  });
  return (
    <div className="stack-lg">
      <h1>Settings</h1>
      <section className="card stack">
        <h2>Registration</h2>
        {registration.isLoading && <Spinner />}
        <ErrorBanner error={registration.error ?? save.error} />
        {registration.data && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={registration.data.enabled}
              disabled={save.isPending}
              onChange={(e) => save.mutate(e.target.checked)}
            />
            Allow anyone who can reach this site to create a local account
          </label>
        )}
        <p className="muted small">
          Keep this off for private deployments. Administrators can always create accounts, and directory (LDAP) users
          are created automatically at first sign-in.
        </p>
      </section>
    </div>
  );
}
