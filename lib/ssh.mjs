// ssh.mjs — todo lo que toca el servidor por SSH: pedir/validar usuario, IP y llave
// .pem (ver resolvePemLocation en config.mjs: acepta archivo o carpeta donde buscar),
// probar la conexión, y abrir el túnel a Postgres en una ventana aparte.
//
// El túnel es lo que permite que DATABASE_URL apunte a 127.0.0.1:15432 desde esta PC:
//   ssh -i llave.pem -N -L 15432:127.0.0.1:5432 usuario@servidor
// La ventana del túnel tiene que quedar ABIERTA mientras se usa el importador de chats.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT_DIR, ensureConfig, saveToEnvFile, ask } from "./config.mjs";
import { WaError } from "./errors.mjs";
import { ok, warn, info, fail, bold } from "./ui.mjs";

const SSH_KEYS = ["SSH_USER", "SSH_HOST", "SSH_KEY"];

export function sshConfigured() {
  return SSH_KEYS.every((k) => process.env[k]);
}

// Pide los datos que falten (usuario, IP, llave .pem) y los devuelve.
// Con reconfigure=true vuelve a preguntar TODO aunque ya esté guardado.
export async function ensureSsh({ reconfigure = false } = {}) {
  if (reconfigure) {
    console.log("\nCurrent SSH configuration:");
    console.log(`  SSH_USER = ${process.env.SSH_USER || "(not set)"}`);
    console.log(`  SSH_HOST = ${process.env.SSH_HOST || "(not set)"}`);
    console.log(`  SSH_KEY  = ${process.env.SSH_KEY || "(not set)"}`);
    console.log("");
    for (const k of SSH_KEYS) delete process.env[k];
  }
  await ensureConfig(SSH_KEYS);

  // La llave puede haberse movido/borrado desde que se guardó: revalidar siempre.
  if (!fs.existsSync(process.env.SSH_KEY)) {
    warn(`The saved key no longer exists: ${process.env.SSH_KEY}. Enter it again.`);
    delete process.env.SSH_KEY;
    await ensureConfig(["SSH_KEY"]);
  }

  return { user: process.env.SSH_USER, host: process.env.SSH_HOST, key: process.env.SSH_KEY };
}

function requireSshClient() {
  const res = spawnSync("ssh", ["-V"], { encoding: "utf8" });
  if (res.error) {
    throw new WaError(
      "ESSH", "The SSH client was not found on this computer",
      "Windows 10/11 provides it under Settings > Apps > Optional features > " +
      "OpenSSH Client. Install it and try again."
    );
  }
}

// Prueba la conexión sin pedir contraseña (BatchMode): si la llave o la IP están mal,
// falla acá con el error real de ssh en vez de más adelante con un mensaje críptico.
export async function testSsh(cfg) {
  requireSshClient();
  const destino = `${cfg.user}@${cfg.host}`;
  info(`Testing connection to ${destino} ...`);
  const res = spawnSync(
    "ssh",
    [
      "-i", cfg.key,
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      destino, "echo CONEXION_OK",
    ],
    { encoding: "utf8" }
  );
  if (res.error) throw new WaError("ESSH", "Could not run ssh", res.error.message);
  if (res.status === 0 && (res.stdout || "").includes("CONEXION_OK")) {
    ok(`Connection successful: ${destino}`);
    return true;
  }
  fail(`Could not connect to ${destino}`);
  const detalle = (res.stderr || "").trim();
  if (detalle) console.log(`  ${detalle.split("\n").join("\n  ")}`);
  console.log(
    "  Common causes: wrong IP address, a key that does not belong to this server,\n" +
    "  or port 22 blocked for your network. Review the SSH configuration menu."
  );
  return false;
}

// Abre el túnel en una VENTANA NUEVA de consola (queda viva aunque este menú se cierre).
// Además deja generado tunel-ssh.cmd en la raíz: el usuario puede abrirlo con doble
// clic la próxima vez sin pasar por el menú.
export async function openTunnel() {
  requireSshClient();
  const cfg = await ensureSsh();

  const localPort = process.env.TUNNEL_LOCAL_PORT || "15432";
  const remoteHost = process.env.TUNNEL_REMOTE_HOST || "127.0.0.1";
  const remotePort = process.env.TUNNEL_REMOTE_PORT || "5432";

  if (!/^[a-zA-Z0-9.-]+$/.test(remoteHost)) {
    throw new WaError("ECFG", "TUNNEL_REMOTE_HOST is not valid", "Use only a domain name or IPv4 address.");
  }
  for (const [name, value] of [["TUNNEL_LOCAL_PORT", localPort], ["TUNNEL_REMOTE_PORT", remotePort]]) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new WaError("ECFG", `${name} is not a valid port`, "Use a number from 1 to 65535.");
    }
  }

  const conectado = await testSsh(cfg);
  if (!conectado) {
    const seguir = await ask("Open the tunnel window anyway? (y/N): ");
    if (!/^(y|s)/i.test(seguir)) return;
  }

  const cmdPath = path.join(ROOT_DIR, "tunel-ssh.cmd");
  const script = [
    "@echo off",
    // el .cmd se guarda en UTF-8 y la ventana nueva arranca con la codepage OEM
    // (437/850): sin esto, una ruta de llave con tildes/eñes se corrompe y ssh
    // no encuentra el archivo
    "chcp 65001 >nul",
    "title SSH Tunnel - Chatwoot PostgreSQL",
    `echo SSH tunnel: 127.0.0.1:${localPort} on this PC forwards to ${remoteHost}:${remotePort} through ${cfg.host}.`,
    "echo.",
    "echo KEEP THIS WINDOW OPEN while using the chat importer.",
    "echo To stop the tunnel: press Ctrl+C or close this window.",
    "echo.",
    `ssh -i "${cfg.key}" -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new -N -L ${localPort}:${remoteHost}:${remotePort} ${cfg.user}@${cfg.host}`,
    "echo.",
    "echo The tunnel closed or could not open. Any error is shown above.",
    "pause",
  ].join("\r\n");
  fs.writeFileSync(cmdPath, script + "\r\n");

  spawn("cmd.exe", ["/c", "start", "Tunel SSH - Chatwoot", cmdPath], {
    detached: true,
    stdio: "ignore",
    cwd: ROOT_DIR,
  }).unref();

  ok("Tunnel opened in a new window (tunel-ssh.cmd was also saved for later use).");
  console.log("");
  info(`While the tunnel is open, the server database is available locally at 127.0.0.1:${localPort}.`);

  // Si DATABASE_URL no apunta al túnel, avisar acá — es EL error más común después.
  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) {
    info(`When the importer asks for DATABASE_URL, use 127.0.0.1:${localPort}, for example:`);
    console.log(`    postgres://chatwoot:PASSWORD@127.0.0.1:${localPort}/chatwoot_production`);
  } else if (!dbUrl.includes(`127.0.0.1:${localPort}`) && !dbUrl.includes(`localhost:${localPort}`)) {
    warn(`The saved DATABASE_URL does not use the tunnel (127.0.0.1:${localPort}):`);
    console.log(`    ${dbUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:********@")}`);
    const cambiar = await ask("Update DATABASE_URL to use the tunnel host and port? (y/N): ");
    if (/^(y|s)/i.test(cambiar)) {
      const nueva = dbUrl.replace(/@[^/]+\//, `@127.0.0.1:${localPort}/`);
      process.env.DATABASE_URL = nueva;
      saveToEnvFile({ DATABASE_URL: nueva });
      ok("DATABASE_URL updated in .env.");
    }
  }
}
