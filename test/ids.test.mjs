import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, deviceId, profileId } from '../lib/ids.js';

test('normalizeToken lowercases, trims, collapses whitespace and punctuation', () => {
  assert.equal(normalizeToken('  Serie 6  WAT28660GB/01 '), 'serie-6-wat28660gb-01');
  assert.equal(normalizeToken('Bosch'), 'bosch');
});

test('deviceId converges for equivalent brand/model spellings', () => {
  const a = deviceId('washer', 'Bosch', 'WAT 28660');
  const b = deviceId('washer', ' bosch ', 'wat-28660');
  assert.equal(a, b);
  assert.equal(a, 'washer__bosch__wat-28660');
});

test('profileId nests under deviceId', () => {
  const d = deviceId('washer', 'Bosch', 'WAT28660');
  assert.equal(profileId(d, 'Cotton 40'), `${d}__cotton-40`);
});
