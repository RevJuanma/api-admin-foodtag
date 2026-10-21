/** Verifica que el catálogo de módulos del panel coincida con el grafo de la API de los restaurantes (api-foodtag). */
import fs from "fs";
import path from "path";
import { MODULES } from "../src/config/modules";

const apiFile = path.join(__dirname, "..", "..", "api-foodtag", "src", "core", "config", "modules.ts");
if (!fs.existsSync(apiFile)) {
  console.warn("No se encontró api-foodtag junto a este proyecto: se omite la paridad.");
  process.exit(0);
}
const block = fs.readFileSync(apiFile, "utf-8").match(/MODULE_REQUIRES[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
const problems: string[] = [];
const seen = new Set<string>();
for (const [, id, deps] of block.matchAll(/["']?([\w-]+)["']?:\s*\[([^\]]*)\]/g)) {
  seen.add(id);
  const api = deps.split(",").map((d) => d.trim().replace(/["']/g, "")).filter(Boolean).sort().join(",");
  const mine = (MODULES as Record<string, { requires: readonly string[] }>)[id];
  if (!mine) problems.push(`la API tiene el módulo "${id}" y el panel no`);
  else if ([...mine.requires].sort().join(",") !== api) problems.push(`"${id}" requiere [${[...mine.requires].sort().join(",")}] en el panel y [${api}] en la API`);
}
for (const id of Object.keys(MODULES)) if (!seen.has(id)) problems.push(`el panel tiene el módulo "${id}" y la API no`);

if (problems.length) {
  console.error(`${problems.length} problema(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Catálogo de módulos OK (${seen.size} módulos, igual que la API)`);
