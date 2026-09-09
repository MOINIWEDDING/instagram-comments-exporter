import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env.local");
const MAX_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 1500;

function upsertEnv(existing, values) {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();

  const updated = lines.map((line) => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${values[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }

  return updated.filter((line, i, arr) => line !== "" || i === arr.length - 1).join("\n");
}

async function main() {
  console.log("Abriendo Instagram en un navegador real. Iniciá sesión ahí (con tu 2FA si aplica).");
  console.log("Este script NO ve ni guarda tu contraseña: la escribís directo en instagram.com.\n");

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + MAX_WAIT_MS;
  let sessionCookie = null;
  let dsUserIdCookie = null;
  let csrfCookie = null;

  while (Date.now() < deadline) {
    const cookies = await context.cookies("https://www.instagram.com");
    sessionCookie = cookies.find((c) => c.name === "sessionid");
    dsUserIdCookie = cookies.find((c) => c.name === "ds_user_id");
    csrfCookie = cookies.find((c) => c.name === "csrftoken");

    if (sessionCookie?.value && dsUserIdCookie?.value) break;

    await page.waitForTimeout(POLL_MS);
  }

  if (!sessionCookie?.value || !dsUserIdCookie?.value) {
    console.error("\nNo se detectó un login exitoso dentro del tiempo de espera (5 min). Cerrando.");
    await browser.close();
    process.exit(1);
  }

  console.log(`\nLogin detectado (ds_user_id=${dsUserIdCookie.value}). Guardando credenciales...`);

  const values = {
    IG_SESSIONID: sessionCookie.value,
    IG_DS_USER_ID: dsUserIdCookie.value,
    ...(csrfCookie?.value ? { IG_CSRFTOKEN: csrfCookie.value } : {}),
  };

  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  writeFileSync(ENV_PATH, upsertEnv(existing, values) + "\n", "utf8");

  console.log(`\nListo. Se escribió ${ENV_PATH} con IG_SESSIONID, IG_DS_USER_ID${csrfCookie ? " e IG_CSRFTOKEN" : ""}.`);
  console.log("Copiá esos mismos valores a Vercel → Settings → Environment Variables para producción.");
  console.log("\nValores (para copiar a Vercel):");
  for (const [key, value] of Object.entries(values)) {
    console.log(`  ${key}=${value}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
