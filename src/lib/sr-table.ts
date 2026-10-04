// A2: pure sr-only table model for charts — React-free so vitest can import
// it without JSX/jsdom. ChartCard.tsx renders the model as a visually-hidden
// <table>; each chart opts in with its already-derived arrays.

export interface SrSeriesInput {
  name: string;
  data: readonly (number | null | undefined)[];
}

export interface SrTableModel {
  headers: string[];
  rows: { name: string; cells: string[] }[];
}

// cap columns so a 150-point gap spine (or a 4.2 MB intervals set) never
// becomes a 150-column SR table — ponytail: full data stays on the chart +
// tooltip; raise maxCols only if SR users ask for every point.
export const srTableModel = (
  xLabels: readonly (string | number)[],
  series: readonly SrSeriesInput[],
  maxCols = 100,
): SrTableModel | null => {
  if (!xLabels.length || !series.length) return null;
  const n = Math.min(xLabels.length, maxCols);
  const fmt = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return "—";
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  };
  return {
    headers: xLabels.slice(0, n).map(String),
    rows: series.map((s) => ({
      name: s.name,
      cells: s.data.slice(0, n).map(fmt),
    })),
  };
};
