# Render sandbox image (F12/F14).
#
# Renders one visual brief's code in headless Chromium and emits every frame as
# PNG. The image is pinned by digest so the same code always renders in the same
# browser — that is what makes "same code, same brief, same image → same frames"
# a real guarantee rather than a hope.
#
# The Playwright base image ships the browser and its system libraries already,
# so nothing is installed at build time except the small Node client the harness
# imports. No `apt-get`, no fonts fetched over the network: every addition is
# attack surface for no payoff.
FROM mcr.microsoft.com/playwright:v1.49.0-noble@sha256:0fc07c73230cb7c376a528d7ffc83c4bdcdcd3fc7efbe54a2eed72b1ec118377

# A dependency-free harness: it resolves playwright-core from this directory.
WORKDIR /opt/render

# playwright-core only — no test runner, no browser download (the base image
# already has the browser at the version this client expects).
RUN npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund playwright-core@1.49.0 >/dev/null 2>&1 \
  && npm cache clean --force >/dev/null 2>&1

COPY harness.mjs /opt/render/harness.mjs

# Root-owned and read-only to the run user: the browser and the harness cannot
# be rewritten by the code they render.
RUN chmod 0555 /opt/render/harness.mjs \
  && chown -R root:root /opt/render

# The container runs as the image's unprivileged user (uid 1000), not root:
# Chromium's own sandbox is disabled in the harness because it needs a namespace
# the container does not provide, and a non-root process is what replaces it.
USER 1000:1000
ENV HOME=/tmp

# -I isolates from PYTHONPATH-style env injection; the harness reads the job from
# stdin and writes one NDJSON record to stdout.
ENTRYPOINT ["node", "/opt/render/harness.mjs"]
