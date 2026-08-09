// menu.mjs — WhatsApp Backup to Chatwoot: menú principal que une los módulos.
//
//   1. Respaldo/export de WhatsApp Business (Python — modules/backup/wa_archive.py)
//   2. Importar contactos a Chatwoot por API (modules/contactos/import-contacts.mjs)
//   3. Túnel SSH a la base Postgres del servidor (lib/ssh.mjs)
//   4. Importar chats a Chatwoot directo a Postgres (modules/chats/import-chats.mjs)
//
// Se ejecuta con doble clic en run.bat (instala dependencias y valida Node) o con
// `node menu.mjs`. Cada módulo corre como proceso hijo con la consola heredada, así
// conserva sus menús, barras de progreso y prompts propios.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT_DIR, ENV_PATH, DROP_DIRS, ask, readEnvFile } from "./lib/config.mjs";
import { banner, bold, info, warn, c } from "./lib/ui.mjs";
import { ensureSsh, openTunnel, testSsh } from "./lib/ssh.mjs";
import { runOnboarding } from "./lib/onboarding.mjs";
import { printError } from "./lib/errors.mjs";

const MOD = (rel) => path.join(ROOT_DIR, "modules", ...rel.split("/"));

// Las carpetas de entrada tienen que existir siempre (si el usuario borró
// alguna, se recrea sola con su LEEME adentro).
const LEEMES = {
  backup: [
    "PLACE HERE / PONÉ ACÁ the complete WhatsApp Business folder copied from Android.",
    "",
    "On the phone / En el teléfono:",
    "  Internal storage / Almacenamiento interno",
    "  > Android > media > com.whatsapp.w4b > WhatsApp Business",
    "",
    "Expected folders / Carpetas esperadas: Databases, Media, Backups.",
    "USB: select File transfer / Android Auto. USB debugging is not required.",
    "USB: elegí Transferencia de archivos / Android Auto. No hace falta Depuración USB.",
    "",
    "Then / Después: run.bat -> option/opción 1.",
  ],
  contactos: [
    "PLACE HERE / PONÉ ACÁ the contacts file to import into Chatwoot:",
    "  - contacts.vcf (phone or Google Contacts export), or",
    "  - a .csv file (Excel: File > Save As > CSV).",
    "",
    "Then / Después: run.bat -> option/opción 2. The program finds it automatically.",
  ],
  exportChats: [
    "PLACE HERE / PONÉ ACÁ the Chatwoot export folder containing",
    "chatwoot_export.json and attachments/.",
    "",
    "Option/opción 1 creates it here automatically when Chatwoot format is selected.",
    "If generated on another computer, copy the complete export_chatwoot folder.",
    "",
    "Then / Después: option/opción 3 (SSH tunnel) and 4 (chat import).",
  ],
};

function ensureDropDirs() {
  for (const [nombre, dir] of Object.entries(DROP_DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
    const leeme = path.join(dir, "README.txt");
    if (!fs.existsSync(leeme)) fs.writeFileSync(leeme, LEEMES[nombre].join("\r\n") + "\r\n");
  }
}

// Los módulos corren con cwd = raíz del programa: ahí quedan los reportes que generan
// (errores*.json, sin-telefono.json, contactos-ambiguos.json, estado.json...).
function runNode(script, args = []) {
  const res = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", cwd: ROOT_DIR });
  if (res.error) warn(`Could not run ${path.basename(script)}: ${res.error.message}`);
  else if (res.status !== 0) warn(`${path.basename(script)} exited with code ${res.status}.`);
}

function runBackupWizard() {
  console.log("");
  info("Opening the backup wizard (Python is installed only if required) ...");
  info("If Windows requests permission to install Python, approve it.");
  console.log("");
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MOD("backup/run_wizard.ps1")],
    {
      stdio: "inherit",
      cwd: MOD("backup"),
      env: {
        ...process.env,
        // el asistente ofrece estas carpetas como respuestas por defecto
        WA_DROP_BACKUP: DROP_DIRS.backup,
        WA_DROP_CONTACTS: DROP_DIRS.contactos,
        WA_DROP_EXPORT: DROP_DIRS.exportChats,
      },
    }
  );
  if (res.error) warn(`Could not start PowerShell: ${res.error.message}`);
  else if (res.status !== 0) warn(`The backup wizard exited with code ${res.status}.`);
}

function maskSecrets(line) {
  return line
    .replace(/^(CHATWOOT_TOKEN=).+/, "$1********")
    .replace(/(:\/\/[^:@\s]+:)[^@\s]+(@)/, "$1********$2");
}

