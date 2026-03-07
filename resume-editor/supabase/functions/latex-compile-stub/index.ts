import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

const MAX_TEX_BYTES = Number.parseInt(Deno.env.get("MAX_TEX_BYTES") ?? "200000", 10);
const INTERNAL_API_TOKEN = Deno.env.get("INTERNAL_API_TOKEN") ?? "";

// Minimal valid PDF for integration testing.
const STUB_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCA+PiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgOTAgVGQKKFN0dWIgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxMCAwMDAwMCBuIAowMDAwMDAwMDYwIDAwMDAwIG4gCjAwMDAwMDAxMTcgMDAwMDAgbiAKMDAwMDAwMDIyNyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjMyMwolJUVPRgo=";

class HttpError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function parseBearerToken(authHeader: string | null): string {
  if (!authHeader) {
    throw new HttpError(401, "MISSING_AUTH", "Missing Authorization header.");
  }

  const [scheme, token] = authHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "INVALID_AUTH_HEADER", "Authorization header must be a Bearer token.");
  }

  return token;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  const path = new URL(req.url).pathname;

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET" && (path.endsWith("/health") || path.endsWith("/latex-compile-stub"))) {
    return jsonResponse({
      ok: true,
      service: "latex-compile-stub",
      now: new Date().toISOString(),
    });
  }

  try {
    if (req.method !== "POST" || !path.endsWith("/compile")) {
      throw new HttpError(404, "NOT_FOUND", "Route not found.");
    }

    if (!INTERNAL_API_TOKEN) {
      throw new HttpError(500, "MISSING_CONFIG", "INTERNAL_API_TOKEN is not configured.");
    }

    const token = parseBearerToken(req.headers.get("Authorization"));
    if (token !== INTERNAL_API_TOKEN) {
      throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }

    const body = await req.json().catch(() => null) as { tex_source?: unknown } | null;
    const texSource = typeof body?.tex_source === "string" ? body.tex_source : "";
    if (!texSource.trim()) {
      throw new HttpError(400, "INVALID_INPUT", "tex_source is required.");
    }

    const texBytes = new TextEncoder().encode(texSource).byteLength;
    if (texBytes > MAX_TEX_BYTES) {
      throw new HttpError(413, "INPUT_TOO_LARGE", `tex_source exceeds max size (${MAX_TEX_BYTES} bytes).`);
    }

    return jsonResponse({
      ok: true,
      pdf_base64: STUB_PDF_BASE64,
      engine: "stub",
      input_hash: await sha256Hex(texSource),
      cache_hit: false,
      duration_ms: 1,
      compile_log: "stub compile successful",
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof HttpError ? error.message : "Unexpected function error.";
    return jsonResponse({ ok: false, error_code: code, error_message: message }, status);
  }
});
