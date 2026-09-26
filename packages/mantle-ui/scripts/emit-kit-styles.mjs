// Ships the kit's design tokens next to the compiled `kit.css`, for
// applications that compile Tailwind themselves (ADR-0029).
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/kit");
if (!existsSync(resolve(dist, "kit.css"))) throw new Error("dist/kit/kit.css was not built");
copyFileSync(resolve(root, "src/kit/styles/tokens.css"), resolve(dist, "tokens.css"));
// A CSS-only build can leave an empty chunk behind.
rmSync(resolve(dist, "kit.js"), { force: true });
console.log("kit styles written");
