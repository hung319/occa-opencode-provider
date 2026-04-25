/**
 * OCCA OpenCode Provider Plugin v1.2.24
 *
 * Auto-detects occa.json from (优先级):
 * 1. OCCA_CONFIG_PATH 环境变量
 * 2. ./occa.json (当前目录)
 * 3. ~/.config/opencode/occa.json
 *
 * Auto-registers OpenAI / Claude / Gemini compatible providers with model lists.
 *
 * Features:
 *  - Config validation with clear error messages
 *  - Hot reload on config file changes
 *  - Model filtering (include/exclude patterns per provider)
 *  - Token masking in logs for security
 *  - Model list caching with configurable TTL
 *  - Custom headers per provider
 *  - Per-provider timeout
 *  - Stale cache fallback on API failure
 *  - Race condition protection with debounced writes
 *  - Duplicate watcher event prevention
 *  - Debug SDK initialization
 *
 * occa.json format:
 * {
 *   "settings": {
 *     "cache_ttl": 1800,          // seconds, default 1800 (30min)
 *     "hot_reload": true          // watch config for changes
 *   },
 *   "provider": {
 *     "my-openai": {
 *       "baseurl": "https://api.openai.com/v1",
 *       "key": "sk-xxx",
 *       "type": "openai",         // openai | claude | gemini
 *       "timeout": 15000,         // ms, optional, default 15000
 *       "headers": {              // optional custom headers
 *         "X-Custom": "value"
 *       },
 *       "models": {               // optional model filter
 *         "include": ["gpt-4*", "o3*"],
 *         "exclude": ["*vision*"]
 *       }
 *     }
 *   }
 * }
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { globMatch, filterModels, applyModelAliases, maskKey } from './src/utils.js';

// ── Constants ───────────────────────────────────────────────────────────────

const OCCA_CONFIG = path.join(os.homedir(), '.config', 'opencode', 'occa.json');
const LOG_DIR = path.join(os.homedir(), '.cache', 'opencode', 'occa-plugin');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');
const ERR_FILE = path.join(LOG_DIR, 'error.log');
const CACHE_FILE = path.join(LOG_DIR, 'models-cache.json');

const DEFAULT_CACHE_TTL = 1800; // 30 minutes
const DEFAULT_TIMEOUT = 15000;  // 15 seconds

function findConfigFile() {
  const envPath = process.env.OCCA_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  
  const cwdConfig = path.join(process.cwd(), 'occa.json');
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }
  
  if (fs.existsSync(OCCA_CONFIG)) {
    return OCCA_CONFIG;
  }
  
  return null;
}

// Map occa type → OpenCode SDK package
const SDK_MAP = {
  openai: '@ai-sdk/openai-compatible',
  claude: '@ai-sdk/anthropic',
  gemini: '@ai-sdk/google',
};

const VALID_TYPES = new Set(['openai', 'claude', 'gemini']);

// Default models when API doesn't return a list
const DEFAULT_MODELS = {
  openai: {
    'gpt-4o': { name: 'GPT-4o' },
    'gpt-4o-mini': { name: 'GPT-4o Mini' },
    'gpt-4.1': { name: 'GPT-4.1' },
    'gpt-4.1-mini': { name: 'GPT-4.1 Mini' },
    'gpt-4.1-nano': { name: 'GPT-4.1 Nano' },
    'o3': { name: 'o3' },
    'o3-mini': { name: 'o3 Mini' },
    'o4-mini': { name: 'o4 Mini' },
    'qwen3-coder-plus': { name: 'qwen3-coder-plus', fullId: 'qwen.aikit.club/qwen3-coder-plus' },
  },
  claude: {
    'claude-opus-4-20250514': { name: 'Claude Opus 4' },
    'claude-sonnet-4-20250514': { name: 'Claude Sonnet 4' },
    'claude-3-7-sonnet-20250219': { name: 'Claude 3.7 Sonnet' },
    'claude-3-5-sonnet-20241022': { name: 'Claude 3.5 Sonnet' },
    'claude-3-5-haiku-20241022': { name: 'Claude 3.5 Haiku' },
  },
  gemini: {
    'gemini-2.5-pro-preview': { name: 'Gemini 2.5 Pro' },
    'gemini-2.5-flash-preview': { name: 'Gemini 2.5 Flash' },
    'gemini-2.0-flash': { name: 'Gemini 2.0 Flash' },
    'gemini-2.0-flash-lite': { name: 'Gemini 2.0 Flash Lite' },
  },
};

// ── Logging ─────────────────────────────────────────────────────────────────

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) { /* ignore */ }
}

