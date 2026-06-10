#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { chmodSync, createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve, dirname, delimiter, basename } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pty from 'node-pty';

const DEFAULT_PRICE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const require = createRequire(import.meta.url);
const DEFAULT_PRICE_CACHE = join(homedir(), '.cache', 'codex-meter', 'prices.litellm.json');
const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const DEFAULT_CODEX_CONFIG = join(homedir(), '.codex', 'config.toml');
const DEFAULT_SHELL_RC = defaultShellRcPath();
const DEFAULT_TMUX_HEIGHT = 2;
const PTY_FOOTER_HEIGHT = 1;
const UNKNOWN_MODEL = 'unknown';
const SHELL_BLOCK_START = '# >>> codex-meter codex wrapper >>>';
const SHELL_BLOCK_END = '# <<< codex-meter codex wrapper <<<';
const DEFAULT_CODEX_STATUS_LINE = [
  'model-with-reasoning',
  'git-branch',
  'context-remaining',
  'context-used',
  'used-tokens',
  'total-input-tokens',
  'total-output-tokens',
  'five-hour-limit',
  'weekly-limit',
];

function usage() {
  return [
    'Usage:',
    '  codex-meter setup [--shell since YYYY-MM-DD|today|week] [--no-shell]',
    '  codex-meter setup --remove-shell',
    '  codex-meter launch since YYYY-MM-DD [-- CODEX_ARGS...]',
    '  codex-meter launch today [-- CODEX_ARGS...]',
    '  codex-meter launch week [-- CODEX_ARGS...]',
    '  codex-meter since YYYY-MM-DD [--watch] [--status] [--json]',
    '  codex-meter today [--watch] [--status] [--json]',
    '  codex-meter week [--watch] [--status] [--json]',
    '',
    'Options:',
    '  --sessions-dir PATH     Codex sessions directory (default: ~/.codex/sessions)',
    '  --config PATH           Codex config path for setup (default: ~/.codex/config.toml)',
    '  --prices PATH           LiteLLM price cache JSON (default: ~/.cache/codex-meter/prices.litellm.json)',
    '  --refresh-prices        Refresh LiteLLM price cache over HTTP, then calculate',
    '  --price-url URL         Override LiteLLM-compatible price JSON URL',
    '  --watch                 Recalculate continuously without model/API calls',
    '  --interval SECONDS      Watch interval (default: 2)',
    '  --status                Print one compact line',
    '  --launch                Launch Codex with a live meter pane/footer',
    '  --tmux                  Open a bottom tmux pane and run live compact status there',
    '  --tmux-height LINES     Bottom tmux pane height (default: 2)',
    '  --json                  Print machine-readable JSON',
    '  --details               Include per-model rows in text output',
    '  --shell since DATE      Override setup shell wrapper range',
    '  --shell-file PATH       Shell rc file for setup wrapper (default: detected shell rc)',
    '  --no-shell              Do not install the setup shell wrapper',
    '  --remove-shell          Remove the managed codex shell wrapper',
    '  -- CODEX_ARGS...        Extra arguments passed to codex in launch mode',
    '  --help                  Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    sessionsDir: DEFAULT_SESSIONS_DIR,
    configPath: DEFAULT_CODEX_CONFIG,
    pricePath: DEFAULT_PRICE_CACHE,
    priceUrl: DEFAULT_PRICE_URL,
    refreshPrices: false,
    watch: false,
    interval: 2,
    status: false,
    launch: false,
    tmux: false,
    tmuxHeight: DEFAULT_TMUX_HEIGHT,
    json: false,
    details: false,
    codexArgs: [],
    shellIntegration: false,
    noShellIntegration: false,
    removeShellIntegration: false,
    shellFile: DEFAULT_SHELL_RC,
    shellCommandArgs: null,
  };

  let command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    return { help: true, options };
  }
  if (command === 'setup') {
    while (args.length > 0) {
      const arg = args.shift();
      switch (arg) {
        case '--config':
          options.configPath = requireValue(arg, args);
          break;
        case '--shell':
          options.shellIntegration = true;
          options.shellCommandArgs = parseSetupShellCommand(args);
          break;
        case '--shell-file':
          options.shellFile = requireValue(arg, args);
          break;
        case '--no-shell':
          options.noShellIntegration = true;
          break;
        case '--remove-shell':
          options.removeShellIntegration = true;
          break;
        case '--help':
        case '-h':
          return { help: true, options };
        default:
          throw new Error(`unknown option: ${arg}`);
      }
    }
    if (options.shellIntegration && options.noShellIntegration) {
      throw new Error('--shell and --no-shell cannot be used together');
    }
    if (options.removeShellIntegration && (options.shellIntegration || options.noShellIntegration)) {
      throw new Error('--remove-shell cannot be combined with --shell or --no-shell');
    }
    if (!options.removeShellIntegration && !options.noShellIntegration) {
      options.shellIntegration = true;
      options.shellCommandArgs ??= defaultSetupShellCommand();
    }
    return { setup: true, options };
  }
  if (command === 'launch') {
    options.launch = true;
    command = args.shift();
    if (!command) {
      throw new Error('launch requires since YYYY-MM-DD, today, or week');
    }
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
    if (arg === '--') {
      options.codexArgs = args.splice(0);
      break;
    }
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
      case '--launch':
        options.launch = true;
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

function parseSetupShellCommand(args) {
  const command = requireValue('--shell', args);
  if (command === 'since') {
    const sinceArg = requireValue('since', args);
    parseSince(sinceArg);
    return ['since', sinceArg];
  }
  if (command === 'today' || command === 'week') {
    parseSince(command);
    return [command];
  }
  throw new Error('--shell requires since YYYY-MM-DD, today, or week');
}

function defaultSetupShellCommand() {
  return ['since', formatDateLocal(new Date())];
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

async function setupCodexStatusLine({ configPath }) {
  let current = '';
  try {
    current = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const updated = upsertCodexStatusLineText(current);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, updated);
  process.stdout.write(`codex-meter setup updated ${configPath}\n`);
  process.stdout.write('Codex built-in status_line now includes token and limit items. Use `codex-meter launch ...` for the custom since/cost live meter.\n');
}

async function setupCodex({ options }) {
  await setupCodexStatusLine(options);
  if (options.removeShellIntegration) {
    await removeCodexShellIntegration({ shellFile: options.shellFile });
  } else if (options.shellIntegration) {
    await setupCodexShellIntegration({
      shellFile: options.shellFile,
      commandArgs: options.shellCommandArgs,
    });
  }
}

async function setupCodexShellIntegration({ shellFile, commandArgs }) {
  let current = '';
  try {
    current = await readFile(shellFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const updated = upsertShellIntegrationText(current, commandArgs);
  await mkdir(dirname(shellFile), { recursive: true });
  await writeFile(shellFile, updated);
  process.stdout.write(`codex-meter shell wrapper updated ${shellFile}\n`);
  process.stdout.write(`New shells will run \`codex\` as \`codex-meter launch ${commandArgs.join(' ')} -- "$@"\`.\n`);
}

async function removeCodexShellIntegration({ shellFile }) {
  let current = '';
  try {
    current = await readFile(shellFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stdout.write(`codex-meter shell wrapper not found in ${shellFile}\n`);
      return;
    }
    throw error;
  }

  const updated = removeManagedShellIntegrationText(current);
  await writeFile(shellFile, updated);
  process.stdout.write(`codex-meter shell wrapper removed from ${shellFile}\n`);
}

function defaultShellRcPath(env = process.env) {
  const shell = basename(env.SHELL ?? '');
  if (shell === 'bash') return join(homedir(), '.bashrc');
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  return join(homedir(), '.profile');
}

function upsertShellIntegrationText(configText, commandArgs) {
  const text = removeManagedShellIntegrationText(configText);
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${prefix}\n${buildShellIntegrationBlock(commandArgs)}`;
}

function removeManagedShellIntegrationText(configText) {
  const start = configText.indexOf(SHELL_BLOCK_START);
  if (start === -1) return configText;
  const end = configText.indexOf(SHELL_BLOCK_END, start);
  if (end === -1) return configText;
  const afterEnd = end + SHELL_BLOCK_END.length;
  const afterNewline = configText[afterEnd] === '\n' ? afterEnd + 1 : afterEnd;
  const before = configText.slice(0, start).replace(/\n{2,}$/, '\n');
  const after = configText.slice(afterNewline).replace(/^\n{2,}/, '\n');
  return `${before}${after}`;
}

function buildShellIntegrationBlock(commandArgs) {
  const launchArgs = commandArgs.map(shellEscape).join(' ');
  return [
    SHELL_BLOCK_START,
    '# Managed by codex-meter. Remove with: codex-meter setup --remove-shell',
    'codex() {',
    `  command codex-meter launch ${launchArgs} -- "$@"`,
    '}',
    SHELL_BLOCK_END,
    '',
  ].join('\n');
}

function upsertCodexStatusLineText(configText) {
  const text = configText.endsWith('\n') || configText.length === 0
    ? configText
    : `${configText}\n`;
  const block = findTomlTableBlock(text, 'tui');
  const statusLine = `status_line = ${formatTomlStringArray(DEFAULT_CODEX_STATUS_LINE)}`;

  if (!block) {
    return `${text}\n[tui]\n# codex-meter:managed-status-line\n${statusLine}\n`;
  }

  const before = text.slice(0, block.start);
  const table = text.slice(block.start, block.end);
  const after = text.slice(block.end);
  const lines = table.split('\n');
  const statusIndex = lines.findIndex((line) => /^\s*status_line\s*=/.test(line));
  if (statusIndex === -1) {
    lines.splice(1, 0, '# codex-meter:managed-status-line', statusLine);
    return `${before}${lines.join('\n')}${after}`;
  }

  const existingItems = parseTomlStringArrayLine(lines[statusIndex]);
  const merged = mergeUnique(existingItems, DEFAULT_CODEX_STATUS_LINE);
  lines[statusIndex] = `status_line = ${formatTomlStringArray(merged)}`;
  const previousLine = lines[statusIndex - 1] ?? '';
  if (!previousLine.includes('codex-meter:managed-status-line')) {
    lines.splice(statusIndex, 0, '# codex-meter:managed-status-line');
  }
  return `${before}${lines.join('\n')}${after}`;
}

function findTomlTableBlock(text, tableName) {
  const headerPattern = new RegExp(`^\\[${escapeRegExp(tableName)}\\]\\s*$`, 'm');
  const header = headerPattern.exec(text);
  if (!header) return null;
  const start = header.index;
  const restStart = start + header[0].length;
  const nextHeader = /^\[[^\]]+\]\s*$/m.exec(text.slice(restStart));
  const end = nextHeader ? restStart + nextHeader.index : text.length;
  return { start, end };
}

function parseTomlStringArrayLine(line) {
  const items = [];
  const match = /=\s*\[(.*)\]\s*$/.exec(line);
  if (!match) return items;
  const itemPattern = /"((?:\\.|[^"\\])*)"/g;
  let itemMatch;
  while ((itemMatch = itemPattern.exec(match[1])) !== null) {
    try {
      items.push(JSON.parse(`"${itemMatch[1]}"`));
    } catch {
      // Ignore malformed string entries and keep the managed defaults.
    }
  }
  return items;
}

