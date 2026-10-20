# Shared types (`@cn/shared`)

Zod schemas and TypeScript types that the gateway, portal, dashboard and agent agree on:

- **Southbound API:** slice catalogue, stats, limit update, demand control.
- **Portal API:** join request/response, bound device, slice snapshot.
- **Formatters:** `formatBandwidth`, `formatLatency` and `formatPercent`. They show `—` for unknown
  values.

The other packages import the built output, so build this package first. `npm run build` at the
root does it.

```bash
npm run build -w @cn/shared
```
