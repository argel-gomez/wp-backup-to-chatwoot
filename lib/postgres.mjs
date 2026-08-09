// Descubrimiento seguro de PostgreSQL para instalaciones autohospedadas de
// Chatwoot. Lee por SSH únicamente las variables de base del contenedor Rails;
// nunca abre 5432 a Internet ni imprime credenciales.

import { spawnSync } from "node:child_process";
import { WaError } from "./errors.mjs";

const REMOTE_DOCKER_DISCOVERY = [
  "set -e",
  "DOCKER=docker",
  "if ! docker info >/dev/null 2>&1; then DOCKER='sudo -n docker'; fi",
  "CID=$($DOCKER ps -q --filter label=com.docker.compose.service=rails | head -n 1)",
  "if [ -z \"$CID\" ]; then CID=$($DOCKER ps -q --filter ancestor=chatwoot/chatwoot | head -n 1); fi",
  "if [ -z \"$CID\" ]; then echo '__ERROR__=rails_not_found'; exit 3; fi",
  "$DOCKER inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \"$CID\" | grep -E '^(DATABASE_URL|POSTGRES_HOST|POSTGRES_PORT|POSTGRES_DATABASE|POSTGRES_DB|POSTGRES_USERNAME|POSTGRES_USER|POSTGRES_PASSWORD)=' || true",
  "PGCID=$($DOCKER ps -q --filter label=com.docker.compose.service=postgres | head -n 1)",
  "if [ -n \"$PGCID\" ]; then",
  "  BIND=$($DOCKER port \"$PGCID\" 5432/tcp 2>/dev/null | head -n 1 || true)",
  "  PGIP=$($DOCKER inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \"$PGCID\" 2>/dev/null || true)",
  "  printf '__PG_BIND__=%s\\n__PG_IP__=%s\\n' \"$BIND\" \"$PGIP\"",
  "fi",
].join("\n");

export function parseKeyValueLines(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

function parseBinding(value) {
  const match = String(value || "").match(/^(.*):(\d+)$/);
  if (!match) return null;
  let host = match[1].replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0" || host === "::" || host === "::1") host = "127.0.0.1";
  return { host, port: match[2] };
}

function isDockerServiceHost(host) {
  return ["postgres", "postgresql", "db", "database"].includes(String(host).toLowerCase());
}

export function deriveDatabaseSettings(values, { localPort = "15432" } = {}) {
  const binding = parseBinding(values.__PG_BIND__);
  const dockerIp = values.__PG_IP__ || "";
  let localUrl;
  let configuredHost;
  let configuredPort;

  if (values.DATABASE_URL) {
    try {
      localUrl = new URL(values.DATABASE_URL);
    } catch {
      throw new WaError("EDBURL", "La DATABASE_URL detectada no es válida", "Revisá la variable en el servidor de Chatwoot.");
    }
    if (!/^postgres(ql)?:$/.test(localUrl.protocol)) {
      throw new WaError("EDBURL", "La DATABASE_URL detectada no es de PostgreSQL");
    }
    configuredHost = localUrl.hostname;
    configuredPort = localUrl.port || values.POSTGRES_PORT || "5432";
  } else {
    const username = values.POSTGRES_USERNAME || values.POSTGRES_USER || "postgres";
    const password = values.POSTGRES_PASSWORD;
    const database = values.POSTGRES_DATABASE || values.POSTGRES_DB || "chatwoot_production";
    configuredHost = values.POSTGRES_HOST || "127.0.0.1";
    configuredPort = values.POSTGRES_PORT || "5432";

    if (password === undefined) {
      throw new WaError(
        "EDBCFG",
        "El contenedor no expone DATABASE_URL ni POSTGRES_PASSWORD",
        "Completá DATABASE_URL manualmente con las credenciales de la instalación."
      );
    }
    localUrl = new URL("postgresql://127.0.0.1");
    localUrl.username = username;
    localUrl.password = password;
    localUrl.pathname = `/${database}`;
  }

  let remoteHost = configuredHost;
  let remotePort = configuredPort;
  if (isDockerServiceHost(configuredHost)) {
    if (binding) {
      remoteHost = binding.host;
      remotePort = binding.port;
    } else if (dockerIp) {
      remoteHost = dockerIp;
    } else {
      throw new WaError(
        "EDBTUNNEL",
        `PostgreSQL usa el host Docker '${configuredHost}', pero no se encontró cómo alcanzarlo desde SSH`,
        "Publicá el puerto solo en 127.0.0.1 del servidor o configurá TUNNEL_REMOTE_HOST manualmente."
      );
    }
  }

  localUrl.hostname = "127.0.0.1";
  localUrl.port = String(localPort);

  return {
    DATABASE_URL: localUrl.toString(),
    TUNNEL_REMOTE_HOST: remoteHost,
    TUNNEL_REMOTE_PORT: String(remotePort),
  };
}

export function discoverDockerDatabase(sshConfig, { localPort = "15432" } = {}) {
  const destination = `${sshConfig.user}@${sshConfig.host}`;
  const result = spawnSync(
    "ssh",
    [
      "-i", sshConfig.key,
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=accept-new",
      destination,
      REMOTE_DOCKER_DISCOVERY,
    ],
    { encoding: "utf8", windowsHide: true }
  );

  if (result.error) throw new WaError("EDBDISC", "No se pudo ejecutar SSH", result.error.message);
  if (result.status !== 0) {
    const values = parseKeyValueLines(result.stdout);
    const cause = values.__ERROR__ === "rails_not_found"
      ? "No se encontró el contenedor Rails de Chatwoot."
      : "Docker no está disponible para ese usuario SSH o la instalación no usa Docker Compose.";
    throw new WaError("EDBDISC", "No se pudo detectar PostgreSQL automáticamente", cause);
  }

  return deriveDatabaseSettings(parseKeyValueLines(result.stdout), { localPort });
}

export function maskDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "********";
    return url.toString();
  } catch {
    return "(URL configurada)";
  }
}
