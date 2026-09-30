import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

/** Shown when an administrator requires the user to choose a new password. */
export function ChangePasswordPage() {
  const { refresh, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1 className="auth-title">Choose a new password</h1>
        <p className="muted">Your administrator requires you to set a new password before continuing.</p>
        <ChangePasswordForm
          onDone={async () => {
            await refresh();
            navigate('/', { replace: true });
          }}
        />
        <p className="auth-alt">
          <button type="button" className="btn btn-link" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
