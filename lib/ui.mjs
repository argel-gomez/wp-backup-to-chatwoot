// ui.mjs — utilidades de consola compartidas (colores, barra de progreso, paneles).
// Mismo espíritu visual que el asistente de modules/backup/wa_archive.py (rich):
// prolijo y con feedback en vivo, pero sin dependencias nuevas — ANSI puro, y se
// desactiva solo si no hay una consola real de por medio (ej. salida redirigida a log).

const TTY = process.stdout.isTTY;

const CODE = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", amber: "\x1b[33m", cyan: "\x1b[36m",
};

export function c(color, text) {
  return TTY ? `${CODE[color] || ""}${text}${CODE.reset}` : text;
}

export function bold(text) {
  return TTY ? `${CODE.bold}${text}${CODE.reset}` : text;
}

export function ok(text) { console.log(`${c("green", "✓")} ${text}`); }
export function warn(text) { console.log(`${c("amber", "⚠")} ${text}`); }
export function fail(text) { console.log(`${c("red", "✗")} ${text}`); }
export function info(text) { console.log(`${c("cyan", "·")} ${text}`); }

// Caja con borde — recibe SOLO texto plano (sin color) para que el ancho no se rompa;
// el color se aplica después de calcular el padding.
export function panel(lines, borderColor = "green") {
  const width = Math.max(...lines.map((l) => l.length), 10);
  const border = (s) => c(borderColor, s);
  console.log(border("┌" + "─".repeat(width + 2) + "┐"));
  for (const line of lines) console.log(`${border("│")} ${line.padEnd(width)} ${border("│")}`);
  console.log(border("└" + "─".repeat(width + 2) + "┘"));
}

export function banner(title, subtitle) {
  panel(subtitle ? [bold(title), c("dim", subtitle)] : [bold(title)]);
}

// Barra de progreso en una sola línea (se actualiza con \r). Sin TTY no imprime nada
// intermedio (evita ensuciar logs redirigidos a archivo) — solo un mensaje final.
// `done` admite decimales: quien llama puede sumar el avance parcial dentro del ítem en
// curso (ej. chat 3 al 40% -> 3.4) para que la barra se mueva aunque un solo ítem tarde
// minutos. El contador se muestra redondeado.
let lastLen = 0;
export function progressBar(done, total, label = "") {
  if (!TTY) return;
  const width = 28;
  const pct = total > 0 ? Math.min(done / total, 1) : 1;
  const filled = Math.round(width * pct);
  const bar = c("green", "█".repeat(filled)) + "░".repeat(width - filled);
  const line = `  ${bar} ${(pct * 100).toFixed(1).padStart(5)}%  ${Math.floor(done)}/${total}  ${label}`;
  process.stdout.write("\r" + line.padEnd(lastLen));
  lastLen = line.length;
}

export function endProgressBar() {
  if (TTY) process.stdout.write("\n");
  lastLen = 0;
}
