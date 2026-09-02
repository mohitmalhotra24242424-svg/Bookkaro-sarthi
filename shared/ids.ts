/** Collision-resistant id helper with a dependency-free fallback (no Node APIs → stays isomorphic). */

export function newId(prefix = ''): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    `fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}
