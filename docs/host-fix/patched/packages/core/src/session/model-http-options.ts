import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

export const withWebRequestOptions = <A, E, R>(request: Request, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(FetchHttpClient.Fetch, (fetch) =>
    Effect.provideService(effect, FetchHttpClient.Fetch, (input, init) =>
      fetch(input, {
        ...init,
        redirect: request.redirect,
        signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
    ),
  )
