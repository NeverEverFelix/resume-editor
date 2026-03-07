FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV STUB_MODE=false
ENV COMPILE_TIMEOUT_MS=20000
ENV MAX_TEX_BYTES=200000
ENV MAX_LOG_CHARS=50000
ENV TEX_ENGINE=pdflatex
ENV TEX_RUNS=2

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-lang-english \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node server.js /app/server.js

USER node
EXPOSE 8080

CMD ["node", "server.js"]
