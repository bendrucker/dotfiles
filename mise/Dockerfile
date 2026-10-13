# A clean Linux home for mise/docker-test. Tools install to a volume at run
# time, so this image changes only when a pin below does.
FROM debian:13-slim

COPY --from=ghcr.io/jdx/mise:2026.10.8 /usr/local/bin/mise /usr/local/bin/mise
COPY --from=oven/bun:1.4.3-debian /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
    && apt-get -y --no-install-recommends install ca-certificates curl gcc git libc6-dev zsh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/zsh dotfiles
USER dotfiles

# Otherwise mounting the volume creates ~/.local as root.
RUN mkdir -p /home/dotfiles/.local/share/mise
