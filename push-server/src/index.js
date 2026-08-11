/**
 * Push-Server fuer "Meine Prinzipien" – Cloudflare Worker.
 *
 * Hintergrund: Auf iOS kann eine PWA keine Benachrichtigung selbst zeitgesteuert
 * ausloesen. Sobald die App zu ist, laeuft kein Code mehr. Deshalb liegt der
 * Zeitplan hier: ein Cron-Trigger schaut jede Minute nach, fuer wen gerade die
 * eingestellte Uhrzeit erreicht ist, und schickt einen Web Push. Die eigentliche
 * App bleibt eine statische Seite auf GitHub Pages.
 *
 * Endpunkte (alle POST, alle mit CORS, alle hinter dem gemeinsamen Geheimnis):
 *   /subscribe    Abo + Uhrzeit + Zeitzone + Wochentage speichern
 *   /unsubscribe  Eintrag loeschen
 *   /test         sofort eine Test-Benachrichtigung schicken
 *   /health       (GET) kleine Statusauskunft, ohne Geheimnis
 */

import { sendPush } from "./webpush.js";

/* ── CORS ──────────────────────────────────────────────────────────── */

function corsHeaders(env, request) {
  // Standard ist die GitHub-Pages-Adresse; ALLOWED_ORIGIN kann sie ueberschreiben.
  // Mehrere Adressen sind per Komma moeglich (z. B. localhost zum Ausprobieren).
  const allowed = (env.ALLOWED_ORIGIN || "https://zyklustracker-a11y.github.io")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const hit = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": hit,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env, request) }
  });
}

/* ── Zeitrechnung ──────────────────────────────────────────────────── */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Die lokale Zeit eines Eintrags in seiner eigenen Zeitzone bestimmen.
 * hourCycle "h23" ist wichtig: mit hour12:false liefern manche ICU-Fassungen
 * fuer Mitternacht "24" statt "0", was den Minutenvergleich stillschweigend
 * kaputtmachen wuerde.
 */
