import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import * as Sentry from "npm:@sentry/deno";
import { JAKES_RESUME_TEMPLATE } from "./templates/jakes-resume.template.ts";

const RUNS_TABLE = "resume_runs";
const DOCUMENTS_TABLE = "resume_documents";
const GENERATED_RESUMES_TABLE = "generated_resumes";
const FUNCTION_NAME = "generate-tailored-resume";

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

type TailoredResumeInput = {
  target_role: string;
  target_company: string;
  summary: string;
  selected_skills: string[];
  experience_rewrites: Array<{
    company: string;
    title: string;
    bullets: string[];
  }>;
  projects_rewrites: Array<{
    name: string;
    bullets: string[];
  }>;
  education: {
    school: string;
    degree: string;
    grad_date: string;
  };
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
    runId?: string;
    requestId?: string;
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

    if (context.runId) {
      scope.setExtra("run_id", context.runId);
    }

    if (context.requestId) {
      scope.setExtra("request_id", context.requestId);
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

function cleanString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeList(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => cleanString(item))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function normalizeExperienceRewrites(value: unknown): TailoredResumeInput["experience_rewrites"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const row = entry as { company?: unknown; title?: unknown; bullets?: unknown };
      const title = cleanString(row.title);
      const bullets = normalizeList(row.bullets, 8);
      if (!title || bullets.length === 0) {
        return null;
      }

      return {
        company: cleanString(row.company, "Unknown Company"),
        title,
        bullets,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function normalizeProjectsRewrites(value: unknown): TailoredResumeInput["projects_rewrites"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const row = entry as { name?: unknown; bullets?: unknown };
      const name = cleanString(row.name);
      const bullets = normalizeList(row.bullets, 6);
      if (!name || bullets.length === 0) {
        return null;
      }

      return {
        name,
        bullets,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function normalizeEducation(value: unknown): TailoredResumeInput["education"] {
  if (!value || typeof value !== "object") {
    return {
      school: "",
      degree: "",
      grad_date: "",
    };
  }

  const row = value as { school?: unknown; degree?: unknown; grad_date?: unknown };
  return {
    school: cleanString(row.school),
    degree: cleanString(row.degree),
    grad_date: cleanString(row.grad_date),
  };
}

function deriveExperienceFromOptimizations(value: unknown, fallbackCompany: string): TailoredResumeInput["experience_rewrites"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const row = entry as {
        experience_title?: unknown;
        role_before?: unknown;
        role_after?: unknown;
        bullets?: unknown;
      };

      if (!Array.isArray(row.bullets)) {
        return null;
      }

      const bullets = row.bullets
        .map((bullet) => {
          if (!bullet || typeof bullet !== "object") {
            return "";
          }
          const b = bullet as { rewritten?: unknown };
          return cleanString(b.rewritten);
        })
        .filter(Boolean)
        .slice(0, 8);

      if (bullets.length === 0) {
        return null;
      }

      return {
        company: fallbackCompany || "Unknown Company",
        title: cleanString(row.role_after || row.role_before || row.experience_title, "Experience"),
        bullets,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function parseTailoredResumeInput(runOutput: unknown, resumeText: string): TailoredResumeInput {
  const output = runOutput && typeof runOutput === "object" ? (runOutput as Record<string, unknown>) : {};
  const tailored = output.tailored_resume_input && typeof output.tailored_resume_input === "object"
    ? (output.tailored_resume_input as Record<string, unknown>)
    : {};

  const fallbackJob = output.job && typeof output.job === "object" ? (output.job as Record<string, unknown>) : {};
  const fallbackMatch = output.match && typeof output.match === "object" ? (output.match as Record<string, unknown>) : {};

  const targetRole = cleanString(tailored.target_role, cleanString(fallbackJob.title, "Target Role"));
  const targetCompany = cleanString(tailored.target_company, cleanString(fallbackJob.company, "Unknown Company"));

  const summaryFallback = cleanString(fallbackMatch.summary, cleanString(output.summary, ""));
  const inferredSummary = summaryFallback || cleanString(resumeText.split("\n").slice(0, 3).join(" "));
  const summary = cleanString(tailored.summary, inferredSummary || "Resume tailored for the target role.");

  const selectedSkills = normalizeList(tailored.selected_skills ?? output.skills, 14);

  const modelExperience = normalizeExperienceRewrites(tailored.experience_rewrites);
  const fallbackOptimizations = deriveExperienceFromOptimizations(output.optimizations, targetCompany);
  const experienceRewrites = modelExperience.length > 0 ? modelExperience : fallbackOptimizations;

  return {
    target_role: targetRole,
    target_company: targetCompany,
    summary,
    selected_skills: selectedSkills,
    experience_rewrites: experienceRewrites,
    projects_rewrites: normalizeProjectsRewrites(tailored.projects_rewrites),
    education: normalizeEducation(tailored.education),
  };
}

function escapeLatex(value: string): string {
  const backslashToken = "__LATEX_BACKSLASH__";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized
    .replace(/\\/g, backslashToken)
    .replace(/([{}$&#_%])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replaceAll(backslashToken, "\\textbackslash{}");
}

function sanitizeNameForFile(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tailored-resume";
}

function latexItems(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  const rows = items
    .map((item) => `    \\resumeItem{${escapeLatex(item)}}`)
    .join("\n");

  return ["  \\resumeItemListStart", rows, "  \\resumeItemListEnd"].join("\n");
}

function buildExperienceSection(experience: TailoredResumeInput["experience_rewrites"]): string {
  if (experience.length === 0) {
    return [
      "\\section{Experience}",
      "\\resumeSubHeadingListStart",
      "  \\resumeSubheading{Experience details unavailable}{}{}{}",
      "\\resumeSubHeadingListEnd",
    ].join("\n");
  }

  const blocks = experience
    .map((entry) => {
      const company = escapeLatex(entry.company);
      const title = escapeLatex(entry.title);
      return [
        `  \\resumeSubheading{${company}}{}{${title}}{}`,
        latexItems(entry.bullets),
      ].join("\n");
    })
    .join("\n");

  return ["\\section{Experience}", "\\resumeSubHeadingListStart", blocks, "\\resumeSubHeadingListEnd"].join("\n");
}

function buildProjectsSection(projects: TailoredResumeInput["projects_rewrites"]): string {
  if (projects.length === 0) {
    return "";
  }

  const blocks = projects
    .map((project) => {
      const name = escapeLatex(project.name);
      return [
        "  \\resumeProjectHeading",
        `      {\\textbf{${name}}}{}`,
        latexItems(project.bullets),
      ].join("\n");
    })
    .join("\n");

  return ["\\section{Projects}", "\\resumeSubHeadingListStart", blocks, "\\resumeSubHeadingListEnd"].join("\n");
}

function buildEducationSection(education: TailoredResumeInput["education"]): string {
  const school = escapeLatex(education.school || "Education");
  const degree = escapeLatex(education.degree || "");
  const gradDate = escapeLatex(education.grad_date || "");

  return [
    "\\section{Education}",
    "\\resumeSubHeadingListStart",
    `  \\resumeSubheading{${school}}{${gradDate}}{${degree}}{}`,
    "\\resumeSubHeadingListEnd",
  ].join("\n");
}

function buildSkillsSection(skills: string[]): string {
  const skillText = escapeLatex(skills.join(", "));
  return [
    "\\section{Technical Skills}",
    "\\begin{itemize}[leftmargin=0.15in, label={}]",
    "  \\small{\\item{",
    `    \\textbf{Skills}{: ${skillText}}`,
    "  }}",
    "\\end{itemize}",
  ].join("\n");
}

function buildSummarySection(summary: string): string {
  const safeSummary = escapeLatex(summary);
  return [
    "\\section{Summary}",
    "\\begin{itemize}[leftmargin=0.15in, label={}]",
    "  \\small{\\item{",
    `    ${safeSummary}`,
    "  }}",
    "\\end{itemize}",
  ].join("\n");
}

function extractCandidateName(resumeText: string): string {
  const firstLine = cleanString(resumeText.split("\n")[0] ?? "");
  if (!firstLine) {
    return "Candidate Name";
  }

  if (firstLine.length > 64 || /[@|]/.test(firstLine)) {
    return "Candidate Name";
  }

  return firstLine;
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [token, value]) => {
    return result.replaceAll(`{{${token}}}`, value);
  }, template);
}

function buildLatexDocument(input: TailoredResumeInput, resumeText: string, template: string): string {
  const candidateName = escapeLatex(extractCandidateName(resumeText));
  const roleLine = escapeLatex(`${input.target_role} - ${input.target_company}`);
  const summarySection = buildSummarySection(input.summary);
  const educationSection = buildEducationSection(input.education);
  const experienceSection = buildExperienceSection(input.experience_rewrites);
  const projectsSection = buildProjectsSection(input.projects_rewrites);
  const skillsSection = buildSkillsSection(input.selected_skills);

  return applyTemplate(template, {
    NAME: candidateName,
    ROLE_LINE: roleLine,
    SUMMARY_SECTION: summarySection,
    EDUCATION_SECTION: educationSection,
    EXPERIENCE_SECTION: experienceSection,
    PROJECTS_SECTION: projectsSection,
    SKILLS_SECTION: skillsSection,
  });
}

serve(async (req) => {
  let adminClient: ReturnType<typeof createClient> | null = null;
  let runId = "";
  let requestId = "";
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

    adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await adminClient.auth.getUser(accessToken);

    if (userError || !user) {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired user token.");
    }

    authenticatedUserId = user.id;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader ?? "",
        },
      },
    });

    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "INVALID_INPUT", "Expected a JSON object body.");
    }

    runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
    requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
    if (!runId) {
      throw new HttpError(400, "INVALID_INPUT", "run_id is required.");
    }

    const { data: run, error: runError } = await userClient
      .from(RUNS_TABLE)
      .select("id, request_id, user_id, output")
      .eq("id", runId)
      .single();

    if (runError || !run) {
      throw new HttpError(404, "RUN_NOT_FOUND", "Run not found.");
    }

    const runUserId = cleanString(run.user_id);
    const runRequestId = cleanString(run.request_id);
    if (!runUserId || runUserId !== authenticatedUserId) {
      throw new HttpError(403, "FORBIDDEN", "Run does not belong to authenticated user.");
    }

    if (requestId && runRequestId && requestId !== runRequestId) {
      throw new HttpError(409, "REQUEST_ID_MISMATCH", "Provided request_id does not match the run.");
    }

    if (!run.output || typeof run.output !== "object") {
      throw new HttpError(409, "RUN_OUTPUT_MISSING", "Run output is required before generating tailored resume.");
    }

    const { data: resumeDoc, error: resumeDocError } = await userClient
      .from(DOCUMENTS_TABLE)
      .select("text")
      .eq("run_id", runId)
      .maybeSingle();

    if (resumeDocError) {
      throw new HttpError(500, "RESUME_DOCUMENT_READ_FAILED", resumeDocError.message);
    }

    const resumeText = typeof resumeDoc?.text === "string" ? resumeDoc.text : "";

    const tailoredInput = parseTailoredResumeInput(run.output, resumeText);
    const latex = buildLatexDocument(tailoredInput, resumeText, JAKES_RESUME_TEMPLATE);
    const suggestedFilename = `${sanitizeNameForFile(tailoredInput.target_company)}-${sanitizeNameForFile(tailoredInput.target_role)}.tex`;

    const templateName = "jakes-resume";

    const { data: generatedResumeRow, error: generatedResumeError } = await adminClient
      .from(GENERATED_RESUMES_TABLE)
      .upsert(
        {
          user_id: authenticatedUserId,
          run_id: runId,
          request_id: requestId || runRequestId || null,
          template: templateName,
          filename: suggestedFilename,
          latex,
        },
        {
          onConflict: "run_id,template",
        },
      )
      .select("id, run_id, template, filename, created_at, updated_at")
      .single();

    if (generatedResumeError || !generatedResumeRow) {
      throw new HttpError(
        500,
        "GENERATED_RESUME_SAVE_FAILED",
        generatedResumeError?.message ?? "Could not save generated resume.",
      );
    }

    const mergedOutput = {
      ...(run.output as Record<string, unknown>),
      tailored_resume: {
        id: generatedResumeRow.id,
        template: templateName,
        generated_at: new Date().toISOString(),
        filename: suggestedFilename,
        latex,
      },
    };

    const { data: updatedRun, error: updateError } = await adminClient
      .from(RUNS_TABLE)
      .update({
        output: mergedOutput,
      })
      .eq("id", runId)
      .eq("user_id", authenticatedUserId)
      .select("id, request_id, output")
      .single();

    if (updateError || !updatedRun) {
      throw new HttpError(500, "RUN_UPDATE_FAILED", updateError?.message ?? "Could not update run output.");
    }

    return jsonResponse(
      {
        run: updatedRun,
        tailored_resume: {
          id: generatedResumeRow.id,
          filename: suggestedFilename,
          template: templateName,
          latex,
        },
      },
      200,
    );
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof HttpError ? error.message : "Unexpected function error.";
    const status = error instanceof HttpError ? error.status : 500;

    await reportServerError(error, {
      req,
      runId,
      requestId,
      userId: authenticatedUserId,
    });

    return jsonResponse(
      {
        error_code: code,
        error_message: message,
      },
      status,
    );
  }
});
