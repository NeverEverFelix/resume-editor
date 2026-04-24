import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GENERATED_RESUMES_TABLE = "generated_resumes";
const RUNS_TABLE = "resume_runs";
const FUNCTION_NAME = "compile-tailored-resume-pdf";
const DEFAULT_BUCKET = "Resumes";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const MAX_LATEX_BYTES = 200_000;
const STATUS = {
  QUEUED_PDF: "queued_pdf",
  COMPILING_PDF: "compiling_pdf",
  COMPLETED: "completed",
  FAILED: "failed",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type RequestBody = {
  latex?: unknown;
  filename?: unknown;
  generated_resume_id?: unknown;
  run_id?: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new HttpError(500, "MISSING_ENV", `Missing environment variable: ${name}`);
  }
  return value;
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

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ensureLatexSize(latex: string) {
  const bytes = new TextEncoder().encode(latex).byteLength;
  if (bytes > MAX_LATEX_BYTES) {
    throw new HttpError(413, "INPUT_TOO_LARGE", `latex exceeds max size (${MAX_LATEX_BYTES} bytes).`);
  }
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!cleaned) {
    return "tailored-resume.pdf";
  }

  const withExt = cleaned.toLowerCase().endsWith(".pdf")
    ? cleaned
    : `${cleaned.replace(/\.tex$/i, "")}.pdf`;

  return withExt || "tailored-resume.pdf";
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function markRunStatus(
  adminClient: ReturnType<typeof createClient>,
  runId: string,
  userId: string,
  status: string,
) {
  const { error } = await adminClient
    .from(RUNS_TABLE)
    .update({
      status,
      error_code: null,
      error_message: null,
    })
    .eq("id", runId)
    .eq("user_id", userId);

  if (error) {
    throw new HttpError(500, "RUN_STATUS_UPDATE_FAILED", error.message);
  }
}

async function markRunFailure(
  adminClient: ReturnType<typeof createClient>,
  runId: string,
  userId: string,
  code: string,
  message: string,
) {
  await adminClient
    .from(RUNS_TABLE)
    .update({
      error_code: code,
      error_message: message,
    })
    .eq("id", runId)
    .eq("user_id", userId);
}

async function resolveLatex(
  body: RequestBody,
  client: ReturnType<typeof createClient>,
): Promise<{ latex: string; filename: string; generatedResumeId: string; runId: string }> {
  const suppliedLatex = cleanString(body.latex);
  const suppliedFilename = cleanString(body.filename);
  const generatedResumeId = cleanString(body.generated_resume_id);
  const suppliedRunId = cleanString(body.run_id);

  if (suppliedLatex) {
    ensureLatexSize(suppliedLatex);
    return {
      latex: suppliedLatex,
      filename: sanitizeFilename(suppliedFilename || "tailored-resume.pdf"),
      generatedResumeId,
      runId: suppliedRunId,
    };
  }

  if (!generatedResumeId && !suppliedRunId) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "Either latex, generated_resume_id, or run_id is required.",
    );
  }

  let generatedResumeQuery = client
    .from(GENERATED_RESUMES_TABLE)
    .select("id, run_id, filename, latex");

  if (generatedResumeId) {
    generatedResumeQuery = generatedResumeQuery.eq("id", generatedResumeId);
  } else {
    generatedResumeQuery = generatedResumeQuery.eq("run_id", suppliedRunId);
  }

  const { data: generatedResume, error } = await generatedResumeQuery.single();

  if (error || !generatedResume) {
    throw new HttpError(404, "GENERATED_RESUME_NOT_FOUND", "Generated resume not found.");
  }

  const latex = cleanString(generatedResume.latex);
  if (!latex) {
    throw new HttpError(409, "LATEX_MISSING", "Generated resume has no LaTeX source.");
  }

  ensureLatexSize(latex);

  return {
    latex,
    filename: sanitizeFilename(suppliedFilename || cleanString(generatedResume.filename) || "tailored-resume.pdf"),
    generatedResumeId,
    runId: suppliedRunId || cleanString(generatedResume.run_id),
  };
}

