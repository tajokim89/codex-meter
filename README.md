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

`--status` prints once and exits. For a live bottom-pane display under Codex,
run inside tmux:

```bash
tmux
codex-meter since 2026-06-10 --tmux
codex
```

This matches the OMX HUD approach: the live meter is a small tmux split pane,
not a custom Codex native footer item. It keeps updating by reading local
session logs and does not make model/API calls.

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
