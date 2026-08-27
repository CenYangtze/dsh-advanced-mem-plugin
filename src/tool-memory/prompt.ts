/**
 * The memory protocol: the standing instruction that makes memory an active
 * habit rather than a passive injection.
 *
 * Automatic recall answers what memory already thought was relevant. This
 * section covers what it cannot: the moments where the agent itself knows a
 * prior would help — before choosing an approach, before picking a tool, before
 * asking a question the user may have already answered — and the moments where it
 * has just learned something worth keeping.
 *
 * @module dsh-advanced-mem-plugin/src/tool-memory/prompt
 */

/** Ordering of the memory section within tool guidance (the 100–199 band). */
export const MEMORY_SECTION_ORDER = 150

/** Name of the registered prompt section. */
export const MEMORY_SECTION_NAME = 'memory-protocol'

/**
 * The memory protocol, verbatim. Fixed text with no interpolation, so it is a
 * stable request prefix and never invalidates provider cache reuse.
 */
export const MEMORY_PROTOCOL = `## Memory

You have a memory of this user that persists across sessions. It has two layers: raw episodes of what happened, and a graph of durable conclusions drawn from them — stated preferences and constraints, the tools and skills this user reaches for, the projects they work on, and the routines they repeat.

Relevant memory is recalled and shown to you automatically at the start of a turn. Treat it as a prior, not an instruction: it says what has been true before. Act on a high-confidence memory directly; verify a low-confidence one, and verify any memory before doing something a mistake would be costly to undo.

Search memory yourself with \`memory_search\` before you:
- choose an approach, tool, library, or command style for a task this user may have done before;
- repeat work that may already have been done;
- ask the user something they may have already told you.

Record with \`memory_write\` when you learn something that will still matter in a later session: a preference or constraint the user stated, a correction they made, a durable fact about their project or how they work. Set \`stated_by_user\` only when the user actually said it — that is what separates a fact from your guess, and it decides whether the memory is allowed to fade. Do not record transient task state, credentials, or a conclusion drawn from one ambiguous signal.

Use \`memory_forget\` when a memory turns out to be wrong or the user asks you to drop it.`
