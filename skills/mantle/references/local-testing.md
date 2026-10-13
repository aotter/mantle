# Local HTTP acceptance


Generation with `--check` and typechecking prove compilation, not handler execution. Before reporting local readiness or deploying, run the application's existing dev command with isolated local data and a console/test email sender. Use a small application-owned Node `assert` + `fetch` script; no browser, deployment or helper server runner is required.

- Exercise actual HTTP Triggers for every custom Procedure handler: valid input/output, invalid input, anonymous refusal on protected operations, authorized synthetic caller and expected stored result. A status below 500 alone is not success; assert the expected status and JSON envelope/body. Use only the generated contract's routes, inputs and permissions.
- For an app-owned `fetch`, exercise its real public routes, not just dist files. Assert HTML content type, visible content and metadata/canonical/JSON-LD with no JavaScript execution, sitemap, robots and an unknown URL returning 404. Create a local synthetic draft and assert it is hidden anonymously; publish, edit and delete it through authorized operations and check the page and sitemap after each change. Reuse the application's existing smoke-test pattern and clean up test rows/server in `finally`.
- Keep caller authority explicit: use supplied `resolveCaller` and caller-scoped Store/Procedure APIs from the installed service-entry docs. Use the actual local host capabilities; local tests do not prove remote identity/provider wiring.
- Record commands and passed/failed/blocked cases for the exact commit. Fix failures before source admission; rerun relevant checks after changing source. Packing does not run these checks and an agent's checklist is not server build attestation.
