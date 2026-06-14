# Macode Auth Bridge

This server lets the image playground reuse the existing New API MySQL user database.

It does not proxy image generation. It only:

- verifies macode / New API username or email plus password against `users`
- issues a local JWT for this playground session
- reads the signed-in user's latest usable token from `tokens`
- returns that token as an OpenAI-compatible `sk-...` API key

## Setup

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

The default port is `3004`. In local Vite development, `/api/*` is proxied to this server.

## Important

`ALLOW_PASSWORD_REGISTER` defaults to `false` so this app does not accidentally write directly into a production New API user table. Create users and tokens in macode / New API, then log in here with the same account.
