# SKILL.md briefs (mantle)

Agent-readable skill briefs for consumers of `@aotter/mantle-*`. Discoverable by URL — no plugin install needed.

| Skill | When to invoke |
|---|---|
| [`install`](install/SKILL.md) | User wants to start or continue a Mantle site. Sites launch on [Mantle landing](https://mantle.tools), which provisions the GitHub repo and first Cloudflare deploy; this brief orients the agent to take over and continue the provisioned repo. |
| [`customize-design`](customize-design/SKILL.md) | User wants to rebrand or restyle a publication starter project. Walks the L1–L4 theme stack (tokens / extraCss+icons+i18n / Header+Footer / whole-template). |
| [`extend`](extend/SKILL.md) | User has an existing project and wants to add a Schema / View / Procedure / Trigger or wire a feature (contact form, search, newsletter signup). |
| [`provision`](provision/SKILL.md) | User wants production fully usable after a landing launch. Verify the Cloudflare deploy, wire per-site staff auth (GitHub OAuth App + Worker secrets), smoke test, and hand off the operator setup URL. |

The skills target `mantle@v0.1.0`. Each one names its assumed grammar version in the front-matter `applies_to:` field; future versions add a sibling SKILL.md or update the existing one.

## Audience

These are written for **AI agents acting on behalf of consumers of mantle**, not for agents maintaining the mantle SDK itself. SDK-internal guidance lives in [`/CLAUDE.md`](../CLAUDE.md). Two audiences, two artifacts.

## Discoverability

The skills target ADR-0007's "AI as primary author" thesis: agents reach these files by URL when the user invokes them by intent ("install mantle", "extend my CMS", "deploy"). No `/skill install` slash command is required — point the agent at the GitHub raw URL or pass the markdown content directly.

## Conventions

Each SKILL.md ships:

- **Front-matter** with `name`, `description`, `when_to_invoke`, `applies_to`.
- **Preflight** section — environment + user-confirmation gates.
- **Step-by-step** — concrete commands (`pnpm validate`, `mantle emit-openapi`, etc.).
- **Diagnostic recipes** — `Symptom → Cause → Fix` table for the common failure modes.
- **Don't** — reviewer-style list of patterns the agent must reject (often citing ADRs).
- **When you're done** — what to report back to the user.

If you're writing a new SKILL, follow the same structure. The CLI commands referenced are stable across v0.1.x.
