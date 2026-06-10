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
const DEFAULT_APP_CONFIG = join(homedir(), '.config', 'codex-meter', 'config.json');
const DEFAULT_MARKERS_FILE = join(homedir(), '.config', 'codex-meter', 'markers.json');
const DEFAULT_SHELL_RC = defaultShellRcPath();
const DEFAULT_TMUX_HEIGHT = 2;
const PTY_FOOTER_HEIGHT = 1;
const UNKNOWN_MODEL = 'unknown';
const UNKNOWN_PROJECT = 'unknown';
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
    '  codex-meter budget --daily USD|--weekly USD|--monthly USD|--clear|--status',
    '  codex-meter doctor',
    '  codex-meter mark NAME',
    '  codex-meter marks',
    '  codex-meter since-mark NAME [--watch] [--status] [--json]',
    '  codex-meter remove-mark NAME',
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
    '  --csv                   Print CSV to stdout',
    '  --details               Include per-model rows in text output',
    '  --models                Include per-model rows',
    '  --projects              Include per-project rows',
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
    csv: false,
    details: false,
    models: false,
    projects: false,
    codexArgs: [],
    meterConfigPath: DEFAULT_APP_CONFIG,
    markersPath: DEFAULT_MARKERS_FILE,
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
  if (command === 'budget') {
    return parseBudgetArgs(args, options);
  }
  if (command === 'doctor') {
    const parsed = parseSharedReadOptions(args, options);
    if (parsed.help) return parsed;
    return { doctor: true, options };
  }
  if (command === 'mark') {
    const markerName = requireValue('mark', args);
    assertNoExtraArgs(args, 'mark');
    return { markerAction: 'mark', markerName, options };
  }
  if (command === 'marks') {
    assertNoExtraArgs(args, 'marks');
    return { markerAction: 'list', options };
  }
  if (command === 'remove-mark') {
    const markerName = requireValue('remove-mark', args);
    assertNoExtraArgs(args, 'remove-mark');
    return { markerAction: 'remove', markerName, options };
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
  let sinceMarkName = null;
  if (command === 'since') {
    sinceArg = args.shift();
    if (!sinceArg) {
      throw new Error('since requires YYYY-MM-DD');
    }
  } else if (command === 'since-mark') {
    sinceMarkName = args.shift();
    if (!sinceMarkName) {
      throw new Error('since-mark requires NAME');
    }
  } else if (command === 'today' || command === 'week') {
    sinceArg = command;
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  const commandArgs = sinceMarkName
    ? ['since-mark', sinceMarkName]
    : command === 'since' ? ['since', sinceArg] : [command];

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
      case '--csv':
        options.csv = true;
        break;
      case '--details':
        options.details = true;
        break;
      case '--models':
        options.models = true;
        break;
      case '--projects':
        options.projects = true;
        break;
      case '--help':
      case '-h':
        return { help: true, options };
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return { since: sinceMarkName ? null : parseSince(sinceArg), sinceMarkName, options, commandArgs };
}

function parseSharedReadOptions(args, options) {
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--sessions-dir':
        options.sessionsDir = requireValue(arg, args);
        break;
      case '--config':
        options.configPath = requireValue(arg, args);
        break;
      case '--prices':
        options.pricePath = requireValue(arg, args);
        break;
      case '--shell-file':
        options.shellFile = requireValue(arg, args);
        break;
      case '--help':
      case '-h':
        return { help: true, options };
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return { options };
}

function parseBudgetArgs(args, options) {
  const budget = { set: {}, clear: false, status: false };
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--daily':
      case '--weekly':
      case '--monthly': {
        budget.set[arg.slice(2)] = parseUsdAmount(requireValue(arg, args), arg);
        break;
      }
      case '--clear':
        budget.clear = true;
        break;
      case '--status':
        budget.status = true;
        break;
      case '--help':
      case '-h':
        return { help: true, options };
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!budget.clear && Object.keys(budget.set).length === 0) {
    budget.status = true;
  }
  return { budget, options };
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

function assertNoExtraArgs(args, command) {
  if (args.length > 0) {
    throw new Error(`${command} received unexpected argument: ${args[0]}`);
  }
}

function parseUsdAmount(value, flag) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${flag} must be a non-negative USD amount`);
  }
  return amount;
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
  const projectModels = new Map();
  const sinceMs = since.date.getTime();
  let latestRateLimits = null;
  let latestTimestamp = null;
  let tokenEventsSeen = 0;

  for (const file of files) {
    let currentModel = UNKNOWN_MODEL;
    let currentProject = UNKNOWN_PROJECT;
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
      if (entry.type === 'session_meta' && payload) {
        currentModel = extractModel(payload) ?? currentModel;
        currentProject = extractProject(payload) ?? currentProject;
        continue;
      }
      if (entry.type === 'turn_context' && payload) {
        currentModel = extractModel(payload) ?? currentModel;
        currentProject = extractProject(payload) ?? currentProject;
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
      const project = currentProject || UNKNOWN_PROJECT;
      const projectModelKey = `${project}\0${model}`;
      if (!projectModels.has(projectModelKey)) {
        projectModels.set(projectModelKey, { project, model, ...emptyUsage() });
      }
      addUsage(models.get(model), delta);
      addUsage(projectModels.get(projectModelKey), delta);
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
    byProjectModel: [...projectModels.values()]
      .sort((a, b) => a.project.localeCompare(b.project) || a.model.localeCompare(b.model)),
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

function extractProject(payload) {
  const repo = firstString(
    payload.git?.repository_url,
    payload.git?.repository,
    payload.repository_url,
    payload.project,
  );
  if (repo) return projectNameFromRepository(repo);
  const cwd = firstString(payload.cwd, payload.directory, payload.workdir, payload.worktree);
  if (cwd) return projectNameFromPath(cwd);
  return null;
}

function projectNameFromRepository(repository) {
  const cleaned = String(repository).replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.at(-1) || UNKNOWN_PROJECT;
}

function projectNameFromPath(path) {
  const cleaned = String(path).replace(/\/+$/, '');
  return basename(cleaned) || cleaned || UNKNOWN_PROJECT;
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
    const estimated = estimateUsageCost(row, row.model, priceBook);
    if (estimated.costUsd === null) return estimated;
    const costUsd = estimated.costUsd;
    totalCost += costUsd;
    pricedTokens += row.totalTokens;
    return estimated;
  });
  const byProjectModel = (summary.byProjectModel ?? [])
    .map((row) => estimateUsageCost(row, row.model, priceBook));
  return {
    ...summary,
    byModel,
    byProjectModel,
    byProject: aggregateProjectCosts(byProjectModel),
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

function estimateUsageCost(row, model, priceBook) {
  const price = findPrice(priceBook, model);
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
  return {
    ...row,
    costUsd: inputCost + cachedInputCost + outputCost,
    priceModel: price.name,
    priceMissing: false,
    pricing: {
      inputCostPerToken: price.inputCostPerToken,
      cachedInputCostPerToken: price.cachedInputCostPerToken,
      outputCostPerToken: price.outputCostPerToken,
      cachedInputFallbackToInput: price.cachedInputCostPerToken === null && price.inputCostPerToken !== null,
    },
  };
}

function aggregateProjectCosts(projectModelRows) {
  const projects = new Map();
  for (const row of projectModelRows) {
    if (!projects.has(row.project)) {
      projects.set(row.project, {
        project: row.project,
        ...emptyUsage(),
        costUsd: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        costPartial: false,
      });
    }
    const project = projects.get(row.project);
    addUsage(project, row);
    if (row.costUsd === null) {
      project.unpricedTokens += row.totalTokens;
      project.costPartial = true;
    } else {
      project.costUsd += row.costUsd;
      project.pricedTokens += row.totalTokens;
    }
  }
  return [...projects.values()]
    .map((project) => ({
      ...project,
      costUsd: project.pricedTokens > 0 ? project.costUsd : null,
      priceMissing: project.unpricedTokens > 0,
    }))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.project.localeCompare(b.project));
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

async function loadBudgetConfig(configPath = DEFAULT_APP_CONFIG) {
  if (!existsSync(configPath)) return { budgets: {} };
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  return normalizeBudgetConfig(raw);
}

function normalizeBudgetConfig(raw) {
  const budgets = {};
  for (const period of ['daily', 'weekly', 'monthly']) {
    const amount = numberOrNull(raw?.budgets?.[period]);
    if (amount !== null && amount >= 0) budgets[period] = amount;
  }
  return { budgets };
}

async function saveBudgetConfig(configPath, config) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(normalizeBudgetConfig(config), null, 2)}\n`);
}

