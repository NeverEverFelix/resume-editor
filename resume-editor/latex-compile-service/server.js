const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
//kkkk
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const MAX_TEX_BYTES = Number.parseInt(process.env.MAX_TEX_BYTES || "200000", 10);
const STUB_MODE = (process.env.STUB_MODE || "false").toLowerCase() === "true";
const COMPILE_TIMEOUT_MS = Number.parseInt(process.env.COMPILE_TIMEOUT_MS || "20000", 10);
const MAX_LOG_CHARS = Number.parseInt(process.env.MAX_LOG_CHARS || "50000", 10);
const TEX_ENGINE = process.env.TEX_ENGINE || "pdflatex";
const TEX_RUNS = Number.parseInt(process.env.TEX_RUNS || "2", 10);

// Minimal valid PDF payload for early integration testing.
const STUB_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCA+PiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgOTAgVGQKKFN0dWIgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxMCAwMDAwMCBuIAowMDAwMDAwMDYwIDAwMDAwIG4gCjAwMDAwMDAxMTcgMDAwMDAgbiAKMDAwMDAwMDIyNyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjMyMwolJUVPRgo=";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res) {
  return json(res, 401, {
    ok: false,
    error_code: "UNAUTHORIZED",
    error_message: "Missing or invalid bearer token.",
  });
}

function parseAuthHeader(value) {
  if (!value) return "";
  const [scheme, token] = value.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return "";
  return token || "";
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_TEX_BYTES * 2) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function sanitizeCompileLog(value) {
  const text = value.replace(/\0/g, "");
  if (text.length <= MAX_LOG_CHARS) return text;
  return `${text.slice(0, MAX_LOG_CHARS)}\n...[truncated]`;
}

function hasForbiddenTeXPrimitives(texSource) {
  // Block common command execution primitives even with no-shell-escape.
  return /\\(?:write18|immediate\s*\\write18|input\|)\b/i.test(texSource);
}

function runEngineOnce(workDir) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(
      TEX_ENGINE,
      [
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-no-shell-escape",
        "-output-directory",
        workDir,
        "main.tex",
      ],
      {
        cwd: workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMPILE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_LOG_CHARS) {
        stdout = stdout.slice(0, MAX_LOG_CHARS);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_LOG_CHARS) {
        stderr = stderr.slice(0, MAX_LOG_CHARS);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

async function compileTexSource(texSource) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "latex-compile-"));
  const texPath = path.join(workspace, "main.tex");
  const pdfPath = path.join(workspace, "main.pdf");

  let log = "";
  let finalRun = null;
  try {
    await fs.writeFile(texPath, texSource, "utf8");

    for (let index = 0; index < Math.max(1, TEX_RUNS); index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const run = await runEngineOnce(workspace);
      finalRun = run;
      log += run.stdout;
      log += run.stderr;
      if (run.timedOut) {
        const error = new Error(`Compilation timed out after ${COMPILE_TIMEOUT_MS}ms.`);
        error.code = "COMPILE_TIMEOUT";
        error.compileLog = sanitizeCompileLog(log);
        throw error;
      }
      if (run.code !== 0) {
        const error = new Error(`LaTeX compiler exited with code ${run.code ?? "unknown"}.`);
        error.code = "COMPILE_FAILED";
        error.compileLog = sanitizeCompileLog(log);
        throw error;
      }
    }

    const pdfBuffer = await fs.readFile(pdfPath);
    return {
      pdfBase64: pdfBuffer.toString("base64"),
      compileLog: sanitizeCompileLog(log),
      exitCode: finalRun?.code ?? 0,
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "latex-compile-service",
      stub_mode: STUB_MODE,
      now: new Date().toISOString(),
    });
  }

  if (req.method === "POST" && url.pathname === "/compile") {
    if (!INTERNAL_API_TOKEN) {
      return json(res, 500, {
        ok: false,
        error_code: "MISSING_CONFIG",
        error_message: "INTERNAL_API_TOKEN is not configured.",
      });
    }

    const token = parseAuthHeader(req.headers.authorization);
    if (!token || token !== INTERNAL_API_TOKEN) {
      return unauthorized(res);
    }

    const startedAt = Date.now();
    try {
      const body = await parseBody(req);
      const texSource = typeof body.tex_source === "string" ? body.tex_source : "";
      if (!texSource.trim()) {
        return json(res, 400, {
          ok: false,
          error_code: "INVALID_INPUT",
          error_message: "tex_source is required.",
        });
      }

      const texBytes = Buffer.byteLength(texSource, "utf8");
      if (texBytes > MAX_TEX_BYTES) {
        return json(res, 413, {
          ok: false,
          error_code: "INPUT_TOO_LARGE",
          error_message: `tex_source exceeds max size (${MAX_TEX_BYTES} bytes).`,
        });
      }

      const inputHash = sha256Hex(texSource);
      if (hasForbiddenTeXPrimitives(texSource)) {
        return json(res, 400, {
          ok: false,
          error_code: "UNSAFE_TEX_INPUT",
          error_message: "Unsupported or unsafe TeX primitives detected.",
          input_hash: inputHash,
          duration_ms: Date.now() - startedAt,
        });
      }

      if (!STUB_MODE) {
        try {
          const result = await compileTexSource(texSource);
          return json(res, 200, {
            ok: true,
            pdf_base64: result.pdfBase64,
            engine: TEX_ENGINE,
            input_hash: inputHash,
            cache_hit: false,
            duration_ms: Date.now() - startedAt,
            compile_log: result.compileLog,
          });
        } catch (error) {
          if (error && error.code === "ENOENT") {
            return json(res, 500, {
              ok: false,
              error_code: "MISSING_DEPENDENCY",
              error_message: `TeX engine '${TEX_ENGINE}' not found in runtime.`,
              input_hash: inputHash,
              duration_ms: Date.now() - startedAt,
            });
          }

          const code = error && typeof error.code === "string" ? error.code : "COMPILE_FAILED";
          const compileLog = error && typeof error.compileLog === "string"
            ? error.compileLog
            : "";
          return json(res, 422, {
            ok: false,
            error_code: code,
            error_message: error instanceof Error ? error.message : "Compilation failed.",
            compile_log: compileLog,
            input_hash: inputHash,
            duration_ms: Date.now() - startedAt,
          });
        }
      }

      return json(res, 200, {
        ok: true,
        pdf_base64: STUB_PDF_BASE64,
        engine: "stub",
        input_hash: inputHash,
        cache_hit: false,
        duration_ms: Date.now() - startedAt,
        compile_log: "stub compile successful",
      });
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error_code: "BAD_REQUEST",
        error_message: error instanceof Error ? error.message : "Invalid request.",
      });
    }
  }

  return json(res, 404, {
    ok: false,
    error_code: "NOT_FOUND",
    error_message: "Route not found.",
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`latex-compile-service listening on :${PORT}`);
});
