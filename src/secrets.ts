/**
 * One-way identity hashing and bounded literal secret redaction.
 *
 * @file
 */
import { createHash } from 'node:crypto';

/** Astral Unicode characters require two UTF-16 code units. */
const MAX_SINGLE_UNIT_POINT = 65_535;

/**
 * Hash a high-entropy identity secret without persisting the raw value.
 *
 * @param value - Random identity credential.
 * @returns Stored SHA-256 digest.
 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Redact known local credentials before captured output reaches disk or clients. */
export class SecretRedactor {
  /** Known literal values, excluding empty strings. */
  private readonly secrets: readonly string[];
  /** Enough trailing input to fence a secret split between native chunks. */
  private readonly overlap: number;
  /** Bounded not-yet-emitted input, never persisted unredacted. */
  private pending = '';

  /**
   * Build a per-stream redactor without copying values into artifacts.
   *
   * @param secrets - Credentials already owned by the coordinating backend.
   */
  public constructor(secrets: readonly string[]) {
    this.secrets = secrets.filter((secret) => secret !== '').toSorted((left, right) => right.length - left.length);
    this.overlap = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  /**
   * Emit safe output while retaining only the possible split-secret boundary.
   *
   * @param chunk - Native decoded process output.
   * @returns Redacted committed output prefix.
   */
  public write(chunk: string): string {
    this.pending += chunk;
    const boundary = Math.max(0, this.pending.length - this.overlap);
    const output: string[] = [];
    let offset = 0;
    while (offset < boundary) {
      const position = offset;
      const match = this.secrets.find((value) => this.pending.startsWith(value, position));
      if (match === undefined) {
        const point = this.pending.codePointAt(offset);
        const length = point !== undefined && point > MAX_SINGLE_UNIT_POINT ? 2 : 1;
        output.push(this.pending.slice(offset, offset + length));
        offset += length;
      } else {
        // Consume the complete match; emitting its prefix can reconstruct an overlapping credential later.
        output.push('[REDACTED]');
        offset += match.length;
      }
    }
    this.pending = this.pending.slice(offset);
    return output.join('');
  }

  /**
   * Flush the final bounded suffix after native output ends.
   *
   * @returns Redacted final suffix.
   */
  public finish(): string {
    const output = this.redact(this.pending);
    this.pending = '';
    return output;
  }

  /**
   * Replace complete literal credentials without interpreting regex syntax.
   *
   * @param value - Complete committed text.
   * @returns Text safe from these known credentials.
   */
  public redact(value: string): string {
    let output = value;
    for (const secret of this.secrets) {
      output = output.replaceAll(secret, '[REDACTED]');
    }
    return output;
  }
}
