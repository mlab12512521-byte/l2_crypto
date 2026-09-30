import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">TeX</span>Collab
        </Link>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>
            Projects
          </NavLink>
          {user?.isAdmin && <NavLink to="/admin">Administration</NavLink>}
        </nav>
        <div className="topbar-right">
          <NavLink to="/account" className="user-chip" title="Account settings">
            {user?.displayName}
          </NavLink>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
