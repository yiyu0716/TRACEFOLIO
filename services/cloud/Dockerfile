FROM node:22-bookworm-slim
WORKDIR /app
COPY services/cloud/package.json services/cloud/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY services/cloud/src ./src
ENV NODE_ENV=production TRACEFOLIO_CLOUD_HOST=0.0.0.0
USER node
EXPOSE 4310
CMD ["npm", "start"]
