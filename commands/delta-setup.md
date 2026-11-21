---
description: Choose this repo's Delta sync mode (private|team|manual)
---

!{node "$HOME/.qwen/delta/cli.js" setup {{args}}}

If no mode was given, explain the three modes (private: only you until shared;
team: shared with your org; manual: only on /delta-share) and ask which to use.
Otherwise confirm the chosen mode in one line.