function formatTomlStringArray(items) {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

function mergeUnique(primary, defaults) {
  const seen = new Set();
  const merged = [];
  for (const item of [...primary, ...defaults]) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function buildMeterChildArgs(commandArgs, options) {
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
  return childArgs;
}

function buildMeterWatchCommand(commandArgs, options) {
  const modulePath = fileURLToPath(import.meta.url);
  const command = [
    'env',
    'CODEX_METER_TMUX=1',
    process.execPath,
    modulePath,
    ...buildMeterChildArgs(commandArgs, options),
  ].map(shellEscape).join(' ');
  return `exec ${command}`;
}

async function launchTmuxPane({ commandArgs, options }) {
  if (!process.env.TMUX) {
    throw new Error('--tmux requires a tmux session. Start tmux, run codex-meter since YYYY-MM-DD --tmux, then run codex in the main pane.');
  }
  const tmuxBin = assertTmuxAvailable();

  if (options.refreshPrices) {
    await refreshPrices({ priceUrl: options.priceUrl, pricePath: options.pricePath });
  }

  const childCommand = buildMeterWatchCommand(commandArgs, options);

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

  const paneId = execFileSync(tmuxBin, tmuxArgs, { encoding: 'utf8' }).trim();
  if (paneId) {
    try {
      execFileSync(tmuxBin, ['select-pane', '-t', paneId, '-T', 'codex-meter']);
      if (process.env.TMUX_PANE) {
        execFileSync(tmuxBin, ['select-pane', '-t', process.env.TMUX_PANE]);
      }
    } catch {
      // Pane title/focus is cosmetic; the meter pane has already launched.
    }
  }

  process.stdout.write(`codex-meter live pane launched below (${options.tmuxHeight} lines).\n`);
}

async function launchManagedCodexSession({ commandArgs, since, options }) {
  const launchMode = selectLaunchMode();
  if (launchMode.kind === 'pty-footer') {
    await launchPtyFooterSession({ since, options });
    return;
  }
  if (launchMode.kind === 'unsupported') {
    throw new Error('no-tmux launch mode requires an interactive terminal.');
  }

  const tmuxBin = launchMode.tmuxBin;
  if (options.refreshPrices) {
    await refreshPrices({ priceUrl: options.priceUrl, pricePath: options.pricePath });
  }

  const sessionName = buildManagedSessionName();
  const meterCommand = buildMeterWatchCommand(commandArgs, options);
  const codexCommand = buildCodexLeaderCommand(options.codexArgs, sessionName, tmuxBin);
  let createdSession = false;

  try {
    execFileSync(tmuxBin, [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      process.cwd(),
      codexCommand,
    ]);
    createdSession = true;
    execFileSync(tmuxBin, [
      'split-window',
      '-v',
      '-l',
      String(options.tmuxHeight),
      '-d',
      '-t',
      sessionName,
      '-c',
      process.cwd(),
      meterCommand,
    ]);
    const attachArgs = process.env.TMUX
      ? ['switch-client', '-t', sessionName]
      : ['attach-session', '-t', sessionName];
    execFileSync(tmuxBin, attachArgs, { stdio: 'inherit' });
  } catch (error) {
    if (createdSession) {
      try {
        execFileSync(tmuxBin, ['kill-session', '-t', sessionName], { stdio: 'ignore' });
      } catch {
        // Best effort cleanup after launch failure.
      }
    }
    throw new Error(`managed launch failed: ${error.message}`);
  }
}

function selectLaunchMode({
  tmuxBin = resolveWorkingTmuxBinary(),
  stdinIsTTY = process.stdin.isTTY,
  stdoutIsTTY = process.stdout.isTTY,
} = {}) {
  if (tmuxBin) return { kind: 'tmux', tmuxBin };
  if (!stdinIsTTY || !stdoutIsTTY) return { kind: 'unsupported' };
  return { kind: 'pty-footer' };
}

async function launchPtyFooterSession({ since, options }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('no-tmux launch mode requires an interactive terminal.');
  }
  ensureNodePtySpawnHelperExecutable();

  const footerOptions = {
    ...options,
    refreshPrices: false,
    json: false,
    status: true,
  };
  if (options.refreshPrices) {
    await refreshPrices({ priceUrl: options.priceUrl, pricePath: options.pricePath });
  }

  const initialSize = currentPtyFooterSize();
  const child = pty.spawn(resolveCodexCommand(), options.codexArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: initialSize.cols,
    rows: initialSize.childRows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLUMNS: String(initialSize.cols),
      LINES: String(initialSize.childRows),
      CODEX_METER_PTY_FOOTER: '1',
    },
  });

  let stopped = false;
  let footerLine = 'codex-meter starting...';
  let refreshRunning = false;
  let redrawTimer = null;
  let refreshInterval = null;
  const previousRawMode = process.stdin.isRaw;

  const restoreTerminal = () => {
    if (restoreTerminal.done) return;
    restoreTerminal.done = true;
    stopped = true;
    if (redrawTimer) clearTimeout(redrawTimer);
    if (refreshInterval) clearInterval(refreshInterval);
    process.stdout.off('resize', onResize);
    process.stdin.off('data', onInput);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
    }
    process.stdout.write('\x1b[r\x1b[0m\x1b[?25h');
    clearFooterRow();
  };
  restoreTerminal.done = false;

  const drawCurrentFooter = () => {
    if (!stopped) drawFooterLine(footerLine);
  };
  const scheduleRedraw = () => {
    if (stopped || redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      drawCurrentFooter();
    }, 25);
  };
  const refreshFooter = async () => {
    if (stopped || refreshRunning) return;
    refreshRunning = true;
    try {
      const summary = await calculate({ since, options: footerOptions });
      footerLine = formatCompact(summary);
    } catch (error) {
      footerLine = `codex-meter error: ${error.message}`;
    } finally {
      refreshRunning = false;
      drawCurrentFooter();
    }
  };
  const onInput = (data) => {
    child.write(data);
  };
  const onResize = () => {
    const size = currentPtyFooterSize();
    child.resize(size.cols, size.childRows);
    reserveFooterRow();
    drawCurrentFooter();
  };
  const onSignal = (signal) => {
    child.kill(signal);
  };

  reserveFooterRow();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdin.on('data', onInput);
  process.stdout.on('resize', onResize);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', restoreTerminal);

  child.onData((data) => {
    process.stdout.write(data);
    scheduleRedraw();
  });

  const exitPromise = new Promise((resolveExit) => {
    child.onExit(({ exitCode, signal }) => {
      restoreTerminal();
      process.off('exit', restoreTerminal);
      process.exitCode = typeof exitCode === 'number'
        ? exitCode
        : exitCodeFromSignal(signal);
      resolveExit();
    });
  });

  refreshInterval = setInterval(refreshFooter, Math.max(1, options.interval) * 1000);
  await refreshFooter();
  await exitPromise;
}

