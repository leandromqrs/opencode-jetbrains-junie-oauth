/** Rejects on abort even when the operation ignores its signal; removes the listener on settlement. */
export async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal, message = "Cancelled"): Promise<T> {
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(message))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort) }
}
