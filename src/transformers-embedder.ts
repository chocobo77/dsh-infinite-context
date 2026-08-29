/**
 * Optional semantic embedder backed by `@huggingface/transformers`
 * (transformers.js), defaulting to `all-MiniLM-L6-v2` (384-dim).
 *
 * This module is isolated so its optional dependency does not affect the
 * dependency-free core. It is loaded lazily by {@link createEmbedder} only
 * when the configuration selects the `transformers` kind.
 *
 * @module dsh-infinite-context/transformers-embedder
 */

import type { Embedder } from './embedder.ts'
import { normalize } from './embedder.ts'

/** The default lightweight semantic model (384 dimensions). */
export const DEFAULT_TRANSFORMERS_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'

type Pipeline = (input: string, options?: Record<string, unknown>) => Promise<{ data: number[] }>

/**
 * A true semantic embedder using a sentence-transformers ONNX model via
 * transformers.js. Requires the optional `@huggingface/transformers` package
 * to be installed; the first call downloads the model (cached afterwards).
 * Type declarations for the optional dependency live in `types/transformers-module.d.ts`.
 */
export class TransformersEmbedder implements Embedder {
  dimension: number
  readonly name: string
  private readonly modelName: string
  private pipelinePromise: Promise<Pipeline> | null = null

  /**
   * @param modelName - Hugging Face model id (default all-MiniLM-L6-v2).
   * @param dimension - expected output dimension (default 384).
   */
  constructor(modelName: string = DEFAULT_TRANSFORMERS_MODEL, dimension = 384) {
    this.modelName = modelName
    this.dimension = dimension
    this.name = `transformers:${modelName}`
  }

  private async pipeline(): Promise<Pipeline> {
    if (this.pipelinePromise === null) {
      this.pipelinePromise = (async () => {
        let mod: { pipeline: (task: string, model: string) => Promise<Pipeline> }
        try {
          mod = await import('@huggingface/transformers')
        } catch (error) {
          throw new Error(
            'the "transformers" embedder requires the optional dependency @huggingface/transformers. '
            + 'Install it (pnpm add @huggingface/transformers) or switch the embedder kind to "lightweight". '
            + `Original error: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return mod.pipeline('feature-extraction', this.modelName)
      })()
    }
    return this.pipelinePromise
  }

  async embed(text: string): Promise<number[]> {
    const run = await this.pipeline()
    const result = await run(text, { pooling: 'mean', normalize: true })
    const data = Array.from(result.data)
    if (data.length !== this.dimension) {
      // The model's real dimension wins; record it so callers stay consistent.
      this.dimension = data.length
    }
    return normalize(data)
  }
}
