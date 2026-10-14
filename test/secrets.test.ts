/**
 * Known local credentials cannot cross captured output chunk boundaries.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { SecretRedactor, hashSecret } from '../src/secrets.ts';

await test('redaction protects every possible split without losing ordinary output', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  for (let split = 0; split <= secret.length; split += 1) {
    const redactor = new SecretRedactor([secret]);
    const chunks = ['before ', secret.slice(0, split), secret.slice(split), ' after'];
    const emitted = chunks.map((chunk) => redactor.write(chunk)).join('') + redactor.finish();
    assert.equal(emitted, 'before [REDACTED] after');
    assert.ok(!emitted.includes(secret));
  }
});

await test('literal metacharacters, repeated secrets and empty lists preserve safe evidence', () => {
  const redactor = new SecretRedactor(['', 's[e]c$r.et']);
  assert.equal(redactor.write('s[e]c$r.et s[e]c$r.et') + redactor.finish(), '[REDACTED] [REDACTED]');
  const plain = new SecretRedactor([]);
  assert.equal(plain.write('ordinary UTF-8 🌌') + plain.finish(), 'ordinary UTF-8 🌌');
  assert.equal(hashSecret('fixture').length, 64);
  assert.notEqual(hashSecret('fixture'), hashSecret('another identity'));
});

await test('redaction never splits a Unicode code point at its retained secret boundary', () => {
  const redactor = new SecretRedactor(['12345']);
  const chunks = ['a🌌xyz', ' later 12345'];
  const actual =
    chunks.map((chunk) => Buffer.from(redactor.write(chunk), 'utf8').toString('utf8')).join('') + redactor.finish();
  assert.equal(actual, 'a🌌xyz later [REDACTED]');
});