async function handleBudgetCommand({ budget, options }) {
  if (budget.clear) {
    await saveBudgetConfig(options.meterConfigPath, { budgets: {} });
    process.stdout.write('codex-meter budget cleared\n');
    return;
  }
  const current = await loadBudgetConfig(options.meterConfigPath);
  const next = {
    budgets: {
      ...current.budgets,
      ...budget.set,
    },
  };
  if (Object.keys(budget.set).length > 0) {
    await saveBudgetConfig(options.meterConfigPath, next);
    process.stdout.write(`codex-meter budget updated ${options.meterConfigPath}\n`);
  }
  printBudgetStatus(next);
}

function printBudgetStatus(config) {
  const budgets = normalizeBudgetConfig(config).budgets;
  const entries = Object.entries(budgets);
  if (entries.length === 0) {
    process.stdout.write('budgets: none\n');
    return;
  }
  for (const [period, amount] of entries) {
    process.stdout.write(`${period}: $${amount.toFixed(2)}\n`);
  }
}

function applyBudgetStatus(summary, budgetConfig) {
  const budgets = normalizeBudgetConfig(budgetConfig).budgets;
  const spend = summary.cost?.usd ?? 0;
  const exceeded = Object.entries(budgets)
    .filter(([, amount]) => spend > amount)
    .map(([period, amount]) => ({
      period,
      limitUsd: amount,
      spendUsd: spend,
      overUsd: spend - amount,
    }));
  return {
    ...summary,
    budget: {
      budgets,
      warning: exceeded.length > 0,
      exceeded,
    },
  };
}

