const { app } = require("@azure/functions");

const TOKEN_TTL_SECONDS = 540;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_BUCKETS = 2000;
const POLISH_MAX_INPUT_CHARS = 6000;
const API_VERSION_CANDIDATES = [
  "2024-10-21",
  "2024-08-01-preview",
  "2024-06-01",
  "2024-02-15-preview",
  "2023-12-01-preview",
];
const CLEANUP_STYLES = new Set(["off", "light", "medium", "heavy"]);
const hits = new Map();

function json(status, body, headers = {}) {
  return {
    status,
    jsonBody: body,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...headers,
    },
  };
}

function configuredOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowed = configuredOrigins();
  if (!origin || !allowed.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function assertAllowedOrigin(request) {
  const origin = request.headers.get("origin") || "";
  const allowed = configuredOrigins();
  if (!allowed.length) {
    return false;
  }
  // Browser Origin checks are defense-in-depth for this per-user broker.
  // Requests without Origin stay blocked unless the owner explicitly opts in.
  if (!origin) {
    return /^true$/i.test(process.env.ALLOW_REQUESTS_WITHOUT_ORIGIN || "");
  }
  return allowed.includes(origin);
}

function clientKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0].trim();
  return `${request.headers.get("origin") || "no-origin"}:${ip || "unknown"}`;
}

function cleanupRateLimit(now) {
  // Keep the local throttle bounded so unique spoofed clients cannot grow memory
  // forever. Public deployments should still use edge/API gateway limits.
  for (const [key, hit] of hits) {
    if (now - hit.startedAt > RATE_LIMIT_WINDOW_MS) {
      hits.delete(key);
    }
  }

  while (hits.size > RATE_LIMIT_MAX_BUCKETS) {
    const oldestKey = hits.keys().next().value;
    hits.delete(oldestKey);
  }
}

function isRateLimited(request) {
  const max = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
  if (!Number.isFinite(max) || max <= 0) {
    return false;
  }

  const key = clientKey(request);
  const now = Date.now();
  cleanupRateLimit(now);
  const current = hits.get(key);
  if (!current || now - current.startedAt > RATE_LIMIT_WINDOW_MS) {
    hits.set(key, { count: 1, startedAt: now });
    return false;
  }

  current.count += 1;
  return current.count > max;
}

function tokenEndpoint(region) {
  if (process.env.SPEECH_TOKEN_ENDPOINT) {
    return process.env.SPEECH_TOKEN_ENDPOINT;
  }
  return `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
}

async function requestSpeechToken() {
  const key = process.env.SPEECH_KEY;
  const region = process.env.SPEECH_REGION;
  if (!key || !region) {
    throw new Error("SPEECH_KEY and SPEECH_REGION app settings are required.");
  }

  const response = await fetch(tokenEndpoint(region), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "0",
      "Ocp-Apim-Subscription-Key": key,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Speech token request failed: HTTP ${response.status} ${detail.slice(0, 120)}`);
  }

  return {
    token: await response.text(),
    region,
    expiresIn: TOKEN_TTL_SECONDS,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

function sanitizeCleanupStyle(style) {
  const normalized = String(style || "medium").trim().toLowerCase();
  return CLEANUP_STYLES.has(normalized) && normalized !== "off" ? normalized : "medium";
}

function cleanupSystemPrompt(style) {
  const base =
    "You are a real-time transcription editor. You receive raw speech-to-text " +
    "output of someone speaking that may contain filler words, false starts, " +
    "stutters, and repetition. Return ONLY the edited text; no quotes, labels, " +
    "or commentary. IMPORTANT: if the text contains any real words, NEVER return " +
    "an empty response; only remove the fillers and keep the real content. Return " +
    "an empty response only if the input is nothing but filler sounds (um, uh, hmm). " +
    "Never add information that wasn't said.";

  if (style === "light") {
    return (
      base +
      " Lightly clean it: remove filler words (um, uh, like, you know), false " +
      "starts and stutters; fix capitalization and punctuation. Keep the " +
      "speaker's exact wording and meaning otherwise."
    );
  }

  if (style === "heavy") {
    return (
      base +
      " Rewrite it into polished, well-structured prose: remove fillers and " +
      "repetition, fix grammar, and improve clarity and flow. You may restructure " +
      "sentences, but preserve the original meaning and intent and do not summarize " +
      "away content."
    );
  }

  return (
    base +
    " Clean it into clear, readable text: remove filler words, false starts, and " +
    "repetition; fix grammar, capitalization, and punctuation; keep the original " +
    "meaning, tone, and order. Do not summarize."
  );
}

function azureOpenAiSettings() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AOAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_KEY || process.env.AOAI_KEY;
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_MODEL ||
    process.env.AOAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || process.env.AOAI_API_VERSION || "";

  if (!endpoint || !key || !deployment) {
    throw new Error("Azure OpenAI endpoint, key, and deployment settings are required.");
  }

  const parsed = normalizeAzureOpenAiEndpoint(endpoint);
  return {
    endpoint: parsed.origin,
    isV1: parsed.isV1,
    key,
    deployment,
    apiVersion: apiVersion.trim(),
  };
}

