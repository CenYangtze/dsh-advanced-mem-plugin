/**
 * Browser-face Context contract for the Kylin memory UI.
 *
 * The shell installs `ctx.connection` as the browser {@link ConnectionHandle}
 * when it boots the client; `@deepseek-ai/dsh-client-connection/client` does not
 * merge that property into `Context` itself. This type-only file belongs to the
 * Client compiler face and is excluded from the Host face, whose `connection`
 * service has a different shape.
 *
 * @module dsh-advanced-mem-plugin/kylin-memory-ui/client-contract
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser Connection service installed by the shell. */
    connection: ConnectionHandle
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewNode {
    /** Chat nodes may carry their render grouping; other targets leave it absent. */
    readonly groupTree?: 'exchange' | 'input' | 'turn' | 'process'
  }
}

export {}
