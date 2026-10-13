// Provided by the running dsh install (peer); only its plugin shape is used here.
declare module '@deepseek-ai/dsh-mcp-client' {
  import type { Context } from '@deepseek-ai/cordis'
  export const name: string
  export const inject: string[]
  export const Config: unknown
  export function apply(ctx: Context, config: unknown): Promise<void>
}
