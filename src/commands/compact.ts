import { rmSync } from "fs";
import { join } from "path";
import { loadConfig, resolveProjectConfig, getEnabledProjects } from "../core/config";
import { shallowClone, gitAdd, gitCommit, gitPush } from "../core/git";
import { compactContributions } from "../core/export-sync";
import { logger } from "../core/logger";
import type { ParsedArgs } from "../cli";

/**
 * Legacy cleanup: merge all of this dev's committed contribution files (merged or not)
 * into one deduped file per project. Not needed on every export — export already
 * compacts CI-merged files incrementally.
 */
export default async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const devName = config.global.devName;
  const projects = args.project ? [args.project] : getEnabledProjects(config);

  for (const project of projects) {
    try {
      const { remote } = resolveProjectConfig(config, project);
      if (!remote.autoMerge && !args.dryRun) {
        logger.warn(`Skipping "${project}": compact pushes directly and needs autoMerge: true.`);
        continue;
      }

      const repoDir = await shallowClone(remote);
      try {
        const r = compactContributions(repoDir, project, devName, { write: !args.dryRun });
        if (!r.written) {
          console.log(`${project}: nothing to compact.`);
          continue;
        }
        console.log(
          `${project}: ${r.removed.length} files, ${r.before} -> ${r.after} observations` +
            (args.dryRun ? " (dry run)" : ""),
        );
        if (args.dryRun) continue;

        await gitAdd(repoDir, [join("contributions", project, devName)]);
        await gitCommit(repoDir, `mem-sync: compact ${r.removed.length} contributions from ${devName} (${project})`);
        await gitPush(repoDir);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.error(`Compact failed for project "${project}"`, { error: String(err) });
    }
  }
}
