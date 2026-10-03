// Pure phase resolver for lazily loaded data — React-free, testable.
// One source of truth for loading / error / empty / ready so a finished-but-
// empty response never renders as a skeleton that can never resolve.

export type ResourcePhase = "loading" | "error" | "empty" | "ready";

export interface PhaseSlice {
  loading: boolean;
  error?: string | null;
  data?: unknown;
}

// needed = this view's resource slices (one or many — ANY error wins, then
// ANY unfinished slice; only a clean finish with zero rows is "empty").
// rowCount is the derived row count AFTER filtering, so a loaded resource
// whose rows all filter away still reports "empty", not "ready".
export const resourcePhase = (
  needed: readonly PhaseSlice[],
  rowCount: number,
): ResourcePhase => {
  if (needed.some((s) => s.error)) return "error";
  // not finished = explicit loading flag OR no payload yet
  if (needed.some((s) => s.loading || s.data === undefined)) return "loading";
  return rowCount === 0 ? "empty" : "ready";
};
