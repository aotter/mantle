/** Compile the existing build-time closure once; retired Core execution code is not shipped. */
import { readdirSync, rmSync } from "node:fs";
import { build } from "esbuild";
const files = directory => readdirSync(directory, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
for (const file of files("dist/build")) if (file.endsWith(".js")) rmSync(file);
await build({entryPoints:["src/build/compiler.ts"],outdir:"dist/build",bundle:true,splitting:true,format:"esm",platform:"node",packages:"external",minify:false,treeShaking:true,target:"node22"});
