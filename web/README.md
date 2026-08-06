# One Million Payments per Second

Interactive capacity model for comparing vanilla Solana transfers, payment-channel v1,
and the proposed ADR-004 payment-channel v2 path. Timeline presets load upgrade-phase
assumptions, while every network, lifecycle, rent, and batching input remains editable.

## Quick Start

```bash
pnpm install
just dev
```

The app opens at `http://localhost:5173`.

## Development

- `just dev` — Start dev server with hot reload
- `just build` — Build for production
- `just lint` — Run ESLint
- `just format` — Format code with Prettier
- `just preview` — Preview production build locally

## Stack

- **React 18** — UI framework
- **TypeScript** — Type safety
- **Vite** — Fast bundling and dev server
- **ESLint + Prettier** — Code quality

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` builds this directory and publishes `web/dist` to GitHub
Pages on every push to `main` that touches `web/**`. Enable it once under
**Settings → Pages → Source: GitHub Actions**; the site then serves at
`https://solana-foundation.github.io/payment-channels/`.

The Vite `base` defaults to `/payment-channels/` (project-page path). It must match the
repo slug that serves Pages; for a custom domain build with `PAGES_BASE=/ pnpm build`
(or change the default in `vite.config.ts`).

> **Note:** the compute-unit constants in `src/App.tsx` are a point-in-time mainnet
> snapshot (measured from program `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`), not a
> live feed. They are a planning model, not real-time telemetry.
