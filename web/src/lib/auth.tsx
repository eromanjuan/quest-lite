import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { get, post, ApiError } from './api';
import type { PermissionKey } from './permissions';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  active: number;
  permissions: PermissionKey[];
}

export interface SignupInput {
  email: string;
  name: string;
  password: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  permissionCatalog: Record<string, string>;
  roleCatalog: Record<string, { name: string; description: string }>;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  /** Signs in — or signs the user up — with a Google ID token from GIS. */
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: PermissionKey) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissionCatalog, setPermissionCatalog] = useState<Record<string, string>>({});
  const [roleCatalog, setRoleCatalog] = useState<Record<string, { name: string; description: string }>>({});

  const load = useCallback(async () => {
    try {
      const res = await get('/auth/me');
      setUser(res.user);
      setPermissionCatalog(res.permissionCatalog ?? {});
      setRoleCatalog(res.roleCatalog ?? {});
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 0)) {
        setUser(null);
      } else {
        console.error('Session lookup failed', err);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onUnauthorized = () => setUser(null);
    window.addEventListener('ql:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ql:unauthorized', onUnauthorized);
  }, [load]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await post('/auth/login', { email, password });
    setUser(res.user);
    // Pull the full catalogs alongside the session.
    const me = await get('/auth/me').catch(() => null);
    if (me) {
      setPermissionCatalog(me.permissionCatalog ?? {});
      setRoleCatalog(me.roleCatalog ?? {});
    }
  }, []);

  /** Creates the account and signs the new user straight in. */
  const signup = useCallback(async (input: SignupInput) => {
    const res = await post('/auth/signup', {
      email: input.email.trim(),
      name: input.name.trim(),
      password: input.password,
    });
    setUser(res.user);
    const me = await get('/auth/me').catch(() => null);
    if (me) {
      setPermissionCatalog(me.permissionCatalog ?? {});
      setRoleCatalog(me.roleCatalog ?? {});
    }
  }, []);

  /** One call covers both: the server signs in or creates the account. */
  const loginWithGoogle = useCallback(async (credential: string) => {
    const res = await post('/auth/google', { credential });
    setUser(res.user);
    const me = await get('/auth/me').catch(() => null);
    if (me) {
      setPermissionCatalog(me.permissionCatalog ?? {});
      setRoleCatalog(me.roleCatalog ?? {});
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout', {});
    } finally {
      setUser(null);
    }
  }, []);

  const can = useCallback(
    (permission: PermissionKey) => !!user && user.permissions.includes(permission),
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({ user, loading, permissionCatalog, roleCatalog, login, signup, loginWithGoogle, logout, refresh: load, can }),
    [user, loading, permissionCatalog, roleCatalog, login, signup, loginWithGoogle, logout, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Throws when used outside the provider — keeps call sites clean. */
export function usePermission(permission: PermissionKey): boolean {
  return useAuth().can(permission);
}
