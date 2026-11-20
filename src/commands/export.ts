import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { loadConfig, resolveProjectConfig, getEnabledProjects } from "../core/config";
import { openMemDb, queryObservations, epochToIsoString } from "../core/mem-db";
import { openAccessDb, logExport } from "../core/access-db";
import { matchesFilter } from "../core/filter";
import { knownKeys, obsKey, mergedOwnFiles, compactContributions, formatTimestamp } from "../core/export-sync";
import {
  shallowClone,
  gitAdd,
  gitCommit,
  gitPush,
  gitCheckoutNewBranch,
  gitPushUpstream,
  createPullRequest,
  checkProviderCli,
  getProviderCliInfo,
} from "../core/git";
import { EXPORT_JSON_VERSION, PACKAGE_VERSION } from "../core/constants";
import { logger } from "../core/logger";
import type { Observation, ExportFile } from "../types/observation";
import type { ParsedArgs } from "../cli";

export default async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const projectNames = resolveProjectNames(args, config);

  if (projectNames.length === 0) {
    logger.warn("No enabled projects found. Nothing to export.");
    return;
  }

  const accessDb = openAccessDb();

  for (const projectName of projectNames) {
    try {
      await exportProject(projectName, config, accessDb, args.dryRun ?? false);
    } catch (err) {
      logger.error(`Export failed for project "${projectName}"`, {
        error: String(err),
      });
    }
  }

  accessDb.close();
}

function resolveProjectNames(
  args: ParsedArgs,
  config: ReturnType<typeof loadConfig>,
): string[] {
  if (args.project) {
    return [args.project];
  }
  return getEnabledProjects(config);
}