function hasBudgetWarning(summary) {
  return summary?.budget?.warning === true;
}

async function loadMarkers(markersPath = DEFAULT_MARKERS_FILE) {
  if (!existsSync(markersPath)) return { markers: {} };
  const raw = JSON.parse(await readFile(markersPath, 'utf8'));
  return normalizeMarkers(raw);
}

function normalizeMarkers(raw) {
  const markers = {};
  const source = raw?.markers && typeof raw.markers === 'object' ? raw.markers : {};
  for (const [name, marker] of Object.entries(source)) {
    if (!isValidMarkerName(name)) continue;
    const since = firstString(marker?.since, marker?.sinceLabel);
    const createdAt = firstString(marker?.createdAt);
    if (!since || !createdAt) continue;
    markers[name] = { name, since, createdAt };
  }
  return { markers };
}

async function saveMarkers(markersPath, markers) {
  await mkdir(dirname(markersPath), { recursive: true });
  await writeFile(markersPath, `${JSON.stringify(normalizeMarkers(markers), null, 2)}\n`);
}

async function handleMarkerCommand(parsed) {
  const markers = await loadMarkers(parsed.options.markersPath);
  if (parsed.markerAction === 'list') {
    const entries = Object.values(markers.markers).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) {
      process.stdout.write('markers: none\n');
      return;
    }
    for (const marker of entries) {
      process.stdout.write(`${marker.name}: since ${marker.since} (${marker.createdAt})\n`);
    }
    return;
  }

  validateMarkerName(parsed.markerName);
  if (parsed.markerAction === 'mark') {
    const marker = {
      name: parsed.markerName,
      since: formatDateLocal(new Date()),
      createdAt: new Date().toISOString(),
    };
    markers.markers[parsed.markerName] = marker;
    await saveMarkers(parsed.options.markersPath, markers);
    process.stdout.write(`marker ${marker.name}: since ${marker.since}\n`);
    return;
  }

  if (parsed.markerAction === 'remove') {
    delete markers.markers[parsed.markerName];
    await saveMarkers(parsed.options.markersPath, markers);
    process.stdout.write(`marker removed: ${parsed.markerName}\n`);
  }
}

