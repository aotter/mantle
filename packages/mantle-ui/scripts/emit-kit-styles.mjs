// Ships the kit's design tokens next to the compiled `kit.css`, for
// applications that compile Tailwind themselves (ADR-0029).
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/kit");
if (!existsSync(resolve(dist, "kit.css"))) throw new Error("dist/kit/kit.css was not built");
for (const file of ["tokens.css", "theme.css"])
  copyFileSync(resolve(root, "src/kit/styles", file), resolve(dist, file));
// A CSS-only build can leave an empty chunk behind.
rmSync(resolve(dist, "kit.js"), { force: true });
console.log("kit styles written");
