FROM node:24-alpine AS build
WORKDIR /automation-service
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /automation-service
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /automation-service/dist ./dist
EXPOSE 3003
CMD ["node", "dist/server.js"]
