import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Loading, EmptyState } from '../ui';
import type { PermissionKey } from '../lib/permissions';

/** Blocks the route until the session resolves, then until the role matches. */
export function ProtectedRoute({
  children,
  permission,
}: {
  children: ReactNode;
  permission?: PermissionKey;
}) {
  const { user, loading, can } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '60dvh', display: 'grid', placeItems: 'center' }}>
        <Loading label="Checking your session…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (permission && !can(permission)) {
    return (
      <div className="card card-pad">
        <EmptyState title="You do not have access to this area" icon={<span>🔒</span>}>
          Your role is <strong>{user.roleLabel}</strong>. This page needs the{' '}
          <code className="mono">{permission}</code> permission. An administrator can adjust roles
          under Administration → Roles.
        </EmptyState>
      </div>
    );
  }

  return <>{children}</>;
}
