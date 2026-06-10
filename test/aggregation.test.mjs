import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateSessions,
  applyBudgetStatus,
  buildCodexLeaderCommand,
  buildCodexShimScript,
  codexShimPath,
  csvEscape,
  estimateCosts,
  exitCodeFromSignal,
  fitTerminalLine,
  formatCompact,
  formatCsv,
  isValidMarkerName,
  loadBudgetConfig,
  loadMarkers,
  parseArgs,
  parseSince,
  resolveCodexBinaryForIntegration,
  resolveCodexCommand,
  saveBudgetConfig,
  saveMarkers,
  selectLaunchMode,
  shouldDefaultLaunch,
  removeManagedShellIntegrationText,
  upsertShellIntegrationText,
  upsertCodexStatusLineText,
} from '../src/cli.mjs';

function emptyTestUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    events: 0,
  };
}

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

test('aggregates and estimates usage by project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-meter-projects-'));
  const sessions = join(root, 'sessions', '2026', '06', '10');
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, 'rollout.jsonl');
  await writeFile(file, [
    JSON.stringify({
      timestamp: '2026-06-10T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        cwd: '/tmp/alpha',
        model: 'gpt-a',
        git: { repository_url: 'https://github.com/acme/alpha.git' },
      },
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
      type: 'turn_context',
      payload: { model: 'gpt-b', cwd: '/tmp/beta' },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T00:03:00.000Z',
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
  assert.deepEqual(
    summary.byProjectModel.map((row) => [row.project, row.model, row.totalTokens]),
    [['alpha', 'gpt-a', 110], ['beta', 'gpt-b', 40]],
  );

  const estimated = estimateCosts(summary, {
    source: 'test',
    path: 'test',
    rawCount: 2,
    models: new Map([
      ['gpt-a', {
        name: 'gpt-a',
        inputCostPerToken: 0.000001,
        cachedInputCostPerToken: 0.0000001,
        outputCostPerToken: 0.000002,
      }],
      ['gpt-b', {
        name: 'gpt-b',
        inputCostPerToken: 0.000002,
        cachedInputCostPerToken: 0.000001,
        outputCostPerToken: 0.000004,
      }],
    ]),
  });

  assert.deepEqual(
    estimated.byProject.map((row) => [row.project, row.totalTokens]),
    [['beta', 40], ['alpha', 110]],
  );
  assert.equal(estimated.byProject[0].costUsd.toFixed(6), '0.000090');
  assert.equal(estimated.byProject[1].costUsd.toFixed(6), '0.000084');
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

test('passes codex args after separator without interpreting them', () => {
  const parsed = parseArgs([
    'since',
    '2026-06-10',
    '--',
    '--model',
    'gpt-5',
    'resume',
    '--last',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);

  assert.deepEqual(parsed.commandArgs, ['since', '2026-06-10']);
  assert.equal(shouldDefaultLaunch(parsed), true);
  assert.deepEqual(parsed.options.codexArgs, [
    '--model',
    'gpt-5',
    'resume',
    '--last',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
});

test('passes unknown options and positional args to codex without separator', () => {
  const model = parseArgs(['since', '2026-06-10', '--model', 'gpt-5', '--reasoning-effort', 'high']);
  assert.equal(shouldDefaultLaunch(model), true);
  assert.deepEqual(model.options.codexArgs, ['--model', 'gpt-5', '--reasoning-effort', 'high']);

  const resume = parseArgs(['since', '2026-06-10', 'resume', '--last']);
  assert.equal(shouldDefaultLaunch(resume), true);
  assert.deepEqual(resume.options.codexArgs, ['resume', '--last']);

  const exec = parseArgs(['launch', 'since', '2026-06-10', 'exec', '--sandbox', 'workspace-write', 'echo ok']);
  assert.equal(exec.options.launch, true);
  assert.deepEqual(exec.options.codexArgs, ['exec', '--sandbox', 'workspace-write', 'echo ok']);

  const arbitrary = parseArgs(['since', '2026-06-10', 'future-command', '--future-flag', 'value']);
  assert.equal(shouldDefaultLaunch(arbitrary), true);
  assert.deepEqual(arbitrary.options.codexArgs, ['future-command', '--future-flag', 'value']);
});

test('plain since launches by default but output modes stay report-only', () => {
  const plain = parseArgs(['since', '2026-06-10']);
  assert.equal(shouldDefaultLaunch(plain), true);

  const resume = parseArgs(['since', '2026-06-10', 'resume']);
  assert.equal(shouldDefaultLaunch(resume), true);
  assert.deepEqual(resume.options.codexArgs, ['resume']);

  const status = parseArgs(['since', '2026-06-10', '--status']);
  assert.equal(shouldDefaultLaunch(status), false);

  const explicitLaunch = parseArgs(['launch', 'since', '2026-06-10']);
  assert.equal(shouldDefaultLaunch(explicitLaunch), false);

  const tmuxPane = parseArgs(['since', '2026-06-10', '--tmux']);
  assert.equal(shouldDefaultLaunch(tmuxPane), false);
});

test('parses new commands and output flags', () => {
  const budget = parseArgs(['budget', '--daily', '10', '--weekly', '50']);
  assert.deepEqual(budget.budget.set, { daily: 10, weekly: 50 });

  const budgetStatus = parseArgs(['budget', '--status']);
  assert.equal(budgetStatus.budget.status, true);

  const doctor = parseArgs(['doctor']);
  assert.equal(doctor.doctor, true);

  const marker = parseArgs(['since-mark', 'sprint-24', '--models', '--projects', '--csv']);
  assert.equal(marker.sinceMarkName, 'sprint-24');
  assert.equal(marker.options.models, true);
  assert.equal(marker.options.projects, true);
  assert.equal(marker.options.csv, true);

  const mark = parseArgs(['mark', 'sprint-24']);
  assert.equal(mark.markerAction, 'mark');
  assert.equal(mark.markerName, 'sprint-24');
});

test('selects pty footer launch mode by default even when tmux is available', () => {
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: null, stdinIsTTY: true, stdoutIsTTY: true }),
    { kind: 'pty-footer' },
  );
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: '/opt/homebrew/bin/tmux', stdinIsTTY: true, stdoutIsTTY: true }),
    { kind: 'pty-footer' },
  );
  assert.deepEqual(
    selectLaunchMode({
      tmuxBin: '/opt/homebrew/bin/tmux',
      stdinIsTTY: true,
      stdoutIsTTY: true,
      forceTmux: true,
    }),
    { kind: 'tmux', tmuxBin: '/opt/homebrew/bin/tmux' },
  );
  assert.deepEqual(
    selectLaunchMode({ tmuxBin: null, stdinIsTTY: true, stdoutIsTTY: true, forceTmux: true }),
    { kind: 'tmux-unavailable' },
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

test('formats compact budget/model output as one line', () => {
  const summary = applyBudgetStatus({
    since: '2026-06-10',
    total: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 110,
      events: 1,
    },
    byModel: [
      {
        model: 'gpt-a',
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 110,
        events: 1,
        costUsd: 12,
      },
    ],
    cost: { usd: 12, pricedTokens: 110, unpricedTokens: 0, partial: false },
  }, { budgets: { daily: 10 } });

  const line = formatCompact(summary, { models: true, maxCols: 200 });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /budget daily \$12\.0000\/\$10\.0000/);
  assert.match(line, /top gpt-a \$12\.0000/);
});

test('stores budgets and calculates warnings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-meter-budget-'));
  const configPath = join(root, 'config.json');
  await saveBudgetConfig(configPath, { budgets: { daily: 5, weekly: 25 } });
  const config = await loadBudgetConfig(configPath);
  assert.deepEqual(config.budgets, { daily: 5, weekly: 25 });

  const summary = applyBudgetStatus({
    cost: { usd: 8 },
    total: emptyTestUsage(),
  }, config);
  assert.equal(summary.budget.warning, true);
  assert.deepEqual(summary.budget.exceeded.map((row) => row.period), ['daily']);
});

