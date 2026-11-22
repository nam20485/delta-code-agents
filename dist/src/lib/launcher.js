import { join, dirname } from "node:path";
import { atomicWriteFile, readText } from "./fsx.js";
import { launcherPath } from "./paths.js";
/**
 * Maintain `~/.qwen/delta/cli.js`, the stable entrypoint slash commands call.
 * `!{}` runs in the session cwd and command markdown gets no runtime path
 * hydration, so commands reference this fixed user-level path; the dispatcher
 * knows its own hydrated location and refreshes the launcher on every event.
 */
export function ensureLauncher(hookJsPath) {
    const target = join(dirname(hookJsPath), "cli.js");
    const content = `#!/usr/bin/env node
// Maintained by the delta-qwen hook dispatcher from the extension's hydrated
// path. Do not edit by hand.
const target = ${JSON.stringify(target)};
(async () => {
  try {
    await import(require("node:url").pathToFileURL(target).href);
  } catch (err) {
    console.error("delta-qwen: launcher target is missing: " + target);
    console.error("The extension was moved or uninstalled. Reinstall or relink");
    console.error("it (qwen extensions install | link <repo>) and run one Qwen");
    console.error("session so the Delta hooks can refresh this launcher.");
    process.exit(1);
  }
})();
`;
    const path = launcherPath();
    if (readText(path) === content)
        return;
    atomicWriteFile(path, content, 0o755);
}
