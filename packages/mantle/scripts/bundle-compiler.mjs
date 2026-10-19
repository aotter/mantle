/** Compile the existing build-time closure once; retired Core execution code is not shipped. */
import { readdirSync, rmSync } from "node:fs";
import { build } from "esbuild";
const files = directory => readdirSync(directory, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
for (const file of files("dist/build")) if (file.endsWith(".js")) rmSync(file);
await build({entryPoints:["src/build/compiler.ts"],outdir:"dist/build",bundle:true,splitting:true,format:"esm",platform:"node",packages:"external",minifyWhitespace:true,minifySyntax:true,treeShaking:true,target:"node22"});

// Independent, platform-neutral opt-in report and hash entries.
for (const file of files("dist/domain/describe")) if (file.endsWith(".js")) rmSync(file);
await build({entryPoints:["src/domain/describe/index.ts", "src/domain/describe/target-hash.ts"],outdir:"dist/domain/describe",bundle:true,splitting:true,format:"esm",platform:"neutral",minifyWhitespace:true,minifySyntax:true,treeShaking:true,target:"es2022"});