serve(async (req) => {
  let authenticatedUserId = "";
  let runId = "";

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST.");
    }

    const supabaseUrl = getEnv("SUPABASE_URL");
    const supabaseAnonKey = getEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const compileServiceUrl = getEnv("LATEX_COMPILE_SERVICE_URL");
    const compileServiceToken = getEnv("LATEX_COMPILE_INTERNAL_TOKEN");
    const bucket = Deno.env.get("GENERATED_RESUMES_BUCKET") ?? DEFAULT_BUCKET;

    const authHeader = req.headers.get("Authorization");
    const accessToken = parseBearerToken(authHeader);
    const isInternalInvocation = accessToken === serviceRoleKey;

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader ?? "" } },
    });

    if (!isInternalInvocation) {
      const {
        data: { user },
        error: userError,
      } = await adminClient.auth.getUser(accessToken);

      if (userError || !user) {
        throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired user token.");
      }
      authenticatedUserId = user.id;
    }

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Expected JSON body.");
    }

    const dataClient = isInternalInvocation ? adminClient : userClient;
    const resolved = await resolveLatex(body, dataClient);
    const latex = resolved.latex;
    const filename = resolved.filename;
    const generatedResumeId = resolved.generatedResumeId;
    runId = resolved.runId;

    if (runId) {
      const { data: run, error: runError } = await dataClient
        .from(RUNS_TABLE)
        .select("id, user_id, status")
        .eq("id", runId)
        .single();

      if (runError || !run) {
        throw new HttpError(404, "RUN_NOT_FOUND", "Run not found.");
      }

      if (isInternalInvocation) {
        authenticatedUserId = cleanString(run.user_id);
      }

      if (cleanString(run.user_id) !== authenticatedUserId) {
        throw new HttpError(403, "FORBIDDEN", "Run does not belong to authenticated user.");
      }

      if (run.status === STATUS.FAILED) {
        throw new HttpError(409, "RUN_TERMINAL", "Run is in terminal failed state.");
      }

      if (
        run.status !== STATUS.QUEUED_PDF &&
        run.status !== STATUS.COMPILING_PDF &&
        run.status !== STATUS.COMPLETED
      ) {
        throw new HttpError(409, "RUN_NOT_READY", "Run is not ready for PDF compile.");
      }

      if (run.status !== STATUS.COMPLETED) {
        await markRunStatus(adminClient, runId, authenticatedUserId, STATUS.COMPILING_PDF);
      }
    }

    let compileResponse: Response;
    try {
      compileResponse = await fetch(`${compileServiceUrl.replace(/\/+$/, "")}/compile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${compileServiceToken}`,
        },
        body: JSON.stringify({ tex_source: latex }),
      });
    } catch (networkError) {
      throw new HttpError(
        502,
        "COMPILE_SERVICE_UNREACHABLE",
        `Could not reach compile service at ${compileServiceUrl}: ${getErrorMessage(networkError)}`,
      );
    }

    const compilePayload = (await compileResponse.json().catch(() => null)) as {
      ok?: unknown;
      error_code?: unknown;
      error_message?: unknown;
      compile_log?: unknown;
      pdf_base64?: unknown;
      engine?: unknown;
      duration_ms?: unknown;
      input_hash?: unknown;
      cache_hit?: unknown;
    } | null;

    if (!compileResponse.ok || !compilePayload || compilePayload.ok !== true) {
      const errorCode = typeof compilePayload?.error_code === "string"
        ? compilePayload.error_code
        : "COMPILE_FAILED";
      const errorMessage = typeof compilePayload?.error_message === "string"
        ? compilePayload.error_message
        : `Compile service failed with HTTP ${compileResponse.status}.`;

      throw new HttpError(422, errorCode, errorMessage);
    }

    const pdfBase64 = typeof compilePayload.pdf_base64 === "string" ? compilePayload.pdf_base64 : "";
    if (!pdfBase64) {
      throw new HttpError(502, "INVALID_COMPILE_RESPONSE", "Compile service did not return pdf_base64.");
    }

    const pdfBytes = base64ToBytes(pdfBase64);
    const latexHash = await sha256Hex(latex);
    const storagePath = [
      "generated",
      authenticatedUserId,
      `${Date.now()}-${latexHash.slice(0, 12)}-${filename}`,
    ].join("/");

    const { error: uploadError } = await adminClient.storage
      .from(bucket)
      .upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        upsert: false,
      });

    if (uploadError) {
      throw new HttpError(500, "PDF_UPLOAD_FAILED", uploadError.message);
    }

    const signedUrlTtl = Number.parseInt(Deno.env.get("GENERATED_RESUMES_SIGNED_URL_TTL") ?? "", 10);
    const ttlSeconds = Number.isFinite(signedUrlTtl) && signedUrlTtl > 0
      ? signedUrlTtl
      : DEFAULT_SIGNED_URL_TTL_SECONDS;

    const { data: signed, error: signedUrlError } = await adminClient.storage
      .from(bucket)
      .createSignedUrl(storagePath, ttlSeconds);

    if (signedUrlError || !signed?.signedUrl) {
      throw new HttpError(500, "SIGNED_URL_FAILED", signedUrlError?.message ?? "Could not create signed URL.");
    }

    if (runId) {
      await markRunStatus(adminClient, runId, authenticatedUserId, STATUS.COMPLETED);
    }

    return jsonResponse(
      {
        ok: true,
        filename,
        path: storagePath,
        signed_url: signed.signedUrl,
        bucket,
        run_id: runId || null,
        generated_resume_id: generatedResumeId || null,
        compile: {
          engine: compilePayload.engine,
          duration_ms: compilePayload.duration_ms,
          input_hash: compilePayload.input_hash,
          cache_hit: compilePayload.cache_hit,
          compile_log: compilePayload.compile_log,
        },
      },
      200,
    );
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof HttpError
      ? error.message
      : `Unexpected function error in ${FUNCTION_NAME}.`;

    if (runId && authenticatedUserId) {
      await markRunFailure(
        createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY")),
        runId,
        authenticatedUserId,
        code,
        message,
      );
    }

    return jsonResponse(
      {
        ok: false,
        error_code: code,
        error_message: message,
      },
      status,
    );
  }
});
