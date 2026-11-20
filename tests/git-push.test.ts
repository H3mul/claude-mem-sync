import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitPush } from "../src/core/git";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString();

test("push retries after rebase when the remote moved since the shallow clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "gp-"));
  const bare = join(root, "bare.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, seed);
  writeFileSync(join(seed, "a"), "a");
  git(seed, "add", "."); git(seed, "commit", "-qm", "a"); git(seed, "push", "-q", "origin", "HEAD:main");

  const mine = join(root, "mine");
  git(root, "clone", "-q", "--depth", "1", "--branch", "main", `file://${bare}`, mine);
  // another writer (CI bot / other host) pushes first
  writeFileSync(join(seed, "b"), "b");
  git(seed, "add", "."); git(seed, "commit", "-qm", "b"); git(seed, "push", "-q", "origin", "HEAD:main");

  writeFileSync(join(mine, "c"), "c");
  git(mine, "add", "."); git(mine, "commit", "-qm", "c");
  await gitPush(mine); // would throw without the rebase retry

  const check = join(root, "check");
  git(root, "clone", "-q", bare, check);
  expect(["a", "b", "c"].every((f) => existsSync(join(check, f)))).toBe(true);
});
