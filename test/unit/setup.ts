// Shared stubs for unit tests: Map-backed localStorage (no jsdom).
// Installed before every test file via vitest setupFiles.

const store = new Map<string, string>();

(globalThis as Record<string, unknown>).localStorage = {
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => (store.has(k) ? store.get(k) : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

// expose for tests that need to inspect/seed raw entries
export const lsStore = store;

export const lsReset = () => { store.clear(); };
