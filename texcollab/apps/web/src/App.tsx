import { lazy, type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAdmin, RequireAuth } from './auth/guards';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import { AccountPage } from './pages/AccountPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';

// The editor/PDF viewer and the admin pages are loaded on demand, keeping the
// login page and dashboard light.
const ProjectPage = lazy(() => import('./features/project/ProjectPage').then((m) => ({ default: m.ProjectPage })));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const AuditPage = lazy(() => import('./pages/admin/AuditPage').then((m) => ({ default: m.AuditPage })));
const CompilationPage = lazy(() =>
  import('./pages/admin/CompilationPage').then((m) => ({ default: m.CompilationPage })),
);
const LdapPage = lazy(() => import('./pages/admin/LdapPage').then((m) => ({ default: m.LdapPage })));
const LogsPage = lazy(() => import('./pages/admin/LogsPage').then((m) => ({ default: m.LogsPage })));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const StatusPage = lazy(() => import('./pages/admin/StatusPage').then((m) => ({ default: m.StatusPage })));
const UsersPage = lazy(() => import('./pages/admin/UsersPage').then((m) => ({ default: m.UsersPage })));

const page = (node: ReactNode) => <Suspense fallback={<Spinner />}>{node}</Suspense>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/change-password"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route path="/project/:projectId" element={<RequireAuth>{page(<ProjectPage />)}</RequireAuth>} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<RequireAdmin>{page(<AdminLayout />)}</RequireAdmin>}>
          <Route index element={page(<UsersPage />)} />
          <Route path="settings" element={page(<SettingsPage />)} />
          <Route path="ldap" element={page(<LdapPage />)} />
          <Route path="compilation" element={page(<CompilationPage />)} />
          <Route path="status" element={page(<StatusPage />)} />
          <Route path="audit" element={page(<AuditPage />)} />
          <Route path="logs" element={page(<LogsPage />)} />
        </Route>
        <Route path="404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Route>
    </Routes>
  );
}
