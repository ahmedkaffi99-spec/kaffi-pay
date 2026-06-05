// Kaffi-Pay — Service Worker v3.0
const CACHE = 'kaffipay-v3';

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return c.addAll(['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/logo.png']).catch(function(){});
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
  e.respondWith(
    fetch(e.request).then(function(resp){
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
