# The clean Linux home mise/docker-test runs this repo's mise setup in. Only the
# toolchain lives here. The tools mise installs go to a volume at run time, so
# changing one pin reinstalls that tool rather than rebuilding every layer.
FROM debian:13-slim

COPY --from=ghcr.io/jdx/mise:2026.10.8 /usr/local/bin/mise /usr/local/bin/mise
COPY --from=oven/bun:1.4.3-debian /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
    && apt-get -y --no-install-recommends install ca-certificates curl gcc git libc6-dev unzip xz-utils zsh \
    && rm -rf /var/lib/apt/lists/*

# The checkout is mounted from the host and owned by a uid that is not this one.
RUN git config --system safe.directory '*'

RUN useradd --create-home --shell /bin/zsh dotfiles
USER dotfiles

# Created here so the volume mounted over it is owned by this user.
RUN mkdir -p /home/dotfiles/.local/share/mise
