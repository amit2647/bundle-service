FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# The registry: the parent repo's bundles/ directory, passed in as the build
# context named "bundles" (docker-compose.yml → additional_contexts). Bundles
# are built into the image and never uploaded at run time.
COPY --from=bundles . /app/registry

ENV BUNDLE_REGISTRY_DIR=/app/registry

EXPOSE 4008

CMD ["npm", "start"]
