/**
 * Terminal host frames round-trip across any chunking and reject bad streams with typed errors.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  FrameDecoder,
  MAX_COLUMNS,
  MAX_FRAME_BODY,
  MAX_ROWS,
  TerminalProtocolError,
  encodeFrame,
} from '../src/factory/terminal-frames.ts';

import type { Frame } from '../src/factory/terminal-frames.ts';

const ESC_CSI_2J = [0x1b, 0x5b, 0x32, 0x4a, 0xff];
const samples: Frame[] = [
  { type: 'started', pid: 123 },
  { type: 'data', data: new Uint8Array(ESC_CSI_2J) },
  { type: 'input', data: new Uint8Array() },
  { type: 'resize', columns: 120, rows: 40 },
  { type: 'close' },
  { type: 'exit', code: 0, signal: null },
  { type: 'error', code: 'unsupported_platform', message: 'No PTY available' },
];
const CHUNK = 7;
const TYPE_RESIZE = 3;
const TYPE_CLOSE = 4;
const TYPE_EXIT = 5;
const UNKNOWN_TYPE = 99;

/**
 * Encode every sample into one wire stream.
 *
 * @returns Concatenated frames.
 */
function wire(): Buffer {
  return Buffer.concat(samples.map((frame) => encodeFrame(frame)));
}

/**
 * Decode bytes with a fresh decoder.
 *
 * @param bytes - Wire bytes.
 * @returns Decoded frames.
 */
function decode(bytes: Uint8Array): Frame[] {
  const decoder = new FrameDecoder();
  return decoder.push(bytes);
}

/**
 * Expect a typed protocol error from a callback.
 *
 * @param run - Action that must fail.
 * @param code - Expected error code.
 */
function rejects(run: () => unknown, code: string): void {
  const isExpected = (error: unknown): boolean => error instanceof TerminalProtocolError && error.code === code;
  assert.throws(run, isExpected);
}

/**
 * Wrap a raw control body in a frame of the given type byte.
 *
 * @param type - Wire type byte.
 * @param body - Body text.
 * @returns Wire bytes.
 */
function raw(type: number, body: string): Buffer {
  const payload = Buffer.from(body);
  return Buffer.concat([Buffer.from([0, 0, 0, payload.length + 1, type]), payload]);
}

void test('every frame type round-trips whole', () => {
  for (const frame of samples) {
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push(encodeFrame(frame)), [frame]);
    assert.equal(decoder.idle, true);
  }
});

void test('frames split byte by byte decode identically', () => {
  const decoder = new FrameDecoder();
  const out: Frame[] = [];
  for (const byte of wire()) {
    out.push(...decoder.push(Uint8Array.of(byte)));
  }
  assert.deepEqual(out, samples);
  assert.equal(decoder.idle, true);
});

void test('coalesced frames decode in order across arbitrary chunks', () => {
  const bytes = wire();
  assert.deepEqual(decode(bytes), samples);
  const decoder = new FrameDecoder();
  const out: Frame[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK) {
    out.push(...decoder.push(bytes.subarray(at, at + CHUNK)));
  }
  assert.deepEqual(out, samples);
});

void test('a maximum-size frame is accepted and one byte more is rejected on encode', () => {
  const data = new Uint8Array(MAX_FRAME_BODY);
  data.fill(65);
  const frame: Frame = { type: 'data', data };
  assert.equal(decode(encodeFrame(frame)).length, 1);
  rejects(() => encodeFrame({ type: 'data', data: new Uint8Array(MAX_FRAME_BODY + 1) }), 'oversized');
});

void test('an oversized declaration fails from the header alone, before buffering a body', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(0xff_ff_ff_ff, 0);
  rejects(() => decode(header), 'oversized');
  header.writeUInt32BE(MAX_FRAME_BODY + 2, 0);
  rejects(() => decode(header), 'oversized');
});

void test('unknown, empty and malformed frames are typed errors', () => {
  rejects(() => decode(Buffer.from([0, 0, 0, 1, UNKNOWN_TYPE])), 'unknown_type');
  rejects(() => decode(Buffer.from([0, 0, 0, 0, 0])), 'malformed');
  rejects(() => decode(raw(TYPE_RESIZE, '{nope')), 'malformed');
  rejects(() => decode(raw(TYPE_RESIZE, '{"columns":80,"rows":24,"shell":"x"}')), 'invalid_frame');
  rejects(() => decode(raw(TYPE_CLOSE, '[]')), 'invalid_frame');
  rejects(() => decode(raw(TYPE_EXIT, '{"code":"0","signal":null}')), 'invalid_frame');
});

void test('resize bounds hold on encode and decode', () => {
  rejects(() => encodeFrame({ type: 'resize', columns: 0, rows: 24 }), 'invalid_frame');
  rejects(() => encodeFrame({ type: 'resize', columns: MAX_COLUMNS + 1, rows: 24 }), 'invalid_frame');
  rejects(() => encodeFrame({ type: 'resize', columns: 80, rows: MAX_ROWS + 1 }), 'invalid_frame');
  rejects(() => encodeFrame({ type: 'resize', columns: 1.5, rows: 24 }), 'invalid_frame');
  const edge: Frame = { type: 'resize', columns: MAX_COLUMNS, rows: MAX_ROWS };
  assert.deepEqual(decode(encodeFrame(edge)), [edge]);
  rejects(() => decode(raw(TYPE_RESIZE, '{"columns":9999,"rows":24}')), 'invalid_frame');
});

void test('a failed decoder stays failed and never resynchronizes', () => {
  const decoder = new FrameDecoder();
  rejects(() => decoder.push(Buffer.from([0, 0, 0, 1, UNKNOWN_TYPE])), 'unknown_type');
  assert.equal(decoder.idle, false);
  rejects(() => decoder.push(encodeFrame({ type: 'close' })), 'after_error');
});

void test('control bodies reject every embedded type and poison the stream', () => {
  for (const type of ['close', 'resize', null, 3]) {
    const decoder = new FrameDecoder();
    const bytes = raw(TYPE_RESIZE, JSON.stringify({ type, columns: 80, rows: 24 }));
    rejects(() => decoder.push(bytes), 'invalid_frame');
    rejects(() => decoder.push(encodeFrame({ type: 'close' })), 'after_error');
  }
});

void test('malformed UTF-8 in a valid-shaped JSON string poisons the decoder', () => {
  const prefix = Buffer.from('{"code":0,"signal":"');
  const suffix = Buffer.from('"}');
  for (const invalid of [[0xc3, 0x28], [0xff], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80]]) {
    const body = Buffer.concat([prefix, Buffer.from(invalid), suffix]);
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, body.length + 1, TYPE_EXIT]), body]);
    const decoder = new FrameDecoder();
    rejects(() => decoder.push(bytes), 'malformed');
    rejects(() => decoder.push(encodeFrame({ type: 'close' })), 'after_error');
  }
});

void test('valid multibyte control text survives every split and BOM-prefixed JSON is rejected', () => {
  const frame: Frame = { type: 'error', code: 'fixture', message: '\u{E9}\u{6F22}\u{1F33E}' };
  const bytes = encodeFrame(frame);
  for (let split = 0; split <= bytes.length; split += 1) {
    const decoder = new FrameDecoder();
    assert.deepEqual([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))], [frame]);
    assert.equal(decoder.idle, true);
  }
  rejects(() => decode(raw(TYPE_CLOSE, '\u{FEFF}{}')), 'malformed');
});
