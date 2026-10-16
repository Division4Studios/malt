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

await test('ordinary short prompts are emitted immediately while actual credential prefixes stay private', () => {
  const secret = 'fixture-credential-0123456789abcdef';
  const redactor = new SecretRedactor([secret]);
  assert.equal(redactor.write('READY> '), 'READY> ');
  assert.equal(redactor.write('fixture-cre'), '');
  assert.equal(redactor.write('dential-0123456789abcdef'), '[REDACTED]');
  assert.equal(redactor.write('\r\nREADY> '), '\r\nREADY> ');
  assert.equal(redactor.finish(), '');
  const overlapping = new SecretRedactor(['abc', 'abcdef']);
  assert.equal(overlapping.write('abc'), '');
  assert.equal(overlapping.write('def > '), '[REDACTED] > ');
});

await test('chunked surrogate pairs are not corrupted by immediate prompt redaction', () => {
  const redactor = new SecretRedactor([]);
  assert.equal(redactor.write('ready \u{D83C}'), 'ready ');
  assert.equal(redactor.write('\u{DF0C}> '), '🌌> ');
  assert.equal(redactor.finish(), '');
});
