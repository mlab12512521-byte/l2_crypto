import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAdmin, RequireAuth } from './auth/guards';
import { AppShell } from './components/AppShell';
import { ProjectPage } from './features/project/ProjectPage';
import { AccountPage } from './pages/AccountPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AuditPage } from './pages/admin/AuditPage';
import { CompilationPage } from './pages/admin/CompilationPage';
import { LogsPage } from './pages/admin/LogsPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { StatusPage } from './pages/admin/StatusPage';
import { UsersPage } from './pages/admin/UsersPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';

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
      <Route
        path="/project/:projectId"
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route
          path="admin"
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="compilation" element={<CompilationPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="logs" element={<LogsPage />} />
        </Route>
        <Route path="404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Route>
    </Routes>
  );
}
