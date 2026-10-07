const C='hhledger-v5';
const FILES=['./','index.html','style.css','app.js','manifest.webmanifest','data/seed.json','icons/icon-192.png','icons/icon-512.png','icons/icon-180.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
// network-first（有網用最新，冇網用快取）。只處理自己網站嘅檔案：
// 雲端同步（script.google.com）一定唔可以經 service worker——以前會將幾 MB 嘅同步回應複製一份塞入快取
// （連 token 喺網址），iPhone Safari 會因此中途斷線（Load failed），冇網時仲可能俾舊回應。
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request,{ignoreSearch:true})))});
