/**
 * Typed view of the compiled `secrets-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/secrets-model.js' {
  /** One secret without its value. */
  interface SecretView {
    /** Name. */
    readonly name: string;
    /** Version. */
    readonly version: number;
    /** Keyed fingerprint. */
    readonly fingerprint: string;
    /** Granted types. */
    readonly grants: readonly string[];
    /** Created. */
    readonly createdAt: number;
    /** Changed. */
    readonly updatedAt: number;
  }

  /** One audit entry. */
  interface AuditView {
    /** When. */
    readonly at: number;
    /** What changed. */
    readonly action: 'created' | 'rotated' | 'regranted' | 'deleted';
    /** Name. */
    readonly name: string;
    /** Grants after the change. */
    readonly grants: readonly string[];
  }

  /** Secrets view model. */
  interface SecretsModel {
    /** Secrets. */
    readonly secrets: readonly SecretView[];
    /** Audit entries. */
    readonly audit: readonly AuditView[];
    /** Grantable types. */
    readonly types: readonly { readonly name: string; readonly label: string }[];
  }

  /**
   * Read the Secrets view model.
   *
   * @param snapshot - Live snapshot.
   * @returns Model.
   */
  export function readSecrets(snapshot: unknown): SecretsModel;

  /**
   * Why a name cannot be used.
   *
   * @param name - Environment variable name as typed.
   * @param existing - Names in use.
   * @returns Problem or null.
   */
  export function nameProblem(name: string, existing: readonly string[]): string | null;

  /**
   * Why a value cannot be saved.
   *
   * @param value - Secret value as typed.
   * @returns Problem or null.
   */
  export function valueProblem(value: string): string | null;

  /**
   * The version-checked save.
   *
   * @param change - What to save.
   * @returns Operator control.
   */
  export function secretSaveInput(change: {
    readonly name: string;
    readonly value: string | null;
    readonly grants: readonly string[];
    readonly existing: SecretView | null;
  }): { readonly operation: 'factory_secret_save'; readonly input: Record<string, unknown> };

  /**
   * The version-checked deletion.
   *
   * @param secret - Secret metadata as shown.
   * @returns Operator control.
   */
  export function secretDeleteInput(secret: SecretView): {
    readonly operation: 'factory_secret_delete';
    readonly input: Record<string, unknown>;
  };

  /**
   * Who receives a secret.
   *
   * @param secret - Secret metadata as shown.
   * @param types - Types with labels.
   * @returns Sentence for the view.
   */
  export function grantText(secret: SecretView, types: SecretsModel['types']): string;

  /**
   * One audit line.
   *
   * @param entry - Audit record.
   * @returns Sentence for the view.
   */
  export function auditText(entry: AuditView): string;
}
