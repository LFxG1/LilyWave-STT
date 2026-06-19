# LilyWave Security Best Practices Report

Updated: 2026-06-19

## Executive Summary

LilyWave is now shaped for the intended GitHub-download model: each user runs their own local/static app and their own Azure Function broker with their own Azure Speech and Azure OpenAI settings. Browser-side Azure keys were removed from the app, local Function secrets are ignored by Git, and the Function template now fails closed unless the owner configures allowed browser origins.

The remaining security boundary is important: this broker should not be run as one shared public service with real keys unless you add real authentication and edge abuse controls. CORS and Origin checks help protect browser use, but they are not authentication.

## Scope

- Frontend: `index.html`, `app.html`, `app.js`, `styles.css`
- Backend: `functions/src/functions/speech-token.js`, `functions/*.json`, `functions/scripts/setup-local.js`
- Documentation: `README.md`, `functions/README.md`, `functions/local.settings.example.json`
- Checks: syntax checks, production dependency audit, and source scans for common DOM/script injection sinks.

## Fixed In This Pass

### F-1. Function broker now fails closed on Origin checks

- Status: Fixed for the self-run template model
- Location:
  - `functions/src/functions/speech-token.js:50`
  - `functions/src/functions/speech-token.js:356`
  - `functions/src/functions/speech-token.js:384`
- What changed:
  - Requests are rejected when `ALLOWED_ORIGINS` is empty.
  - Requests without an `Origin` header are rejected unless `ALLOW_REQUESTS_WITHOUT_ORIGIN=true`.
  - The example settings keep `ALLOW_REQUESTS_WITHOUT_ORIGIN=false`.
- Residual risk: non-browser clients can forge an `Origin` header. Treat this as browser defense-in-depth, not identity or quota protection.

### F-2. Function rate limiter is bounded

- Status: Fixed locally, residual edge risk accepted
- Location:
  - `functions/src/functions/speech-token.js:5`
  - `functions/src/functions/speech-token.js:70`
  - `functions/src/functions/speech-token.js:93`
- What changed:
  - Expired rate-limit buckets are cleaned up.
  - The in-memory bucket map is capped with `RATE_LIMIT_MAX_BUCKETS`.
- Residual risk: per-instance throttles reset when Functions scale or restart. Public deployments still need Azure API Management, Front Door/WAF, Easy Auth, or another gateway layer.

### F-3. CSP is broader for the static frontend

- Status: Fixed as a static-page meta policy
- Location:
  - `index.html:9`
  - `app.html:9`
- What changed:
  - Added explicit `default-src`, `connect-src`, `img-src`, `style-src`, `font-src`, `object-src`, `base-uri`, and `form-action` directives.
  - Kept Speech SDK requirements for `blob:` and `wasm-unsafe-eval`.
- Residual risk: meta CSP cannot enforce `frame-ancestors`. If someone deploys this publicly, set CSP and clickjacking headers at the host/CDN layer.

### F-4. Active app DOM HTML sinks were removed

- Status: Fixed in active source
- Location:
  - `app.js:404`
  - `app.js:414`
  - `app.js:421`
- What changed:
  - Placeholder rendering now uses DOM creation, `textContent`, and `replaceChildren()`.
  - Active source scans found no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `eval(` in `app.js`, `app.html`, `index.html`, or the Function source.

### F-5. Advanced token endpoint override is restricted

- Status: Fixed
- Location:
  - `app.js:146`
  - `app.js:166`
  - `app.js:1718`
  - `app.html:232`
- What changed:
  - Overrides must be `https:` unless they point to localhost, `127.0.0.1`, or `::1`.
  - Invalid saved overrides are ignored.
  - The Settings UI now warns users to use only their own Function endpoint.

## Accepted Residual Risks

### R-1. Anonymous Function routes are intentional for this template

- Severity if self-run by each user: Low to Medium
- Severity if deployed as one public shared broker: High
- Location:
  - `functions/src/functions/speech-token.js:347`
  - `functions/src/functions/speech-token.js:375`
- Notes:
  - `authLevel: "anonymous"` avoids putting a Function key into the browser, which would simply move the secret exposure problem.
  - This is acceptable for a downloadable template where every user owns the Azure quota behind their Function.
  - A public shared service must add authentication and abuse controls before using real keys.

### R-2. Transcript text remains in tab-scoped session storage

- Severity: Low privacy hardening item
- Notes:
  - `sessionStorage` avoids long-lived browser persistence, but transcript text can still be read by same-origin script until the tab/session ends.
  - A future privacy option could keep transcript history memory-only by default.

### R-3. Local Function secrets are plaintext on disk

- Severity: Low for local development
- Notes:
  - `functions/local.settings.json` is ignored by Git.
  - `IsEncrypted: false` is normal for editable local Azure Functions settings.
  - For Azure deployment, use Function App settings or Key Vault references instead of committing local settings.

## Verification

- `node --check app.js`
- `npm run check` in `functions/`
- `npm audit --omit=dev --json` in `functions/`
- Source scans for active app and Function code:
  - `innerHTML`
  - `outerHTML`
  - `insertAdjacentHTML`
  - `eval(`

## Security Guidance For GitHub Users

This project is safest when users clone/download it, create their own Azure Speech and Azure OpenAI resources, and run or deploy their own Function broker. Do not publish one shared broker URL with your real keys for everyone to use unless you also add authentication, monitoring, rate limiting, and gateway-level abuse controls.
