# Game server image. Runs the TypeScript server directly through tsx — no build
# step, same entrypoint as `npm run server`. Works on ARM (Oracle Ampere A1):
# rapier3d-compat is wasm and three/ws are pure JS, so there's nothing to compile.
FROM node:20-alpine

WORKDIR /app

# Install all deps including devDependencies — tsx (the runtime) lives there.
COPY package*.json ./
RUN npm install --include=dev

COPY . .

# Internal port; Caddy terminates TLS and proxies to it. Override with $PORT.
EXPOSE 8787

CMD ["npx", "tsx", "src/server/index.ts"]