function resolveCodexCommand(env = process.env) {
  const override = env.CODEX_METER_CODEX_BIN;
  return typeof override === 'string' && override.trim() ? override.trim() : 'codex';
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  let packageRoot;
  try {
    packageRoot = resolve(dirname(require.resolve('node-pty/lib/index.js')), '..');
  } catch {
    return;
  }
  for (const helperPath of [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ]) {
    if (!existsSync(helperPath)) continue;
    const stats = statSync(helperPath);
    if ((stats.mode & 0o111) !== 0) continue;
    chmodSync(helperPath, stats.mode | 0o755);
  }
}

function currentPtyFooterSize() {
  const cols = Math.max(20, process.stdout.columns || 80);
  const rows = Math.max(2, process.stdout.rows || 24);
  return {
    cols,
    rows,
    childRows: Math.max(1, rows - PTY_FOOTER_HEIGHT),
    footerRow: rows,
  };
}

function reserveFooterRow() {
  const { childRows } = currentPtyFooterSize();
  process.stdout.write(`\x1b[1;${childRows}r`);
}

function drawFooterLine(line) {
  const { childRows, cols, footerRow } = currentPtyFooterSize();
  const text = fitTerminalLine(line, cols);
  process.stdout.write(`\x1b7\x1b[1;${childRows}r\x1b[${footerRow};1H\x1b[7m${text}\x1b[0m\x1b8`);
}

