import { useLocation } from 'preact-iso';
import { namespaceName, namespaces, namespacesError } from '../../lib/namespaces';
import { href, namespaceFromPath, P, switchNamespacePath } from '../../routes';

// Not a valid Temporal namespace name; also the /api/x wildcard for every namespace.
const ALL = '*';

/**
 * Header namespace picker. "All namespaces" opens the cross-namespace list;
 * a namespace keeps the current section where it exists in every namespace.
 */
export function NamespaceSwitcher({ fallback }: { fallback: string }) {
  const { path, route } = useLocation();
  const fromPath = namespaceFromPath(path);
  const value = path === P.allWorkflows ? ALL : (fromPath ?? fallback);
  const names = (namespaces.value ?? []).map(namespaceName);
  // Keep the current namespace selectable while the list loads, fails, or lacks it.
  if (value !== ALL && !names.includes(value)) names.unshift(value);

  const onChange = (e: Event) => {
    const next = (e.currentTarget as HTMLSelectElement).value;
    route(next === ALL ? href(P.allWorkflows, {}) : switchNamespacePath(path, next));
  };

  return (
    <label class="header-group">
      <span class="visually-hidden">Namespace</span>
      <select
        class="select"
        value={value}
        onChange={onChange}
        title={namespacesError.value ? `Could not load namespaces: ${namespacesError.value.message}` : 'Namespace'}
      >
        <option value={ALL}>All namespaces</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
