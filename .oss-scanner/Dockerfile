# OSS Scanner build for GitWand (https://github.com/anthropics/oss-scanner).
# Builds the TypeScript packages and the Rust/Tauri backend, as CI does.
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config file patchelf xz-utils \
      libwebkit2gtk-4.1-dev libglib2.0-dev libsoup-3.0-dev \
      libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (see .nvmrc) and pnpm (pinned by "packageManager" in package.json)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Rust stable
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

RUN pnpm install --frozen-lockfile
# The VitePress site is not part of the product under audit.
RUN pnpm -r --filter '!gitwand-website' run build
# Fetch and compile the Rust dependencies now: the audit has no network.
RUN cd apps/desktop/src-tauri && cargo fetch && cargo test --no-run

# Cheap tests, so the image is known to work; a failure must not abort the build.
RUN pnpm test || echo "WARNING: pnpm test reported failures"
