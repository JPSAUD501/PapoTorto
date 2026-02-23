# PapoTorto (Convex-Only)

Backend, banco e realtime rodam no Convex. Sem backend Bun de API, sem SQLite/Postgres e sem transporte socket manual.

## Requisitos

- Bun 1.3+
- Projeto Convex configurado
- OPENROUTER_API_KEY
- VITE_CONVEX_URL
- ADMIN_PASSCODE

## Setup inicial

```bash
bun install
bun run dev:convex
```

Se for o primeiro setup do projeto Convex local, o comando acima orienta a vinculacao do deployment.

## Desenvolvimento

Terminal 1:

```bash
bun run dev:convex
```

Terminal 2:

```bash
bun run dev:web
```

Paginas:

- /index.html (live)
- /history.html
- /admin.html
- /broadcast.html

## Admin HTTP Actions (Convex)

- POST /admin/login
- GET /admin/status
- POST /admin/pause
- POST /admin/resume
- POST /admin/reset
- GET /admin/export

Autorizacao: header x-admin-passcode com ADMIN_PASSCODE.

## Votacao via chat (Fossabot)

A votacao da plateia e feita via chat (Twitch/YouTube) com Fossabot.

Guia completo:

- `README.fossabot.md`

## Build web

```bash
bun run build:web
bun run preview:web
```

## Stream worker

```bash
bun run start:stream
```

Dry-run local:

```bash
bun run start:stream:dryrun
```

Capture sink: envio por HTTP POST /chunks.

Configuracao de destino RTMP (qualquer plataforma):

- `STREAM_RTMP_TARGET` (URL completa com stream key)

## Coolify (2 servicos)

1. web
- Dockerfile: Dockerfile
- Porta: 5109
- Variaveis: VITE_CONVEX_URL

2. stream-worker
- Dockerfile: Dockerfile.stream
- Sem porta publica obrigatoria
- Variaveis: `BROADCAST_URL`, `STREAM_RTMP_TARGET`, `STREAM_APP_PORT`, `STREAM_*` opcionais
