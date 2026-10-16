import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon, type IconName } from '../ui/icons';
import { initials, titleCase } from '../lib/format';
import type { PermissionKey } from '../lib/permissions';

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  permission?: PermissionKey;
  end?: boolean;
}

interface NavGroup {
  label: string;
  entries: NavEntry[];
}

const NAV: NavGroup[] = [
  {
    label: 'Operate',
    entries: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: '/tasks', label: 'My Tasks', icon: 'tasks', permission: 'task.read' },
      { to: '/calendar', label: 'Calendar', icon: 'calendar', permission: 'task.read' },
      { to: '/call-queue', label: 'Call Queue', icon: 'phone', permission: 'task.read' },
    ],
  },
  {
    label: 'Workspaces',
    entries: [
      { to: '/prospecting', label: 'Prospecting', icon: 'prospects', permission: 'prospect.read' },
      { to: '/underwriting', label: 'Underwriting', icon: 'estimate', permission: 'bid.read' },
      { to: '/sales', label: 'Sales', icon: 'sales', permission: 'deal.read' },
      { to: '/production', label: 'Production', icon: 'production', permission: 'production.read' },
    ],
  },
  {
    label: 'Records',
    entries: [
      { to: '/contacts', label: 'Contacts', icon: 'contacts', permission: 'crm.read' },
      { to: '/companies', label: 'Companies', icon: 'companies', permission: 'crm.read' },
      { to: '/reports', label: 'Reports', icon: 'reports', permission: 'kpi.view' },
    ],
  },
  {
    label: 'System',
    entries: [{ to: '/admin', label: 'Administration', icon: 'admin', permission: 'admin.manage' }],
  },
];

export function Shell() {
  const { user, can, logout, permissionCatalog } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('ql:theme') as 'light' | 'dark') ?? 'light',
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ql:theme', theme);
  }, [theme]);

  // Close the mobile rail whenever the route changes.
  useEffect(() => {
    setRailOpen(false);
  }, [location.pathname]);

  const groups = NAV.map((g) => ({
    ...g,
    entries: g.entries.filter((e) => !e.permission || can(e.permission)),
  })).filter((g) => g.entries.length > 0);

  const title = currentTitle(location.pathname, groups);

  return (
    <div className="shell">
      {railOpen ? <div className="rail-scrim" onClick={() => setRailOpen(false)} /> : null}
      <nav className={`rail ${railOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="rail-brand">
          <div className="rail-mark" aria-hidden="true">
            Q
          </div>
          <div>
            <b>QUEST LITE</b>
            <span>Construction Ops</span>
          </div>
        </div>

        <div className="rail-scroll">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.entries.map((e) => (
                <NavLink
                  key={e.to}
                  to={e.to}
                  end={e.end}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <Icon name={e.icon} className="ico" size={17} />
                  <span className="truncate">{e.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        <div className="rail-foot">
          <button
            className="nav-item"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            type="button"
          >
            <Icon name="settings" className="ico" size={17} />
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
          <div className="rail-user">
            <div className="avatar" aria-hidden="true">
              {initials(user?.name)}
            </div>
            <div className="who truncate">
              <b className="truncate">{user?.name}</b>
              <span>{user?.roleLabel}</span>
            </div>
            <button
              className="btn btn-ghost btn-icon"
              style={{ marginLeft: 'auto', color: '#8a8375' }}
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <button
            className="btn btn-ghost btn-icon rail-toggle"
            onClick={() => setRailOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            <Icon name="menu" />
          </button>
          <div className="crumb">
            <span className="cur truncate">{title}</span>
          </div>
          <div className="spacer" />
          <div className="row small muted nowrap" style={{ gap: 6 }}>
            <span className="hidden-mobile">{user?.roleLabel}</span>
          </div>
        </header>

        <main className="content" id="main">
          <Outlet context={{ can, permissionCatalog }} />
        </main>
      </div>
    </div>
  );
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/prospecting/, 'Prospecting'],
  [/^\/prospects/, 'Prospect'],
  [/^\/underwriting/, 'Underwriting'],
  [/^\/bids/, 'Bid'],
  [/^\/sales/, 'Sales'],
  [/^\/deals/, 'Deal'],
  [/^\/production/, 'Production'],
  [/^\/projects/, 'Project'],
  [/^\/jobs/, 'Job'],
  [/^\/contacts/, 'Contacts'],
  [/^\/companies/, 'Companies'],
  [/^\/tasks/, 'Tasks'],
  [/^\/calendar/, 'Calendar'],
  [/^\/call-queue/, 'Call Queue'],
  [/^\/reports/, 'Reports'],
  [/^\/admin/, 'Administration'],
];

function currentTitle(path: string, _groups: NavGroup[]): string {
  for (const [re, label] of TITLES) if (re.test(path)) return label;
  return titleCase(path.replace(/^\//, '').split('/')[0]);
}
