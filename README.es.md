# Respaldo de WhatsApp Business a Chatwoot

**Español** · [English](README.md)

Herramienta de código abierto para Windows que respalda **WhatsApp Business para
Android**, exporta el historial e importa contactos, conversaciones y adjuntos a
Chatwoot.

> [!IMPORTANT]
> Funciona únicamente con la aplicación WhatsApp Business para **Android**. No
> funciona con iPhone/iOS, WhatsApp personal ni respaldos de WhatsApp Cloud API.

> [!CAUTION]
> Es un proyecto comunitario experimental, no oficial ni afiliado con WhatsApp o
> Chatwoot. La importación histórica escribe directamente en PostgreSQL. Probalo
> primero en una instancia de prueba y creá un `pg_dump` verificado antes de tocar
> producción. Tener una licencia paga de Chatwoot no convierte esta herramienta
> en un producto con soporte oficial.

## Instalación rápida

1. En GitHub seleccioná **Code → Download ZIP**.
2. Extraé el ZIP completo; no ejecutes `run.bat` dentro del archivo comprimido.
3. Hacé doble clic en `run.bat`.
4. El onboarding pregunta si querés solamente respaldar, importar contactos por
   API o ejecutar el flujo completo para Chatwoot autohospedado.

También podés clonar el repositorio:

```powershell
git clone https://github.com/argel-gomez/wp-backup-to-chatwoot.git
cd wp-backup-to-chatwoot
.\run.bat
```

## Compatibilidad y registro de pruebas

Este es el entorno informado para la validación actual de `v1.0.0`. Es un registro
de prueba, no una garantía de que todas las instalaciones tengan el mismo esquema.

| Componente | Valor probado | Fecha de prueba |
|---|---|---|
| Android | 16 | 9 de agosto de 2026 |
| WhatsApp Business | Versión no registrada | 9 de agosto de 2026 |
| Chatwoot | v4.16.2 | 9 de agosto de 2026 |
| PostgreSQL | Versión no registrada | 9 de agosto de 2026 |

Antes de informar compatibilidad conviene completar las versiones faltantes. La
versión de PostgreSQL se obtiene sin modificar datos con:

```sql
SELECT version();
```

La versión de WhatsApp Business aparece en Android bajo **Configuración →
Aplicaciones → WhatsApp Business → Detalles de la aplicación**. Después de cada
actualización de Chatwoot se debe repetir el dry-run y la prueba en staging.

### Instalación automática de dependencias

- **Node.js:** debe estar instalado antes. `run.bat` verifica la versión y muestra
  el comando oficial de `winget` si falta o está desactualizado.
- **Paquetes de Node:** se instalan automáticamente con `npm ci` la primera vez,
  usando las versiones exactas de `package-lock.json`.
- **Python:** solo se necesita para respaldo/exportación. La opción 1 instala
  Python 3.12 mediante `winget` si no existe.
- **Paquetes de Python:** el asistente los instala cuando hacen falta.
- **Cliente OpenSSH:** se necesita para importar chats en una instalación propia;
  se habilita desde Características opcionales de Windows si falta.
- **ADB:** no se necesita para la copia USB normal y nunca se instala solo. Las
  Platform Tools se instalan únicamente si vas a usar la alternativa avanzada.

La instalación de paquetes requiere Internet y Windows puede solicitar autorización
para instalar Python.

## Copiar la carpeta desde Android

El programa crea automáticamente esta carpeta de destino:

```text
PLACE-HERE-1-ANDROID-BACKUP\
```

Además deja un `README.txt` bilingüe dentro y muestra la ubicación en el menú.

### Método recomendado: transferencia de archivos USB

1. Conectá el teléfono Android desbloqueado con un cable USB de datos.
2. Tocá la notificación USB y elegí **Transferencia de archivos / Android Auto**;
   no lo dejes en **Solo cargar**.
3. En el Explorador de archivos de Windows abrí **Este equipo → teléfono →
   Almacenamiento interno compartido**.
4. Navegá hasta:

   ```text
   Android\media\com.whatsapp.w4b\WhatsApp Business
   ```

5. Copiá la carpeta completa `WhatsApp Business`, incluyendo `Databases`, `Media`
   y `Backups`.
