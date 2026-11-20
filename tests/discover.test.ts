import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "discover-"));
const configPath = join(home, "config.json"); // never touch the real config
const dbPath = join(home, "mem.db");
const db = new Database(dbPath);
db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT)");
for (const p of ["known", "fresh", ""]) db.run("INSERT INTO observations (project) VALUES (?)", [p]);
db.close();

const { parseConfig } = await import("../src/core/config");
const { discoverProjects } = await import("../src/core/discover");

const mk = (autoDiscover: boolean) =>
  parseConfig({
    global: { devName: "a", claudeMemDbPath: dbPath, autoDiscover },
    projects: { known: { remote: { repo: "o/r" }, export: { tags: ["#shared"] } } },
  });

describe("discoverProjects", () => {
  test("no-op when disabled or skipped", async () => {
    expect(Object.keys((await discoverProjects(mk(false))).projects)).toEqual(["known"]);
    expect(Object.keys((await discoverProjects(mk(true), { skip: true })).projects)).toEqual(["known"]);
  });

  test("adds local projects, cloning the first project's settings, and persists", async () => {
    const next = await discoverProjects(mk(true), { configPath });
    expect(Object.keys(next.projects).sort()).toEqual(["fresh", "known"]);
    expect(next.projects.fresh).toEqual(next.projects.known);
    const saved = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(saved.projects.fresh.export.tags).toEqual(["#shared"]);
  });
});