function log(msg) {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

function logError(msg) {
  try {
    ensureLogDir();
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    fs.appendFileSync(ERR_FILE, line);
  } catch (_) { /* ignore */ }
}

// ── Token masking ───────────────────────────────────────────────────────────


// ── Config validation ───────────────────────────────────────────────────────

function validateConfig(cfg) {
  const errors = [];

  if (!cfg || typeof cfg !== 'object') {
    errors.push('Config must be a JSON object');
    return { valid: false, errors };
  }

  if (!cfg.provider || typeof cfg.provider !== 'object') {
    errors.push('Missing required field "provider" (object)');
    return { valid: false, errors };
  }

  const providerKeys = Object.keys(cfg.provider);
  if (providerKeys.length === 0) {
    errors.push('"provider" object is empty — add at least one provider');
    return { valid: false, errors };
  }

  for (const [id, p] of Object.entries(cfg.provider)) {
    if (!p || typeof p !== 'object') {
      errors.push(`Provider "${id}" must be an object`);
      continue;
    }
    if (!p.baseurl || typeof p.baseurl !== 'string') {
      errors.push(`Provider "${id}" missing required field "baseurl" (string)`);
    }
    if (!p.key || typeof p.key !== 'string') {
      errors.push(`Provider "${id}" missing required field "key" (string)`);
    }
    if (p.type && !VALID_TYPES.has(p.type.toLowerCase())) {
      errors.push(`Provider "${id}" has invalid type "${p.type}" — must be: openai | claude | gemini`);
    }
    if (p.timeout && typeof p.timeout !== 'number') {
      errors.push(`Provider "${id}" field "timeout" must be a number (ms)`);
    }
    if (p.headers && typeof p.headers !== 'object') {
      errors.push(`Provider "${id}" field "headers" must be an object`);
    }
    if (p.models) {
      if (typeof p.models !== 'object') {
        errors.push(`Provider "${id}" field "models" must be an object`);
      } else {
        if (p.models.include && !Array.isArray(p.models.include)) {
          errors.push(`Provider "${id}" field "models.include" must be an array of patterns`);
        }
        if (p.models.exclude && !Array.isArray(p.models.exclude)) {
          errors.push(`Provider "${id}" field "models.exclude" must be an array of patterns`);
        }
      }
    }
  }

  if (cfg.settings) {
    if (typeof cfg.settings !== 'object') {
      errors.push('"settings" must be an object');
    } else {
      if (cfg.settings.cache_ttl !== undefined && typeof cfg.settings.cache_ttl !== 'number') {
        errors.push('"settings.cache_ttl" must be a number (seconds)');
      }
      if (cfg.settings.hot_reload !== undefined && typeof cfg.settings.hot_reload !== 'boolean') {
        errors.push('"settings.hot_reload" must be a boolean');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Config reader ───────────────────────────────────────────────────────────

let configPath = null;

function readOccaConfig() {
  if (!configPath) {
    configPath = findConfigFile();
  }
  
  if (!configPath) {
    logError('Config not found. Checked: OCCA_CONFIG_PATH env, ./occa.json, ~/.config/opencode/occa.json');
    return null;
  }

  if (!fs.existsSync(configPath)) {
    logError(`Config not found at ${configPath}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);

    const validation = validateConfig(cfg);
    if (!validation.valid) {
      for (const err of validation.errors) {
        logError(`[Config] Validation: ${err}`);
      }
      return null;
    }

    log(`[Config] Loaded ${Object.keys(cfg.provider).length} provider(s) from ${configPath}`);
    return cfg;
  } catch (e) {
    logError(`[Config] JSON parse error: ${e.message}`);
    return null;
  }
}

// ── Cache with locking ────────────────────────────────────────────────────

let cacheWriteInProgress = false;
let cacheWritePending = false;

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch (_) {
    return {};
  }
}

function writeCache(cache) {
  try {
    ensureLogDir();
    // Use atomic write: write to temp file then rename
    const tmpFile = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch (_) { /* ignore */ }
}

// Debounced write to prevent race conditions
function writeCacheDebounced(cache) {
  if (cacheWriteInProgress) {
    cacheWritePending = true;
    return;
  }
  cacheWriteInProgress = true;
  writeCache(cache);
  
  // Small delay to allow other writes to queue
  setTimeout(() => {
    cacheWriteInProgress = false;
    if (cacheWritePending) {
      cacheWritePending = false;
      writeCacheDebounced(readCache());
    }
  }, 100);
}

function getCachedModels(providerId, ttl) {
  const cache = readCache();
  const entry = cache[providerId];
  if (!entry) return null;

  const age = (Date.now() - entry.timestamp) / 1000;
  if (age > ttl) {
    log(`[Cache] ${providerId} expired (${Math.round(age)}s > ${ttl}s)`);
    delete cache[providerId];
    writeCache(cache);
    return null;
  }

  log(`[Cache] ${providerId} hit (${Math.round(age)}s old, ttl=${ttl}s)`);
  return entry.models;
}

function clearCache(providerId = null) {
  const cache = readCache();
  if (providerId) {
    delete cache[providerId];
    log(`[Cache] Cleared for provider: ${providerId}`);
  } else {
    Object.keys(cache).forEach(k => delete cache[k]);
    log('[Cache] Cleared all');
  }
  writeCache(cache);
}

function setCachedModels(providerId, models) {
  const cache = readCache();
  cache[providerId] = { timestamp: Date.now(), models };
  writeCache(cache);
}

// ── Model filtering ─────────────────────────────────────────────────────────

function globMatch(pattern, str) {
  // Convert glob pattern to regex: * → .*, ? → .
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(str);
}

function filterModels(models, filter) {
  if (!filter) return models;

  const result = {};
  for (const [id, info] of Object.entries(models)) {
    // Include: if specified, model must match at least one pattern
    if (filter.include && filter.include.length > 0) {
      if (!filter.include.some(p => globMatch(p, id))) continue;
    }
    // Exclude: if model matches any pattern, skip
    if (filter.exclude && filter.exclude.length > 0) {
      if (filter.exclude.some(p => globMatch(p, id))) continue;
    }
    result[id] = info;
  }
  return result;
}

// No model aliases - keep original models only
// This prevents SDK from looking for wrong provider
function applyModelAliases(models) {
  return models;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function httpRequest(urlStr, headers = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...headers },
      };
      const req = mod.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(data) });
          } catch {
            resolve({ ok: false, status: res.statusCode, json: null, raw: data });
          }
        });
      });
      req.on('error', (e) => {
        logError(`[HTTP] Request failed ${urlStr}: ${e.message}`);
        resolve({ ok: false, status: 0, json: null, error: e.message });
      });
      req.setTimeout(timeout, () => {
        req.destroy();
        logError(`[HTTP] Timeout after ${timeout}ms: ${urlStr}`);
        resolve({ ok: false, status: 0, json: null, error: `timeout (${timeout}ms)` });
      });
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, json: null, error: e.message });
    }
  });
}

// ── Model fetchers per API type ─────────────────────────────────────────────

async function fetchOpenAIModels(baseurl, apiKey, headers, timeout) {
    const url = baseurl.replace(/\/+$/, '') + '/models';
    // Build headers safely to support both standard Authorization and custom auth_header formats
    const finalHeaders = {};
    // Copy over any string-valued headers except the special 'auth_header' field
    if (headers) {
        for (const [k, v] of Object.entries(headers)) {
            if (k === 'auth_header') continue;
            if (typeof v === 'string') finalHeaders[k] = v;
        }
    }
    // Apply custom auth_header if provided
    if (headers && headers.auth_header) {
        const key = headers.auth_header.key || 'Authorization';
        finalHeaders[key] = headers.auth_header.value;
    }
    // Fallback to Bearer token if no explicit Authorization header present
    if (!finalHeaders.Authorization && apiKey) {
        finalHeaders.Authorization = `Bearer ${apiKey}`;
    }
    log(`[OpenAI] Fetching from ${url}`);
    const res = await httpRequest(url, finalHeaders, timeout);
    if (!res.ok) {
        logError(`[OpenAI] Fetch failed: status=${res.status} error=${res.error} raw=${res.raw}`);
        return null;
    }
    if (!res.json?.data) {
        logError(`[OpenAI] No data in response: ${res.raw}`);
        return null;
    }
    const models = {};
    for (const m of res.json.data) {
        if (m.id) models[m.id] = { name: m.id };
    }
    log(`[OpenAI] Fetched ${Object.keys(models).length} models`);
    return models;
}

async function fetchClaudeModels(baseurl, apiKey, headers, timeout) {
  let url = baseurl.replace(/\/+$/, '');
  if (!url.endsWith('/v1')) url += '/v1';
  url += '/models';

  const res = await httpRequest(url, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...headers,
  }, timeout);
  if (!res.ok || !res.json?.data) {
    logError(`[Claude] Models fetch failed (${res.status}): ${res.error || 'no data'}`);
    return null;
  }
  const models = {};
  for (const m of res.json.data) {
    if (m.id) models[m.id] = { name: m.display_name || m.id };
  }
  log(`[Claude] Fetched ${Object.keys(models).length} models`);
  return models;
}

async function fetchGeminiModels(baseurl, apiKey, headers, timeout) {
  let url = baseurl.replace(/\/+$/, '') + '/models?key=' + encodeURIComponent(apiKey);
  const res = await httpRequest(url, headers, timeout);
  if (!res.ok || !res.json?.models) {
    logError(`[Gemini] Models fetch failed (${res.status}): ${res.error || 'no data'}`);
    return null;
  }
  const models = {};
  for (const m of res.json.models) {
    const id = (m.name || '').replace(/^models\//, '');
    if (id) models[id] = { name: m.displayName || id };
  }
  log(`[Gemini] Fetched ${Object.keys(models).length} models`);
  return models;
}

const FETCH_MAP = {
  openai: fetchOpenAIModels,
  claude: fetchClaudeModels,
  gemini: fetchGeminiModels,
};

// ── Hot reload ──────────────────────────────────────────────────────────────

let watcher = null;
let reloadCallback = null;
let reloadDebounceTimer = null;
let lastReloadTime = 0;

function startWatcher(callback) {
  if (watcher) return;
  reloadCallback = callback;

  try {
    watcher = fs.watch(configPath, (eventType) => {
      if (eventType === 'change') {
        const now = Date.now();
        // Prevent duplicate reloads within 1 second
        if (now - lastReloadTime < 1000) {
          log('[Watcher] Debounced duplicate event');
          return;
        }
        clearTimeout(reloadDebounceTimer);
        reloadDebounceTimer = setTimeout(() => {
          lastReloadTime = now;
          log('[Watcher] Config file changed, reloading...');
          if (reloadCallback) reloadCallback();
        }, 500);
      }
    });
    log('[Watcher] Started watching occa.json');
  } catch (e) {
    logError(`[Watcher] Failed to start: ${e.message}`);
  }
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    log('[Watcher] Stopped');
  }
}

// ── Main plugin export ──────────────────────────────────────────────────────

export const OccaPlugin = async (ctx) => {
  log('[Plugin] Starting OCCA Plugin v1.2.24...');

  let currentResults = [];

  async function loadProviders(forceRefresh = false) {
    const occa = readOccaConfig();
    if (!occa) {
      logError('[Plugin] Config invalid or missing — no providers registered');
      currentResults = [];
      return;
    }

    const settings = occa.settings || {};
    const cacheTTL = settings.cache_ttl ?? DEFAULT_CACHE_TTL;

    const providerEntries = Object.entries(occa.provider);
    log(`[Plugin] Processing ${providerEntries.length} provider(s)...`);

    const results = await Promise.all(
      providerEntries.map(async ([id, p]) => {
        const type = (p.type || 'openai').toLowerCase();
        const baseurl = p.baseurl || '';
        const key = p.key || '';
        const timeout = p.timeout || DEFAULT_TIMEOUT;
        const customHeaders = p.headers || {};
        const modelFilter = p.models || null;
        const sdk = SDK_MAP[type] || SDK_MAP.openai;
        const fetcher = FETCH_MAP[type] || fetchOpenAIModels;

        log(`[Provider] ${id} type=${type} url=${baseurl} key=${maskKey(key)} timeout=${timeout}ms`);

        let models = null;
        let cachedModels = null;
        let cacheUsed = false;

        if (!forceRefresh && cacheTTL > 0) {
          cachedModels = getCachedModels(id, cacheTTL);
        }

        let apiFetchSuccess = false;

        if (!cachedModels && baseurl && key) {
          log(`[Provider] ${id} attempting fresh fetch...`);
          const freshModels = await fetcher(baseurl, key, customHeaders, timeout);
          if (freshModels && Object.keys(freshModels).length > 0) {
            setCachedModels(id, freshModels);
            models = freshModels;
            apiFetchSuccess = true;
            log(`[Provider] ${id} fresh fetch success, ${Object.keys(freshModels).length} models`);
          } else {
            log(`[Provider] ${id} fresh fetch FAILED`);
          }
        } else if (cachedModels) {
          models = cachedModels;
          cacheUsed = true;
          log(`[Provider] ${id} using cached models (${Object.keys(cachedModels).length})`);
        }

        // Apply model filter
        if (modelFilter && models) {
          const before = Object.keys(models).length;
          models = filterModels(models, modelFilter);
          const after = Object.keys(models).length;
          if (before !== after) {
            log(`[Provider] ${id} model filter: ${before} → ${after} models`);
          }
        }

// Apply model aliases (short IDs)
        models = applyModelAliases(models);

        return { id, type, baseurl, key, sdk, models, timeout };
      })
    );

    currentResults = results;
    log(`[Plugin] Prepared ${results.length} provider(s)`);
  }

  // Initial load
  await loadProviders();

  // Start hot reload if enabled
  const occa = readOccaConfig();
  if (occa?.settings?.hot_reload !== false) {
    startWatcher(async () => {
      await loadProviders(true);
      // Notify OpenCode of config change via ctx if available
      if (ctx?.refresh) {
        try { await ctx.refresh(); } catch (_) { /* ignore */ }
      }
    });
  }

  return {
    config: async (config) => {
      log('[Hook] config() called');
      if (!config.provider) config.provider = {};

      // Check if cache has expired and reload if needed
      const occa = readOccaConfig();
      if (occa) {
        const cacheTTL = occa.settings?.cache_ttl ?? DEFAULT_CACHE_TTL;
        if (cacheTTL > 0) {
          const cache = readCache();
          // Check all cached entries - not just currentResults
          const allCachedIds = Object.keys(cache);
          let hasExpired = false;
          for (const id of allCachedIds) {
            const entry = cache[id];
            const age = (Date.now() - entry.timestamp) / 1000;
            if (age > cacheTTL) {
              hasExpired = true;
              break;
            }
          }
          if (hasExpired) {
            log('[Hook] Cache expired, reloading providers...');
            await loadProviders(true);
          }
        }
      }

        for (const r of currentResults) {
          const providerConfig = {
            npm: r.sdk,
            name: r.id,
            options: {
              baseURL: r.baseurl,
              apiKey: r.key,
            },
            models: r.models,
          };

          // Avoid duplicate re-registration if identical config already exists
          const existing = config.provider[r.id];
          const isSame = existing
            && existing.options
            && existing.options.baseURL === r.baseurl
            && existing.options.apiKey === r.key
            && JSON.stringify(existing.models) === JSON.stringify(r.models);
          if (!isSame) {
            config.provider[r.id] = providerConfig;
            log(`[Hook] Registered "${r.id}" (${r.type}) with ${Object.keys(r.models).length} model(s)`);
          }

          // Map hostname so SDK can find credentials for model provider prefix
          try {
            const u = new URL(r.baseurl);
            const hostname = u.hostname;
            if (!config.provider[hostname] || config.provider[hostname].name !== r.id) {
              config.provider[hostname] = providerConfig;
              log(`[Hook] Registered "${hostname}" for model matching`);
            }
          } catch (_) {}
        }
    },
  };
};

export default OccaPlugin;
