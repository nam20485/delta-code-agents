---
description: Share this session to your team (or invite emails)
---

!{DELTA_QWEN_ARGS={{args}} node "$HOME/.qwen/delta/cli.js" share --from-env}

If the output asks for consent, tell the user exactly what will be uploaded and
ask them to run `/delta-share confirm` (or `/delta-share confirm <email>` to
invite specific people). Otherwise report the thread link in one line.
