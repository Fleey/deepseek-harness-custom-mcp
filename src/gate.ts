/**
 * Per-tool switches for one MCP server.
 *
 * dsh-mcp-client registers every tool its server lists and has no filter of
 * its own, and the tools service's `restrict()` only works inside an agent
 * scope. So each client child is forked from a context whose `tools` is a
 * {@link ToolGate}: it keeps every definition the client hands over — which is
 * also where the settings page gets descriptions and input schemas — and
 * forwards only the switched-on ones to the real registry. Switching a tool
 * registers or withdraws it in place; the connection is left alone.
 */

/** The fields of a tool definition this plugin reads; the rest passes through untouched. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description?: unknown
  readonly parameters?: unknown
}

export interface ToolRegistry {
  register(definition: ToolDefinitionLike): () => void
}

export interface ToolInfo {
  /** Name after `mcp__<server>__`: the key `disabledTools` uses. */
  name: string
  description: string
  /** JSON Schema of the arguments, as the server declared it. */
  parameters?: unknown
  /** Whether the model can call it now. */
  enabled: boolean
}

export class ToolGate {
  /** Every definition of the client's current generation, by public name. */
  private readonly offered = new Map<string, ToolDefinitionLike>()
  /** Disposers of the definitions forwarded to the real registry, by public name. */
  private readonly live = new Map<string, () => void>()
  private disabled: ReadonlySet<string>
  private closed = false

  /**
   * @param prefix - `mcp__<server>__`, stripped to get the names `disabled` holds.
   * @param registry - the real tools service.
   * @param disabled - names of the tools to keep from the model.
   * @param onError - told when switching a tool on or off failed.
   */
  constructor(
    private readonly prefix: string,
    private readonly registry: ToolRegistry,
    disabled: Iterable<string>,
    private readonly onError: (tool: string, error: unknown) => void = () => {},
  ) {
    this.disabled = new Set(disabled)
  }

  private short(name: string): string {
    return name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name
  }

  private wanted(name: string): boolean {
    return !this.closed && !this.disabled.has(this.short(name))
  }

  /**
   * The `tools` service the MCP client sees: `register` goes through the gate,
   * other members reach the real service unchanged. Symbol keys are hidden so
   * Cordis does not take the facade for the service itself and re-bind it.
   */
  facade<T extends object>(tools: T): T {
    const register = (definition: ToolDefinitionLike) => this.register(definition)
    return new Proxy(tools, {
      get: (target, prop) => {
        if (prop === 'register') return register
        if (typeof prop === 'symbol') return undefined
        const value: unknown = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /** Same contract as the registry's `register`: a duplicate or a refused definition throws. */
  register(definition: ToolDefinitionLike): () => void {
    const name = definition.name
    if (this.offered.has(name)) throw new Error(`tool "${name}" is already registered`)
    if (this.wanted(name)) this.live.set(name, this.registry.register(definition))
    this.offered.set(name, definition)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.offered.get(name) !== definition) return
      this.offered.delete(name)
      this.withdraw(name)
    }
  }

  /** Switch tools to match a new list of disabled names. */
  update(disabled: Iterable<string>): void {
    this.disabled = new Set(disabled)
    for (const [name, definition] of this.offered) {
      const live = this.live.has(name)
      if (live && !this.wanted(name)) {
        this.withdraw(name)
      } else if (!live && this.wanted(name)) {
        try {
          this.live.set(name, this.registry.register(definition))
        } catch (error) {
          this.onError(this.short(name), error)
        }
      }
    }
  }

  private withdraw(name: string): void {
    const dispose = this.live.get(name)
    if (dispose === undefined) return
    this.live.delete(name)
    try {
      dispose()
    } catch (error) {
      this.onError(this.short(name), error)
    }
  }

  /** Every tool the server offers, switched on or off, in name order. */
  list(): ToolInfo[] {
    return [...this.offered.values()]
      .map(definition => ({
        name: this.short(definition.name),
        description: typeof definition.description === 'string' ? definition.description : '',
        parameters: definition.parameters,
        enabled: this.live.has(definition.name),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** Withdraw every tool; registrations arriving later are kept from the registry. */
  close(): void {
    this.closed = true
    for (const name of [...this.live.keys()]) this.withdraw(name)
    this.offered.clear()
  }
}
