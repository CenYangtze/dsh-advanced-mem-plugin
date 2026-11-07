/**
 * Type-only declaration for the memory snapshot message source.
 *
 * Both the Host recall plugin and the browser recall card need this shape.
 * Keeping it in a leaf module lets each compiler face include the declaration
 * without pulling the other face's runtime source into its program.
 *
 * @module dsh-advanced-mem-plugin/memory-recall/source
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A once-per-turn memory snapshot, excluded from user-authored capture. */
    'memory-recall': {
      kind: 'memory-recall'
      form: 'snapshot'
      sections: { name: string; text: string }[]
    }
  }
}

export {}
