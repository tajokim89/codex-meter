import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateSessions, estimateCosts, parseArgs, parseSince } from '../src/cli.mjs';

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
