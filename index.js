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
  // Fix cứng chỉ tìm trong ~/.config/opencode/occa.json
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
  }

  return { valid: errors.length === 0, errors };
}

// ── Config reader ───────────────────────────────────────────────────────────

let configPath = null;

function readOccaConfig() {
  if (!configPath) configPath = findConfigFile();
  
  if (!configPath || !fs.existsSync(configPath)) {
    logError('Config not found. Checked: ~/.config/opencode/occa.json');
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const validation = validateConfig(cfg);
    if (!validation.valid) {
      for (const err of validation.errors) logError(`[Config] Validation: ${err}`);
      return null;
    }
    return cfg;
  } catch (e) {
    logError(`[Config] JSON parse error: ${e.message}`);
    return null;
  }
}

// ── Cache with locking ────────────────────────────────────────────────────

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch (_) { return {}; }
}

function writeCache(cache) {
  try {
    ensureLogDir();
    const tmpFile = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch (_) { /* ignore */ }
}

function getCachedModels(providerId, ttl) {
  const cache = readCache();
  const entry = cache[providerId];
  if (!entry) return null;

  const age = (Date.now() - entry.timestamp) / 1000;
  if (age > ttl) {
    delete cache[providerId];
    writeCache(cache);
    return null;
  }
  return entry.models;
}

function setCachedModels(providerId, models) {
  const cache = readCache();
  cache[providerId] = { timestamp: Date.now(), models };
  writeCache(cache);
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
      req.on('error', (e) => resolve({ ok: false, status: 0, json: null, error: e.message }));
      req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, status: 0, json: null, error: 'timeout' }); });
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, json: null, error: e.message });
    }
  });
}

// ── Model fetchers per API type ─────────────────────────────────────────────

async function fetchOpenAIModels(baseurl, apiKey, headers, timeout) {
    const url = baseurl.replace(/\/+$/, '') + '/models';
    const finalHeaders = {};
    if (headers) {
        for (const [k, v] of Object.entries(headers)) {
            if (k === 'auth_header') continue;
            if (typeof v === 'string') finalHeaders[k] = v;
        }
    }
    if (headers && headers.auth_header) {
        const key = headers.auth_header.key || 'Authorization';
        finalHeaders[key] = headers.auth_header.value;
    }
    if (!finalHeaders.Authorization && apiKey) {
        finalHeaders.Authorization = `Bearer ${apiKey}`;
    }
    
    log(`[OpenAI] Fetching from ${url}`);
    const res = await httpRequest(url, finalHeaders, timeout);
    if (!res.ok || !res.json?.data) {
        logError(`[OpenAI] Fetch failed: status=${res.status}`);
        return null;
    }
    
    const models = {};
    for (const m of res.json.data) {
        if (m.id) {
            const { id, object, created, owned_by, permission, root, parent, ...extra } = m;
            const info = { name: m.id };
            if (extra.context_length) info.limit = { context: extra.context_length };
            if (extra.max_output_tokens) {
              if (info.limit) info.limit.output = extra.max_output_tokens;
              else info.limit = { output: extra.max_output_tokens };
            }
            for (const [k, v] of Object.entries(extra)) {
              if (k !== 'limit') info[k] = v;
            }
            models[m.id] = info;
        }
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
  if (!res.ok || !res.json?.data) return null;
  
  const models = {};
  for (const m of res.json.data) {
    if (m.id) models[m.id] = { name: m.display_name || m.id };
  }
  return models;
}

async function fetchGeminiModels(baseurl, apiKey, headers, timeout) {
  let url = baseurl.replace(/\/+$/, '') + '/models?key=' + encodeURIComponent(apiKey);
  const res = await httpRequest(url, headers, timeout);
  if (!res.ok || !res.json?.models) return null;
  
  const models = {};
  for (const m of res.json.models) {
    const id = (m.name || '').replace(/^models\//, '');
    if (id) models[id] = { name: m.displayName || id };
  }
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
        if (now - lastReloadTime < 1000) return;
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

// ── Main plugin export ──────────────────────────────────────────────────────

export const OccaPlugin = async (ctx) => {
  log('[Plugin] Starting OCCA Plugin (Pass-through Edition)...');

  let currentResults = [];

  async function loadProviders(forceRefresh = false) {
    const occa = readOccaConfig();
    if (!occa) {
      currentResults = [];
      return;
    }

    const settings = occa.settings || {};
    const cacheTTL = settings.cache_ttl ?? DEFAULT_CACHE_TTL;
    const providerEntries = Object.entries(occa.provider);

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

        let models = null;
        if (!forceRefresh && cacheTTL > 0) {
          models = getCachedModels(id, cacheTTL);
        }

        if (!models && baseurl && key) {
          const freshModels = await fetcher(baseurl, key, customHeaders, timeout);
          if (freshModels && Object.keys(freshModels).length > 0) {
            setCachedModels(id, freshModels);
            models = freshModels;
          }
        }

        // Apply model filter if exists
        if (modelFilter && models) {
          models = filterModels(models, modelFilter);
        }

        return { id, type, baseurl, key, sdk, models: models || {} };
      })
    );

    currentResults = results;
  }

  // Initial load
  await loadProviders();

  // Start hot reload if enabled
  const occa = readOccaConfig();
  if (occa?.settings?.hot_reload !== false) {
    startWatcher(async () => {
      await loadProviders(true);
      if (ctx?.refresh) {
        try { await ctx.refresh(); } catch (_) { /* ignore */ }
      }
    });
  }

  return {
    config: async (config) => {
      log('[Hook] config() called');
      if (!config.provider) config.provider = {};

      for (const r of currentResults) {
        const rawModels = {};
        
        // Pass-through: Bê y nguyên modelId do API trả về, không split, không sửa đổi
        for (const [modelId, info] of Object.entries(r.models)) {
          rawModels[modelId] = info;
        }

        const providerConfig = {
          npm: r.sdk,
          name: r.id,
          options: {
            baseURL: r.baseurl,
            apiKey: r.key,
            // Đã gỡ bỏ toàn bộ Interceptor (không có fetch override).
            // OpenCode sẽ giao tiếp nguyên bản với API.
          },
          models: rawModels,
        };

        const existing = config.provider[r.id];
        const isSame = existing
          && existing.options
          && existing.options.baseURL === r.baseurl
          && existing.options.apiKey === r.key
          && JSON.stringify(existing.models) === JSON.stringify(rawModels);
          
        if (!isSame) {
          config.provider[r.id] = providerConfig;
          log(`[Hook] Registered "${r.id}" (${r.type}) with ${Object.keys(rawModels).length} model(s)`);
        }
      }
    },
  };
};

export default OccaPlugin;
