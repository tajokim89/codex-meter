# codex-meter

Local, zero-token Codex usage monitor with cached cost estimates.

`codex-meter` reads local Codex session logs from `~/.codex/sessions/**/*.jsonl`.
It does not call a model, does not send prompts to Codex, and does not spend
tokens while monitoring usage.

## Usage

Install:

```bash
npm install -g codex-meter
```

Run:

```bash
codex-meter setup
codex-meter launch since 2026-06-10
codex-meter since 2026-06-10
codex-meter since 2026-06-10 --status
codex-meter since 2026-06-10 --models --projects
codex-meter since 2026-06-10 --csv
codex-meter since 2026-06-10 --watch --status
codex-meter since 2026-06-10 --tmux
codex-meter budget --daily 10 --weekly 50
codex-meter doctor
codex-meter mark sprint-24
codex-meter since-mark sprint-24 --status
codex-meter today
codex-meter week
```

Install from a local checkout before publishing:

```bash
npm install -g .
```

Publish the package:

```bash
npm publish
```

`package.json` sets `publishConfig.access = "public"`, so after publishing the
end-user install command is just `npm install -g codex-meter`.

Compact output:

```text
since 2026-06-10 | tokens 639.4k | cached 564.2k | uncached 68.3k | est $0.4200
```

## Codex Setup

Run setup once after installing:

```bash
codex-meter setup
```

This configures Codex's built-in `[tui].status_line` with token and limit items
similar to OMX setup. Codex owns that footer and only supports built-in item IDs
there, so `setup` also installs a managed `codex` shim plus a shell wrapper that
makes the normal `codex` command start with the live since/cost meter
automatically.

By default, the wrapper starts counting from the date when `setup` is run. For
example, if you run setup on June 10, 2026, it writes this managed shell
function to your detected shell rc file, usually `~/.zshrc`, and prepends the
managed shim directory to `PATH`:

```sh
codex() {
  env CODEX_METER_CODEX_BIN=/path/to/real/codex codex-meter launch since 2026-06-10 -- "$@"
}
```

Open a new terminal, then use Codex normally:

```bash
codex
codex resume
codex --model gpt-5
```

The shim is installed at `~/.local/share/codex-meter/bin/codex` by default. It
passes every argument from `codex ...` through to the real Codex CLI, so
subcommands such as `codex resume` continue to work while the meter stays
attached.

To change the default meter start date and launch Codex immediately:

```bash
codex-meter since 2026-06-10
```

That updates the managed `codex` wrapper, so later `codex`, `codex resume`, and
other Codex arguments keep using that same meter range. After the meter range,
Codex subcommands, prompts, and options can be written naturally:

```bash
codex-meter since 2026-06-10 resume
codex-meter since 2026-06-10 resume --last
codex-meter since 2026-06-10 --model gpt-5
codex-meter since 2026-06-10 exec "npm test"
```

`--` still works as an optional separator if you want to force everything after
it to Codex, but unknown options and positional args are already forwarded to
Codex without needing the separator.

To choose a different start date during setup:

```bash
codex-meter setup --shell since 2026-06-10
```

To configure only Codex's built-in status line and skip the shell wrapper:

```bash
codex-meter setup --no-shell
```

To remove only the shell wrapper:

```bash
codex-meter setup --remove-shell
```

That also removes the managed shim. It does not uninstall Codex or codex-meter.

## Cost Estimates

Costs are estimated per model. The tool tracks the active model from each
session's `turn_context` event and applies the matching LiteLLM price entry for
that model. Every model found in the logs is grouped and calculated
independently.

Use `--details` to show every model group:

```bash
codex-meter since 2026-06-10 --details
codex-meter since 2026-06-10 --models
codex-meter since 2026-06-10 --projects
```

By default, pricing is read only from the local cache:

```text
~/.cache/codex-meter/prices.litellm.json
```

Refresh it explicitly when you want current LiteLLM prices:

```bash
codex-meter since 2026-06-10 --refresh-prices
```

Price refresh is an HTTP request to LiteLLM's public price JSON. It is not a
model call and does not use tokens.

If a model is missing from the cached price file, the output marks the estimate
as partial and lists that model with `price missing`.

For scripts or status bars, use:

```bash
codex-meter since 2026-06-10 --status
```

For CSV export:

```bash
codex-meter since 2026-06-10 --csv
codex-meter since 2026-06-10 --models --projects --csv
```

## Budgets

Set local budget guardrails:

```bash
codex-meter budget --daily 10
codex-meter budget --weekly 50
codex-meter budget --monthly 150
codex-meter budget --status
codex-meter budget --clear
```

Budgets are stored in `~/.config/codex-meter/config.json`. When estimated spend
exceeds a configured budget, compact output and the live footer include a budget
warning. The PTY footer uses a warning style when the terminal supports it.

## Markers

Create named reset points so you do not have to remember dates:

```bash
codex-meter mark sprint-24
codex-meter marks
codex-meter since-mark sprint-24 --status
codex-meter remove-mark sprint-24
```

Markers are stored in `~/.config/codex-meter/markers.json`.

## Doctor

Run a read-only diagnostic:

```bash
codex-meter doctor
```

Doctor checks Node, the Codex and codex-meter binaries, shell wrapper,
Codex status line config, session logs, price cache JSON, and node-pty spawn
support.

`--status` prints once and exits. It does not inject text into Codex's native
footer. For a live bottom-pane display under Codex, launch Codex through
`codex-meter`:

```bash
codex-meter launch since 2026-06-10
```

By default, `codex-meter launch` uses a PTY wrapper even when `tmux` or `psmux`
is installed. Codex runs normally in the top part of the terminal, and
`codex-meter` reserves the last terminal row for a continuously updating
local-only since/cost meter.

The no-tmux wrapper uses `node-pty` because Codex is a full-screen terminal UI.
PTY support is what lets `codex-meter` pass input through normally, resize the
child terminal, preserve Codex's exit code, and draw a separate footer row
without injecting text into the Codex conversation.
When Codex exits, the wrapper restores the terminal and clears the screen once
so the previous full-screen session does not remain behind.

Pass Codex arguments after `--` when needed:

```bash
codex-meter launch since 2026-06-10 -- --model gpt-5
```

If you are already inside a tmux session and only want to add the bottom pane,
use:

```bash
codex-meter since 2026-06-10 --tmux
```

To force the older managed tmux launch mode, pass `--tmux` to `launch`:

```bash
codex-meter launch since 2026-06-10 --tmux
```

For a live inline display in the current terminal, use:

```bash
codex-meter since 2026-06-10 --watch --status
```

## Notes

- Token aggregation uses cumulative `total_token_usage` deltas, which avoids
  double-counting duplicate `token_count` events.
- Cached input tokens are charged with LiteLLM's cached-input price when that
  field exists. If not, they fall back to the normal input price and the JSON
  output notes the fallback.
- `reasoning_output_tokens` are shown separately but not charged twice, because
  they are part of output token accounting.
- This is intentionally standalone and does not depend on OMX.