async function exportProject(
  projectName: string,
  config: ReturnType<typeof loadConfig>,
  accessDb: ReturnType<typeof openAccessDb>,
  dryRun: boolean,
): Promise<void> {
  const resolved = resolveProjectConfig(config, projectName);

  logger.info(`Exporting project "${projectName}"`, {
    memProject: resolved.memProject,
    filters: resolved.export,
  });

  // Open claude-mem DB read-only
  const memDb = openMemDb(config.global.claudeMemDbPath);

  try {
    // Query and filter observations
    const allObs = queryObservations(memDb, resolved.memProject);
    const filtered = allObs.filter((obs) => matchesFilter(obs, resolved.export));

    logger.info(`Matched ${filtered.length} of ${allObs.length} observations`, {
      project: projectName,
    });

    if (filtered.length === 0) {
      logger.info(`No observations match export filters for "${projectName}". Skipping.`);
      return;
    }

    // Dry-run: print preview and return
    if (dryRun) {
      printPreview(projectName, resolved.export, filtered);
      return;
    }

    // Clone remote repo (removed again in finally; hourly runs must not leak temp dirs)
    const repoDir = await shallowClone(resolved.remote);
    try {
    const devName = config.global.devName;
    const contribDir = join(repoDir, "contributions", projectName, devName);

    // Self-healing: export only what the remote (contributions + merged) doesn't hold yet.
    const known = knownKeys(repoDir, projectName);
    const delta = filtered.filter((o) => !known.has(obsKey(o)));

    // Prune: compact our own CI-merged files into one (no retention wait; merged/ keeps
    // the keys "known", and compacting rather than deleting keeps cap-evicted ones known too).
    const compacted = compactContributions(repoDir, projectName, devName, {
      only: mergedOwnFiles(repoDir, projectName, devName),
    });

    const now = new Date();
    let relativePath = "";
    if (delta.length > 0) {
      const exportFile: ExportFile = {
        version: EXPORT_JSON_VERSION,
        exportedBy: devName,
        exportedAt: now.toISOString(),
        exportedAtEpoch: Math.floor(now.getTime() / 1000),
        project: projectName,
        packageVersion: PACKAGE_VERSION,
        filters: {
          types: resolved.export.types,
          keywords: resolved.export.keywords,
          tags: resolved.export.tags,
        },
        observations: delta,
        observationCount: delta.length,
      };
      relativePath = join("contributions", projectName, devName, `${formatTimestamp(now)}.json`);
      mkdirSync(contribDir, { recursive: true });
      writeFileSync(join(repoDir, relativePath), JSON.stringify(exportFile, null, 2), "utf-8");
      logger.info(`Wrote export file: ${relativePath} (${delta.length} new)`);
    }

    if (delta.length === 0 && !compacted.written) {
      console.log(`\nNo new observations for "${projectName}". Nothing to push.`);
      return;
    }

    // `git add <dir>` stages new files and deletions alike
    await gitAdd(repoDir, [join("contributions", projectName, devName)]);
    await gitCommit(
      repoDir,
      delta.length > 0
        ? `mem-sync: export ${delta.length} new observations from ${devName} (${projectName})` +
            (compacted.written ? ` [compacted ${compacted.removed.length} files]` : "")
        : `mem-sync: compact ${compacted.removed.length} merged contributions from ${devName} (${projectName})`,
    );

    let pushedTo: string;

    if (resolved.remote.autoMerge) {
      // Direct push
      await gitPush(repoDir);
      pushedTo = `${resolved.remote.repo}@${resolved.remote.branch}`;
      logger.info("Pushed directly to remote branch", { pushedTo });
    } else {
      // PR/MR workflow: check provider CLI, create branch, push, open PR/MR
      const cliAvailable = await checkProviderCli(resolved.remote.type);
      if (!cliAvailable) {
        const cliInfo = getProviderCliInfo(resolved.remote.type);
        throw new Error(
          `${cliInfo.name} is required for PR-based export but was not found. ` +
            `Install it from ${cliInfo.url} or set autoMerge: true.`,
        );
      }

      const dateStr = now.toISOString().slice(0, 10);
      const branchName = `mem-sync/${config.global.devName}/${dateStr}`;

      await gitCheckoutNewBranch(repoDir, branchName);
      await gitPushUpstream(repoDir, branchName);

      const prUrl = await createPullRequest(
        repoDir,
        `mem-sync: ${config.global.devName} export for ${projectName}`,
        [
          `## Memory Export`,
          ``,
          `- **Developer:** ${config.global.devName}`,
          `- **Project:** ${projectName}`,
          `- **Observations:** ${delta.length}`,
          `- **Exported at:** ${now.toISOString()}`,
          ``,
          `Auto-generated by claude-mem-sync.`,
        ].join("\n"),
        resolved.remote,
      );

      pushedTo = prUrl;
      logger.info("Created pull request / merge request", { url: prUrl });
    }

    // Log export to access.db
    if (delta.length > 0) logExport(accessDb, projectName, delta.length, relativePath, pushedTo);

    console.log(
      `\nExport complete for "${projectName}": ${delta.length} new observations -> ${pushedTo}`,
    );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  } finally {
    memDb.close();
  }
}


function printPreview(
  projectName: string,
  filters: { types: string[]; keywords: string[]; tags: string[] },
  observations: Observation[],
): void {
  console.log(`\nProject: ${projectName}`);
  console.log(
    `Filters: types=[${filters.types.join(", ")}] keywords=[${filters.keywords.join(", ")}] tags=[${filters.tags.join(", ")}]`,
  );
  console.log(`Matched: ${observations.length} observations\n`);

  const maxDisplay = 20;
  const displayed = observations.slice(0, maxDisplay);

  for (const obs of displayed) {
    const date = epochToIsoString(obs.created_at_epoch).slice(0, 10);
    console.log(`  #${obs.id} [${obs.type}] ${date} "${obs.title}"`);
  }

  if (observations.length > maxDisplay) {
    console.log(`  ... (${observations.length - maxDisplay} more)`);
  }

  const sizeBytes = new TextEncoder().encode(JSON.stringify(observations)).length;
  const sizeKb = (sizeBytes / 1024).toFixed(1);
  console.log(`\nTotal export size: ~${sizeKb} KB`);
}
