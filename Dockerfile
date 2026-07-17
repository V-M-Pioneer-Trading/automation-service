FROM node:22-alpine AS build
WORKDIR /automation-service
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /automation-service
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /automation-service/dist ./dist
EXPOSE 3003
CMD ["node", "dist/server.js"]
