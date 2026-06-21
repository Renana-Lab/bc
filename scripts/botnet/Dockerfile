FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true --non-interactive

COPY scripts ./scripts
COPY src/real_ethereum/build ./src/real_ethereum/build
COPY src/real_ethereum/marketConfig.js ./src/real_ethereum/marketConfig.js
COPY src/real_ethereum/factoryAddress.js ./src/real_ethereum/factoryAddress.js

ENV BOTNET_PORT=3002
EXPOSE 3002

CMD ["npm", "run", "botnet:api"]
