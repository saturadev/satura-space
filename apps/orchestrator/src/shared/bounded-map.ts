export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly cap: number) {
    super()
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined
    const value = super.get(key) as V
    super.delete(key)
    super.set(key, value)
    return value
  }

  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    while (this.size > this.cap) super.delete(this.keys().next().value as K)
    return this
  }
}
