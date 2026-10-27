# Toolchain for mise/docker-test. Tools install to a volume at run time.
FROM debian:13-slim

COPY --from=ghcr.io/jdx/mise:2026.10.20 /usr/local/bin/mise /usr/local/bin/mise
COPY --from=oven/bun:1.4.4-debian /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
    && apt-get -y --no-install-recommends install ca-certificates curl gcc git libc6-dev zsh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/zsh dotfiles
USER dotfiles

# Owned by this user, or the volume mount creates it as root.
RUN mkdir -p /home/dotfiles/.local/share/mise
