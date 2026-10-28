import { useLocation } from 'preact-iso';
import { navCollapsed } from '../../lib/prefs';
import { hasCapability } from '../../lib/server-info';
import { href, P } from '../../routes';

type IconName = 'workflows' | 'schedules' | 'batch' | 'queues' | 'archival' | 'all' | 'namespaces' | 'import' | 'nexus' | 'codec' | 'search' | 'cluster';

// 24×24 stroke icons; kept inline so the shell needs no icon font or extra request.
const ICON_PATHS: Record<IconName, string> = {
  workflows: 'M4 6h16M4 12h16M4 18h10',
  schedules: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  batch: 'M4 8h12v12H4zM8 4h12v12',
  queues: 'M4 6h4v12H4zM10 6h4v12h-4zM16 6h4v12h-4z',
  archival: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  all: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  namespaces: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  import: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  nexus: 'M6 6h4v4H6zM14 14h4v4h-4zM10 8h4a2 2 0 0 1 2 2v4',
  codec: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  cluster: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d={ICON_PATHS[name]} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function NavLink({ to, icon, active, label }: { to: string; icon: IconName; active: boolean; label: string }) {
  return (
    <a class="nav-link" href={to} aria-current={active ? 'page' : undefined} title={label}>
      <Icon name={icon} />
      <span class="nav-label">{label}</span>
    </a>
  );
}

/** Left navigation: sections of the current namespace, then global pages. */
export function Nav({ ns, version }: { ns: string; version: string }) {
  const { path } = useLocation();
  const within = (base: string) => path === base || path.startsWith(`${base}/`);
  const items: { to: string; icon: IconName; label: string }[] = [
    { to: href(P.workflows, { ns }), icon: 'workflows', label: 'Workflows' },
    { to: href(P.schedules, { ns }), icon: 'schedules', label: 'Schedules' },
    { to: href(P.batchOperations, { ns }), icon: 'batch', label: 'Batch operations' },
    { to: href(P.taskQueues, { ns }), icon: 'queues', label: 'Task queues' },
    { to: href(P.archival, { ns }), icon: 'archival', label: 'Archival' },
  ];

  return (
    <nav class="nav" aria-label="Main">
      <div class="nav-heading nav-heading-ns" title={ns}>
        {ns}
      </div>
      {items.map((i) => (
        <NavLink key={i.label} to={i.to} icon={i.icon} active={within(i.to)} label={i.label} />
      ))}
      <div class="nav-heading">Global</div>
      <NavLink to={P.allWorkflows} icon="all" active={within(P.allWorkflows)} label="All namespaces" />
      <NavLink to={P.search} icon="search" active={path === P.search} label="Search activities & events" />
      <NavLink to={P.namespaces} icon="namespaces" active={path === P.namespaces} label="Namespaces" />
      {hasCapability('nexus') && <NavLink to={P.nexus} icon="nexus" active={within(P.nexus)} label="Nexus" />}
      <NavLink to={P.import} icon="import" active={within(P.import)} label="Import history" />
      <NavLink to={P.codecSettings} icon="codec" active={path === P.codecSettings} label="Codec server" />
      <NavLink to={P.cluster} icon="cluster" active={path === P.cluster} label="Cluster" />
      <div class="nav-footer">
        <span class="nav-version muted">Tempolens {version}</span>
        <button
          type="button"
          class="btn btn-ghost"
          aria-expanded={!navCollapsed.value}
          aria-label={navCollapsed.value ? 'Expand navigation' : 'Collapse navigation'}
          title={navCollapsed.value ? 'Expand navigation' : 'Collapse navigation'}
          onClick={() => (navCollapsed.value = !navCollapsed.value)}
        >
          {navCollapsed.value ? '»' : '«'}
        </button>
      </div>
    </nav>
  );
}
