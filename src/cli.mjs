#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_PRICE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const DEFAULT_PRICE_CACHE = join(homedir(), '.cache', 'codex-meter', 'prices.litellm.json');
const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const DEFAULT_TMUX_HEIGHT = 2;
const UNKNOWN_MODEL = 'unknown';

function usage() {
  return [
    'Usage:',
    '  codex-meter since YYYY-MM-DD [--watch] [--status] [--json]',
    '  codex-meter today [--watch] [--status] [--json]',
    '  codex-meter week [--watch] [--status] [--json]',
    '',
    'Options:',
    '  --sessions-dir PATH     Codex sessions directory (default: ~/.codex/sessions)',
    '  --prices PATH           LiteLLM price cache JSON (default: ~/.cache/codex-meter/prices.litellm.json)',
    '  --refresh-prices        Refresh LiteLLM price cache over HTTP, then calculate',
    '  --price-url URL         Override LiteLLM-compatible price JSON URL',
    '  --watch                 Recalculate continuously without model/API calls',
    '  --interval SECONDS      Watch interval (default: 2)',
    '  --status                Print one compact line',
    '  --tmux                  Open a bottom tmux pane and run live compact status there',
    '  --tmux-height LINES     Bottom tmux pane height (default: 2)',
    '  --json                  Print machine-readable JSON',
    '  --details               Include per-model rows in text output',
    '  --help                  Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    sessionsDir: DEFAULT_SESSIONS_DIR,
    pricePath: DEFAULT_PRICE_CACHE,
    priceUrl: DEFAULT_PRICE_URL,
    refreshPrices: false,
    watch: false,
    interval: 2,
    status: false,
    tmux: false,
    tmuxHeight: DEFAULT_TMUX_HEIGHT,
    json: false,
    details: false,
  };

  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    return { help: true, options };
  }

  let sinceArg = null;
  if (command === 'since') {
    sinceArg = args.shift();
    if (!sinceArg) {
      throw new Error('since requires YYYY-MM-DD');
    }
  } else if (command === 'today' || command === 'week') {
    sinceArg = command;
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  const commandArgs = command === 'since' ? ['since', sinceArg] : [command];

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--sessions-dir':
        options.sessionsDir = requireValue(arg, args);
        break;
      case '--prices':
        options.pricePath = requireValue(arg, args);
        break;
      case '--price-url':
        options.priceUrl = requireValue(arg, args);
        break;
      case '--refresh-prices':
        options.refreshPrices = true;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--interval':
        options.interval = Number(requireValue(arg, args));
        if (!Number.isFinite(options.interval) || options.interval <= 0) {
          throw new Error('--interval must be a positive number');
        }
        break;
      case '--status':
        options.status = true;
        break;
      case '--tmux':
        options.tmux = true;
        break;
      case '--tmux-height':
        options.tmuxHeight = Number(requireValue(arg, args));
        if (!Number.isInteger(options.tmuxHeight) || options.tmuxHeight <= 0) {
          throw new Error('--tmux-height must be a positive integer');
        }
        break;
      case '--json':
        options.json = true;
        break;
      case '--details':
        options.details = true;
        break;
      case '--help':
      case '-h':
        return { help: true, options };
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return { since: parseSince(sinceArg), options, commandArgs };
}

function requireValue(flag, args) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseSince(value) {
  const now = new Date();
  if (value === 'today') {
    return {
      label: formatDateLocal(now),
      date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    };
  }
  if (value === 'week') {
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    return {
      label: 'week',
      date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset),
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('date must be YYYY-MM-DD');
  }
  const [year, month, day] = value.split('-').map(Number);
  return {
    label: value,
    date: new Date(year, month - 1, day),
  };
}

function formatDateLocal(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function listSessionFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }));
  }
  await walk(resolve(root));
  files.sort();
  return files;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    events: 0,
  };
}

function addUsage(target, usage) {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  target.events += usage.events ?? 0;
}

function normalizeUsage(raw) {
  return {
    inputTokens: numberOrZero(raw?.input_tokens),
    cachedInputTokens: numberOrZero(raw?.cached_input_tokens),
    outputTokens: numberOrZero(raw?.output_tokens),
    reasoningOutputTokens: numberOrZero(raw?.reasoning_output_tokens),
    totalTokens: numberOrZero(raw?.total_tokens),
    events: 1,
  };
}