function clearFooterRow() {
  const { footerRow } = currentPtyFooterSize();
  process.stdout.write(`\x1b7\x1b[${footerRow};1H\x1b[2K\x1b8`);
}

function fitTerminalLine(line, cols) {
  const normalized = String(line).replace(/[\r\n]+/g, ' ');
  if (normalized.length >= cols) return normalized.slice(0, cols);
  return normalized.padEnd(cols, ' ');
}

function exitCodeFromSignal(signal) {
  if (typeof signal === 'number') return 128 + signal;
  const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  return 128 + (signalNumbers[signal] ?? 1);
}

function assertTmuxAvailable() {
  const tmuxBin = resolveWorkingTmuxBinary();
  if (!tmuxBin) {
    throw new Error('this mode requires a working tmux or psmux binary on PATH.');
  }
  return tmuxBin;
}

function resolveWorkingTmuxBinary() {
  const tmuxBin = resolveTmuxBinary();
  if (!tmuxBin) {
    return null;
  }
  try {
    execFileSync(tmuxBin, ['-V'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return tmuxBin;
}

function resolveTmuxBinary() {
  const candidates = process.platform === 'win32'
    ? ['tmux.exe', 'tmux', 'psmux.exe', 'psmux']
    : ['tmux', 'psmux'];
  for (const command of candidates) {
    const resolved = resolveCommandPath(command);
    if (resolved) return resolved;
  }
  return null;
}

function resolveCommandPath(command) {
  const pathEntries = String(process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolve(entry, command);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function buildManagedSessionName() {
  return `codex-meter-${process.pid}-${Date.now().toString(36)}`;
}

function buildCodexLeaderCommand(codexArgs, sessionName, tmuxBin) {
  const codexCommand = ['codex', ...codexArgs].map(shellEscape).join(' ');
  const closeSessionCommand = `${shellEscape(tmuxBin)} kill-session -t ${shellEscape(sessionName)} >/dev/null 2>&1 || true`;
  const script = [
    codexCommand,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    '  printf "\\n[codex-meter] codex exited with code %s. Press Enter to close this session.\\n" "$status" >&2',
    '  IFS= read -r _codex_meter_close || true',
    'fi',
    closeSessionCommand,
    'exit "$status"',
  ].join('\n');
  return `/bin/sh -c ${shellEscape(script)}`;
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
    if (parsed.setup) {
      await setupCodex(parsed);
    } else if (parsed.options.launch) {
      await launchManagedCodexSession(parsed);
    } else if (parsed.options.tmux) {
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
  exitCodeFromSignal,
  fitTerminalLine,
  formatCompact,
  loadPriceBook,
  parseArgs,
  parseSince,
  resolveCodexCommand,
  selectLaunchMode,
  upsertShellIntegrationText,
  removeManagedShellIntegrationText,
  upsertCodexStatusLineText,
};
