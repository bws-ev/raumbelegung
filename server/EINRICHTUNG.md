# Raumbelegung BWS – Gastzugang über raum.bws-ev.de

Ziel: Monika und später Gäste sehen die Belegung ohne BWS-Konto.
Sie sehen belegt/frei und den Veranstalter, keinen Betreff.
Der Dienst läuft auf dem Hetzner-Server (Projekt BWS, ubuntu-4gb-nbg1-2).

Reihenfolge: 1 Entra → 2 Exchange → 3 DNS → 4 Server → 5 Test → 6 Gastlink.

---

## 1. Entra: Anwendungsberechtigung und Geheimnis

Entra Admin Center → App-Registrierungen → „Raumbelegung BWS".

a) API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph →
   **Anwendungsberechtigungen** → `Calendars.Read` → hinzufügen →
   „Administratorzustimmung für BildungsWerkstatt erteilen".
   Die vorhandene delegierte Berechtigung Calendars.Read bleibt.

b) Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel →
   Beschreibung „Belegungsdienst Hetzner", Gültigkeit 24 Monate.
   Den **Wert** sofort kopieren, er wird nur einmal angezeigt.
   Er kommt in Schritt 4 in die Datei /etc/raumbelegung.env.
   Ablaufdatum in den Kalender eintragen.

c) Für Schritt 2 wird die Anwendungs-ID (Client-ID) gebraucht:
   1fd3facf-d2aa-4680-b963-7212dff467d5

---

## 2. Exchange: App auf die Raumpostfächer begrenzen

Ohne diesen Schritt könnte die App jeden Kalender der BWS lesen.

```powershell
Connect-ExchangeOnline

# E-Mail-aktivierte Sicherheitsgruppe mit den acht Räumen
New-DistributionGroup -Name "Raumbelegung-API" -Alias raumbelegung-api -Type Security
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member raum-digi1
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member raum-analog
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member raum-perso
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member raum-systemisch-2og
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member raum-besprechung-2og
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member palmenhaus-cafe
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member palmenhaus-seminar
Add-DistributionGroupMember -Identity "Raumbelegung-API" -Member palmenhaus-beratung

# Zugriff der App auf diese Gruppe beschränken
New-ApplicationAccessPolicy -AppId 1fd3facf-d2aa-4680-b963-7212dff467d5 `
  -PolicyScopeGroupId raumbelegung-api@bws-ev.de `
  -AccessRight RestrictAccess `
  -Description "Belegungsdienst darf nur Raumkalender lesen"

# Prüfen (Granted bei Raum, Denied bei einer Person)
Test-ApplicationAccessPolicy -AppId 1fd3facf-d2aa-4680-b963-7212dff467d5 -Identity raum-analog@bws-ev.de
Test-ApplicationAccessPolicy -AppId 1fd3facf-d2aa-4680-b963-7212dff467d5 -Identity perr@bws-ev.de
```

Die Policy greift nach bis zu 30 Minuten.

Damit Monika buchen kann, müssen die Räume externe Anfragen annehmen:

```powershell
"raum-digi1","raum-analog","raum-perso","raum-systemisch-2og","raum-besprechung-2og",
"palmenhaus-cafe","palmenhaus-seminar","palmenhaus-beratung" |
  ForEach-Object { Set-CalendarProcessing -Identity $_ -ProcessExternalMeetingMessages $true }
```

---

## 3. DNS bei IONOS

Server-IP in der Hetzner Console ablesen (Projekt BWS → Server → ubuntu-4gb-nbg1-2 → Primäre IPv4).

IONOS → Domain bws-ev.de → DNS → Eintrag hinzufügen:
- Typ **A**, Hostname `raum`, Wert = IPv4 des Servers, TTL 1 Stunde
- optional Typ **AAAA**, Hostname `raum`, Wert = IPv6 des Servers

Prüfen nach ein paar Minuten: `dig +short raum.bws-ev.de`

---

## 4. Server einrichten

Als root per SSH auf den Server. Die vier Dateien aus dem Ordner `server/`
des Repos werden gebraucht; am einfachsten das Repo auf dem Server klonen.

```bash
apt update && apt install -y nginx nodejs git certbot python3-certbot-nginx
node -v    # muss 18 oder höher sein

# Code holen
git clone https://github.com/bws-ev/raumbelegung.git /opt/raumbelegung-src
mkdir -p /opt/raumbelegung /var/www/raumbelegung
cp /opt/raumbelegung-src/server/server.js /opt/raumbelegung/
cp /opt/raumbelegung-src/index.html /var/www/raumbelegung/

# Konfiguration (Geheimnis und Gastschlüssel eintragen)
cp /opt/raumbelegung-src/server/raumbelegung.env.beispiel /etc/raumbelegung.env
echo "GUEST_KEY-Vorschlag: $(openssl rand -hex 16)"
nano /etc/raumbelegung.env        # CLIENT_SECRET und GUEST_KEY ausfüllen
chmod 600 /etc/raumbelegung.env

# Dienst
cp /opt/raumbelegung-src/server/raumbelegung.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now raumbelegung
systemctl status raumbelegung --no-pager
curl -s localhost:8787/api/health      # → {"ok":true}

# nginx + Zertifikat
cp /opt/raumbelegung-src/server/nginx-raum.bws-ev.de.conf /etc/nginx/sites-available/raum.bws-ev.de
ln -s /etc/nginx/sites-available/raum.bws-ev.de /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d raum.bws-ev.de --redirect -m info@bws-ev.de --agree-tos -n
```

Firewall „web-basis" in der Hetzner Console: eingehend TCP 80 und 443 müssen offen sein.

Später aktualisieren:
```bash
cd /opt/raumbelegung-src && git pull
cp server/server.js /opt/raumbelegung/ && cp index.html /var/www/raumbelegung/
systemctl restart raumbelegung
```

---

## 5. Test

```bash
KEY=$(grep GUEST_KEY /etc/raumbelegung.env | cut -d= -f2)
curl -s "https://raum.bws-ev.de/api/belegung?from=$(date +%F)&to=$(date -d '+7 days' +%F)&key=$KEY" | head -c 600
```

Erwartet: JSON mit `rooms` und Einträgen. Bei `403` auf dem Graph-Teil fehlt
die Admin-Zustimmung oder die Access Policy greift noch nicht.
Logs: `journalctl -u raumbelegung -f`

---

## 6. Gastlink

Monika bekommt:

    https://raum.bws-ev.de/?key=<GUEST_KEY>

Die Seite erkennt den Schlüssel, überspringt die Microsoft-Anmeldung und
zeigt „Gast" im Status. Klick auf eine freie Zeit zeigt die Raumadresse
zum Einladen. Der gleiche Link funktioniert auch auf
https://bws-ev.github.io/raumbelegung/?key=<GUEST_KEY>

Mit BWS-Konto bleibt alles wie bisher: https://raum.bws-ev.de/ ohne key.
Dafür in Entra unter Authentifizierung die Redirect-URI
`https://raum.bws-ev.de/` (SPA) ergänzen.

Schlüssel wechseln: GUEST_KEY in /etc/raumbelegung.env ändern,
`systemctl restart raumbelegung`, neuen Link verteilen.
