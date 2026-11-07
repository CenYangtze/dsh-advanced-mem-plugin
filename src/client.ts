import type { Context } from '@deepseek-ai/cordis'
import { apply as applySettings, inject as settingsInject } from './experience-harness/client/index.ts'
import { apply as applyMemoryUi, inject as memoryUiInject } from './kylin-memory-ui/client/index.ts'

/** Services shared by the settings and Kylin visual memory companions. */
export const inject = [...new Set([...settingsInject, ...memoryUiInject])]

/** Register both browser surfaces without replacing existing model settings. */
export function apply(ctx: Context): void {
  applySettings(ctx)
  applyMemoryUi(ctx)
}