function showConfig() {
  console.log("");
  if (!fs.existsSync(ENV_PATH)) {
    info("Nothing has been saved yet (.env does not exist). Each module asks for what it needs.");
    return;
  }
  console.log(bold(`Saved configuration (${ENV_PATH}):`));
  console.log("");
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    console.log(`  ${maskSecrets(line)}`);
  }
  console.log("");
  info("To change a value, edit or delete it in .env. If you delete the line,");
  info("the program asks for it again the next time it is needed.");
}

function showHeader() {
  console.log("");
  banner("WhatsApp Backup to Chatwoot", "WhatsApp Business backup and Chatwoot migration");
  const resumen = [];
  resumen.push(process.env.SSH_HOST ? `server: ${process.env.SSH_USER || "?"}@${process.env.SSH_HOST}` : "server: not configured");
  resumen.push(process.env.CHATWOOT_BASE_URL ? `chatwoot: ${process.env.CHATWOOT_BASE_URL}` : "chatwoot: not configured");
  console.log(c("dim", `  ${resumen.join("   |   ")}`));
}

// El .env es la fuente de verdad: si un módulo guardó un dato nuevo en la vuelta
// anterior se re-aplica acá (loadEnvFile no pisa lo heredado), y si el usuario BORRÓ
// una línea con el menú abierto, la clave se saca también del entorno — así el
// próximo módulo la vuelve a preguntar, como promete la opción 7.
let clavesDelEnv = new Set(Object.keys(readEnvFile()));

function refreshEnv() {
  const ahora = readEnvFile();
  for (const clave of clavesDelEnv) {
    if (!(clave in ahora)) delete process.env[clave];
  }
  Object.assign(process.env, ahora);
  clavesDelEnv = new Set(Object.keys(ahora));
}

async function menu() {
  while (true) {
    refreshEnv();

    showHeader();
    console.log("");
    console.log(c("dim", "  Place your files in the PLACE-HERE-1/2/3 folders (each contains README.txt)."));
    console.log("");
    console.log(bold("   Complete workflow (in this order):"));
    console.log("1) BACK UP and export WhatsApp Business (phone folder already copied to the PC)");
    console.log("2) Import CONTACTS into Chatwoot (CSV or VCF through the API)");
    console.log("3) Open the SSH TUNNEL to the server (required for step 4)");
    console.log("4) Import WhatsApp CHATS into Chatwoot (test, steps 1-3, and undo)");
    console.log("");
    console.log(bold("   Tools:"));
    console.log("5) Configure SSH (user, host, .pem key)");
    console.log("6) Test the SSH connection");
    console.log("7) View saved configuration");
    console.log("8) Repeat initial setup (onboarding)");
    console.log("");
    console.log("0) Exit");

    const choice = await ask("\nChoose an option: ");
    try {
      if (choice === "1") {
        runBackupWizard();
      } else if (choice === "2") {
        runNode(MOD("contactos/import-contacts.mjs"));
      } else if (choice === "3") {
        await openTunnel();
      } else if (choice === "4") {
        runNode(MOD("chats/import-chats.mjs"));
      } else if (choice === "5") {
        await ensureSsh({ reconfigure: true });
        await testSsh({ user: process.env.SSH_USER, host: process.env.SSH_HOST, key: process.env.SSH_KEY });
      } else if (choice === "6") {
        await testSsh(await ensureSsh());
      } else if (choice === "7") {
        showConfig();
      } else if (choice === "8") {
        await runOnboarding({ force: true });
        refreshEnv();
      } else if (choice === "0" || choice === "") {
        console.log("\nDone. Goodbye.");
        break;
      } else {
        warn("Invalid option.");
      }
    } catch (e) {
      printError(e);
    }
  }
}

try {
  ensureDropDirs();
  if (!process.stdin.isTTY) {
    console.error(
      "This menu is interactive and requires a real console (double-click run.bat).\n" +
      "For automation, run the modules directly:\n" +
      "  node modules/contactos/import-contacts.mjs <file.csv|vcf>\n" +
      "  node modules/chats/import-chats.mjs --dry-run | --all | --undo | ...\n" +
      "  node modules/chats/recon.mjs"
    );
    process.exit(1);
  }
  await runOnboarding({ force: process.argv.includes("--onboarding") });
  refreshEnv();
  await menu();
} catch (e) {
  printError(e);
  process.exit(1);
}