async function resolveSinceMarker(parsed) {
  if (!parsed.sinceMarkName) return parsed;
  validateMarkerName(parsed.sinceMarkName);
  const markers = await loadMarkers(parsed.options.markersPath);
  const marker = markers.markers[parsed.sinceMarkName];
  if (!marker) {
    throw new Error(`marker not found: ${parsed.sinceMarkName}`);
  }
  return {
    ...parsed,
    since: parseSince(marker.since),
    commandArgs: ['since', marker.since],
  };
}

function validateMarkerName(name) {
  if (!isValidMarkerName(name)) {
    throw new Error('marker name must be 1-64 chars of letters, numbers, dot, underscore, or dash');
  }
}

function isValidMarkerName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name));
}

async function runDoctor({ options }) {
  const checks = [];
  checks.push(checkNodeVersion());
  checks.push(checkCommandAvailable('codex-meter'));
  checks.push(checkCommandAvailable('codex'));
  checks.push(await checkShellWrapper(options.shellFile));
  checks.push(await checkCodexStatusLine(options.configPath));
  checks.push(await checkSessionLogs(options.sessionsDir));
  checks.push(await checkPriceCache(options.pricePath));
  checks.push(await checkNodePtySpawn());

  for (const check of checks) {
    const status = check.ok ? 'ok' : 'fail';
    const detail = check.detail ? ` - ${check.detail}` : '';
    process.stdout.write(`${status} ${check.name}${detail}\n`);
    if (!check.ok && check.fix) {
      process.stdout.write(`  fix: ${check.fix}\n`);
    }
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'node >=18',
    ok: major >= 18,
    detail: `v${process.versions.node}`,
    fix: 'install Node.js 18 or newer',
  };
}

function checkCommandAvailable(command) {
  const path = resolveCommandPath(command);
  return {
    name: `${command} binary`,
    ok: Boolean(path),
    detail: path || 'not found on PATH',
    fix: command === 'codex-meter'
      ? 'run npm install -g codex-meter'
      : 'install the Codex CLI',
  };
}

async function checkShellWrapper(shellFile) {
  try {
    const text = await readFile(shellFile, 'utf8');
    const ok = text.includes(SHELL_BLOCK_START)
      && text.includes('codex-meter launch')
      && text.includes('codex()');
    return {
      name: 'shell wrapper',
      ok,
      detail: shellFile,
      fix: 'run codex-meter setup',
    };
  } catch (error) {
    return {
      name: 'shell wrapper',
      ok: false,
      detail: `${shellFile}: ${error.code ?? error.message}`,
      fix: 'run codex-meter setup',
    };
  }
}

async function checkCodexStatusLine(configPath) {
  try {
    const text = await readFile(configPath, 'utf8');
    const ok = text.includes('codex-meter:managed-status-line') && /status_line\s*=/.test(text);
    return {
      name: 'Codex status_line',
      ok,
      detail: configPath,
      fix: 'run codex-meter setup',
    };
  } catch (error) {
    return {
      name: 'Codex status_line',
      ok: false,
      detail: `${configPath}: ${error.code ?? error.message}`,
      fix: 'run codex-meter setup',
    };
  }
}

async function checkSessionLogs(sessionsDir) {
  try {
    const files = await listSessionFiles(sessionsDir);
    return {
      name: 'session logs',
      ok: files.length > 0,
      detail: `${files.length} jsonl files in ${resolve(sessionsDir)}`,
      fix: 'run Codex once so it creates a local session log',
    };
  } catch (error) {
    return {
      name: 'session logs',
      ok: false,
      detail: `${sessionsDir}: ${error.message}`,
      fix: 'check --sessions-dir',
    };
  }
}

async function checkPriceCache(pricePath) {
  try {
    JSON.parse(await readFile(pricePath, 'utf8'));
    return {
      name: 'price cache',
      ok: true,
      detail: pricePath,
    };
  } catch (error) {
    return {
      name: 'price cache',
      ok: false,
      detail: `${pricePath}: ${error.code ?? error.message}`,
      fix: 'run codex-meter since 2026-06-10 --refresh-prices',
    };
  }
}

