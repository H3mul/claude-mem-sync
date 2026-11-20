import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Observation, ExportFile } from "../types/observation";
import type { MergeState } from "../types/merge-state";

/** Composite dedup key (same fields as merger.deduplicateObservations). */
export function obsKey(o: Observation): string {
  return `${o.memory_session_id}|${o.title}|${o.created_at_epoch}`;
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null; // unreadable => treated as absent, so its observations get re-exported (self-heal)
  }
}

function contribFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

/**
 * Keys of every observation the remote already holds for a project:
 * all developers' contribution files plus merged/<project>/latest.json.
 * (merged is included so compaction/CI cleanup never causes a re-export.)
 */
export function knownKeys(repoDir: string, project: string): Set<string> {
  const keys = new Set<string>();
  const add = (file: ExportFile | null) => file?.observations?.forEach((o) => keys.add(obsKey(o)));

  const projDir = join(repoDir, "contributions", project);
  if (existsSync(projDir)) {
    for (const dev of readdirSync(projDir)) {
      for (const f of contribFiles(join(projDir, dev))) add(readJson(join(projDir, dev, f)));
    }
  }
  add(readJson(join(repoDir, "merged", project, "latest.json")));
  return keys;
}

/** Relative paths of this dev's contribution files that CI has already merged. */
export function mergedOwnFiles(repoDir: string, project: string, dev: string): Set<string> {
  const state = readJson<MergeState>(join(repoDir, ".merge-state.json"));
  const prefix = `contributions/${project}/${dev}/`;
  return new Set(
    Object.keys(state?.projects?.[project]?.processedFiles ?? {}).filter((p) => p.startsWith(prefix)),
  );
}

export interface CompactResult {
  /** Relative paths removed. */
  removed: string[];
  /** Relative path of the written file, or null if nothing to do. */
  written: string | null;
  before: number;
  after: number;
}

/**
 * Merge a dev's contribution files into one deduped file and delete the sources.
 * `only` restricts the sources to those relative paths (export-time prune uses
 * the CI-merged files). No-op for <2 files without internal duplicates.
 * Per-dev on purpose: keeps `exportedBy` attribution intact.
 */
export function compactContributions(
  repoDir: string,
  project: string,
  dev: string,
  opts: { only?: Set<string>; write?: boolean; now?: Date } = {},
): CompactResult {
  const rel = (f: string) => `contributions/${project}/${dev}/${f}`;
  const dir = join(repoDir, "contributions", project, dev);
  const files = contribFiles(dir).filter((f) => !opts.only || opts.only.has(rel(f)));

  const seen = new Set<string>();
  const merged: Observation[] = [];
  let before = 0;
  let header: ExportFile | null = null;
  const readable: string[] = [];

  for (const f of files) {
    const data = readJson<ExportFile>(join(dir, f));
    if (!data) continue; // never delete what we could not read
    readable.push(f);
    header = data;
    for (const o of data.observations ?? []) {
      before++;
      if (!seen.has(obsKey(o))) {
        seen.add(obsKey(o));
        merged.push(o);
      }
    }
  }

  const noop = !header || (readable.length < 2 && merged.length === before);
  if (noop) return { removed: [], written: null, before, after: before };

  const now = opts.now ?? new Date();
  const out: ExportFile = {
    ...header!,
    exportedAt: now.toISOString(),
    exportedAtEpoch: Math.floor(now.getTime() / 1000),
    observations: merged,
    observationCount: merged.length,
  };
  const writtenRel = rel(`${formatTimestamp(now)}-compacted.json`);
  const removed = readable.map(rel);

  if (opts.write !== false) {
    // Write first, then delete: a crash in between leaves duplicates, never data loss.
    writeFileSync(join(repoDir, writtenRel), JSON.stringify(out, null, 2), "utf-8");
    for (const r of removed) if (r !== writtenRel) unlinkSync(join(repoDir, r));
  }
  return { removed, written: writtenRel, before, after: merged.length };
}
