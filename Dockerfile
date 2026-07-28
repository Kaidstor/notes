FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN bun run build

# В рантайм едет только dist: бандл сервера одним файлом и собранный фронт.
# Ни исходников, ни node_modules — из контейнера нечего доставать `docker cp`.
FROM oven/bun:1.3-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["bun", "dist/server.js"]