async function checkNodePtySpawn() {
  return new Promise((resolveCheck) => {
    let output = '';
    let child;
    try {
      child = pty.spawn(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        name: process.env.TERM || 'xterm-256color',
        cols: 20,
        rows: 2,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (error) {
      resolveCheck({
        name: 'node-pty spawn',
        ok: false,
        detail: error.message,
        fix: 'reinstall codex-meter with npm install -g codex-meter',
      });
      return;
    }
    child.onData((data) => {
      output += data;
    });
    child.onExit(() => {
      resolveCheck({
        name: 'node-pty spawn',
        ok: output.includes('ok'),
        detail: output.includes('ok') ? 'spawned node successfully' : 'no output from test spawn',
        fix: 'reinstall codex-meter with npm install -g codex-meter',
      });
    });
  });
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

function formatCompact(summary, options = {}) {
  const cached = summary.total.cachedInputTokens;
  const uncached = Math.max(summary.total.inputTokens - cached, 0);
  const cost = formatCost(summary.cost);
  const parts = [
    `since ${summary.since}`,
    `tokens ${formatTokens(summary.total.totalTokens)}`,
    `cached ${formatTokens(cached)}`,
    `uncached ${formatTokens(uncached)}`,
    `est ${cost}`,
  ];
  const budgetWarning = formatBudgetWarning(summary);
  if (budgetWarning) parts.push(budgetWarning);
  if (options.models) {
    const model = topCostModel(summary.byModel);
    if (model) {
      const modelPart = `top ${model.model} ${formatCostValue(model.costUsd)}`;
      const withModel = [...parts, modelPart].join(' | ');
      if (!options.maxCols || withModel.length <= options.maxCols) {
        parts.push(modelPart);
      }
    }
  }
  return parts.join(' | ');
}

function formatText(summary, { details, models, projects }) {
  const lines = [
    formatCompact(summary, { models }),
    `input ${formatTokens(summary.total.inputTokens)} | output ${formatTokens(summary.total.outputTokens)} | reasoning ${formatTokens(summary.total.reasoningOutputTokens)}`,
  ];
  const budgetWarning = formatBudgetWarning(summary);
  if (budgetWarning) {
    lines.push(`budget warning: ${budgetWarning}`);
  }
  if (summary.cost.partial) {
    lines.push(`cost note: partial estimate; ${formatTokens(summary.cost.unpricedTokens)} tokens have no cached price entry`);
  }
  if (details || models || summary.byModel.length > 1 || summary.cost.partial) {
    lines.push('models:');
    for (const row of summary.byModel) {
      lines.push(`  ${row.model}: ${formatUsageCostRow(row)}`);
    }
  }
  if (projects) {
    lines.push('projects:');
    for (const row of summary.byProject ?? []) {
      lines.push(`  ${row.project}: ${formatUsageCostRow(row)}`);
    }
  }
  return lines.join('\n');
}

function formatUsageCostRow(row) {
  const cached = row.cachedInputTokens;
  const uncached = Math.max(row.inputTokens - cached, 0);
  const cost = row.costUsd === null ? 'price missing' : formatCostDetailValue(row.costUsd);
  const partial = row.costPartial || row.priceMissing ? ' partial' : '';
  return `tokens ${formatTokens(row.totalTokens)} | cached ${formatTokens(cached)} | uncached ${formatTokens(uncached)} | output ${formatTokens(row.outputTokens)} | est ${cost}${partial}`;
}

function formatBudgetWarning(summary) {
  const warning = summary.budget?.exceeded?.[0];
  if (!warning) return '';
  return `budget ${warning.period} ${formatCostValue(warning.spendUsd)}/${formatCostValue(warning.limitUsd)}`;
}

function topCostModel(rows) {
  return [...(rows ?? [])]
    .filter((row) => row.costUsd !== null)
    .sort((a, b) => b.costUsd - a.costUsd)[0] ?? null;
}

function formatCost(cost) {
  if (!cost || cost.pricedTokens <= 0) return 'unavailable';
  const suffix = cost.partial ? ' partial' : '';
  return `${formatCostValue(cost.usd)}${suffix}`;
}

function formatCostValue(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  return `$${value.toFixed(4)}`;
}

function formatCostDetailValue(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  return `$${value.toFixed(6)}`;
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
  const [summary, priceBook, budgetConfig] = await Promise.all([
    aggregateSessions({ sessionsDir: options.sessionsDir, since }),
    loadPriceBook(options.pricePath),
    loadBudgetConfig(options.meterConfigPath),
  ]);
  return applyBudgetStatus(estimateCosts(summary, priceBook), budgetConfig);
}

function formatCsv(summary, options) {
  const columns = [
    'type',
    'name',
    'model',
    'project',
    'since',
    'total_tokens',
    'input_tokens',
    'cached_input_tokens',
    'uncached_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'cost_usd',
    'price_missing',
  ];
  const rows = [
    csvUsageRow('total', 'total', summary.total, {
      since: summary.since,
      costUsd: summary.cost?.pricedTokens > 0 ? summary.cost.usd : null,
      priceMissing: summary.cost?.partial ?? false,
    }),
  ];
  if (options.details || options.models) {
    for (const row of summary.byModel ?? []) {
      rows.push(csvUsageRow('model', row.model, row, {
        model: row.model,
        since: summary.since,
        costUsd: row.costUsd,
        priceMissing: row.priceMissing,
      }));
    }
  }
  if (options.projects) {
    for (const row of summary.byProject ?? []) {
      rows.push(csvUsageRow('project', row.project, row, {
        project: row.project,
        since: summary.since,
        costUsd: row.costUsd,
        priceMissing: row.priceMissing,
      }));
    }
  }
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? '')).join(',')),
  ].join('\n');
}

