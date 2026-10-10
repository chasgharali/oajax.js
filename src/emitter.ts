type Listener = (payload: never) => void

/** A minimal typed event emitter. A throwing listener never breaks the others. */
export function createEmitter<Events extends object>() {
  const listeners = new Map<keyof Events, Set<Listener>>()
  return {
    on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): () => void {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(fn as Listener)
      return () => set!.delete(fn as Listener)
    },
    off<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): void {
      listeners.get(event)?.delete(fn as Listener)
    },
    emit<E extends keyof Events>(event: E, payload: Events[E]): void {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          ;(fn as (p: Events[E]) => void)(payload)
        } catch (err) {
          console.error(`oajax: a "${String(event)}" listener threw`, err)
        }
      }
    },
  }
}
