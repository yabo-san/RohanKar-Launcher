FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

COPY --from=jdxcode/mise /usr/local/bin/mise /usr/local/bin/mise

# xvfb for the headless e2e run, the libraries Electron's Linux build links
# against, python3 for pre-commit, and a toolchain in case better-sqlite3 has
# no prebuilt binary for the installed Electron
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        xvfb xauth \
        libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 \
        libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
        python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN echo 'eval "$(mise activate bash)"' >> /home/vscode/.bashrc \
    && echo 'eval "$(mise activate zsh)"' >> /home/vscode/.zshrc
