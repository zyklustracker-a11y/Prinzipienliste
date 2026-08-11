/**
 * Erzeugt ein VAPID-Schluesselpaar (P-256) – ohne Abhaengigkeiten, nur mit der
 * WebCrypto-API von Node. Gleichwertig zu `npx web-push generate-vapid-keys`,
 * spart aber die Installation.
 *
 *   node generate-vapid.mjs           -> lesbare Ausgabe
 *   node generate-vapid.mjs --json    -> JSON (nutzt setup.sh)
 *
 * ACHTUNG: Der private Schluessel darf NIE in eine Datei im Repository. Er
 * gehoert ausschliesslich als Worker-Secret hinterlegt.
 */

const b64url = (buf) => {
  const arr = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return Buffer.from(bin, "binary").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
);

const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));   // 65 Byte -> 87 Zeichen
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = jwk.d;                                                          // 32 Byte -> 43 Zeichen

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ publicKey, privateKey }));
} else {
  console.log("");
  console.log("Oeffentlicher Schluessel (kommt ins Frontend, darf oeffentlich sein):");
  console.log("  " + publicKey);
  console.log("");
  console.log("Privater Schluessel (NUR als Worker-Secret, niemals ins Repository):");
  console.log("  " + privateKey);
  console.log("");
}
