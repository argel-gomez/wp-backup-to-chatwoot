// errors.mjs — errores con código estable, mismo criterio que los [E##] de
// modules/backup/wa_archive.py: un código fijo por tipo de falla, buscable en el
// README, en vez de un mensaje libre distinto cada vez.

export class WaError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function printError(e) {
  if (e instanceof WaError) {
    console.error(`\n[${e.code}] ${e.message}`);
    if (e.detail) console.error(`  ${e.detail}`);
  } else {
    console.error(`\n[E00] ${e.message}`);
  }
}