test('formats CSV with escaped fields and optional breakdowns', () => {
  assert.equal(csvEscape('a,"b"'), '"a,""b"""');
  const csv = formatCsv({
    since: '2026-06-10',
    total: {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
    },
    cost: { usd: 0.5, pricedTokens: 12, partial: false },
    byModel: [
      {
        model: 'gpt,a',
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 12,
        costUsd: 0.5,
        priceMissing: false,
      },
    ],
    byProject: [
      {
        project: 'repo "one"',
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 12,
        costUsd: 0.5,
        priceMissing: false,
      },
    ],
  }, { models: true, projects: true });

  assert.match(csv, /^type,name,model,project,since,total_tokens/m);
  assert.match(csv, /model,"gpt,a","gpt,a",/);
  assert.match(csv, /project,"repo ""one""",,"repo ""one"""/);
});

test('stores markers and validates marker names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-meter-markers-'));
  const markersPath = join(root, 'markers.json');
  await saveMarkers(markersPath, {
    markers: {
      sprint_24: {
        name: 'sprint_24',
        since: '2026-06-10',
        createdAt: '2026-06-10T00:00:00.000Z',
      },
    },
  });
  const markers = await loadMarkers(markersPath);
  assert.equal(markers.markers.sprint_24.since, '2026-06-10');
  assert.equal(isValidMarkerName('sprint-24'), true);
  assert.equal(isValidMarkerName('../sprint'), false);
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
    '--shim-dir',
    '/tmp/codex-meter-bin',
    '--shell',
    'since',
    '2026-06-10',
  ]);

  assert.equal(parsed.setup, true);
  assert.equal(parsed.options.shellIntegration, true);
  assert.equal(parsed.options.shellFile, '/tmp/.zshrc');
  assert.equal(parsed.options.shimDir, '/tmp/codex-meter-bin');
  assert.deepEqual(parsed.options.shellCommandArgs, ['since', '2026-06-10']);

  const removeParsed = parseArgs(['setup', '--remove-shell']);
  assert.equal(removeParsed.options.removeShellIntegration, true);
  assert.equal(removeParsed.options.shellIntegration, false);

  const noShellParsed = parseArgs(['setup', '--no-shell']);
  assert.equal(noShellParsed.options.noShellIntegration, true);
  assert.equal(noShellParsed.options.shellIntegration, false);
});

