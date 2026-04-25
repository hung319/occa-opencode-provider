import assert from 'node:assert/strict';
import { globMatch, filterModels, applyModelAliases } from '../src/utils.js';

function testGlobMatch() {
  assert.ok(globMatch('gpt-4*', 'gpt-4o'));
  assert.ok(globMatch('gpt-4?*', 'gpt-4o'));
  assert.ok(!globMatch('gpt-4*', 'gpt-3'));
}

function testFilterModels() {
  const models = {
    'gpt-4o': { name: 'GPT-4o' },
    'gpt-4o-vision': { name: 'GPT-4o Vision' },
    'qwen3': { name: 'Qwen3' },
  };

  // Include only gpt-4* and exclude vision variants
  const filtered = filterModels(models, { include: ['gpt-4*'], exclude: ['*vision*'] });
  // Expect only 'gpt-4o' because 'gpt-4o-vision' is excluded by pattern
  assert.deepStrictEqual(Object.keys(filtered).sort(), ['gpt-4o'].sort());
}

function testApplyModelAliases() {
  const models = {
    'gpt-4o': { name: 'GPT-4o' },
  };
  const aliased = applyModelAliases(models);
  // Should be identical reference in current implementation
  assert.strictEqual(aliased, models);
}

function run() {
  testGlobMatch();
  testFilterModels();
  testApplyModelAliases();
  console.log('[Tests] model-filter tests passed');
}

run();