function usageDelta(previousRaw, currentRaw, fallbackRaw) {
  const current = normalizeUsage(currentRaw);
  if (!previousRaw) {
    return current.totalTokens > 0 ? current : normalizeUsage(fallbackRaw);
  }
  const previous = normalizeUsage(previousRaw);
  const delta = {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
    events: 1,
  };
  const hasNegative = Object.entries(delta)
    .filter(([key]) => key !== 'events')
    .some(([, value]) => value < 0);
  if (hasNegative) {
    return normalizeUsage(fallbackRaw);
  }
  return delta;
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function hasUsage(usage) {
  return usage.inputTokens > 0
    || usage.cachedInputTokens > 0
    || usage.outputTokens > 0
    || usage.reasoningOutputTokens > 0
    || usage.totalTokens > 0;
}

async function aggregateSessions({ sessionsDir, since }) {
  const files = await listSessionFiles(sessionsDir);
  const total = emptyUsage();
  const models = new Map();
  const sinceMs = since.date.getTime();
  let latestRateLimits = null;
  let latestTimestamp = null;
  let tokenEventsSeen = 0;

  for (const file of files) {
    let currentModel = UNKNOWN_MODEL;
    let previousTotalUsage = null;
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = entry?.payload;
      if (entry.type === 'turn_context' && payload) {
        currentModel = extractModel(payload) ?? currentModel;
        continue;
      }

      if (payload?.type !== 'token_count') continue;
      tokenEventsSeen++;

      const timestamp = Date.parse(entry.timestamp);
      const currentTotal = payload.info?.total_token_usage;
      const delta = usageDelta(previousTotalUsage, currentTotal, payload.info?.last_token_usage);
      previousTotalUsage = currentTotal ?? previousTotalUsage;

      if (!Number.isFinite(timestamp) || timestamp < sinceMs || !hasUsage(delta)) {
        continue;
      }

      const model = currentModel || UNKNOWN_MODEL;
      if (!models.has(model)) {
        models.set(model, emptyUsage());
      }
      addUsage(models.get(model), delta);
      addUsage(total, delta);
      latestRateLimits = payload.rate_limits ?? latestRateLimits;
      latestTimestamp = entry.timestamp ?? latestTimestamp;
    }
  }

  return {
    since: since.label,
    sinceIso: since.date.toISOString(),
    generatedAt: new Date().toISOString(),
    latestTimestamp,
    sessionsDir: resolve(sessionsDir),
    filesScanned: files.length,
    tokenEventsSeen,
    total,
    byModel: [...models.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, usage]) => ({ model, ...usage })),
    rateLimits: latestRateLimits,
  };
}

