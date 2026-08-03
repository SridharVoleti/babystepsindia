import type { Granularity } from "@/lib/db/subscriptions";

export function DateRangeForm({
  fromDate,
  toDate,
  granularity,
}: {
  fromDate: string;
  toDate: string;
  granularity: Granularity;
}) {
  return (
    <form
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-chakra-100 bg-white p-4"
    >
      <div>
        <label htmlFor="from" className="field-label">
          From
        </label>
        <input
          id="from"
          name="from"
          type="date"
          defaultValue={fromDate}
          className="field-input"
        />
      </div>
      <div>
        <label htmlFor="to" className="field-label">
          To
        </label>
        <input
          id="to"
          name="to"
          type="date"
          defaultValue={toDate}
          className="field-input"
        />
      </div>
      <div>
        <label htmlFor="granularity" className="field-label">
          Granularity
        </label>
        <select
          id="granularity"
          name="granularity"
          defaultValue={granularity}
          className="field-input"
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
        </select>
      </div>
      <button type="submit" className="btn-primary">
        Apply
      </button>
    </form>
  );
}
