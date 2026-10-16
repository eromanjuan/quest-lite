import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '../lib/auth';
import { ToastProvider } from '../lib/toast';
import { Shell } from './Shell';
import { LoginPage } from './LoginPage';
import { SignupPage } from './SignupPage';
import { ProtectedRoute } from './ProtectedRoute';
import { Loading } from '../ui';

/**
 * Pages are split per route so a session only downloads the workspace it is
 * in. This matters on the free Firebase Hosting tier, where transfer is a
 * daily budget rather than an unlimited resource. React and the app shell stay
 * in the initial chunk; shared helpers are grouped by Vite into common chunks.
 */
const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage'));
const ProspectingBoardPage = lazy(() => import('../features/prospecting/ProspectingBoardPage'));
const ProspectTablePage = lazy(() => import('../features/prospecting/ProspectTablePage'));
const CallQueuePage = lazy(() => import('../features/prospecting/CallQueuePage'));
const ProspectDetailPage = lazy(() => import('../features/prospecting/ProspectDetailPage'));
const BidQueuePage = lazy(() => import('../features/underwriting/BidQueuePage'));
const BidDetailPage = lazy(() => import('../features/underwriting/BidDetailPage'));
const SalesBoardPage = lazy(() => import('../features/sales/SalesBoardPage'));
const DealDetailPage = lazy(() => import('../features/sales/DealDetailPage'));
const ProjectsPage = lazy(() => import('../features/production/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('../features/production/ProjectDetailPage'));
const JobDetailPage = lazy(() => import('../features/production/JobDetailPage'));
const ContactsPage = lazy(() => import('../features/records/ContactsPage'));
const CompaniesPage = lazy(() => import('../features/records/CompaniesPage'));
const TasksPage = lazy(() => import('../features/records/TasksPage'));
const CalendarPage = lazy(() => import('../features/records/CalendarPage'));
const ReportsPage = lazy(() => import('../features/reports/ReportsPage'));
const AdminPage = lazy(() => import('../features/admin/AdminPage'));

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          {/* A single Suspense boundary around the router: a lazy page resolves
              within its own route, so a slow chunk never unmounts the shell. */}
          <Suspense fallback={<Loading label="Loading workspace…" />}>
            <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <Shell />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />

              <Route path="prospecting" element={<ProspectingBoardPage />} />
              <Route path="prospecting/table" element={<ProspectTablePage />} />
              <Route path="call-queue" element={<CallQueuePage />} />
              <Route path="prospects/:id" element={<ProspectDetailPage />} />

              <Route
                path="underwriting"
                element={
                  <ProtectedRoute permission="bid.read">
                    <BidQueuePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="bids/:id"
                element={
                  <ProtectedRoute permission="bid.read">
                    <BidDetailPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="sales"
                element={
                  <ProtectedRoute permission="deal.read">
                    <SalesBoardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="deals/:id"
                element={
                  <ProtectedRoute permission="deal.read">
                    <DealDetailPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="production"
                element={
                  <ProtectedRoute permission="production.read">
                    <ProjectsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="projects/:id"
                element={
                  <ProtectedRoute permission="production.read">
                    <ProjectDetailPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="jobs/:id"
                element={
                  <ProtectedRoute permission="production.read">
                    <JobDetailPage />
                  </ProtectedRoute>
                }
              />

              <Route
                path="contacts"
                element={
                  <ProtectedRoute permission="crm.read">
                    <ContactsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="companies"
                element={
                  <ProtectedRoute permission="crm.read">
                    <CompaniesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="tasks"
                element={
                  <ProtectedRoute permission="task.read">
                    <TasksPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="calendar"
                element={
                  <ProtectedRoute permission="task.read">
                    <CalendarPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="reports"
                element={
                  <ProtectedRoute permission="kpi.view">
                    <ReportsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin/*"
                element={
                  <ProtectedRoute permission="admin.manage">
                    <AdminPage />
                  </ProtectedRoute>
                }
              />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
