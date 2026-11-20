import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Observation } from "../types/observation";

export const obsKey = (o: Observation) => `${o.memory_session_id}|${o.title}|${o.created_at_epoch}`;

function keysOf(file: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return new Set((parsed.observations as Observation[]).map(obsKey));
  } catch {
    return new Set(); // missing/unreadable => nothing known (self-heal: re-export)
  }
}

/**
 * Observations not in the newest contribution file of `devDir` (sortable timestamp
 * filenames) nor in the merged file. Merged is included so CI purging the last
 * contribution file never causes a full re-export. `synced` (local record of what
 * we exported/imported) also covers observations the merge cap evicted from merged.
 */
export function newSinceLastExport(
  devDir: string,
  mergedFile: string,
  observations: Observation[],
  synced: Set<string> = new Set(),
): Observation[] {
  const last = existsSync(devDir)
    ? readdirSync(devDir).filter((f) => f.endsWith(".json")).sort().at(-1)
    : undefined;
  const known = new Set([
    ...synced,
    ...(last ? keysOf(join(devDir, last)) : []),
    ...(existsSync(mergedFile) ? keysOf(mergedFile) : []),
  ]);
  return observations.filter((o) => !known.has(obsKey(o)));
}
