FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    WHATSAPP_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787
VOLUME /data
EXPOSE 8787
USER node
ENTRYPOINT ["node", "src/cli.js"]
CMD ["serve", "--http"]
