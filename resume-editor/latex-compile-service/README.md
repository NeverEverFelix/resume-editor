# LaTeX Compile Service

## Endpoints
- `GET /health`
- `POST /compile` (Bearer auth required)

## Environment Variables
- `PORT` (default: `8080`)
- `INTERNAL_API_TOKEN` (required for `/compile`)
- `MAX_TEX_BYTES` (default: `200000`)
- `COMPILE_TIMEOUT_MS` (default: `20000`)
- `MAX_LOG_CHARS` (default: `50000`)
- `TEX_ENGINE` (default: `pdflatex`)
- `TEX_RUNS` (default: `2`)
- `STUB_MODE` (default: `false`)

## Run Locally
```bash
cd latex-compile-service
INTERNAL_API_TOKEN=dev-token node server.js
```

## Smoke Tests
```bash
curl -sS http://localhost:8080/health
```

```bash
curl -sS http://localhost:8080/compile \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"tex_source":"\\documentclass{article}\\begin{document}Hello\\end{document}"}'
```

Expected compile response (in stub mode): `ok: true` and `pdf_base64`.

## Notes
- In default mode (`STUB_MODE=false`), the service runs real LaTeX compilation via `pdflatex`.
- Compilation runs in a temporary directory and cleans up files after every request.
- `-no-shell-escape` is enforced for `pdflatex`.
- Common unsafe TeX primitives are rejected before compile.
- In `STUB_MODE=true`, the service returns a minimal valid PDF without running TeX.

## Docker (Railway-ready)
Build image:
```bash
cd latex-compile-service
docker build -t latex-compile-service:local .
```

Run container:
```bash
docker run --rm -p 8080:8080 \
  -e INTERNAL_API_TOKEN=dev-token \
  latex-compile-service:local
```

## Deploy on Railway
1. Create a new Railway service from this folder (`latex-compile-service`) using `Dockerfile`.
2. Set service environment variables:
   - `INTERNAL_API_TOKEN=<strong-random-token>`
   - optional overrides: `COMPILE_TIMEOUT_MS`, `MAX_TEX_BYTES`, `TEX_RUNS`
3. Deploy and verify:
   - `GET <railway-url>/health`
   - `POST <railway-url>/compile` with `Authorization: Bearer <INTERNAL_API_TOKEN>`

## Wire Supabase To Railway
After Railway is healthy, update Supabase secrets:
```bash
supabase secrets set --project-ref <project-ref> \
  LATEX_COMPILE_SERVICE_URL=https://<your-railway-domain> \
  LATEX_COMPILE_INTERNAL_TOKEN=<same-internal-api-token>
```

Then redeploy (or no-op deploy) `compile-tailored-resume-pdf`:
```bash
supabase functions deploy compile-tailored-resume-pdf --project-ref <project-ref>
```
