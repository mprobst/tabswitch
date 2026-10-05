/** Unit tests for the version arithmetic in scripts/release.ts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpVersion } from '../../scripts/release.ts';

test('bumps each part and resets the lower ones', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
});

test('treats missing parts as zero', () => {
  assert.equal(bumpVersion('0.2', 'patch'), '0.2.1');
  assert.equal(bumpVersion('1', 'minor'), '1.1.0');
});

test('rejects versions it cannot bump', () => {
  assert.throws(() => bumpVersion('1.2.3.4', 'patch'));
  assert.throws(() => bumpVersion('1.x', 'patch'));
});
