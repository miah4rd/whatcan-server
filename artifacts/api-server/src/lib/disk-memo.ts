import { readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * A Map that survives a restart. Every in-memory memo of "what this pass already read" died with
 * pm2 restart, and a deploy day (25.09.2026: 19 restarts) re-read every card's thread and re-asked
 * the model the same questions: 41% of that day's model spend fell in the 12 minutes after a restart.
 * Loaded once at start; saved a few seconds after the last change, whole file, tmp + rename.
 */
export function diskMap<V>(file: string, o: { max?: number; revive?: (v: V) => V } = {}): { map: Map<string, V>; touch: () => void } {
  const map = new Map<string, V>();
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, V>)) map.set(k, o.revive ? o.revive(v) : v);
  } catch {
    /* first start or unreadable: start empty, exactly as before */
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        const max = o.max ?? 5000;
        if (map.size > max) for (const k of [...map.keys()].slice(0, map.size - max)) map.delete(k);
        writeFileSync(file + ".tmp", JSON.stringify(Object.fromEntries(map)));
        renameSync(file + ".tmp", file);
      } catch {
        /* best effort: the memo is a saving, never a dependency */
      }
    }, 5000);
  };
  return { map, touch };
}
