// Run by `bun install` ("prepare"): point git at the tracked hooks in .githooks/.
// Skips quietly outside a git checkout (a tarball, a CI cache restore), and
// fails loudly if git refuses, so a checkout never looks protected when it is not.
const inRepo = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
if (inRepo.exitCode === 0 && inRepo.stdout.toString().trim() === "true") {
  const set = Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], { stderr: "pipe" });
  if (set.exitCode !== 0) {
    console.error(`Could not install the git hooks (git config core.hooksPath .githooks): ${set.stderr.toString().trim()}`);
    process.exit(1);
  }
}
