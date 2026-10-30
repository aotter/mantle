---
name: mantle
description: Create, continue, upgrade, test, speed up or deploy a Mantle application (@aotter/mantle manifests, SQL Views and Procedures, MCP, REST, Admin, mantle generate). Every contract comes from the installed version's `mantle help`.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/mantle/SKILL.md
---

# Mantle

This skill only routes; it holds no contract. The installed `@aotter/mantle` is the authority, and `mantle help` prints
its docs one topic at a time.

1. **Start with `mantle help`.** In a project run `npx mantle help`; before one exists, `npx @aotter/mantle@<exact
   version> help`. It prints the entry page (how to choose, build and accept); `mantle help <topic>` prints one page and
   ends with the commands for the pages it links. `mantle help topics` lists them all. For a new app, do every step of its
   "Build from a product brief". Follow it rather than this file, an SDK checkout or an online copy.
2. **Work in the user's application.** Read its `package.json` and lockfile for the exact Mantle version and keep using
   that version's docs until the user asks to upgrade (`mantle help releases/index`). Preserve existing code, identity,
   versions and resources.
3. **Stop for the user at the entry page's checkpoints:** show the running Admin and its Developer UI once the manifests
   generate, and ask before acceptance and before the performance pass. Never report done without them; end with what
   each one found and changed, and each layer as CONVERGED, BLOCKED or UNVERIFIED.
4. **Deploy, delete remote data or publish nothing unless the user asks for that exact action.**