function normalizeAzureOpenAiEndpoint(raw) {
  const endpoint = String(raw || "").trim().replace(/\/+$/, "");
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("AZURE_OPENAI_ENDPOINT must use https.");
  }
  const host = url.host;
  return {
    origin: `${url.protocol}//${host}`,
    host,
    isV1: /\.services\.ai\.azure\.com$/i.test(host) || /\/openai\/v1(\/|$)/i.test(url.pathname),
  };
}

function buildMessages(style, text) {
  return [
    { role: "system", content: cleanupSystemPrompt(style) },
    { role: "user", content: `Raw transcription to clean now:\n${text}` },
  ];
}

function classicUrl(settings, apiVersion) {
  return (
    settings.endpoint +
    "/openai/deployments/" +
    encodeURIComponent(settings.deployment) +
    "/chat/completions?api-version=" +
    encodeURIComponent(apiVersion)
  );
}

function extractContent(data) {
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  return String(content || "").trim();
}

async function polishWithV1(settings, messages) {
  const response = await fetch(`${settings.endpoint}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.key}`,
      "api-key": settings.key,
    },
    body: JSON.stringify({
      model: settings.deployment,
      messages,
      temperature: 0.2,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    throw new Error(`Azure OpenAI v1 request failed: HTTP ${response.status}`);
  }

  return extractContent(await response.json());
}

async function polishWithClassic(settings, messages) {
  const versions = [];
  const addVersion = (version) => {
    if (version && !versions.includes(version)) {
      versions.push(version);
    }
  };
  addVersion(settings.apiVersion);
  API_VERSION_CANDIDATES.forEach(addVersion);

  const body = JSON.stringify({
    messages,
    temperature: 0.2,
    max_tokens: 800,
  });

  for (const version of versions) {
    const response = await fetch(classicUrl(settings, version), {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": settings.key },
      body,
    });

    if (response.ok) {
      return extractContent(await response.json());
    }

    if (response.status === 400) {
      const detail = await response.text();
      if (/api[- ]?version/i.test(detail)) {
        continue;
      }
    }

    throw new Error(`Azure OpenAI request failed: HTTP ${response.status}`);
  }

  throw new Error("No supported Azure OpenAI API version found.");
}

async function readPolishRequest(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 20000) {
    return { error: "Request is too large.", status: 413 };
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return { error: "Request body must be JSON.", status: 400 };
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return { error: "Text is required.", status: 400 };
  }
  if (text.length > POLISH_MAX_INPUT_CHARS) {
    return { error: "Text is too long.", status: 413 };
  }

  return {
    text,
    style: sanitizeCleanupStyle(body.style),
  };
}

async function requestPolishedText(text, style) {
  const settings = azureOpenAiSettings();
  const messages = buildMessages(style, text);
  if (settings.isV1) {
    return polishWithV1(settings, messages);
  }
  return polishWithClassic(settings, messages);
}

app.http("speech-token", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "speech-token",
  handler: async (request, context) => {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return { status: 204, headers };
    }

    if (!assertAllowedOrigin(request)) {
      return json(403, { error: "Origin is not allowed." }, headers);
    }

    if (isRateLimited(request)) {
      return json(429, { error: "Too many token requests." }, headers);
    }

    try {
      return json(200, await requestSpeechToken(), headers);
    } catch (err) {
      context.error("Speech token broker failed:", err.message);
      return json(500, { error: "Could not issue Speech token." }, headers);
    }
  },
});

app.http("polish-text", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polish-text",
  handler: async (request, context) => {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return { status: 204, headers };
    }

    if (!assertAllowedOrigin(request)) {
      return json(403, { error: "Origin is not allowed." }, headers);
    }

    if (isRateLimited(request)) {
      return json(429, { error: "Too many polish requests." }, headers);
    }

    const input = await readPolishRequest(request);
    if (input.error) {
      return json(input.status, { error: input.error }, headers);
    }

    try {
      return json(200, { text: await requestPolishedText(input.text, input.style) }, headers);
    } catch (err) {
      if (/settings are required/i.test(err.message)) {
        return json(503, { error: "Auto-polish is not configured." }, headers);
      }
      context.error("Auto-polish broker failed:", err.message);
      return json(502, { error: "Could not polish text." }, headers);
    }
  },
});
