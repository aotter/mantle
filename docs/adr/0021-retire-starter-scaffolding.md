# ADR-0021: Author applications directly; retire Starter scaffolding

Status: Accepted by owner, 2026-09-08 (#786). Supersedes ADR-0018 for the 0.1.2 line.

Core is an embeddable manifest engine. Applications own package manifests,
Worker entries, provider configuration, business manifests and visitor UI.
Core no longer creates those files from a Starter bundle. Remove `create` and
the Starter three-way `update` CLI, their bundle renderer/export, and the
cross-repository Starter/Landing release gates. Legacy consumers retain the
immutable 0.1.0-alpha.17 packages, tags and URLs.

`generate` remains an explicit compiler for existing manifests and optional
installed Admin UI assets. It must not initialize a missing project or invent
a default Schema, frontend or home route. Web remains optional runtime
composition, with consumer-provided templates and routes.

Version-matched install/update skills describe direct authoring and reviewed
SDK dependency upgrades. Existing project source, provider identity, secrets
and legacy metadata remain user-owned. No replacement init/template command,
new preset registry or Builder/Platform implementation belongs to this change.

A small Core-owned reference consumer proves generation and a running Worker
against exact packed packages and public registry candidates. It is a test and
worked example, not a downloadable scaffolder or another launch product.
Useful transaction Queue/DO patterns remain documented with immutable sources.

Release ownership stays in the existing Core controller: source and packed
consumer gates → immutable tag → verified registry candidates → public-registry
consumer gate → monotonic channels → GitHub release. No downstream repo writer
is required. Wrong public artifacts still require fixing forward; no retagging.
