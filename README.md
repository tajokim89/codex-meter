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
codex-meter since 2026-06-10 --watch --status
codex-meter since 2026-06-10 --tmux
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
there, so `setup` also installs a managed shell wrapper that makes the normal
`codex` command start with the live since/cost meter automatically.

By default, the wrapper starts counting from the date when `setup` is run. For
example, if you run setup on June 10, 2026, it writes this managed shell function
to your detected shell rc file, usually `~/.zshrc`:

```sh
codex() {
  command codex-meter launch since 2026-06-10 -- "$@"
}
```

Open a new terminal, then use Codex normally:

```bash
codex
codex --model gpt-5
```

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

## Cost Estimates

Costs are estimated per model. The tool tracks the active model from each
session's `turn_context` event and applies the matching LiteLLM price entry for
that model. Every model found in the logs is grouped and calculated
independently.

Use `--details` to show every model group:

```bash
codex-meter since 2026-06-10 --details
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

`--status` prints once and exits. It does not inject text into Codex's native
footer. For a live bottom-pane display under Codex, launch Codex through
`codex-meter`:

```bash
codex-meter launch since 2026-06-10
```

When `tmux` or `psmux` is available, `codex-meter` creates a managed session,
starts Codex in the main pane, and starts the live meter in a small bottom pane.
You do not need to run `tmux` yourself.

When no terminal multiplexer is installed, `codex-meter launch` uses a PTY
wrapper instead of falling back to plain `codex`. Codex runs normally in the top
part of the terminal, and `codex-meter` reserves the last terminal row for a
continuously updating local-only since/cost meter.

The no-tmux wrapper uses `node-pty` because Codex is a full-screen terminal UI.
PTY support is what lets `codex-meter` pass input through normally, resize the
child terminal, preserve Codex's exit code, and draw a separate footer row
without injecting text into the Codex conversation.

Pass Codex arguments after `--` when needed:

```bash
codex-meter launch since 2026-06-10 -- --model gpt-5
```

If you are already inside a tmux session and only want to add the bottom pane,
use:

```bash
codex-meter since 2026-06-10 --tmux
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
