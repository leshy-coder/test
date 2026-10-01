import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moonPhase } from '../server/weather.js';

test('Mondphase: bekannter Vollmond und Neumond', () => {
  // 29.09.2023 war Vollmond, 14.10.2023 Neumond (ringförmige Sonnenfinsternis)
  assert.ok(moonPhase(new Date('2023-09-29T10:00:00Z')).illumination > 97);
  assert.ok(moonPhase(new Date('2023-10-14T18:00:00Z')).illumination < 3);
  assert.equal(moonPhase(new Date('2023-10-14T18:00:00Z')).name, 'Neumond');
});
