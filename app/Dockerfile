# Party Line server + web app in one small image.
FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY web /app/web
# Which version this is (commit and date), shown in the developer panel. Set by deploy/update.sh.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
