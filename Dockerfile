# syntax=docker/dockerfile:1
# The directive above has to be the first line. It pins the stable frontend,
# which is what guarantees `RUN --mount=type=secret` below.

# bookworm-slim for the same reason as the platform's other Node images: it
# tracks Debian's glibc and Node's own release-testing matrix.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

WORKDIR /app

COPY package.json package-lock.json ./

# `@branchleft/tsconfig` and the descriptor types are build-time dependencies
# hosted on GitHub Packages, which rejects anonymous reads even for a public
# package. The token arrives as a BuildKit secret and is written to a userconfig
# that lives and dies inside this one RUN, so it never becomes part of a layer
# and is not reachable from the built image. `npm ci` fails closed if the secret
# is absent. --ignore-scripts: nothing here needs an install script.
RUN --mount=type=secret,id=node_auth_token \
    sh -eu -c 'printf "@branchleft:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/node_auth_token)" > /tmp/npmrc; \
      NPM_CONFIG_USERCONFIG=/tmp/npmrc npm ci --ignore-scripts; \
      rm -f /tmp/npmrc'

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# There are no runtime dependencies: pruning leaves only the compiled service.
RUN npm prune --omit=dev

# No config, username file, password file, signing key or audit file is baked
# in. All five are bind-mounted at run time and named by --config or
# SAFETY_SERVICE_CONFIG. The service only dials out, so there is nothing to
# expose.
# Numeric, so the non-root check does not depend on the base image's /etc/passwd.
# 1000:1000 is the base image's `node` user.
USER 1000:1000
CMD ["node", "dist/bin.js"]