function localParts(timeZone, date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short"
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    hour: parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10),
    weekday: WEEKDAYS[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`      // lokales Datum, fuer "hoechstens einmal pro Tag"
  };
}

/* ── Eintraege ─────────────────────────────────────────────────────── */

/** Schluessel aus dem Endpunkt ableiten, damit ein erneutes Abo denselben Eintrag trifft. */
async function keyFor(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function sanitize(input) {
  const sub = input && input.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint)) {
    throw new Error("subscription.endpoint fehlt oder ist keine https-Adresse");
  }
  const hour = Number(input.hour);
  const minute = Number(input.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("hour muss 0..23 sein");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("minute muss 0..59 sein");

  let days = Array.isArray(input.days) ? input.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  days = [...new Set(days)].sort();
  if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];

  // Zeitzone gegen Intl pruefen – ein Tippfehler wuerde den Cron sonst jede
  // Minute mit derselben Ausnahme abwuergen.
  let timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }); }
  catch { timeZone = "UTC"; }

  return {
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: (sub.keys && sub.keys.p256dh) || "", auth: (sub.keys && sub.keys.auth) || "" }
    },
    hour, minute, days, timeZone,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 80) : null,
    body: typeof input.body === "string" && input.body.trim() ? input.body.trim().slice(0, 200) : null,
    lastSent: null,
    updatedAt: Date.now()
  };
}

/* ── Nachrichtentext ───────────────────────────────────────────────── */

// Standardtext. Laesst sich pro Eintrag ueberschreiben (title/body beim
// /subscribe mitschicken) – dafuer ist KEIN neues Deploy noetig.
const DEFAULT_TITLE = "Meine Prinzipien";
const DEFAULT_BODY = "Zeit, deine Prinzipien zu festigen.";

function payloadFor(rec, env) {
  return {
    title: rec.title || env.NOTIFY_TITLE || DEFAULT_TITLE,
    body: rec.body || env.NOTIFY_BODY || DEFAULT_BODY,
    url: env.APP_URL || "https://zyklustracker-a11y.github.io/Prinzipienliste/"
  };
}

function pushConfig(env) {
  const missing = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].filter(k => !env[k]);
  if (missing.length) throw new Error("Worker-Secret fehlt: " + missing.join(", "));
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || "mailto:push@example.com"
  };
}

/* ── HTTP ──────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        hasVapid: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        hasSecret: !!env.SHARED_SECRET,
        publicKey: env.VAPID_PUBLIC_KEY || null   // oeffentlich, darf raus
      }, 200, env, request);
    }

    // Gemeinsames Geheimnis. ACHTUNG: Der Client-Code liegt in einem
    // oeffentlichen Repository, der Wert ist dort also mitlesbar. Das haelt
    // zufaellige Zugriffe ab, ist aber kein echter Zugangsschutz.
    const given = request.headers.get("X-App-Secret") || "";
    if (!env.SHARED_SECRET || given !== env.SHARED_SECRET) {
      return json({ error: "nicht berechtigt" }, 401, env, request);
    }

    if (request.method !== "POST") {
      return json({ error: "nur POST" }, 405, env, request);
    }

    let input;
    try { input = await request.json(); }
    catch { return json({ error: "ungueltiges JSON" }, 400, env, request); }

    try {
      if (url.pathname === "/subscribe") {
        const rec = sanitize(input);
        const key = await keyFor(rec.subscription.endpoint);
        // Vorherigen Versandstempel uebernehmen, damit ein Neuspeichern (etwa
        // beim Aendern der Uhrzeit) nicht zu einer zweiten Meldung am selben Tag fuehrt.
        const prev = await env.SUBS.get(key, "json");
        if (prev && prev.lastSent) rec.lastSent = prev.lastSent;
        await env.SUBS.put(key, JSON.stringify(rec));
        return json({ ok: true, id: key, hour: rec.hour, minute: rec.minute, days: rec.days, timeZone: rec.timeZone }, 200, env, request);
      }

      if (url.pathname === "/unsubscribe") {
        const ep = input && input.subscription && input.subscription.endpoint;
        if (!ep) return json({ error: "subscription.endpoint fehlt" }, 400, env, request);
        await env.SUBS.delete(await keyFor(ep));
        return json({ ok: true }, 200, env, request);
      }

      if (url.pathname === "/test") {
        const ep = input && input.subscription && input.subscription.endpoint;
        if (!ep) return json({ error: "subscription.endpoint fehlt" }, 400, env, request);
        const key = await keyFor(ep);
        // Bevorzugt den gespeicherten Eintrag, damit der Test denselben Weg
        // geht wie der echte Versand. Sonst das mitgeschickte Abo verwenden.
        const rec = (await env.SUBS.get(key, "json")) || sanitize({ ...input, hour: 20, minute: 0 });
        const payload = payloadFor(rec, env);
        payload.title = "Test – " + payload.title;
        const res = await sendPush(rec.subscription, payload, pushConfig(env));
        if (res.gone) await env.SUBS.delete(key);
        return json({
          ok: res.status >= 200 && res.status < 300,
          status: res.status, withPayload: res.withPayload,
          detail: res.body || null
        }, 200, env, request);
      }

      return json({ error: "unbekannter Pfad" }, 404, env, request);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 400, env, request);
    }
  },

  /* ── Cron: jede Minute ─────────────────────────────────────────── */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env, new Date(event.scheduledTime || Date.now())));
  }
};

export async function runSchedule(env, now) {
  let cfg;
  try { cfg = pushConfig(env); }
  catch (e) { console.error("Cron abgebrochen:", e.message); return { sent: 0, error: e.message }; }

  let cursor, sent = 0, removed = 0, skipped = 0, failed = 0;
  do {
    const page = await env.SUBS.list({ cursor, prefix: "sub:" });
    cursor = page.list_complete ? null : page.cursor;

    for (const entry of page.keys) {
      // Jeder Eintrag fuer sich – ein kaputter darf den ganzen Lauf nicht kippen.
      try {
        const rec = await env.SUBS.get(entry.name, "json");
        if (!rec || !rec.subscription) { await env.SUBS.delete(entry.name); removed++; continue; }

        const loc = localParts(rec.timeZone || "UTC", now);
        if (loc.hour !== rec.hour || loc.minute !== rec.minute) { skipped++; continue; }
        if (!(rec.days || []).includes(loc.weekday)) { skipped++; continue; }
        if (rec.lastSent === loc.date) { skipped++; continue; }   // hoechstens einmal pro Tag

        const res = await sendPush(rec.subscription, payloadFor(rec, env), cfg);

        if (res.gone) {
          // 404/410: das Abo existiert beim Push-Dienst nicht mehr.
          await env.SUBS.delete(entry.name);
          removed++;
          continue;
        }
        if (res.status >= 200 && res.status < 300) {
          rec.lastSent = loc.date;
          await env.SUBS.put(entry.name, JSON.stringify(rec));
          sent++;
        } else {
          // z. B. 429 oder 5xx: Stempel NICHT setzen, damit es der naechste
          // Lauf am selben Tag noch einmal versuchen kann.
          failed++;
          console.error("Push fehlgeschlagen", entry.name, res.status, res.body);
        }
      } catch (e) {
        failed++;
        console.error("Eintrag uebersprungen", entry.name, String((e && e.message) || e));
      }
    }
  } while (cursor);

  console.log(`Cron: ${sent} gesendet, ${removed} entfernt, ${failed} fehlgeschlagen, ${skipped} nicht faellig`);
  return { sent, removed, failed, skipped };
}
