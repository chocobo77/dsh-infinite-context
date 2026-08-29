/**
 * Ambient type declaration for the optional `@huggingface/transformers`
 * dependency (transformers.js). The package is loaded lazily; this stub keeps
 * typecheck working when it is not installed. When installed, its own types
 * are used instead at runtime (this declaration only affects type resolution).
 */

declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model: string,
  ): Promise<(input: string, options?: Record<string, unknown>) => Promise<{ data: number[] }>>
}
