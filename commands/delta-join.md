---
description: Join a shared Delta thread in its checkout
---

!{DELTA_QWEN_ARGS={{args}} node "$HOME/.qwen/delta/cli.js" join --from-env}

If a checkout directory is printed, tell the user to run `/cd <directory>` to
move this session into the thread's files. If no link was given, ask for the
Delta thread link. Report errors in one line.