6. Pegala de modo que quede así:

   ```text
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Databases
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Media
   PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business\Backups
   ```

7. Esperá a que Windows termine de copiar antes de desconectar el teléfono.

La **depuración USB no hace falta** para la transferencia normal por MTP y no es
recomendable activarla sin necesidad.

### Alternativa avanzada: ADB y depuración USB

Usala solamente si Windows no logra copiar la carpeta por MTP. El programa no
puede activar la depuración automáticamente: Android exige que el dueño la active
y autorice desde el teléfono.

1. Instalá las [SDK Platform Tools oficiales](https://developer.android.com/tools/releases/platform-tools).
2. Activá **Opciones de desarrollador → Depuración USB**.
3. Conectá y desbloqueá el teléfono; aceptá la huella RSA de la computadora.
4. Desde la raíz del proyecto ejecutá:

   ```powershell
   adb devices
   adb pull "/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business" "PLACE-HERE-1-ANDROID-BACKUP\WhatsApp Business"
   ```

5. Al terminar, desactivá la depuración y revocá las autorizaciones si ya no
   necesitás ADB.

## Dónde colocar cada archivo

| Carpeta | Contenido |
|---|---|
| `PLACE-HERE-1-ANDROID-BACKUP\` | Carpeta completa `WhatsApp Business` de Android |
| `PLACE-HERE-2-CONTACTS\` | Archivo de contactos `.vcf` o `.csv` |
| `PLACE-HERE-3-CHATWOOT-EXPORT\` | `chatwoot_export.json` y `attachments` |

Cada carpeta tiene instrucciones bilingües en `README.txt`.

## Flujo recomendado

1. Copiá la carpeta completa del teléfono.
2. Ejecutá `run.bat` y elegí la opción 1 para verificar y exportar el respaldo.
3. Elegí formato **Chatwoot** si importarás conversaciones.
4. Para contactos, colocá el VCF/CSV en `PLACE-HERE-2-CONTACTS` y usá la opción 2.
5. Para historial, creá primero un `pg_dump`, abrí el túnel SSH con la opción 3
   y ejecutá el **Dry-run** de la opción 4.
6. Importá uno o dos chats de prueba y revisalos en Chatwoot.
7. Recién después importá el resto y sus adjuntos.

Los números con `+` o prefijo `00` se conservan como E.164. Los números nacionales
reciben `DEFAULT_COUNTRY_CODE`, por lo que un mismo archivo puede incluir contactos
de cualquier país.

## Seguridad de PostgreSQL

No abras el puerto 5432 a Internet. La conexión debe viajar así:

```text
Programa en Windows → 127.0.0.1:15432 → túnel SSH → PostgreSQL:5432
```

La detección automática lee solamente las variables necesarias de Docker y
guarda la URL en el `.env` local sin mostrar la contraseña. Consultá las guías
oficiales de Chatwoot sobre [Docker](https://developers.chatwoot.com/self-hosted/deployment/docker)
y [respaldos](https://developers.chatwoot.com/self-hosted/deployment/backup).

## Privacidad

- `.env`, llaves SSH, bases, contactos, mensajes y adjuntos están ignorados por Git.
- No publiques VCF, CSV, dumps, exports, `msgstore`, tokens ni datos del servidor.
- Procesá solamente información para la que tengas autorización.
- Revisá [SECURITY.es.md](SECURITY.es.md) antes de informar un problema.

La [documentación principal en inglés](README.md) contiene el onboarding completo,
las variables, comandos, solución de problemas y detalles de cada paso.

## Compartir en la comunidad

Este es un proyecto externo e independiente. Podés compartir el enlace en la
comunidad o Discord de Chatwoot sin enviarlo al repositorio oficial
`chatwoot/chatwoot`. No lo presentes como integración oficial ni como herramienta
con soporte de Chatwoot; los problemas y solicitudes deben dirigirse a este
repositorio.

## Licencia

[MIT](LICENSE). Se puede usar, modificar y redistribuir conservando el aviso de
licencia.

## Autor

Argel Gomez — [github.com/argel-gomez/wp-backup-to-chatwoot](https://github.com/argel-gomez/wp-backup-to-chatwoot)
