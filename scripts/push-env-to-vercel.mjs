import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");
const KEYS = ["IG_SESSIONID", "IG_DS_USER_ID", "IG_CSRFTOKEN"];
const TARGET_ENVS = ["production", "preview"];

function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && KEYS.includes(match[1])) values[match[1]] = match[2];
  }
  return values;
}

if (!existsSync(ENV_PATH)) {
  console.error(`No existe ${ENV_PATH}. Corré primero 'npm run get-session'.`);
  process.exit(1);
}

const values = parseEnv(readFileSync(ENV_PATH, "utf8"));
const missing = KEYS.filter((k) => !values[k]);
if (missing.length) {
  console.error(`Faltan valores en .env.local: ${missing.join(", ")}`);
  process.exit(1);
}

for (const key of KEYS) {
  for (const env of TARGET_ENVS) {
    // Remove existing value first (ignore errors if it doesn't exist yet).
    spawnSync("npx", ["vercel", "env", "rm", key, env, "--yes"], {
      stdio: "ignore",
      shell: true,
    });

    console.log(`Subiendo ${key} → ${env}...`);
    const result = spawnSync("npx", ["vercel", "env", "add", key, env], {
      input: values[key],
      stdio: ["pipe", "inherit", "inherit"],
      shell: true,
    });

    if (result.status !== 0) {
      console.error(`Falló al subir ${key} a ${env}`);
      process.exit(1);
    }
  }
}

console.log("\nListo. Variables subidas a Vercel (production y preview).");
console.log("Hacé un redeploy para que el sitio las tome (vercel --prod, o vuelve a subir código).");
