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
    console.log("\nConfiguración SSH actual:");
    console.log(`  SSH_USER = ${process.env.SSH_USER || "(sin definir)"}`);
    console.log(`  SSH_HOST = ${process.env.SSH_HOST || "(sin definir)"}`);
    console.log(`  SSH_KEY  = ${process.env.SSH_KEY || "(sin definir)"}`);
    console.log("");
    for (const k of SSH_KEYS) delete process.env[k];
  }
  await ensureConfig(SSH_KEYS);

  // La llave puede haberse movido/borrado desde que se guardó: revalidar siempre.
  if (!fs.existsSync(process.env.SSH_KEY)) {
    warn(`La llave guardada ya no existe: ${process.env.SSH_KEY} — hay que volver a indicarla.`);
    delete process.env.SSH_KEY;
    await ensureConfig(["SSH_KEY"]);
  }

  return { user: process.env.SSH_USER, host: process.env.SSH_HOST, key: process.env.SSH_KEY };
}

function requireSshClient() {
  const res = spawnSync("ssh", ["-V"], { encoding: "utf8" });
  if (res.error) {
    throw new WaError(
      "ESSH", "No se encontró el cliente ssh en este equipo",
      "Windows 10/11 lo trae como característica opcional: Configuración > Aplicaciones > " +
      "Características opcionales > 'Cliente OpenSSH'. Instalalo y volvé a intentar."
    );
  }
}

// Prueba la conexión sin pedir contraseña (BatchMode): si la llave o la IP están mal,
// falla acá con el error real de ssh en vez de más adelante con un mensaje críptico.
export async function testSsh(cfg) {
  requireSshClient();
  const destino = `${cfg.user}@${cfg.host}`;
  info(`Probando conexión a ${destino} ...`);
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
  if (res.error) throw new WaError("ESSH", "No se pudo ejecutar ssh", res.error.message);
  if (res.status === 0 && (res.stdout || "").includes("CONEXION_OK")) {
    ok(`Conexión OK: ${destino}`);
    return true;
  }
  fail(`No se pudo conectar a ${destino}`);
  const detalle = (res.stderr || "").trim();
  if (detalle) console.log(`  ${detalle.split("\n").join("\n  ")}`);
  console.log(
    "  Causas típicas: IP equivocada, llave que no corresponde a ese servidor, o el\n" +
    "  puerto 22 cerrado para tu red. Revisá con la opción de configurar SSH del menú."
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
    throw new WaError("ECFG", "TUNNEL_REMOTE_HOST no es un host válido", "Usá solamente un dominio o una dirección IPv4.");
  }
  for (const [name, value] of [["TUNNEL_LOCAL_PORT", localPort], ["TUNNEL_REMOTE_PORT", remotePort]]) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new WaError("ECFG", `${name} no es un puerto válido`, "Usá un número entre 1 y 65535.");
    }
  }

  const conectado = await testSsh(cfg);
  if (!conectado) {
    const seguir = await ask("¿Abrir la ventana del túnel igual? (s/N): ");
    if (!/^s/i.test(seguir)) return;
  }

  const cmdPath = path.join(ROOT_DIR, "tunel-ssh.cmd");
  const script = [
    "@echo off",
    // el .cmd se guarda en UTF-8 y la ventana nueva arranca con la codepage OEM
    // (437/850): sin esto, una ruta de llave con tildes/eñes se corrompe y ssh
    // no encuentra el archivo
    "chcp 65001 >nul",
    "title Tunel SSH - Postgres de Chatwoot",
    `echo Tunel SSH: 127.0.0.1:${localPort} en esta PC va a ${remoteHost}:${remotePort} por ${cfg.host}.`,
    "echo.",
    "echo DEJA ESTA VENTANA ABIERTA mientras uses el importador de chats.",
    "echo Para cortar el tunel: Ctrl+C o cerrar esta ventana.",
    "echo.",
    `ssh -i "${cfg.key}" -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new -N -L ${localPort}:${remoteHost}:${remotePort} ${cfg.user}@${cfg.host}`,
    "echo.",
    "echo El tunel se cerro (o no pudo abrirse - el error queda arriba).",
    "pause",
  ].join("\r\n");
  fs.writeFileSync(cmdPath, script + "\r\n");

  spawn("cmd.exe", ["/c", "start", "Tunel SSH - Chatwoot", cmdPath], {
    detached: true,
    stdio: "ignore",
    cwd: ROOT_DIR,
  }).unref();

  ok("Túnel abierto en una ventana nueva (también quedó tunel-ssh.cmd para la próxima).");
  console.log("");
  info(`Con el túnel abierto, la base del servidor se ve en esta PC como 127.0.0.1:${localPort}.`);

  // Si DATABASE_URL no apunta al túnel, avisar acá — es EL error más común después.
  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) {
    info(`Cuando el importador pida la DATABASE_URL, usá el host 127.0.0.1:${localPort}, ej:`);
    console.log(`    postgres://chatwoot:LA_CLAVE@127.0.0.1:${localPort}/chatwoot_production`);
  } else if (!dbUrl.includes(`127.0.0.1:${localPort}`) && !dbUrl.includes(`localhost:${localPort}`)) {
    warn(`Ojo: la DATABASE_URL guardada no apunta al túnel (127.0.0.1:${localPort}):`);
    console.log(`    ${dbUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:********@")}`);
    const cambiar = await ask("¿Corregir el host/puerto de la DATABASE_URL para que use el túnel? (s/N): ");
    if (/^s/i.test(cambiar)) {
      const nueva = dbUrl.replace(/@[^/]+\//, `@127.0.0.1:${localPort}/`);
      process.env.DATABASE_URL = nueva;
      saveToEnvFile({ DATABASE_URL: nueva });
      ok("DATABASE_URL actualizada en .env.");
    }
  }
}
