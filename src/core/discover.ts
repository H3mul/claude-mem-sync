import { readdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_PATH } from "./constants";
import { getEnabledProjects } from "./config";
import { openMemDb } from "./mem-db";
import { shallowClone } from "./git";
import { logger } from "./logger";
import type { Config } from "../types/config";

/**
 * Opt-in (global.autoDiscover): register claude-mem projects that aren't in the
 * config yet, cloning the first enabled project's remote/export settings.
 * Sources: the local claude-mem DB, plus (store: true) the store's merged/ dirs.
 * Persists to the config file. Never removes projects.
 */
export async function discoverProjects(
  config: Config,
  opts: { skip?: boolean; store?: boolean; configPath?: string } = {},
): Promise<Config> {
  if (!config.global.autoDiscover || opts.skip) return config;
  const first = getEnabledProjects(config)[0];
  if (!first) return config;
  const tpl = config.projects[first];

  const names = new Set<string>();
  try {
    const db = openMemDb(config.global.claudeMemDbPath);
    try {
      const rows = db.prepare("SELECT DISTINCT project FROM observations WHERE project != ''").all() as { project: string }[];
      rows.forEach((r) => names.add(r.project));
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn("Auto-discover: local DB scan failed", { error: String(err) });
  }

  if (opts.store) {
    let dir: string | undefined;
    try {
      dir = await shallowClone(tpl.remote);
      const merged = join(dir, "merged");
      if (existsSync(merged)) {
        readdirSync(merged, { withFileTypes: true }).filter((d) => d.isDirectory()).forEach((d) => names.add(d.name));
      }
    } catch (err) {
      logger.warn("Auto-discover: store scan failed", { error: String(err) });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  const added = [...names].filter((n) => !(n in config.projects));
  if (added.length === 0) return config;

  const projects = { ...config.projects };
  for (const n of added) projects[n] = structuredClone(tpl);
  const next = { ...config, projects };
  writeFileSync(opts.configPath ?? CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  logger.info(`Auto-discover: added ${added.length} project(s)`, { added });
  console.log(`Auto-discover: added ${added.join(", ")}`);
  return next;
}
