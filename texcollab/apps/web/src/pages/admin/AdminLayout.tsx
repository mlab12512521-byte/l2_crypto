import { NavLink, Outlet } from 'react-router-dom';

export function AdminLayout() {
  return (
    <div className="admin-layout">
      <nav className="subnav" aria-label="Administration">
        <NavLink to="/admin" end>
          Users
        </NavLink>
        <NavLink to="/admin/settings">Settings</NavLink>
        <NavLink to="/admin/ldap">Directory (LDAP)</NavLink>
        <NavLink to="/admin/compilation">Compilation &amp; limits</NavLink>
        <NavLink to="/admin/status">System status</NavLink>
        <NavLink to="/admin/audit">Audit log</NavLink>
        <NavLink to="/admin/logs">Application logs</NavLink>
      </nav>
      <section className="admin-content">
        <Outlet />
      </section>
    </div>
  );
}
