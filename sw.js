/**
 * Service Worker für "Meine Prinzipien".
 *
 * BEWUSST OHNE fetch-Handler und ohne jedes Caching.
 *
 * Die App ist eine einzige index.html, die von GitHub Pages ausgeliefert wird.
 * Würde dieser Worker Anfragen abfangen und zwischenspeichern, könnte die App
 * nach einem Deploy auf einem alten Stand hängenbleiben – ein Fehler, der auf
 * einem Homebildschirm-Icon nur schwer wieder aufzulösen ist. Der Worker
 * existiert einzig, damit Push-Benachrichtigungen ankommen: Ohne fetch-Handler
 * geht jede Anfrage unverändert ans Netz, genau wie vorher.
 *
 * (Wenn die App später einmal offline laufen soll, gehört das hierher – dann
 * aber mit Network-First für index.html, nicht mit Cache-First.)
 */

const NOTIFY_TAG = "prinzipien-erinnerung";
const ICON = "./icon-512.png";

// Fällt nur an, wenn der Push ohne Nutzlast ankommt (Ausweichweg des Servers,
// falls die Verschlüsselung scheitert). Für eine immer gleiche Abenderinnerung
// reicht dieser feste Text.
const FALLBACK = {
  title: "Meine Prinzipien",
  body: "Zeit, deine Prinzipien zu festigen.",
  url: "./"
};

// Neue Fassung sofort übernehmen, statt auf das Schließen aller Fenster zu warten.
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(event){ event.waitUntil(self.clients.claim()); });

/* ── Benachrichtigung anzeigen ─────────────────────────────────────── */
self.addEventListener("push", function(event){
  var data = Object.assign({}, FALLBACK);
  if(event.data){
    try{
      var parsed = event.data.json();
      if(parsed && typeof parsed === "object"){
        if(parsed.title) data.title = String(parsed.title);
        if(parsed.body)  data.body  = String(parsed.body);
        if(parsed.url)   data.url   = String(parsed.url);
      }
    }catch(e){
      // Kein JSON – dann wenigstens den Rohtext zeigen.
      try{ var t = event.data.text(); if(t) data.body = t; }catch(e2){}
    }
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: ICON,
    badge: ICON,
    tag: NOTIFY_TAG,     // ersetzt eine noch offene alte Erinnerung
    renotify: true,
    data: { url: data.url }
  }));
});

/* ── Antippen: vorhandenes Fenster fokussieren, sonst neues öffnen ──── */
self.addEventListener("notificationclick", function(event){
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || FALLBACK.url;
  var targetUrl = new URL(target, self.registration.scope);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
      for(var i = 0; i < list.length; i++){
        var c = list[i];
        // Alles im Geltungsbereich der App zählt als "die App ist schon offen".
        if(c.url.indexOf(self.registration.scope) === 0){
          // In die Prinzipien-Ansicht springen und danach fokussieren.
          if(c.postMessage){ try{ c.postMessage({ type: "erinnerung-geoeffnet" }); }catch(e){} }
          if(c.focus) return c.focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
    })
  );
});

/* ── Abo erneuern, wenn der Browser es austauscht ──────────────────── */
// Der Push-Dienst kann eine Subscription ersetzen. Passiert das, während die App
// zu ist, erfährt das Frontend nichts davon – deshalb muss der Worker das neue
// Abo selbst nachmelden, sonst kommt nie wieder eine Erinnerung an.
self.addEventListener("pushsubscriptionchange", function(event){
  event.waitUntil((async function(){
    try{
      var cfg = await readConfig();
      if(!cfg || !cfg.serverUrl || !cfg.vapidPublicKey) return;

      var fresh = event.newSubscription;
      if(!fresh){
        fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToBytes(cfg.vapidPublicKey)
        });
      }

      // Das alte Abo abmelden, damit im KV kein toter Eintrag zurückbleibt.
      if(event.oldSubscription && event.oldSubscription.endpoint){
        await post(cfg, "/unsubscribe", { subscription: { endpoint: event.oldSubscription.endpoint } }).catch(function(){});
      }

      await post(cfg, "/subscribe", {
        subscription: fresh.toJSON(),
        hour: cfg.hour, minute: cfg.minute, days: cfg.days, timeZone: cfg.timeZone
      });
    }catch(e){
      console.error("pushsubscriptionchange fehlgeschlagen:", e);
    }
  })());
});

/* ── Hilfsmittel ───────────────────────────────────────────────────── */

// Die Einstellungen liegen in IndexedDB, weil ein Service Worker nicht an
// localStorage kommt. Das Frontend schreibt sie bei jeder Änderung mit.
function readConfig(){
  return new Promise(function(resolve){
    var req = indexedDB.open("prinzipien-push", 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains("config")) db.createObjectStore("config");
    };
    req.onsuccess = function(){
      try{
        var db = req.result;
        var g = db.transaction("config", "readonly").objectStore("config").get("settings");
        g.onsuccess = function(){ resolve(g.result || null); };
        g.onerror = function(){ resolve(null); };
      }catch(e){ resolve(null); }
    };
    req.onerror = function(){ resolve(null); };
  });
}

function post(cfg, path, body){
  return fetch(cfg.serverUrl.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Secret": cfg.sharedSecret || "" },
    body: JSON.stringify(body)
  });
}

function b64urlToBytes(s){
  var b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
