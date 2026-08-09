// Asistente de primera ejecución. Separa claramente los tres alcances posibles:
// respaldo local, contactos por API y migración completa a Chatwoot autohospedado.

import {
  ask,
  ensureConfig,
  readEnvFile,
  saveToEnvFile,
} from "./config.mjs";
import { ensureSsh, testSsh } from "./ssh.mjs";
import { discoverDockerDatabase, maskDatabaseUrl } from "./postgres.mjs";
import { banner, bold, info, ok, warn } from "./ui.mjs";
import { printError } from "./errors.mjs";

const yes = (value) => /^s(i|í)?$/i.test(String(value).trim());

export function onboardingNeeded() {
  return readEnvFile().ONBOARDING_DONE !== "1";
}

function save(values) {
  Object.assign(process.env, values);
  saveToEnvFile(values);
}

async function configureChatwootApi() {
  console.log(bold("\nConexión a la API de Chatwoot\n"));
  info("El token se escribe oculto y queda solamente en tu archivo .env local.");
  await ensureConfig(["CHATWOOT_BASE_URL", "CHATWOOT_TOKEN", "DEFAULT_COUNTRY_CODE"]);

  let response;
  try {
    response = await fetch(`${process.env.CHATWOOT_BASE_URL}/api/v1/profile`, {
      headers: { api_access_token: process.env.CHATWOOT_TOKEN },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    warn(`No se pudo comprobar la API ahora: ${error.message}`);
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    return false;
  }

  if (!response.ok) {
    warn(`Chatwoot respondió HTTP ${response.status}. Revisá la URL y el token.`);
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    return false;
  }

  const profile = await response.json();
  const accounts = Array.isArray(profile.accounts) ? profile.accounts : [];
  let account = accounts.find((item) => String(item.id) === process.env.CHATWOOT_ACCOUNT_ID);

  if (!account && accounts.length === 1) {
    account = accounts[0];
  } else if (!account && accounts.length > 1) {
    console.log("\nCuentas disponibles para este token:");
    accounts.forEach((item, index) => console.log(`  ${index + 1}) ${item.name} (id ${item.id})`));
    while (!account) {
      const selected = Number(await ask(`Elegí una cuenta (1-${accounts.length}): `));
      account = accounts[selected - 1];
      if (!account) warn("Opción inválida.");
    }
  }

  if (account) {
    save({ CHATWOOT_ACCOUNT_ID: String(account.id) });
    ok(`API conectada: ${account.name} (cuenta ${account.id}).`);
  } else {
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    ok("API conectada.");
  }
  return true;
}

async function configureSelfHostedDatabase() {
  console.log(bold("\nAcceso al servidor autohospedado\n"));
  info("PostgreSQL seguirá cerrado a Internet: la conexión viajará por un túnel SSH.");
  const ssh = await ensureSsh();
  if (!(await testSsh(ssh))) {
    warn("La configuración quedó guardada, pero PostgreSQL no se detectará hasta corregir SSH.");
    return false;
  }

  console.log("");
  info("Si Chatwoot usa Docker Compose, se pueden leer únicamente sus variables PostgreSQL.");
  info("No se modifica el servidor y las credenciales no se muestran en pantalla.");
  const detect = await ask("¿Detectar automáticamente la base desde Docker? (S/n): ");

  if (!detect || yes(detect)) {
    try {
      const settings = discoverDockerDatabase(ssh, {
        localPort: process.env.TUNNEL_LOCAL_PORT || "15432",
      });
      save(settings);
      ok("PostgreSQL detectado. La URL local quedó guardada para usarla con el túnel SSH.");
      console.log(`  ${maskDatabaseUrl(settings.DATABASE_URL)}`);
      return true;
    } catch (error) {
      printError(error);
    }
  }

  console.log("");
  warn("Detección automática no completada.");
  info("El administrador puede copiar DATABASE_URL desde el .env de Chatwoot.");
  info("No hay que abrir el puerto 5432 en el firewall.");
  const manual = await ask("¿Pegar la DATABASE_URL manualmente ahora? (s/N): ");
  if (yes(manual)) {
    await ensureConfig(["DATABASE_URL"]);
    return true;
  }
  return false;
}

export async function runOnboarding({ force = false } = {}) {
  if (!force && !onboardingNeeded()) return;

  console.log("");
  banner("Configuración inicial", "tus secretos quedan solamente en esta computadora");
  console.log("");
  console.log("¿Qué querés hacer con esta instalación?");
  console.log("  1) Solo respaldar/exportar WhatsApp Business (sin Chatwoot)");
  console.log("  2) Respaldar e importar contactos por la API (Cloud o autohospedado)");
  console.log("  3) Flujo completo con chats y adjuntos (solo Chatwoot autohospedado)");
  console.log("  4) Configurar más tarde");

  let mode;
  while (!mode) {
    const selected = await ask("\nElegí una opción (1-4): ");
    if (selected === "1") mode = "backup";
    else if (selected === "2") mode = "contacts";
    else if (selected === "3") mode = "self_hosted";
    else if (selected === "4" || selected === "") mode = "manual";
    else warn("Opción inválida.");
  }

  if (mode === "contacts") {
    await configureChatwootApi();
  } else if (mode === "self_hosted") {
    await ensureConfig(["DEFAULT_COUNTRY_CODE"]);
    const contacts = await ask("\n¿También querés importar contactos por API? (S/n): ");
    if (!contacts || yes(contacts)) await configureChatwootApi();
    await configureSelfHostedDatabase();
  }

  save({ SETUP_MODE: mode, ONBOARDING_DONE: "1" });
  console.log("");
  ok("Configuración inicial finalizada. Podés repetirla desde la opción 8 del menú.");
}
