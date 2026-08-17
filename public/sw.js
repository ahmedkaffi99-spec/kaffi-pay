// Baki-Pay — Service Worker v9.0
const CACHE = 'bakipay-v6';
const ICON_URLS = ['/icon-192.png', '/icon-512.png', '/favicon.ico'];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return c.addAll(['/', '/index.html', '/manifest.json']).catch(function(){});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  // Firebase/API calls — réseau uniquement
  if(e.request.url.includes('firestore') ||
     e.request.url.includes('firebase') ||
     e.request.url.includes('googleapis')) return;
  var url = new URL(e.request.url);
  var isIcon = ICON_URLS.indexOf(url.pathname) !== -1;
  var req = isIcon ? new Request(e.request, {cache: 'no-store'}) : e.request;
  e.respondWith(
    fetch(req).then(function(resp){
      var clone = resp.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
      return resp;
    }).catch(function(){
      return caches.match(e.request).then(function(cached){
        return cached || caches.match('/index.html');
      });
    })
  );
});
