# Auth-Alternativen für Learnweb-Zugriff

Stand: 2026-05-04

Diese Notiz bewertet realistische Wege, SSO-geschützte Learnweb-Inhalte für den
Connector lesbar zu machen, ohne Moodle-Credentials oder Session-Daten an den
Client auszugeben.

## Option A: Moodle Web Service REST API

Moodle bietet offizielle Web Services über Endpunkte wie
`/webservice/rest/server.php`. Dafür müssen Web Services, Protokolle,
Funktionen, Rollenrechte und Tokens serverseitig freigeschaltet werden.

Vorteile:

- Stabilere Datenformen als HTML-Scraping.
- Klare Funktionengrenzen und Rechteprüfung durch Moodle.

Nachteile im WWU-Kontext:

- Aktuell liegt kein Admin- oder Service-Token-Zugriff vor.
- Ein Token-Workflow müsste über die Learnweb-/IT-Administration geklärt werden.
- Viele benötigte Kurs-/Plugin-Daten sind nur verfügbar, wenn die jeweilige
  Funktion explizit freigeschaltet und dem Token erlaubt ist.

Bewertung: fachlich sauber, aber nicht kurzfristig umsetzbar. Als Folgepfad erst
nach IT-Ticket für Service-Token verfolgen.

Primärquellen:

- https://docs.moodle.org/en/Using_web_services
- https://docs.moodle.org/en/Web_services
- https://docs.moodle.org/501/en/Development:Creating_a_web_service_client

## Option B: Session-authentifizierte Moodle-AJAX-Endpunkte

Moodles `core/ajax` ruft zentrale AJAX-Webservice-Funktionen über die aktuelle
Browser-/Moodle-Session auf. Der Connector kann denselben Weg mit der bestehenden
SSO-Session und einem gültigen `sesskey` nutzen, ohne ein separates Web-Service-
Token zu benötigen.

Vorteile:

- Passt zur bestehenden Session-Architektur des Connectors.
- Liefert strukturierte Daten für UI-Funktionen, die Moodle clientseitig rendert.
- Kein neues NPM-Paket und kein Admin-Token nötig.

Nachteile:

- Methoden und Response-Shapes sind stärker an Moodles UI-Flows gekoppelt.
- `sesskey` muss gültig gecacht und bei Re-Login invalidiert werden.
- Fehler kommen teils als HTTP 200 mit `exception`-Objekt und müssen explizit
  klassifiziert werden.

Bewertung: bester kurzfristiger Pfad für Timeline/Calendar. Im Code wird bereits
`core_calendar_get_action_events_by_timesort` über `/lib/ajax/service.php`
genutzt; weitere AJAX-Funktionen sollten nur nach Fixture- und Log-Validierung
ergänzt werden.

Primärquellen:

- https://moodledev.io/docs/4.1/guides/javascript/ajax
- https://jsdoc.moodledev.io/4.01/module-core_ajax.html
- https://moodledev.io/docs/5.1/apis/subsystems/external/functions

## Option C: SSO-Scraping über HTML-Seiten

Der aktuelle Connector nutzt die bestehende Moodle-Session, ruft HTML-Seiten ab
und extrahiert strukturierte Daten mit Cheerio. Für unbekannte oder gedriftete
Modtypes gibt es zusätzlich `parseFallback` und `learnweb-get-page`, die
bereinigten Seitentext zurückgeben.

Vorteile:

- Funktioniert ohne Moodle-Admin-Rechte.
- Deckt Plugin-Seiten ab, die keine freigeschaltete Webservice-Funktion besitzen.
- Gute kurzfristige Diagnosebasis, wenn Parser strukturierte Selektoren verlieren.

Nachteile:

- HTML und CSS-Klassen können mit Moodle-/Plugin-Updates driften.
- Parser brauchen Fixtures und Regressionstests.
- Datei-Downloads über `/pluginfile.php` sind bewusst nicht abgedeckt; dafür
  wären Binary-Streaming, Content-Type-Prüfung und Caching nötig.

Bewertung: bleibt der Standardpfad für Activity-Parser und den SSO-Proxy. Neue
Parser sollen zuerst gegen Plugin-Quellen und danach gegen sanitizte Fixtures
abgesichert werden.

Primärquellen:

- https://github.com/learnweb/moodle-mod_ratingallocate
- https://moodledev.io/docs/5.0/apis/plugintypes/mod
