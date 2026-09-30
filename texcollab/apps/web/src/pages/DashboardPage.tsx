import { useAuth } from '../auth/AuthContext';

/** Project dashboard. Project listing arrives with the projects module (phase 2). */
export function DashboardPage() {
  const { user } = useAuth();
  return (
    <div className="stack-lg">
      <h1>Projects</h1>
      <div className="card empty-state">
        <p>Welcome, {user?.displayName}.</p>
        <p className="muted">You have no projects yet.</p>
      </div>
    </div>
  );
}
