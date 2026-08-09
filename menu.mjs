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
  if (res.error) warn(`No se pudo ejecutar ${path.basename(script)}: ${res.error.message}`);
  else if (res.status !== 0) warn(`${path.basename(script)} terminó con código ${res.status}.`);
}

function runBackupWizard() {
  console.log("");
  info("Abriendo el asistente de respaldo (instala Python solo si hace falta) ...");
  info("Si Windows pide permisos para instalar Python, aceptalos.");
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
  if (res.error) warn(`No se pudo lanzar PowerShell: ${res.error.message}`);
  else if (res.status !== 0) warn(`El asistente de respaldo terminó con código ${res.status}.`);
}

function maskSecrets(line) {
  return line
    .replace(/^(CHATWOOT_TOKEN=).+/, "$1********")
    .replace(/(:\/\/[^:@\s]+:)[^@\s]+(@)/, "$1********$2");
}

function showConfig() {
  console.log("");
  if (!fs.existsSync(ENV_PATH)) {
    info("Todavía no hay nada guardado (.env no existe). Cada módulo pregunta lo suyo al usarlo.");
    return;
  }
  console.log(bold(`Configuración guardada (${ENV_PATH}):`));
  console.log("");
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    console.log(`  ${maskSecrets(line)}`);
  }
  console.log("");
  info("Para cambiar un valor: borralo o editalo en .env (bloc de notas) — o borrá la");
  info("línea y el programa lo vuelve a preguntar la próxima vez que lo necesite.");
}

function showHeader() {
  console.log("");
  banner("WhatsApp Backup to Chatwoot", "respaldo de WhatsApp Business + importación a Chatwoot");
  const resumen = [];
  resumen.push(process.env.SSH_HOST ? `servidor: ${process.env.SSH_USER || "?"}@${process.env.SSH_HOST}` : "servidor: sin configurar");
  resumen.push(process.env.CHATWOOT_BASE_URL ? `chatwoot: ${process.env.CHATWOOT_BASE_URL}` : "chatwoot: sin configurar");
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
    console.log(c("dim", "  Tus archivos van en las carpetas PLACE-HERE-1/2/3 (cada una tiene un README.txt)."));
    console.log("");
    console.log(bold("   Flujo completo (en este orden):"));
    console.log("1) RESPALDAR y exportar WhatsApp Business (celular ya copiado a la PC)");
    console.log("2) Importar CONTACTOS a Chatwoot (CSV o VCF, por API)");
    console.log("3) Abrir TÚNEL SSH al servidor (necesario para el paso 4)");
    console.log("4) Importar CHATS de WhatsApp a Chatwoot (menú propio: prueba, pasos 1-3, deshacer)");
    console.log("");
    console.log(bold("   Herramientas:"));
    console.log("5) Configurar SSH (usuario, IP, llave .pem)");
    console.log("6) Probar la conexión SSH");
    console.log("7) Ver la configuración guardada");
    console.log("8) Repetir la configuración inicial (onboarding)");
    console.log("");
    console.log("0) Salir");

    const choice = await ask("\nElegí una opción: ");
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
        console.log("\nListo, chau.");
        break;
      } else {
        warn("Opción inválida.");
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
      "Este menú es interactivo y necesita una consola real (doble clic en run.bat).\n" +
      "Para automatizar, corré los módulos directo:\n" +
      "  node modules/contactos/import-contacts.mjs <archivo.csv|vcf>\n" +
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
