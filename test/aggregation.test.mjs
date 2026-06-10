import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateSessions,
  estimateCosts,
  exitCodeFromSignal,
  fitTerminalLine,
  parseArgs,
  parseSince,
  resolveCodexCommand,
  selectLaunchMode,
  removeManagedShellIntegrationText,
  upsertShellIntegrationText,
  upsertCodexStatusLineText,
} from '../src/cli.mjs';

test('aggregates token_count deltas by model and skips duplicate totals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-meter-'));
  const sessions = join(root, 'sessions', '2026', '06', '10');
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, 'rollout.jsonl');
  await writeFile(file, [
    JSON.stringify({
      timestamp: '2026-06-10T00:00:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-a' },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 110,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T00:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 110,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T00:03:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-b' },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T00:04:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 130,
            cached_input_tokens: 50,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 150,
          },
        },
      },
    }),
    '',
  ].join('\n'));

  const summary = await aggregateSessions({
    sessionsDir: join(root, 'sessions'),
    since: parseSince('2026-06-10'),
  });

  assert.equal(summary.total.inputTokens, 130);
  assert.equal(summary.total.cachedInputTokens, 50);
  assert.equal(summary.total.outputTokens, 20);
  assert.equal(summary.total.totalTokens, 150);
  assert.deepEqual(
    summary.byModel.map((row) => [row.model, row.totalTokens]),
    [['gpt-a', 110], ['gpt-b', 40]],
  );
});

test('estimates costs for every priced model and marks missing prices partial', () => {
  const summary = {
    total: {
      inputTokens: 300,
      cachedInputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalTokens: 350,
      events: 2,
    },
    byModel: [
      {
        model: 'gpt-a',
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 110,
        events: 1,
      },
      {
        model: 'gpt-missing',
        inputTokens: 200,
        cachedInputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 8,
        totalTokens: 240,
        events: 1,
      },
    ],
  };
  const priceBook = {
    source: 'test',
    path: 'test',
    rawCount: 1,
    models: new Map([
      ['gpt-a', {
        name: 'gpt-a',
        inputCostPerToken: 0.000001,
        cachedInputCostPerToken: 0.0000001,
        outputCostPerToken: 0.000002,
      }],
    ]),
  };

  const estimated = estimateCosts(summary, priceBook);
  assert.equal(estimated.byModel.length, 2);
  assert.equal(estimated.byModel[0].costUsd, 0.000084);
  assert.equal(estimated.byModel[1].priceMissing, true);
  assert.equal(estimated.cost.partial, true);
  assert.equal(estimated.cost.unpricedTokens, 240);
});

test('parses tmux bottom pane options', () => {
  const parsed = parseArgs([
    'since',
    '2026-06-10',
    '--tmux',
    '--tmux-height',
    '3',
    '--interval',
    '5',
  ]);

  assert.deepEqual(parsed.commandArgs, ['since', '2026-06-10']);
  assert.equal(parsed.options.tmux, true);
  assert.equal(parsed.options.tmuxHeight, 3);
  assert.equal(parsed.options.interval, 5);
});

test('parses managed launch and codex passthrough args', () => {
  const parsed = parseArgs([
    'launch',
    'since',
    '2026-06-10',
    '--interval',
    '3',
    '--',
    '--model',
    'gpt-5',
  ]);

  assert.deepEqual(parsed.commandArgs, ['since', '2026-06-10']);
  assert.equal(parsed.options.launch, true);
  assert.equal(parsed.options.interval, 3);
  assert.deepEqual(parsed.options.codexArgs, ['--model', 'gpt-5']);
});

test('selects pty footer launch mode when tmux is unavailable in a tty', () => {
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: null, stdinIsTTY: true, stdoutIsTTY: true }),
    { kind: 'pty-footer' },
  );
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: '/opt/homebrew/bin/tmux', stdinIsTTY: true, stdoutIsTTY: true }),
    { kind: 'tmux', tmuxBin: '/opt/homebrew/bin/tmux' },
  );
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: null, stdinIsTTY: false, stdoutIsTTY: true }),
    { kind: 'unsupported' },
  );
});

test('formats pty footer lines to exactly one terminal row', () => {
  assert.equal(fitTerminalLine('abc', 5), 'abc  ');
  assert.equal(fitTerminalLine('abcdef', 5), 'abcde');
  assert.equal(fitTerminalLine('a\nb\rc', 5), 'a b c');
  assert.equal(exitCodeFromSignal('SIGINT'), 130);
});

test('resolves codex command with test override', () => {
  assert.equal(resolveCodexCommand({}), 'codex');
  assert.equal(resolveCodexCommand({ CODEX_METER_CODEX_BIN: '/bin/sh' }), '/bin/sh');
  assert.equal(resolveCodexCommand({ CODEX_METER_CODEX_BIN: '   ' }), 'codex');
});

test('parses setup command config option', () => {
  const parsed = parseArgs(['setup', '--config', '/tmp/codex-config.toml']);

  assert.equal(parsed.setup, true);
  assert.equal(parsed.options.configPath, '/tmp/codex-config.toml');
  assert.equal(parsed.options.shellIntegration, true);
  assert.match(parsed.options.shellCommandArgs[1], /^\d{4}-\d{2}-\d{2}$/);
});

test('parses setup shell wrapper options', () => {
  const parsed = parseArgs([
    'setup',
    '--shell-file',
    '/tmp/.zshrc',
    '--shell',
    'since',
    '2026-06-10',
  ]);

  assert.equal(parsed.setup, true);
  assert.equal(parsed.options.shellIntegration, true);
  assert.equal(parsed.options.shellFile, '/tmp/.zshrc');
  assert.deepEqual(parsed.options.shellCommandArgs, ['since', '2026-06-10']);

  const removeParsed = parseArgs(['setup', '--remove-shell']);
  assert.equal(removeParsed.options.removeShellIntegration, true);
  assert.equal(removeParsed.options.shellIntegration, false);

  const noShellParsed = parseArgs(['setup', '--no-shell']);
  assert.equal(noShellParsed.options.noShellIntegration, true);
  assert.equal(noShellParsed.options.shellIntegration, false);
});

test('upserts and removes managed shell wrapper block', () => {
  const first = upsertShellIntegrationText('export EDITOR=vim\n', ['since', '2026-06-10']);
  assert.match(first, /codex\(\) \{\n  command codex-meter launch 'since' '2026-06-10' -- "\$@"/);

  const second = upsertShellIntegrationText(first, ['today']);
  assert.equal((second.match(/codex-meter codex wrapper/g) ?? []).length, 2);
  assert.doesNotMatch(second, /2026-06-10/);
  assert.match(second, /command codex-meter launch 'today' -- "\$@"/);

  const removed = removeManagedShellIntegrationText(second);
  assert.equal(removed, 'export EDITOR=vim\n');
});

test('setup merges codex status line into existing tui table', () => {
  const updated = upsertCodexStatusLineText([
    'model = "gpt-5"',
    '',
    '[tui]',
    'theme = "night"',
    'status_line = ["git-branch"]',
    '',
    '[features]',
    'hooks = true',
    '',
  ].join('\n'));

  assert.match(updated, /\[tui\]\ntheme = "night"\n# codex-meter:managed-status-line\nstatus_line = \["git-branch", "model-with-reasoning"/);
  assert.match(updated, /\[features\]\nhooks = true/);
});
