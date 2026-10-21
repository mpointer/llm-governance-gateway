# Security Policy

## Supported versions

This package is pre-1.0. Security fixes land on the latest published minor
only; there are no maintenance branches for earlier minors.

| Version | Supported |
| --- | --- |
| Latest 0.x minor on npm | Yes |
| Earlier 0.x minors | No, upgrade |

The library runs in your process and holds provider API keys in memory. It
never sends keys anywhere except the provider they belong to. Keys are read
from `ProviderConfig.apiKeys`, the shell environment, or `.env.local` /
`.env` via `loadEnvFiles()`. Production keys belong in your deploy platform's
secret store, not in files.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Preferred: use GitHub's private vulnerability reporting on this repository
   (Security tab, "Report a vulnerability").
2. Otherwise: email the maintainer address in `package.json` with
   `[security] llm-governance-gateway` in the subject.

Include the package version, a minimal reproduction, and what an attacker
gains. You will get an acknowledgement within 7 days. A fix for a confirmed
report ships as a patch release with a CHANGELOG entry; the advisory is
published after the release, credited to you unless you ask otherwise.

## Scope notes

- Spend caps are enforced against the `UsageStore` you supply. A store that
  returns wrong sums, or an in-memory store on a serverless platform, weakens
  the cap. That is configuration, not a vulnerability in the library, but
  reports that show the library makes such a misconfiguration easy are
  welcome.
- The optional HTTP layer (`llm-governance-gateway/http`) authenticates with
  static bearer tokens you configure. It is a thin surface meant to sit
  behind your own network boundary; reports on it are in scope.
- Guardrail hooks, the judge, and the sanitizer are best-effort controls.
  A prompt that gets past them is a quality report, not a security report,
  unless it also crosses a tenant or spend boundary.
