/**
 * Web Push fuer die Cloudflare-Workers-Runtime – ohne Abhaengigkeiten.
 *
 * Warum nicht die uebliche npm-Bibliothek "web-push": die baut auf Node-crypto
 * (jws, asn1.js, http_ece) und laeuft in Workers nicht. Und warum keine der
 * WebCrypto-Portierungen: die einzige ernsthafte Kandidatin
 * (@block65/webcrypto-web-push) steht seit Dezember 2024 still und bringt drei
 * transitive Abhaengigkeiten mit. Fuer etwas, das jahrelang unbeaufsichtigt
 * laufen soll, ist eine eigene Umsetzung ohne Fremdcode die haltbarere Wahl:
 * hier kann nichts verwaisen oder aus der Registry verschwinden.
 *
 * Umgesetzt sind:
 *   - VAPID (RFC 8292): ES256-signiertes JWT im Authorization-Header
 *   - Payload-Verschluesselung (RFC 8291): aes128gcm
 *
 * Alles davon deckt die WebCrypto-API der Workers-Runtime ab:
 * ECDSA P-256 zum Signieren, ECDH P-256 fuer den Schluesselaustausch,
 * HKDF-SHA256 zur Ableitung und AES-GCM zum Verschluesseln.
 */

/* ── Kodierung ─────────────────────────────────────────────────────── */

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/* ── VAPID: ES256-JWT ──────────────────────────────────────────────── */

/**
 * Den privaten VAPID-Schluessel importieren. Generatoren (auch
 * `npx web-push generate-vapid-keys`) liefern den privaten Schluessel als
 * base64url des rohen 32-Byte-Skalars. WebCrypto braucht dafuer ein JWK,
 * dessen x/y aus dem oeffentlichen Schluessel stammen – deshalb werden beide
 * Haelften uebergeben.
 */
async function importVapidKey(publicB64, privateB64) {
  const pub = b64urlToBytes(publicB64);   // 65 Byte: 0x04 || X(32) || Y(32)
  const priv = b64urlToBytes(privateB64); // 32 Byte
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY ist kein unkomprimierter P-256-Punkt (65 Byte, 0x04)");
  if (priv.length !== 32) throw new Error("VAPID_PRIVATE_KEY hat nicht 32 Byte");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(priv)
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

/** Authorization-Header nach RFC 8292 bauen: `vapid t=<jwt>, k=<pubkey>`. */
export async function vapidHeader(endpoint, publicB64, privateB64, subject) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,   // 12 h; das Maximum sind 24 h
    sub: subject
  };
  const signingInput = bytesToB64url(utf8(JSON.stringify(header))) + "." +
                       bytesToB64url(utf8(JSON.stringify(claims)));
  const key = await importVapidKey(publicB64, privateB64);
  // WebCrypto liefert ECDSA-Signaturen bereits als rohes r||s (64 Byte) –
  // genau das erwartet JWS. Keine DER-Umwandlung noetig.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  const jwt = signingInput + "." + bytesToB64url(sig);
  return `vapid t=${jwt}, k=${publicB64}`;
}

/* ── Payload-Verschluesselung: aes128gcm (RFC 8291) ────────────────── */

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8
  );
  return new Uint8Array(bits);
}

/**
 * Nutzlast fuer einen Abonnenten verschluesseln.
 * Ergebnis ist der komplette Body:
 *   salt(16) | recordSize(4) | idLen(1) | serverPublicKey(65) | ciphertext
 */
export async function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublicRaw = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);

  // Fluechtiges Schluesselpaar des Servers – pro Nachricht ein neues.
  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, true, []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey }, serverKeys.privateKey, 256
  ));

  // RFC 8291 §3.4 – der gemeinsame Ausgangsschluessel bindet beide oeffentlichen
  // Schluessel mit ein, damit die Ableitung an genau dieses Paar gebunden ist.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublicRaw, serverPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salt, ikm, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8("Content-Encoding: nonce"),    new Uint8Array([0])), 12);

  // 0x02 schliesst den (einzigen und letzten) Datensatz ab.
  const plaintext = concat(utf8(payload), new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext
  ));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);   // big-endian

  return concat(salt, recordSize, new Uint8Array([serverPublicRaw.length]), serverPublicRaw, ciphertext);
}

/* ── Versand ───────────────────────────────────────────────────────── */

/**
 * Eine Push-Nachricht zustellen.
 *
 * Schlaegt die Verschluesselung fehl, geht die Nachricht bewusst OHNE Nutzlast
 * raus: dann entfaellt die Verschluesselung komplett, nur der VAPID-Header
 * bleibt, und der Service Worker zeigt seinen fest hinterlegten Text. Fuer eine
 * immer gleiche Abenderinnerung reicht das voellig – besser eine Erinnerung
 * mit Standardtext als gar keine.
 *
 * @returns {Promise<{status:number, gone:boolean, withPayload:boolean, body:string}>}
 *          gone === true bedeutet: 404/410, das Abo ist tot und gehoert geloescht.
 */
export async function sendPush(subscription, payloadObj, cfg) {
  const { endpoint, keys } = subscription;
  const headers = {
    TTL: String(cfg.ttl ?? 12 * 60 * 60),
    Urgency: "normal",
    Authorization: await vapidHeader(endpoint, cfg.publicKey, cfg.privateKey, cfg.subject)
  };

  let body = null;
  let withPayload = false;
  if (payloadObj && keys && keys.p256dh && keys.auth) {
    try {
      body = await encryptPayload(JSON.stringify(payloadObj), keys.p256dh, keys.auth);
      headers["Content-Encoding"] = "aes128gcm";
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(body.length);
      withPayload = true;
    } catch (e) {
      // Ausweichweg: ohne Nutzlast weiter, Text steckt im Service Worker.
      console.error("Verschluesselung fehlgeschlagen, sende ohne Nutzlast:", e && e.message);
      body = null;
      withPayload = false;
    }
  }

  const res = await fetch(endpoint, { method: "POST", headers, body });
  const text = await res.text().catch(() => "");
  return {
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    withPayload,
    body: text.slice(0, 300)
  };
}
