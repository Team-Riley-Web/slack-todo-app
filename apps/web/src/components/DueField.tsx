import type { DueWhen } from '@tr/task-core';

/**
 * Due, as four one-tap choices -- No date, Today, Tomorrow, Pick a date --
 * with a time as an optional extra underneath.
 *
 * It replaced a single datetime-local input, which on a phone opened a picker
 * that defaulted to this exact minute: "due today" was saved as "due 9:07am",
 * overdue before the pane had closed. Most due dates are a day. A time is the
 * exception, so it sits behind "Add a time" rather than in the way.
 *
 * Plain radios and inputs, so it works with no client JavaScript; the date
 * field shows only when "Pick a date" is chosen, which the stylesheet does with
 * `:has()`. The server reads it with `resolveDueChoice`.
 */
export function DueField({
  when = 'none', date = '', time = '',
}: { when?: DueWhen; date?: string; time?: string }) {
  const options: Array<[DueWhen, string]> = [
    ['none', 'No date'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['date', 'Pick a date'],
  ];
  return (
    <fieldset className="due-field">
      <legend>Due</legend>
      <div className="due-choices">
        {options.map(([value, label]) => (
          <label key={value} className="due-choice">
            <input type="radio" name="dueWhen" value={value} defaultChecked={when === value} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <label className="due-date">
        <span className="sr-only">Date</span>
        <input type="date" name="dueDate" defaultValue={date} aria-label="Due date" />
      </label>
      <details className="due-time" open={time !== ''}>
        <summary>Add a time</summary>
        <input type="time" name="dueTime" defaultValue={time} aria-label="Due time" />
      </details>
    </fieldset>
  );
}