function csvUsageRow(type, name, usage, extra = {}) {
  const cached = usage.cachedInputTokens ?? 0;
  const input = usage.inputTokens ?? 0;
  return {
    type,
    name,
    model: extra.model ?? '',
    project: extra.project ?? '',
    since: extra.since ?? '',
    total_tokens: usage.totalTokens ?? 0,
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens: Math.max(input - cached, 0),
    output_tokens: usage.outputTokens ?? 0,
    reasoning_output_tokens: usage.reasoningOutputTokens ?? 0,
    cost_usd: extra.costUsd === null || extra.costUsd === undefined ? '' : extra.costUsd.toFixed(6),
    price_missing: extra.priceMissing ? 'true' : 'false',
  };
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function printSummary(summary, options) {
  if (options.csv) {
    process.stdout.write(`${formatCsv(summary, options)}\n`);
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const output = options.status ? formatCompact(summary, options) : formatText(summary, options);
  process.stdout.write(`${output}\n`);
}

async function watch({ since, options }) {
  if (options.csv) {
    throw new Error('--csv cannot be combined with --watch');
  }
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
      process.stdout.write(`\r\x1b[K${watchOptions.status ? formatCompact(summary, watchOptions) : formatText(summary, watchOptions).replace(/\n/g, '   ')}`);
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
  if (options.models) {
    childArgs.push('--models');
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
  let footerWarning = false;
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
    if (!stopped) drawFooterLine(footerLine, { warning: footerWarning });
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
      footerWarning = hasBudgetWarning(summary);
      footerLine = formatCompact(summary, {
        ...footerOptions,
        maxCols: currentPtyFooterSize().cols,
      });
    } catch (error) {
      footerWarning = true;
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

function drawFooterLine(line, { warning = false } = {}) {
  const { childRows, cols, footerRow } = currentPtyFooterSize();
  const text = fitTerminalLine(line, cols);
  const style = warning ? '\x1b[41;97m' : '\x1b[7m';
  process.stdout.write(`\x1b7\x1b[1;${childRows}r\x1b[${footerRow};1H${style}${text}\x1b[0m\x1b8`);
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
    if (parsed.budget) {
      await handleBudgetCommand(parsed);
    } else if (parsed.doctor) {
      await runDoctor(parsed);
    } else if (parsed.markerAction) {
      await handleMarkerCommand(parsed);
    } else {
      parsed = await resolveSinceMarker(parsed);
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
  applyBudgetStatus,
  csvEscape,
  estimateCosts,
  exitCodeFromSignal,
  fitTerminalLine,
  formatCsv,
  formatCompact,
  isValidMarkerName,
  loadPriceBook,
  loadBudgetConfig,
  loadMarkers,
  parseArgs,
  parseSince,
  resolveCodexCommand,
  saveBudgetConfig,
  saveMarkers,
  selectLaunchMode,
  upsertShellIntegrationText,
  removeManagedShellIntegrationText,
  upsertCodexStatusLineText,
};
