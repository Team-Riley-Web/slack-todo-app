import { Icon } from './Icon';

/**
 * Search, top right.
 *
 * A GET form, so the query lands in the URL and the result is linkable. Every
 * other active filter rides along as a hidden field, otherwise searching
 * would silently clear the view you were looking at.
 */
export function SearchBox({
  path, params,
}: {
  path: string;
  params: Record<string, string | string[] | undefined>;
}) {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const carry = (['space', 'status', 'assignee', 'due', 'from', 'to', 'sort', 'dir'] as const)
    .map((key) => [key, one(params[key])] as const)
    .filter(([, value]) => value !== undefined && value !== '');

  return (
    <form className="search" method="get" action={path}>
      {carry.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <span className="search-field">
        <Icon name="search" />
        <input
          type="search"
          name="q"
          defaultValue={one(params.q) ?? ''}
          placeholder="Search tasks"
          aria-label="Search task titles"
        />
      </span>
    </form>
  );
}
