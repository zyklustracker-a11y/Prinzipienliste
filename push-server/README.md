# Push-Server für die Abenderinnerung

Ein kleiner Cloudflare Worker, der die Abenderinnerung verschickt. Die eigentliche
App bleibt eine statische Seite auf GitHub Pages – hier liegt nur der Zeitplan.

**Warum überhaupt ein Server?** Auf iOS kann eine PWA keine Benachrichtigung selbst
zeitgesteuert auslösen. Sobald die App zu ist, läuft kein Code mehr. Also muss der
Anstoß von außen kommen: Ein Cron-Trigger schaut jede Minute nach, für wen gerade
die eingestellte Uhrzeit erreicht ist, und schickt einen Web Push.

## Einrichtung

Einmal ausführen, danach nie wieder nötig:

```bash
cd push-server
export CLOUDFLARE_API_TOKEN="dein-token"      # Vorlage "Edit Cloudflare Workers"
export CLOUDFLARE_ACCOUNT_ID="deine-account-id"
bash setup.sh
```

Das Skript legt den KV-Namespace an, erzeugt das VAPID-Schlüsselpaar und ein
gemeinsames Geheimnis, hinterlegt beides als Worker-Secrets und veröffentlicht den
Worker. Am Ende gibt es die drei Werte aus, die in `index.html` eingetragen werden.

Statt der Umgebungsvariablen geht auch `npx wrangler login`.

Kurzer Funktionstest danach:

```bash
curl https://prinzipien-push.<dein-subdomain>.workers.dev/health
```

## Was wo liegt

| Wert | Ort | Öffentlich? |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Worker-Secret **und** `index.html` | ja, muss es sein |
| `VAPID_PRIVATE_KEY` | nur Worker-Secret | **nein, niemals** |
| `SHARED_SECRET` | Worker-Secret **und** `index.html` | siehe unten |
| Abos, Uhrzeit, Zeitzone, Wochentage | KV-Namespace `SUBS` | nein |

Im Repository liegt keiner dieser Werte. `.gitignore` sperrt zusätzlich
`.dev.vars`, `.env`, `vapid*.json` und `.wrangler/`.

> **Zur Ehrlichkeit beim gemeinsamen Geheimnis:** Der Client-Code steht in einem
> öffentlichen Repository, der Wert ist dort also mitlesbar. Er hält zufällige
> Zugriffe ab und macht das Erraten der Endpunkte sinnlos – ein echter
> Zugangsschutz ist er nicht. Für eine Ein-Personen-App ist das vertretbar; wer
> mehr will, müsste auf echte Authentifizierung umstellen.

## Endpunkte

Alle bis auf `/health` verlangen den Header `X-App-Secret`. Ohne gültigen Wert: 401.

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/subscribe` | Abo + Uhrzeit + IANA-Zeitzone + Wochentage speichern |
| POST | `/unsubscribe` | Eintrag löschen |
| POST | `/test` | sofort eine Test-Benachrichtigung schicken |
| GET | `/health` | Statusauskunft, nennt den öffentlichen VAPID-Schlüssel |

`/subscribe` erwartet:

```json
{
  "subscription": { "endpoint": "https://web.push.apple.com/…",
                    "keys": { "p256dh": "…", "auth": "…" } },
  "hour": 20,
  "minute": 0,
  "days": [0,1,2,3,4,5,6],
  "timeZone": "Europe/Zurich",
  "title": "optional",
  "body": "optional"
}
```

`days` zählt von 0 = Sonntag bis 6 = Samstag. Eine leere Liste bedeutet: alle Tage.
Eine unbekannte Zeitzone fällt still auf UTC zurück, damit ein Tippfehler nicht
jede Minute den Cron-Lauf abwürgt.

## Wie der Cron entscheidet

Jede Minute, für jeden Eintrag einzeln:

1. Lokale Zeit in dessen Zeitzone bestimmen (`Intl.DateTimeFormat` mit `timeZone`,
   `hourCycle: "h23"` – sonst liefern manche ICU-Fassungen für Mitternacht „24“).
2. Stunde und Minute müssen übereinstimmen, der Wochentag muss aktiviert sein.
3. `lastSent` speichert das lokale Datum des letzten Versands – so geht pro Tag
   höchstens eine Meldung raus.
4. Antwortet der Push-Dienst mit 404 oder 410, ist das Abo tot und wird gelöscht.
5. Bei 429 oder 5xx wird `lastSent` **nicht** gesetzt, damit es der nächste Lauf
   am selben Tag noch einmal versucht.

Jeder Eintrag läuft in seinem eigenen `try`. Ein defekter Datensatz kann den Lauf
also nicht abbrechen.

## Web Push ohne Fremdcode

Die übliche npm-Bibliothek `web-push` baut auf Node-crypto (`jws`, `asn1.js`,
`http_ece`) und läuft in Workers nicht. Die naheliegende WebCrypto-Portierung
`@block65/webcrypto-web-push` steht seit Dezember 2024 still und bringt drei
transitive Abhängigkeiten mit.

Deshalb ist beides hier direkt umgesetzt (`src/webpush.js`, rund 200 Zeilen):

* **VAPID** nach RFC 8292 – ES256-signiertes JWT, 12 Stunden gültig.
* **Payload-Verschlüsselung** nach RFC 8291 – `aes128gcm`, pro Nachricht ein
  frisches Salt und ein frisches flüchtiges Schlüsselpaar.

Für etwas, das jahrelang unbeaufsichtigt laufen soll, ist das die haltbarere Wahl:
Es gibt nichts, das verwaisen oder aus der Registry verschwinden kann.

Verifiziert wurde die Verschlüsselung, indem die erzeugte Nutzlast mit dem privaten
Schlüssel des Abonnenten wieder entschlüsselt wird – also genau den Weg, den der
Browser des Empfängers geht.

**Ausweichweg:** Schlägt die Verschlüsselung wider Erwarten fehl, geht die
Nachricht ohne Nutzlast raus. Dann entfällt die Verschlüsselung komplett, nur der
VAPID-Header bleibt, und der Service Worker zeigt seinen fest hinterlegten Text.
Für eine immer gleiche Abenderinnerung reicht das.

## Text oder Uhrzeit später ändern

**Uhrzeit, Wochentage, An/Aus:** in der App unter *Audio-Einstellungen →
Erinnerungen*. Kein Deploy, kein Eingriff hier.

**Benachrichtigungstext, ohne Deploy:** Der Text lässt sich pro Eintrag setzen.
Einmal aufrufen genügt – bestehende Uhrzeit und Tage bleiben erhalten, wenn sie
mitgeschickt werden:

```bash
curl -X POST https://<worker>/subscribe \
  -H "Content-Type: application/json" \
  -H "X-App-Secret: <dein-geheimnis>" \
  -d '{"subscription":{"endpoint":"<dein-endpunkt>","keys":{"p256dh":"…","auth":"…"}},
       "hour":20,"minute":0,"timeZone":"Europe/Zurich","days":[0,1,2,3,4,5,6],
       "title":"Neuer Titel","body":"Neuer Text"}'
```

Den eigenen Endpunkt zeigt die App unter *Erinnerungen* an.

**Benachrichtigungstext für alle, mit Deploy:** `NOTIFY_TITLE` und `NOTIFY_BODY`
in `wrangler.toml` ändern, dann `npx wrangler deploy`. Die App bleibt unberührt.

## Betrieb

```bash
npx wrangler tail          # Protokoll live mitlesen
npx wrangler deploy        # nach Änderungen neu veröffentlichen
npx wrangler kv key list --binding SUBS   # gespeicherte Abos ansehen
```
