FROM node:22-alpine

# No dependencies: the bridge is plain ESM on the Node standard library.
WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=3010
EXPOSE 3010

# Run unprivileged. Override with `user:` in compose when the secret files are
# owned by another uid.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/bridge.mjs"]
