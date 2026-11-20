import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { knownKeys, obsKey, compactContributions, mergedOwnFiles } from "../src/core/export-sync";
import type { Observation } from "../src/types/observation";

const obs = (title: string): Observation => ({
  id: 1, memory_session_id: "s", type: "decision", title, narrative: null, text: null,
  facts: null, concepts: null, files_read: null, files_modified: null, created_at_epoch: 1710000000,
});

function repoWith(files: Record<string, Observation[]>, merged: Observation[] = []) {
  const repo = mkdtempSync(join(tmpdir(), "es-"));
  for (const [rel, o] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), JSON.stringify({ exportedBy: "x", observations: o, observationCount: o.length }));
  }
  if (merged.length) {
    mkdirSync(join(repo, "merged/p"), { recursive: true });
    writeFileSync(join(repo, "merged/p/latest.json"), JSON.stringify({ observations: merged }));
  }
  return repo;
}
const P = (dev: string, f: string) => `contributions/p/${dev}/${f}`;

describe("export-sync", () => {
  test("knownKeys spans all devs and merged", () => {
    const repo = repoWith({ [P("me", "a.json")]: [obs("A")], [P("bob", "b.json")]: [obs("B")] }, [obs("C")]);
    const k = knownKeys(repo, "p");
    for (const t of ["A", "B", "C"]) expect(k.has(obsKey(obs(t)))).toBe(true);
    expect(k.has(obsKey(obs("D")))).toBe(false);
  });

  test("compact merges own files, dedupes, leaves other devs alone", () => {
    const repo = repoWith({
      [P("me", "1.json")]: [obs("A"), obs("B")],
      [P("me", "2.json")]: [obs("B"), obs("C")],
      [P("bob", "1.json")]: [obs("A")],
    });
    const r = compactContributions(repo, "p", "me");
    expect(r.before).toBe(4);
    expect(r.after).toBe(3);
    const mine = readdirSync(join(repo, "contributions/p/me"));
    expect(mine.length).toBe(1);
    expect(JSON.parse(readFileSync(join(repo, "contributions/p/me", mine[0]), "utf-8")).observationCount).toBe(3);
    expect(readdirSync(join(repo, "contributions/p/bob")).length).toBe(1);
  });

  test("compact respects `only` and is a no-op for a single clean file", () => {
    const repo = repoWith({ [P("me", "1.json")]: [obs("A")], [P("me", "2.json")]: [obs("B")] });
    expect(compactContributions(repo, "p", "me", { only: new Set([P("me", "1.json")]) }).written).toBeNull();
    expect(readdirSync(join(repo, "contributions/p/me")).length).toBe(2);
  });

  test("mergedOwnFiles reads processedFiles for this dev only", () => {
    const repo = repoWith({});
    const info = { hash: "", processedAt: 1, observationsCount: 0 };
    writeFileSync(join(repo, ".merge-state.json"), JSON.stringify({
      projects: { p: { processedFiles: { [P("me", "1.json")]: info, [P("bob", "1.json")]: info } } },
    }));
    expect([...mergedOwnFiles(repo, "p", "me")]).toEqual([P("me", "1.json")]);
  });
});
