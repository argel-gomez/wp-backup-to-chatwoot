# Seguridad

## Datos que nunca deben publicarse

No adjuntes a un issue, commit o pull request archivos de respaldo, contactos,
conversaciones, adjuntos, bases de datos, `.env`, tokens de Chatwoot, URLs con
credenciales ni llaves SSH.

No abras PostgreSQL (`5432`) a Internet para usar este proyecto. La importación
de chats debe conectarse mediante el túnel SSH local que crea la aplicación.

Si una credencial fue publicada accidentalmente, elimina el contenido público y
rota inmediatamente la credencial. Borrar solamente el último commit no la
elimina del historial de Git.

## Informar una vulnerabilidad

Usa la opción **Report a vulnerability** de la pestaña Security del repositorio
si está disponible. Si no lo está, abre un issue sin incluir secretos, datos
personales ni instrucciones de explotación, y solicita un canal privado al
mantenedor.

Incluye la versión o commit afectado, el impacto esperado y los pasos mínimos
para reproducir el problema con datos ficticios.
