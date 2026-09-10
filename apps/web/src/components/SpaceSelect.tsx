import type { Space } from '@tr/task-core';
import { spaceGroups } from '@/lib/space-groups';

/**
 * A Space dropdown, grouped into Spaces and Clients.
 *
 * Native `optgroup`, so it needs no JavaScript and gets the platform's own
 * dropdown on every device. The grouping rule lives in `spaceGroups`, which
 * is where it is tested.
 *
 * Shared by the edit pane and the channel-mapping form. They submit different
 * values from the same list -- an id and a canonical name -- so `valueOf` is
 * a prop rather than a decision made here.
 */
export function SpaceSelect({
  name, spaces, valueOf, defaultValue, placeholder, required, ariaLabel,
}: {
  name: string;
  spaces: Space[];
  valueOf: (space: Space) => string;
  defaultValue?: string;
  /** A disabled first option, for a form with no sensible default. */
  placeholder?: string;
  required?: boolean;
  ariaLabel?: string;
}) {
  const groups = spaceGroups(spaces, valueOf);

  return (
    <select
      name={name}
      required={required}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
    >
      {placeholder ? (
        <option value="" disabled>{placeholder}</option>
      ) : null}
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.choices.map((choice) => (
            <option key={choice.space.id} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