function extractModel(payload) {
  return firstString(
    payload.model,
    payload.model_slug,
    payload.model_name,
    payload.collaboration_mode?.settings?.model,
  );
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

async function loadPriceBook(pricePath) {
  if (!existsSync(pricePath)) {
    return { source: 'missing', path: pricePath, models: new Map(), rawCount: 0 };
  }
  const text = await readFile(pricePath, 'utf8');
  const raw = JSON.parse(text);
  const models = new Map();
  for (const [name, entry] of Object.entries(raw)) {
    const price = normalizePriceEntry(entry);
    if (!price) continue;
    models.set(normalizeModelKey(name), { name, ...price });
    const stripped = stripProvider(name);
    if (stripped !== name) {
      models.set(normalizeModelKey(stripped), { name, ...price });
    }
  }
  return { source: 'cache', path: pricePath, models, rawCount: Object.keys(raw).length };
}

function normalizePriceEntry(entry) {
  const input = numberOrNull(entry?.input_cost_per_token);
  const output = numberOrNull(entry?.output_cost_per_token);
  const cachedInput = firstNumber(
    entry?.cache_read_input_token_cost,
    entry?.input_cost_per_token_batches,
    entry?.cached_input_cost_per_token,
  );
  if (input === null && output === null && cachedInput === null) return null;
  return {
    inputCostPerToken: input,
    cachedInputCostPerToken: cachedInput,
    outputCostPerToken: output,
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const normalized = numberOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function stripProvider(model) {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

function normalizeModelKey(model) {
  return stripProvider(String(model).trim().toLowerCase());
}

function findPrice(priceBook, model) {
  const candidates = [
    model,
    stripProvider(model),
    model.replace(/^openai\//i, ''),
  ].map(normalizeModelKey);
  for (const candidate of candidates) {
    const price = priceBook.models.get(candidate);
    if (price) return price;
  }
  return null;
}

function estimateCosts(summary, priceBook) {
  let totalCost = 0;
  let pricedTokens = 0;
  const byModel = summary.byModel.map((row) => {
    const price = findPrice(priceBook, row.model);
    if (!price) {
      return { ...row, costUsd: null, priceModel: null, priceMissing: true };
    }
    const uncachedInputTokens = Math.max(row.inputTokens - row.cachedInputTokens, 0);
    const cachedCostPerToken = price.cachedInputCostPerToken ?? price.inputCostPerToken;
    const inputCost = price.inputCostPerToken === null
      ? 0
      : uncachedInputTokens * price.inputCostPerToken;
    const cachedInputCost = cachedCostPerToken === null
      ? 0
      : row.cachedInputTokens * cachedCostPerToken;
    const outputCost = price.outputCostPerToken === null
      ? 0
      : row.outputTokens * price.outputCostPerToken;
    const costUsd = inputCost + cachedInputCost + outputCost;
    totalCost += costUsd;
    pricedTokens += row.totalTokens;
    return {
      ...row,
      costUsd,
      priceModel: price.name,
      priceMissing: false,
      pricing: {
        inputCostPerToken: price.inputCostPerToken,
        cachedInputCostPerToken: price.cachedInputCostPerToken,
        outputCostPerToken: price.outputCostPerToken,
        cachedInputFallbackToInput: price.cachedInputCostPerToken === null && price.inputCostPerToken !== null,
      },
    };
  });
  return {
    ...summary,
    byModel,
    cost: {
      usd: totalCost,
      pricedTokens,
      unpricedTokens: Math.max(summary.total.totalTokens - pricedTokens, 0),
      partial: pricedTokens < summary.total.totalTokens,
      priceSource: priceBook.source,
      pricePath: priceBook.path,
      priceEntries: priceBook.rawCount,
    },
  };
}

async function refreshPrices({ priceUrl, pricePath }) {
  const response = await fetch(priceUrl, {
    headers: { 'user-agent': 'codex-meter/0.1.0' },
  });
  if (!response.ok) {
    throw new Error(`price refresh failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  JSON.parse(text);
  await mkdir(dirname(pricePath), { recursive: true });
  await writeFile(pricePath, text);
}

function formatCompact(summary) {
  const cached = summary.total.cachedInputTokens;
  const uncached = Math.max(summary.total.inputTokens - cached, 0);
  const cost = formatCost(summary.cost);
  return [
    `since ${summary.since}`,
    `tokens ${formatTokens(summary.total.totalTokens)}`,
    `cached ${formatTokens(cached)}`,
    `uncached ${formatTokens(uncached)}`,
    `est ${cost}`,
  ].join(' | ');
}

function formatText(summary, { details }) {
  const lines = [
    formatCompact(summary),
    `input ${formatTokens(summary.total.inputTokens)} | output ${formatTokens(summary.total.outputTokens)} | reasoning ${formatTokens(summary.total.reasoningOutputTokens)}`,
  ];
  if (summary.cost.partial) {
    lines.push(`cost note: partial estimate; ${formatTokens(summary.cost.unpricedTokens)} tokens have no cached price entry`);
  }
  if (details || summary.byModel.length > 1 || summary.cost.partial) {
    lines.push('models:');
    for (const row of summary.byModel) {
      const cached = row.cachedInputTokens;
      const uncached = Math.max(row.inputTokens - cached, 0);
      const cost = row.costUsd === null ? 'price missing' : `$${row.costUsd.toFixed(6)}`;
      lines.push(`  ${row.model}: tokens ${formatTokens(row.totalTokens)} | cached ${formatTokens(cached)} | uncached ${formatTokens(uncached)} | est ${cost}`);
    }
  }
  return lines.join('\n');
}

function formatCost(cost) {
  if (!cost || cost.pricedTokens <= 0) return 'unavailable';
  const suffix = cost.partial ? ' partial' : '';
  return `$${cost.usd.toFixed(4)}${suffix}`;
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimFixed(value) {
  return value.toFixed(1).replace(/\.0$/, '');
}

async function calculate({ since, options }) {
  if (options.refreshPrices) {
    await refreshPrices({ priceUrl: options.priceUrl, pricePath: options.pricePath });
  }
  const [summary, priceBook] = await Promise.all([
    aggregateSessions({ sessionsDir: options.sessionsDir, since }),
    loadPriceBook(options.pricePath),
  ]);
  return estimateCosts(summary, priceBook);
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const output = options.status ? formatCompact(summary) : formatText(summary, options);
  process.stdout.write(`${output}\n`);
}

async function watch({ since, options }) {
  const watchOptions = { ...options };
  if (watchOptions.refreshPrices) {
    await refreshPrices({ priceUrl: watchOptions.priceUrl, pricePath: watchOptions.pricePath });
    watchOptions.refreshPrices = false;
  }
  while (true) {
    const summary = await calculate({ since, options: watchOptions });
    if (watchOptions.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stdout.write(`\r\x1b[K${watchOptions.status ? formatCompact(summary) : formatText(summary, watchOptions).replace(/\n/g, '   ')}`);
    }
    await sleep(watchOptions.interval * 1000);
  }
}

async function launchTmuxPane({ commandArgs, options }) {
  if (!process.env.TMUX) {
    throw new Error('--tmux requires a tmux session. Start tmux, run codex-meter since YYYY-MM-DD --tmux, then run codex in the main pane.');
  }

  if (options.refreshPrices) {
    await refreshPrices({ priceUrl: options.priceUrl, pricePath: options.pricePath });
  }

  const childArgs = [
    ...commandArgs,
    '--watch',
    '--status',
    '--interval',
    String(options.interval),
  ];
  if (options.sessionsDir !== DEFAULT_SESSIONS_DIR) {
    childArgs.push('--sessions-dir', options.sessionsDir);
  }
  if (options.pricePath !== DEFAULT_PRICE_CACHE) {
    childArgs.push('--prices', options.pricePath);
  }

  const modulePath = fileURLToPath(import.meta.url);
  const childCommand = [
    'env',
    'CODEX_METER_TMUX=1',
    process.execPath,
    modulePath,
    ...childArgs,
  ].map(shellEscape).join(' ');

  const tmuxArgs = [
    'split-window',
    '-v',
    '-l',
    String(options.tmuxHeight),
    '-c',
    process.cwd(),
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
  ];
  if (process.env.TMUX_PANE) {
    tmuxArgs.push('-t', process.env.TMUX_PANE);
  }
  tmuxArgs.push(childCommand);

  const paneId = execFileSync('tmux', tmuxArgs, { encoding: 'utf8' }).trim();
  if (paneId) {
    try {
      execFileSync('tmux', ['select-pane', '-t', paneId, '-T', 'codex-meter']);
      if (process.env.TMUX_PANE) {
        execFileSync('tmux', ['select-pane', '-t', process.env.TMUX_PANE]);
      }
    } catch {
      // Pane title/focus is cosmetic; the meter pane has already launched.
    }
  }

  process.stdout.write(`codex-meter live pane launched below (${options.tmuxHeight} lines).\n`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    if (parsed.options.tmux) {
      await launchTmuxPane(parsed);
    } else if (parsed.options.watch) {
      await watch(parsed);
    } else {
      const summary = await calculate(parsed);
      printSummary(summary, parsed.options);
    }
  } catch (error) {
    process.stderr.write(`codex-meter: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
}

if (isDirectRun()) {
  main();
}

export {
  aggregateSessions,
  estimateCosts,
  formatCompact,
  loadPriceBook,
  parseArgs,
  parseSince,
};
