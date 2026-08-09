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

const yes = (value) => /^(y(es)?|s(i|í)?)$/i.test(String(value).trim());

export function onboardingNeeded() {
  return readEnvFile().ONBOARDING_DONE !== "1";
}

function save(values) {
  Object.assign(process.env, values);
  saveToEnvFile(values);
}

async function configureChatwootApi() {
  console.log(bold("\nChatwoot API connection\n"));
  info("The token is entered securely and remains only in your local .env file.");
  await ensureConfig(["CHATWOOT_BASE_URL", "CHATWOOT_TOKEN", "DEFAULT_COUNTRY_CODE"]);

  let response;
  try {
    response = await fetch(`${process.env.CHATWOOT_BASE_URL}/api/v1/profile`, {
      headers: { api_access_token: process.env.CHATWOOT_TOKEN },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    warn(`The API could not be verified now: ${error.message}`);
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    return false;
  }

  if (!response.ok) {
    warn(`Chatwoot returned HTTP ${response.status}. Check the URL and token.`);
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    return false;
  }

  const profile = await response.json();
  const accounts = Array.isArray(profile.accounts) ? profile.accounts : [];
  let account = accounts.find((item) => String(item.id) === process.env.CHATWOOT_ACCOUNT_ID);

  if (!account && accounts.length === 1) {
    account = accounts[0];
  } else if (!account && accounts.length > 1) {
    console.log("\nAccounts available to this token:");
    accounts.forEach((item, index) => console.log(`  ${index + 1}) ${item.name} (id ${item.id})`));
    while (!account) {
      const selected = Number(await ask(`Choose an account (1-${accounts.length}): `));
      account = accounts[selected - 1];
      if (!account) warn("Invalid option.");
    }
  }

  if (account) {
    save({ CHATWOOT_ACCOUNT_ID: String(account.id) });
    ok(`API connected: ${account.name} (account ${account.id}).`);
  } else {
    await ensureConfig(["CHATWOOT_ACCOUNT_ID"]);
    ok("API connected.");
  }
  return true;
}

async function configureSelfHostedDatabase() {
  console.log(bold("\nSelf-hosted server access\n"));
  info("PostgreSQL will remain closed to the Internet: the connection uses an SSH tunnel.");
  const ssh = await ensureSsh();
  if (!(await testSsh(ssh))) {
    warn("The configuration was saved, but PostgreSQL cannot be detected until SSH works.");
    return false;
  }

  console.log("");
  info("If Chatwoot uses Docker Compose, only its PostgreSQL variables can be inspected.");
  info("The server is not modified and credentials are never displayed.");
  const detect = await ask("Automatically detect the database from Docker? (Y/n): ");

  if (!detect || yes(detect)) {
    try {
      const settings = discoverDockerDatabase(ssh, {
        localPort: process.env.TUNNEL_LOCAL_PORT || "15432",
      });
      save(settings);
      ok("PostgreSQL detected. The local URL was saved for use with the SSH tunnel.");
      console.log(`  ${maskDatabaseUrl(settings.DATABASE_URL)}`);
      return true;
    } catch (error) {
      printError(error);
    }
  }

  console.log("");
  warn("Automatic detection was not completed.");
  info("An administrator can copy DATABASE_URL from Chatwoot's .env file.");
  info("Do not open port 5432 in the firewall.");
  const manual = await ask("Enter DATABASE_URL manually now? (y/N): ");
  if (yes(manual)) {
    await ensureConfig(["DATABASE_URL"]);
    return true;
  }
  return false;
}

export async function runOnboarding({ force = false } = {}) {
  if (!force && !onboardingNeeded()) return;

  console.log("");
  banner("Initial setup", "your secrets remain only on this computer");
  console.log("");
  console.log("What do you want to do with this installation?");
  console.log("  1) Back up/export WhatsApp Business only (no Chatwoot)");
  console.log("  2) Back up and import contacts through the API (Cloud or self-hosted)");
  console.log("  3) Full chat and attachment workflow (self-hosted Chatwoot only)");
  console.log("  4) Configure later");

  let mode;
  while (!mode) {
    const selected = await ask("\nChoose an option (1-4): ");
    if (selected === "1") mode = "backup";
    else if (selected === "2") mode = "contacts";
    else if (selected === "3") mode = "self_hosted";
    else if (selected === "4" || selected === "") mode = "manual";
    else warn("Invalid option.");
  }

  if (mode === "contacts") {
    await configureChatwootApi();
  } else if (mode === "self_hosted") {
    await ensureConfig(["DEFAULT_COUNTRY_CODE"]);
    const contacts = await ask("\nDo you also want to import contacts through the API? (Y/n): ");
    if (!contacts || yes(contacts)) await configureChatwootApi();
    await configureSelfHostedDatabase();
  }

  save({ SETUP_MODE: mode, ONBOARDING_DONE: "1" });
  console.log("");
  ok("Initial setup complete. You can repeat it from menu option 8.");
}
