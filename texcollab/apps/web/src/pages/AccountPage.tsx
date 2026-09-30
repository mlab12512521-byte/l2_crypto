import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

export function AccountPage() {
  const { user } = useAuth();
  const [changed, setChanged] = useState(false);
  if (!user) return null;
  return (
    <div className="narrow stack-lg">
      <h1>Account</h1>
      <section className="card">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Username</dt>
          <dd>{user.username}</dd>
          <dt>Display name</dt>
          <dd>{user.displayName}</dd>
          <dt>E-mail</dt>
          <dd>{user.email ?? '—'}</dd>
          <dt>Account type</dt>
          <dd>{user.authSource === 'ldap' ? 'Directory (LDAP)' : 'Local'}</dd>
        </dl>
      </section>
      <section className="card">
        <h2>Password</h2>
        {user.authSource === 'ldap' ? (
          <p className="muted">Your password is managed by your organisation's directory.</p>
        ) : (
          <>
            {changed && (
              <div className="banner banner-success" role="status">
                Password changed. Other devices have been signed out.
              </div>
            )}
            <ChangePasswordForm onDone={() => setChanged(true)} />
          </>
        )}
      </section>
    </div>
  );
}
