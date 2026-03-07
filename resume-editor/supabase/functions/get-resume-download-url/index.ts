import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import * as Sentry from "npm:@sentry/deno";

const RESUME_BUCKET = "Resumes";
const APPLICATIONS_TABLE = "applications";
const FUNCTION_NAME = "get-resume-download-url";
const sentryDsn = Deno.env.get("SENTRY_DSN");
const sentryEnabled = Boolean(sentryDsn);
const sentryEnvironment = Deno.env.get("SENTRY_ENVIRONMENT") ?? Deno.env.get("SUPABASE_ENV") ?? "production";
const sentryRelease = Deno.env.get("SENTRY_RELEASE");
const sentryDebug = Deno.env.get("SENTRY_DEBUG") === "true";
const sentryTracesSampleRateRaw = Deno.env.get("SENTRY_TRACES_SAMPLE_RATE") ?? "0";
const sentryTracesSampleRate = Math.max(0, Math.min(1, Number.parseFloat(sentryTracesSampleRateRaw)));

if (sentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    environment: sentryEnvironment,
    release: sentryRelease,
    tracesSampleRate: Number.isFinite(sentryTracesSampleRate) ? sentryTracesSampleRate : 0,
    debug: sentryDebug,
    attachStacktrace: true,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.Authorization;
      }
      return event;
    },
  });
}

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new HttpError(500, "MISSING_ENV", `Missing environment variable: ${name}`);
  }
  return value;
}

function parseBearerToken(authHeader: string | null) {
  if (!authHeader) {
    throw new HttpError(401, "MISSING_AUTH", "Missing Authorization header.");
  }

  const [scheme, token] = authHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "INVALID_AUTH_HEADER", "Authorization header must be a Bearer token.");
  }

  return token;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown non-Error thrown.");
}

function getRequestContext(req: Request) {
  const url = new URL(req.url);
  const forwardedFor = req.headers.get("x-forwarded-for");
  return {
    method: req.method,
    url: req.url,
    path: url.pathname,
    host: url.host,
    user_agent: req.headers.get("user-agent"),
    request_id: req.headers.get("x-request-id"),
    forwarded_for: forwardedFor ? forwardedFor.split(",")[0]?.trim() : null,
  };
}

async function reportServerError(
  error: unknown,
  context: {
    req: Request;
    applicationId?: string;
    userId?: string;
  },
) {
  if (!sentryEnabled) {
    return;
  }

  if (error instanceof HttpError && error.status < 500) {
    return;
  }

  Sentry.withScope((scope) => {
    const requestContext = getRequestContext(context.req);
    scope.setTag("supabase_function", FUNCTION_NAME);
    scope.setTag("http_method", requestContext.method);
    scope.setTag("http_path", requestContext.path);
    scope.setTag("runtime", "deno");
    scope.setTag("handled", "true");

    if (error instanceof HttpError) {
      scope.setTag("http_error_code", error.code);
      scope.setExtra("http_status", error.status);
    }

    if (context.applicationId) {
      scope.setExtra("application_id", context.applicationId);
    }

    if (context.userId) {
      scope.setUser({ id: context.userId });
    }

    scope.setContext("request", requestContext);
    scope.setExtra("timestamp", new Date().toISOString());
    Sentry.captureException(toError(error));
  });

  await Sentry.flush(2000);
}

serve(async (req) => {
  let applicationId = "";
  let authenticatedUserId = "";

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
    const authHeader = req.headers.get("Authorization");
    const accessToken = parseBearerToken(authHeader);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    applicationId = typeof body.application_id === "string" ? body.application_id.trim() : "";

    if (!applicationId) {
      throw new HttpError(400, "INVALID_INPUT", "application_id is required.");
    }

    const {
      data: { user },
      error: userError,
    } = await adminClient.auth.getUser(accessToken);

    if (userError || !user) {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired user token.");
    }
    authenticatedUserId = user.id;

    const { data: application, error: applicationError } = await userClient
      .from(APPLICATIONS_TABLE)
      .select("id, user_id, resume_path, resume_filename")
      .eq("id", applicationId)
      .single();

    if (applicationError || !application) {
      throw new HttpError(404, "APPLICATION_NOT_FOUND", "Application not found.");
    }

    if (application.user_id !== authenticatedUserId) {
      throw new HttpError(403, "FORBIDDEN", "Application does not belong to authenticated user.");
    }

    if (!application.resume_path || typeof application.resume_path !== "string") {
      throw new HttpError(400, "MISSING_RESUME_PATH", "Application has no resume file.");
    }

    const { data: signed, error: signedError } = await adminClient.storage
      .from(RESUME_BUCKET)
      .createSignedUrl(application.resume_path, 60);

    if (signedError || !signed?.signedUrl) {
      throw new HttpError(500, "SIGNED_URL_FAILED", signedError?.message ?? "Could not create download url.");
    }

    return jsonResponse(
      {
        signed_url: signed.signedUrl,
        filename: application.resume_filename ?? "resume",
      },
      200,
    );
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof HttpError ? error.message : "Unexpected function error.";

    await reportServerError(error, {
      req,
      applicationId,
      userId: authenticatedUserId,
    });

    return jsonResponse({ error_code: code, error_message: message }, status);
  }
});
