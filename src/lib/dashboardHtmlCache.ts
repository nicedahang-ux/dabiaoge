type CacheEntry = {
  html: string;
  sourceTable: string | null;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
    }
  });
}

export function getCached(dashboardId: string): string | undefined {
  return cache.get(dashboardId)?.html;
}

export function setCached(
  dashboardId: string,
  html: string,
  sourceTable: string | null
): void {
  cache.set(dashboardId, { html, sourceTable });
  notify();
}

export function invalidateBySourceTable(tableName: string): void {
  if (!tableName) return;
  let changed = false;
  for (const [id, entry] of cache.entries()) {
    if (entry.sourceTable && entry.sourceTable === tableName) {
      cache.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

export function invalidateOne(dashboardId: string): void {
  if (cache.delete(dashboardId)) notify();
}

export function invalidateAll(): void {
  if (cache.size === 0) return;
  cache.clear();
  notify();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
