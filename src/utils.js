// Shared small utilities for plugin logic

// Glob pattern to regex matching
export function globMatch(pattern, str) {
  // Convert glob pattern to regex: * -> .*, ? -> .
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(str);
}

// Filter models by include/exclude glob patterns
export function filterModels(models, filter) {
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

// Currently no model aliases; return as-is (hook for future aliasing)
export function applyModelAliases(models) {
  return models;
}

// Mask API keys in logs
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '(empty)';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}
