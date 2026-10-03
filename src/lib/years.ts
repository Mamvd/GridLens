// OpenF1 has no data before 2023 (earlier years 404) — single source of truth
// for the year floor. Pure and React-free so scripts/future-check.mjs can
// import it without compiling JSX.
export const MIN_DATA_YEAR = 2023;

export const availableYears = (min: number = MIN_DATA_YEAR): number[] =>
  [2026, 2025, 2024, 2023].filter((y) => y >= min);
