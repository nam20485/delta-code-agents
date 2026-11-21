/** `--source` identity for every delta CLI call this plugin makes. */
export const DELTA_SOURCE = "delta-qwen";
/** `--producer-name` shown for our output in Delta transcripts. */
export const PRODUCER_NAME = "Qwen Code";
/** Tools whose disk edits are attributed to the call via `thread capture`. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "multi_file_edit",
  "rename_file",
  "run_shell_command",
]);
