# Provider paths

One wire style is supported and named: the **Meta Model API**. Two generic
shapes are documented so an endpoint you own can be adapted without code
changes - they are the same request and the same response, only the envelope
differs.

| Provider | Endpoint | Auth header | Body shape |
|---|---|---|---|
| Meta Model API | `https://api.meta.ai/v1/messages` | `Authorization: Bearer <key>` | messages array |
| messages-style endpoint | `{BASE_URL}/v1/messages` | `x-api-key: <key>` plus a version header | `messages`, `max_tokens`, `system` |
| chat-style endpoint | `{BASE_URL}/chat/completions` | `Authorization: Bearer <key>` | `messages: [{role, content}]` |

## Notes

- **One base URL per session.** A client that talks to a single base URL cannot switch between endpoints that speak different dialects unless something in the middle translates. That is the whole reason a bridge exists rather than a single hardcoded call.
- **Model names are not portable.** A model name means nothing to an endpoint that does not host it, so the bridge keeps the model name in configuration, never in code.
- **Status codes worth handling:** 401 means the key is wrong, 402 means the account has a billing problem, 429 means slow down, 5xx means retry once with backoff. Never retry a 401 or a 402.
- **Cost.** A gesture request is a few hundred bytes in and a two-line JSON out. Even a generous per-request price is negligible at human gesture rates, which is why this is a good use of a hosted model rather than a local one.

## What is not built

There is no live call in this repository. `gesture-bridge.example.js` shows where the adapter plugs in; the built-in shape matcher remains the working path today.
