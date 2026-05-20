FROM oven/bun:1-alpine

WORKDIR /app

# Copy manifest first for layer cache
COPY package.json ./
RUN bun install --production --no-save || true

# App source
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["bun", "run", "server.js"]