test('upserts and removes managed shell wrapper block', () => {
  const first = upsertShellIntegrationText('export EDITOR=vim\n', ['since', '2026-06-10'], {
    shimDir: '/tmp/codex-meter-bin',
    codexBin: '/usr/local/bin/codex',
  });
  assert.match(first, /export PATH="\$_codex_meter_bin_dir:\$PATH"/);
  assert.match(first, /codex\(\) \{\n  env CODEX_METER_CODEX_BIN='\/usr\/local\/bin\/codex' codex-meter launch 'since' '2026-06-10' -- "\$@"/);

  const second = upsertShellIntegrationText(first, ['today'], {
    shimDir: '/tmp/codex-meter-bin',
    codexBin: '/usr/local/bin/codex',
  });
  assert.equal((second.match(/codex-meter codex wrapper/g) ?? []).length, 2);
  assert.doesNotMatch(second, /2026-06-10/);
  assert.match(second, /codex-meter launch 'today' -- "\$@"/);

  const removed = removeManagedShellIntegrationText(second);
  assert.equal(removed, 'export EDITOR=vim\n');
});

test('managed codex shim preserves codex subcommands including resume', () => {
  const script = buildCodexShimScript({
    commandArgs: ['since', '2026-06-10'],
    codexBin: '/usr/local/bin/codex',
  });

  assert.match(script, /codex-meter:managed-codex-shim/);
  assert.match(script, /export CODEX_METER_CODEX_BIN='\/usr\/local\/bin\/codex'/);
  assert.match(script, /exec codex-meter launch 'since' '2026-06-10' -- "\$@"/);

  const leaderCommand = buildCodexLeaderCommand(['resume'], 'session-name', '/usr/bin/tmux', '/usr/local/bin/codex');
  assert.match(leaderCommand, /usr\/local\/bin\/codex/);
  assert.match(leaderCommand, /resume/);
  assert.match(leaderCommand, /clear 2>\/dev\/null/);
});

test('resolves real codex binary while skipping managed shim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-meter-shim-'));
  const shimDir = join(root, 'shim-bin');
  const realDir = join(root, 'real-bin');
  await mkdir(shimDir, { recursive: true });
  await mkdir(realDir, { recursive: true });
  await writeFile(codexShimPath(shimDir), buildCodexShimScript({
    commandArgs: ['today'],
    codexBin: join(realDir, 'codex'),
  }));
  await writeFile(join(realDir, 'codex'), '#!/bin/sh\n');

  const resolved = resolveCodexBinaryForIntegration({
    shimDir,
    env: { PATH: [shimDir, realDir].join(delimiter) },
  });
  assert.equal(resolved, join(realDir, 'codex'));
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
