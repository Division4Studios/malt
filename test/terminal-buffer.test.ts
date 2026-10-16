/**
 * Public terminal replay, byte limits and streaming credential protection.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { TerminalBuffer } from '../src/factory/terminal-buffer.ts';

await test('replay preserves sequence order and marks an evicted start', () => {
  const buffer = new TerminalBuffer(8, {});
  buffer.write(Buffer.from('one'));
  buffer.write(Buffer.from('two'));
  assert.deepEqual(buffer.readAfter(1), [{ type: 'data', sequence: 2, text: 'two' }]);
  buffer.write(Buffer.from('three'));
  assert.deepEqual(buffer.readAfter(0), [
    { type: 'truncated', sequence: 1 },
    { type: 'data', sequence: 2, text: 'two' },
    { type: 'data', sequence: 3, text: 'three' },
  ]);
  assert.equal(buffer.byteLength, 8);
  assert.deepEqual(buffer.readAfter(3), []);
  // Callers cannot mutate the retained replay.
  const replay = buffer.readAfter(1);
  replay.length = 0;
  assert.equal(buffer.readAfter(1).length, 2);
});

await test('fragmented replay bounds metadata and materializes only the requested page', () => {
  const buffer = new TerminalBuffer(262_144, {});
  for (let index = 0; index < 262_144; index += 1) {
    buffer.write(Buffer.from('q'));
  }
  assert.ok(buffer.byteLength <= 4096, 'Entry overhead has its own retention ceiling.');
  let cursor = 0;
  let received = 0;
  let pages = 0;
  for (;;) {
    const previous = cursor;
    const page = buffer.readAfter(cursor, { bytes: 65_536, entries: 128 });
    assert.ok(page.length <= 128);
    if (page.length === 0) {
      break;
    }
    assert.ok(page.every((entry) => entry.sequence >= previous));
    cursor = page.at(-1)?.sequence ?? cursor;
    received += page.filter((entry) => entry.type === 'data').length;
    pages += 1;
    assert.ok(pages <= 33, 'Pagination cannot repeatedly scan or materialize the discarded 262k entries.');
  }
  assert.equal(received, 4096);
  assert.equal(cursor, 262_144);
  assert.throws(() => buffer.readAfter(0, { entries: 1 }), RangeError);
});

await test('a flood and oversized Unicode chunks stay byte bounded', () => {
  const buffer = new TerminalBuffer(7, {});
  for (let index = 0; index < 1000; index += 1) {
    buffer.write(Buffer.from('🌌éabc'));
    assert.ok(buffer.byteLength <= 7);
    const data = buffer.readAfter(0).filter((entry) => entry.type === 'data');
    assert.equal(
      data.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
      buffer.byteLength,
    );
    assert.ok(data.every((entry) => !entry.text.includes('�')));
  }
  assert.equal(buffer.readAfter(0)[0]?.type, 'truncated');
  buffer.write(Buffer.from('x'.repeat(1_000_000)));
  assert.ok(buffer.byteLength <= 7);
  assert.equal(
    buffer
      .readAfter(0)
      .filter((entry) => entry.type === 'data')
      .map((entry) => entry.text)
      .join(''),
    'xxxxxxx',
  );
  const tiny = new TerminalBuffer(1, {});
  tiny.write(Buffer.from('🌌'));
  assert.equal(tiny.byteLength, 0);
  assert.deepEqual(tiny.readAfter(0), [{ type: 'truncated', sequence: 1 }]);
});

await test('UTF-8 characters survive every byte split and byte-at-a-time input', () => {
  const bytes = Buffer.from('before 🌌 café 漢字 after');
  for (let split = 0; split <= bytes.length; split += 1) {
    const buffer = new TerminalBuffer(128, {});
    buffer.write(bytes.subarray(0, split));
    buffer.write(bytes.subarray(split));
    buffer.finish();
    assert.equal(
      buffer
        .readAfter(0)
        .filter((entry) => entry.type === 'data')
        .map((entry) => entry.text)
        .join(''),
      bytes.toString(),
    );
  }
  const byteStream = new TerminalBuffer(128, {});
  for (const byte of bytes) {
    byteStream.write(Uint8Array.of(byte));
  }
  byteStream.finish();
  assert.equal(
    byteStream
      .readAfter(0)
      .filter((entry) => entry.type === 'data')
      .map((entry) => entry.text)
      .join(''),
    bytes.toString(),
  );
});

await test('environment and explicit credentials are redacted before every replay', () => {
  const secret = 'fake-oauth-credential-12345';
  const literal = 'auth.json-fixture.[token]';
  for (let split = 0; split <= secret.length; split += 1) {
    const buffer = new TerminalBuffer(256, { CLAUDE_CODE_OAUTH_TOKEN: secret }, [literal]);
    for (const chunk of ['Authorization: Bearer ', secret.slice(0, split), secret.slice(split), ` ${literal} done`]) {
      buffer.write(Buffer.from(chunk));
      assert.ok(!JSON.stringify(buffer.readAfter(0)).includes(secret));
      assert.ok(!JSON.stringify(buffer.readAfter(0)).includes(literal));
    }
    buffer.finish();
    assert.equal(
      buffer
        .readAfter(0)
        .filter((entry) => entry.type === 'data')
        .map((entry) => entry.text)
        .join(''),
      'Authorization: Bearer [REDACTED] [REDACTED] done',
    );
  }
});

await test('finish flushes only once and invalid limits or cursors fail', () => {
  const buffer = new TerminalBuffer(128, {}, ['credential']);
  buffer.write(Buffer.from('cred'));
  assert.deepEqual(buffer.readAfter(0), []);
  buffer.finish();
  const replay = buffer.readAfter(0);
  assert.deepEqual(replay, [{ type: 'data', sequence: 1, text: 'cred' }]);
  buffer.finish();
  assert.deepEqual(buffer.readAfter(0), replay);
  assert.throws(() => {
    buffer.write(Buffer.from('later'));
  }, /finished/v);
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new TerminalBuffer(invalid, {}), RangeError);
  }
  for (const invalid of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => buffer.readAfter(invalid), RangeError);
  }
});

await test('oversized output retains a continuous suffix after the gap', () => {
  const buffer = new TerminalBuffer(5, {});
  buffer.write(Buffer.from('a'));
  buffer.write(Buffer.from('🌌🌌'));
  assert.deepEqual(buffer.readAfter(0), [
    { type: 'truncated', sequence: 2 },
    { type: 'data', sequence: 2, text: '🌌' },
  ]);
  buffer.write(Buffer.from('bb'));
  assert.deepEqual(buffer.readAfter(0), [
    { type: 'truncated', sequence: 2 },
    { type: 'data', sequence: 3, text: 'bb' },
  ]);
});

await test('overlapping credentials cannot be reconstructed across committed replay chunks', () => {
  for (const secret of ['aa', 'aba', 'abab', 'abcab']) {
    const input = secret.repeat(4);
    for (let split = 1; split < input.length; split += 1) {
      const buffer = new TerminalBuffer(2048, {}, [secret]);
      const chunks = [input.slice(0, split), input.slice(split)];
      for (const chunk of chunks) {
        buffer.write(Buffer.from(chunk));
        const liveText = buffer
          .readAfter(0)
          .filter((entry) => entry.type === 'data')
          .map((entry) => entry.text)
          .join('');
        assert.ok(!liveText.includes(secret), `${secret}: split ${String(split)} before finish`);
      }
      buffer.finish();
      const emitted = buffer
        .readAfter(0)
        .filter((entry) => entry.type === 'data')
        .map((entry) => entry.text)
        .join('');
      assert.ok(!emitted.includes(secret), `${secret}: split ${String(split)} after finish`);
    }
  }
  const exactBuffer = new TerminalBuffer(128, {}, ['aa']);
  for (const chunk of ['aaa', 'a']) {
    exactBuffer.write(Buffer.from(chunk));
  }
  exactBuffer.finish();
  assert.equal(
    exactBuffer
      .readAfter(0)
      .filter((entry) => entry.type === 'data')
      .map((entry) => entry.text)
      .join(''),
    '[REDACTED][REDACTED]',
  );
});
