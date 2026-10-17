'use strict';
const KEY='hhledger.v1', SYNC_KEY='hhledger.sync', SYNCQ_KEY='hhledger.syncq', APP_VER='v32';
const TX_TYPES=['支出','收入','轉帳','分期還款'];
const WISH_ST=['想要','訂咗','收咗','棄單'];
/* 常用店舖／商戶（宅店舖、記帳對方／商戶、固定支出帳單商戶；「其他」可自由輸入並記住） */
const DEFAULT_STORES=['孤注一扭','FROM JAPAN','ONEMAP','Buyee','AMAZON','L Model','淘寶傲峰','玩具迷城','精品','香港玩具所','HOBBY LAND','Premium Bandai','AmiAmi','Carousell','Buy and Ship','港魂','爆米玩具','Mandarake','HKTVmall','Keeta','foodpanda','Uber Eats','PayPal','Apple','Google','YouTube','SmarTone','CMHK','HKBN','WSD','Prudential','停車場','Mum'];
const OTHER_STORE='其他';
function shopOpts(){
  const pick=xs=>[...new Set((xs||[]).map(x=>String(x||'').trim()).filter(Boolean))];
  const fromWish=pick(live(S.wishlist||[]).map(w=>w.store));
  const fromTx=pick(live(S.transactions||[]).map(t=>t.counterparty));
  const fromRc=pick(live(S.recurring||[]).map(r=>r.merchant));
  const extra=pick(S.shops);
  return [...new Set([...DEFAULT_STORES,...extra,...fromWish,...fromTx,...fromRc])].sort((a,b)=>a.localeCompare(b,'zh-HK'));
}
function rememberShop(name){
  name=String(name||'').trim();
  if(!name||name===OTHER_STORE)return;
  if(DEFAULT_STORES.includes(name))return;
  if(!Array.isArray(S.shops))S.shops=[];
  if(!S.shops.includes(name))S.shops.push(name);
}
window.toggleStoreOther=sel=>{
  const custom=document.querySelector('[name="'+sel.dataset.other+'"]');
  if(!custom)return;
  if(sel.value===OTHER_STORE){custom.hidden=false;custom.required=!!sel.closest('label');custom.focus()}
  else{custom.hidden=true;custom.required=false;custom.value=''}
};
/* 互斥選項 UI：一律全部顯示，選中只加 .on；永唔好 filter 走當前／只 render 未選。 */
const CHIP_OPT_MAX=8;
const shouldChipOpts=d=>!!(d&&d.opts)&&!d.other&&(!!d.chips||d.k==='status'||((d.opts.length<=CHIP_OPT_MAX)&&!d.opts.some(o=>String(o||'').length>24)));
function choiceChipsHtml(opts,cur,{name,cls,btnCls,emptyLab}={}){
  const lab=v=>(v===''||v==null)?(emptyLab||'（未設定）'):String(v);
  const curS=cur==null?'':String(cur);
  const btns=(opts||[]).map(o=>{
    const v=o==null?'':String(o);
    return `<button type="button" class="${btnCls||'choice-btn'}${v===curS?' on':''}" data-v="${esc(v)}">${esc(lab(v))}</button>`;
  }).join('');
  const hid=name?`<input type="hidden" name="${esc(name)}" value="${esc(curS)}">`:'';
  return `<div class="${cls||'choice-chips'}">${btns}${hid}</div>`;
}
function bindChoiceChips(root,onPick){
  (root||document).querySelectorAll('.choice-chips').forEach(box=>{
    if(box.dataset.bound==='1')return; box.dataset.bound='1';
    const inp=box.querySelector('input[type="hidden"]');
    box.querySelectorAll('button[data-v]').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.preventDefault(); e.stopPropagation();
        const v=btn.getAttribute('data-v')||'';
        box.querySelectorAll('button[data-v]').forEach(b=>b.classList.toggle('on',b===btn));
        if(inp)inp.value=v;
        if(typeof onPick==='function') onPick(v,box,btn);
      });
    });
  });
}

let S=null, tab='overview', txMonth=null, wishFilter='全部', wishAnchorOnOpen=true, ovMonth=null, ovYear=null, txLimit=300, txQuery='', txKind='全部', arKind='summary', arId='';
let tabBeforeSettings=null, settingsOpen=false, syncRerenderPending=0;
const $=s=>document.querySelector(s);
/* dialog 關閉後 iOS／Safari 有時會把同一個 click「穿透」去背後嘅卡片／FAB（例如總覽「每月固定支出」），造成跳 tab 甚至無限開 dialog */
function closeDlgSafe(dlg){
  const d=dlg||$('#dlg');
  if(!d)return;
  const guard=document.createElement('div');
  guard.setAttribute('aria-hidden','true');
  guard.style.cssText='position:fixed;inset:0;z-index:9999;background:transparent;touch-action:none';
  document.body.appendChild(guard);
  try{d.close()}catch(_){}
  setTimeout(()=>{try{guard.remove()}catch(_){}},350);
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>typeof x==='number'&&isFinite(x)?x:0;
const fmt=(x,d=2)=>x==null||x===''||isNaN(x)?'TBD':'$'+Number(x).toLocaleString('en-HK',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt0=x=>fmt(x,0);
const pct=x=>x==null||x===''||isNaN(x)?'—':(x*100).toFixed(1)+'%';
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const nowISO=()=>new Date().toISOString();
/* 新 updatedAt 一定要大過舊嗰個（就算舊資料嘅時間喺將來／機時間唔準），否則 last-write-wins 會食咗你啱啱嘅改動 */
const stamp=prev=>{const t=nowISO();if(!prev||t>prev)return t;const d=new Date(prev);return isNaN(d)?t:new Date(d.getTime()+1).toISOString()};
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const live=a=>(a||[]).filter(x=>x&&!x.deleted);

/* ---------- 儲存（細資料用 localStorage；大資料自動轉 IndexedDB） ----------
   iPhone Safari 嘅 localStorage 上限約 5 MB，而且按 UTF-16 計（1 個字元 = 2 bytes），即係約 260 萬字元；
   12k 筆交易已經差唔多爆。又要留位俾同步設定同排隊清單，所以資料超過 LS_MAX 字元就一定用 IndexedDB。 */
const IDB_FLAG=KEY+'.idb', LS_MAX=1500000;
let idbP=null;
function idb(){
  if(!idbP){idbP=new Promise((ok,no)=>{const r=indexedDB.open('hhledger',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');
    r.onsuccess=()=>{const db=r.result;db.onclose=()=>{idbP=null};db.onversionchange=()=>{db.close();idbP=null};ok(db)};
    r.onerror=()=>no(r.error);r.onblocked=()=>no(new Error('IndexedDB blocked'))});idbP.catch(()=>{idbP=null})}
  return idbP}
// iOS 間中會「Connection to Indexed Database server lost」（app 喺背景耐咗）：重新連線再試
async function idbOp(fn){for(let i=0;;i++){try{return await fn(await idb())}catch(e){idbP=null;if(i>=2)throw e;await new Promise(r=>setTimeout(r,200*(i+1)))}}}
const idbSet=(k,v)=>idbOp(db=>new Promise((ok,no)=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>ok();t.onerror=()=>no(t.error);t.onabort=()=>no(t.error||new Error('IndexedDB abort'))}));
const idbGet=k=>idbOp(db=>new Promise((ok,no)=>{const t=db.transaction('kv','readonly');const q=t.objectStore('kv').get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)}));
function lsSet(k,v){try{localStorage.setItem(k,v);return true}catch(e){return false}}
let storageNote='', storageLocked=false, idbPending=null, idbWriting=null;
function save(){
  if(storageLocked)return;   // 讀唔到本機資料庫嗰陣唔寫，費事用空白資料覆蓋咗真資料
  const js=JSON.stringify(S);
  if(!localStorage.getItem(IDB_FLAG)&&js.length<LS_MAX&&lsSet(KEY,js)){storageNote='';return}
  idbPending=js;   // 連續 save 只寫最新嗰份，而且一次寫一份（次序唔會亂）
  if(!idbWriting)idbWriting=(async()=>{
    try{while(idbPending!=null){const v=idbPending;idbPending=null;await idbSet(KEY,v)}
      if(!localStorage.getItem(IDB_FLAG)){try{localStorage.removeItem(KEY)}catch(_){}lsSet(IDB_FLAG,'1')}
      storageNote='資料量大，已改用 IndexedDB 儲存（仍然只喺呢部機）'}
    catch(e){alert('儲存失敗：部機儲存空間唔夠，或者瀏覽器唔俾用資料庫（例如私密瀏覽）。請先喺設定匯出備份。')}
    finally{idbWriting=null}})();
}
async function readStored(){
  const flag=localStorage.getItem(IDB_FLAG), ls=flag?null:localStorage.getItem(KEY);
  if(ls)return ls;
  try{const v=await idbGet(KEY);if(v){if(!flag)lsSet(IDB_FLAG,'1');return v}}
  catch(e){if(flag){storageLocked=true;return null}}   // 有資料但讀唔到 → 鎖住唔寫
  return null;
}
async function load(){
  const raw=await readStored();
  if(raw){try{S=JSON.parse(raw)}catch(e){S=null}}
  if(!S){S=await (await fetch('data/seed.json',{cache:'no-store'})).json();save()}
  normalize();
  if(storageLocked){render();alert('暫時讀唔到呢部機嘅資料庫（iPhone 偶爾會咁）。為咗唔覆蓋你嘅資料，今次唔會儲存任何改動，亦唔會同步。請完全關閉 Safari／app 再開。');return}
  txMonth=ovMonth=today().slice(0,7); ovYear=today().slice(0,4);
  render();
  const m=location.hash.match(/^#sync=([A-Za-z0-9_-]+)/);
  if(m){try{const b=m[1].replace(/-/g,'+').replace(/_/g,'/');const j=JSON.parse(decodeURIComponent(escape(atob(b+'==='.slice((b.length+3)%4)))));
    if(j.u&&j.t){Sync.setCfg({url:j.u,token:j.t});history.replaceState(null,'',location.pathname);tab='overview';
      await Sync.syncNow(true);alert(Sync.cfg().lastError?('同步設定咗，但未成功：'+Sync.cfg().lastError):'雲端同步已設定好 ✓');rerender(1)}}catch(_){alert('同步連結唔啱')}
    window.addEventListener('online',()=>Sync.flush());setInterval(()=>Sync.flush(),60000);return}
  Sync.auto();
}
function normalize(){
  ['accounts','transactions','installments','wishlist','categories','salary','forecast','bonus','archive','loans','recurring','shops'].forEach(k=>{if(!Array.isArray(S[k]))S[k]=[]});
  if(!S.burden)S.burden={};
  // 宅狀態遷移 → 訂咗／收咗／棄單；再按付款現實校正（仲欠／只付訂金唔可以係「收咗」）
  const WISH_ST_MAP={
    '想要':'想要','想買':'想要','願望':'想要',
    '落訂未收貨':'訂咗','已付訂金':'訂咗','訂咗等拎':'訂咗','已訂':'訂咗','訂咗':'訂咗','未俾':'訂咗',
    '收咗貨':'收咗','已買':'收咗','收咗':'收咗',
    '棄單':'棄單','唔想要':'棄單','氣單':'棄單'
  };
  live(S.wishlist).forEach(w=>{
    const cur=w.status||'';
    let ns=WISH_ST_MAP[cur]||(WISH_ST.includes(cur)?cur:'訂咗');
    if(ns!=='棄單'&&ns!=='想要'){
      const o=wishOwed(w), dep=n(w.deposit), fp=n(w.finalPaid), price=n(w.price);
      const stillWaiting=(o!=null&&o>0)||(dep>0&&fp===0)||(dep>0&&price>0&&dep+fp<price);
      if(stillWaiting&&ns==='收咗') ns='訂咗';
    }
    if(ns!==cur){w.status=ns;w.updatedAt=stamp(w.updatedAt);Sync.queue('wishlist',w)}
  });
  if(wishFilter!=='全部'&&!WISH_ST.includes(wishFilter)) wishFilter='全部';
  if(!S.categories.includes('退款／代付收回'))S.categories.push('退款／代付收回');
}

/* ---------- 計算 ---------- */
const cards=()=>live(S.accounts).filter(a=>a.stmtBal!=null);
const exposure=a=>a.totalAcct!=null?a.totalAcct:n(a.stmtBal)+n(a.unposted);
const afterPay=a=>exposure(a)-n(a.paidAfterStmt);
const acctById=id=>live(S.accounts).find(a=>a.id===id);
/* 卡 Live 結欠：優先 App／銀行 balance（負數＝多付／surplus）；冇數字就退回 afterPay */
const cardLiveBal=a=>typeof a.balance==='number'&&isFinite(a.balance)?a.balance:afterPay(a);
/* 循環結餘／結欠（同 cardLiveBal；負＝多付，正＝結欠）。唔好同分期剩餘撈埋做一個數。 */
const revolvingBal=a=>cardLiveBal(a);
/* 分期剩餘（未入帳）：優先 unposted；冇就喺 outstanding／totalAcct 安全推算 */
const instRemain=a=>{
  if(typeof a.unposted==='number'&&isFinite(a.unposted))return Math.max(0,a.unposted);
  const tot=typeof a.outstanding==='number'&&isFinite(a.outstanding)?a.outstanding
    :(typeof a.totalAcct==='number'&&isFinite(a.totalAcct)?a.totalAcct:null);
  if(tot==null)return 0;
  return Math.max(0,tot-Math.max(0,cardLiveBal(a)));
};
/* 永遠分兩行：循環 vs 分期（HSBC／Citi 都唔好混淆） */
function cardSplitHtml(a){
  const rev=revolvingBal(a), ir=instRemain(a), fb=fmtBal(rev);
  let h=`<div class="row"><div class="l">循環結餘／結欠</div><div class="r ${fb.cls}">${fb.txt}</div></div>
    <div class="row"><div class="l">分期剩餘</div><div class="r">${fmt(ir)}</div></div>`;
  if(a.creditLimit!=null&&typeof a.availableCredit==='number'){
    const used=Math.max(0,n(a.creditLimit)-n(a.availableCredit));
    h+=`<div class="row"><div class="l">額度佔用</div><div class="r">${fmt(used)}<small class="note">可用 ${fmt(a.availableCredit)}</small></div></div>`;
  }
  if(rev<0&&ir>0)h+=`<div class="sub">循環多付中，但分期仲佔信用額</div>`;
  else if(rev>0&&ir>0)h+=`<div class="sub">循環結欠 + 分期剩餘＝卡上兩筆要分開睇</div>`;
  return h;
}
/* 流動儲備：優先 hsbc-one+hsbc-savings，否則 bank，否則所有銀行／現金／信封／儲備（唔計卡） */
const cashAccts=()=>{const A=live(S.accounts);const pref=A.filter(a=>a.id==='hsbc-one'||a.id==='hsbc-savings');
  if(pref.length)return pref;const bank=A.filter(a=>a.id==='bank');if(bank.length)return bank;
  return A.filter(a=>a.stmtBal==null&&/銀行|現金|信封|儲備/.test(a.type||''))};
const cashReserve=()=>cashAccts().reduce((s,a)=>s+n(a.balance),0);
const hasCashTrack=()=>cashAccts().length>0;
/* 記帳篩選：現金／儲蓄 vs 信用卡（用帳戶名稱對） */
const _normAcct=s=>String(s||'').toLowerCase().replace(/\s+/g,'');
const cashAcctNames=()=>cashAccts().map(a=>a.name).filter(Boolean);
const cardAcctNames=()=>cards().map(a=>a.name).filter(Boolean);
function txMatchesNames(t,names){
  const acc=_normAcct(t.account); if(!acc)return false;
  return names.some(n=>{const nn=_normAcct(n); return nn&&(acc===nn||acc.includes(nn)||nn.includes(acc));});
}
function isCashLikeTx(t){
  if(txMatchesNames(t,cashAcctNames()))return true;
  const acc=_normAcct(t.account);
  if(/visa|citi|mastercard|amex|信用卡|premier|signature/.test(acc))return false;
  return /hsbcone|hsbc\s*one|港元儲蓄|儲蓄|543|現金|八達通|信封|儲備|^bank$|滙豐.*存款|one\s*account/.test(acc);
}
function isCardLikeTx(t){
  if(txMatchesNames(t,cardAcctNames()))return true;
  const acc=_normAcct(t.account);
  return /visa|citi|mastercard|amex|信用卡|premier|signature|hsbcvisa/.test(acc);
}

/* 儲備安全線：預設 max(10000, 約一個月固定支出)；localStorage hhledger.reserveFloor 可覆寫 */
const reserveFloor=()=>{const o=localStorage.getItem('hhledger.reserveFloor');if(o!=null&&o!==''&&!isNaN(+o))return Math.max(0,+o);
  let t=0;try{t=n(fxStats().total)}catch(_){}return Math.max(10000,Math.round(t))};
const reserveWarnFloor=()=>reserveFloor()*2;
const fmtBal=x=>{if(x==null||x===''||isNaN(x))return{txt:'—',cls:''};if(x<0)return{txt:'多付 '+fmt(-x),cls:'pos'};if(x>0)return{txt:'結欠 '+fmt(x),cls:'neg'};return{txt:'結清 ✓',cls:'pos'}};
const coverQuip=(cash,netCard,instSum=0)=>{
  let tip;
  if(netCard<0)tip='循環多付中，做得好 💪';
  else if(netCard===0)tip='循環結清 ✓';
  else if(cash>=reserveWarnFloor())tip='家底穩陣，繼續保持 ✨';
  else if(cash>=reserveFloor())tip='儲備仲夠，留意使錢節奏 👀';
  else tip='流動儲備偏低，出街使錢前睇清楚 ⚠️';
  if(instSum>0)tip+=' · 分期剩餘合計 '+fmt(instSum);
  return tip;
};
function reserveStatusHtml(){if(!hasCashTrack())return'';const cash=cashReserve(),floor=reserveFloor(),warn=reserveWarnFloor();
  if(cash<floor)return`<div class="warn">⚠️ 流動儲備約 ${fmt0(cash)}，低過安全線 ${fmt0(floor)} — 出街使錢前睇清楚</div>`;
  if(cash<warn)return`<div class="warn-amber">💡 流動儲備約 ${fmt0(cash)}，接近安全線 ${fmt0(floor)}（警戒線 ${fmt0(warn)}）</div>`;
  return''}
function updateReserveBanner(){const el=$('#reserveBanner');if(!el)return;if(!S||tab==='overview'||!hasCashTrack()){el.hidden=true;el.textContent='';el.className='';return}
  const cash=cashReserve(),floor=reserveFloor(),warn=reserveWarnFloor();
  if(cash<floor){el.hidden=false;el.className='warn reserve-bar';el.textContent=`⚠️ 流動儲備約 ${fmt0(cash)}，低過安全線 ${fmt0(floor)} — 出街使錢前睇清楚`}
  else if(cash<warn){el.hidden=false;el.className='warn-amber reserve-bar';el.textContent=`💡 流動儲備約 ${fmt0(cash)}，接近安全線 ${fmt0(floor)}`}
  else{el.hidden=true;el.textContent='';el.className=''}}
function checkReserveNotify(){if(!S||!hasCashTrack())return;const cash=cashReserve(),floor=reserveFloor();if(!(cash<floor))return;
  const msg=`流動儲備約 ${fmt0(cash)}，低過安全線 ${fmt0(floor)} — 出街使錢前睇清楚`,key='hhledger.reserveNotify',d=today();
  if(localStorage.getItem(key)===d)return;try{localStorage.setItem(key,d)}catch(_){}
  toast('⚠️ '+msg,4000);
  if(typeof Notification==='undefined')return;
  const fire=()=>{try{new Notification('家計簿',{body:msg,tag:'hhledger-reserve'})}catch(_){}};
  if(Notification.permission==='granted')fire();
  else if(Notification.permission!=='denied')Notification.requestPermission().then(p=>{if(p==='granted')fire()}).catch(()=>{})}
const burdenList=()=>live(S.installments).filter(i=>i.countInBurden&&!/已完/.test(i.status||''));
/* 每月分期負擔：有貸款 tab 資料就以貸款為準（唔會同分期 tab 重複計） */
const burden=()=>loanMode()?activeLoans().reduce((s,l)=>s+n(l.monthly),0):burdenList().reduce((s,i)=>s+n(i.monthly),0);
const burdenParts=()=>{if(!loanMode())return burdenList().map(i=>[String(i.card||'').split(/[ （]/)[0],n(i.monthly)]);
  const g={};activeLoans().forEach(l=>{const k=String(l.card||l.lender||'其他').split(/[ （]/)[0];g[k]=(g[k]||0)+n(l.monthly)});return Object.entries(g).sort((a,b)=>b[1]-a[1])};
const receivable=()=>{
  const fromWish=live(S.wishlist).filter(w=>!w.receivedBack).reduce((s,w)=>s+n(w.receivable),0);
  const fromTx=live(S.transactions).filter(t=>n(t.partnerRecv)>0&&!t.partnerReceivedBack).reduce((s,t)=>s+n(t.partnerRecv),0);
  return fromWish+fromTx;
};
/* partner 應收：宅代付 + 記帳拆帳（partnerRecv）；未收排前，再按日期新→舊 */
const chargeAcctOf=w=>String((w&&(w.chargeAccount||w.account||w.paidFrom))||'').trim();
const chargeAcctOpts=()=>['',...live(S.accounts).filter(a=>a.id!=='recv').map(a=>a.name)];
function wishToRecvRow(w){
  return {_kind:'wish',id:w.id,item:w.item||'',receivable:n(w.receivable),receivedBack:!!w.receivedBack,
    forWhom:w.forWhom||'',store:w.store||'',orderRef:w.orderRef||'',date:w.date||'',
    chargeAccount:chargeAcctOf(w),recvAccount:w.recvAccount||'',recvDate:w.recvDate||''};
}
function txToRecvRow(t){
  return {_kind:'tx',id:t.id,item:t.desc||t.counterparty||t.category||'（記帳拆帳）',receivable:n(t.partnerRecv),
    receivedBack:!!t.partnerReceivedBack,forWhom:t.partnerFor||'',store:t.counterparty||'',orderRef:'',date:t.date||'',
    chargeAccount:String(t.account||'').trim(),recvAccount:t.partnerRecvAccount||'',recvDate:t.partnerRecvDate||''};
}
function recvItems(){
  const wish=live(S.wishlist).filter(w=>n(w.receivable)>0).map(wishToRecvRow);
  const txs=live(S.transactions).filter(t=>n(t.partnerRecv)>0).map(txToRecvRow);
  return wish.concat(txs).sort((a,b)=>{
    const ua=!a.receivedBack,ub=!b.receivedBack; if(ua!==ub)return ua?-1:1;
    const d=(b.date||'').localeCompare(a.date||''); if(d)return d;
    return String(a.item||'').localeCompare(String(b.item||''),'zh-HK');
  });
}
const chargeLabel=w=>{const c=chargeAcctOf(w);return c?'欠喺 '+c:'欠喺？（未設定）'};
function ensureRecvIncome(w){
  if(!w)return;
  if(w.receivedBack&&n(w.receivable)>0&&w.recvAccount){
    const desc='partner 收回：'+wishDisplayTitle(w);
    const d=w.recvDate||today();
    let tx=w.recvTxId?S.transactions.find(x=>x.id===w.recvTxId):null;
    if(tx&&!tx.deleted){
      tx.type='收入';tx.category='退款／代付收回';tx.account=w.recvAccount;tx.amount=n(w.receivable);
      tx.desc=desc;tx.date=d;tx.updatedAt=stamp(tx.updatedAt);Sync.queue('transactions',tx);
    }else{
      const nw={id:uid('t'),date:d,type:'收入',category:'退款／代付收回',account:w.recvAccount,amount:n(w.receivable),desc,notes:'由 partner 應收自動入帳',updatedAt:stamp()};
      S.transactions.push(nw);Sync.queue('transactions',nw);
      w.recvTxId=nw.id;w.updatedAt=stamp(w.updatedAt);Sync.queue('wishlist',w);
    }
  }else if(!w.receivedBack&&w.recvTxId){
    const tx=S.transactions.find(x=>x.id===w.recvTxId);
    if(tx&&!tx.deleted)tombstone('transactions',w.recvTxId);
    w.recvTxId=null;w.updatedAt=stamp(w.updatedAt);Sync.queue('wishlist',w);
  }
}
/* 記帳拆帳：partner 應收收回 → 自動收入「退款／代付收回」（鏡像 ensureRecvIncome） */
function ensureTxPartnerRecv(t){
  if(!t)return;
  if(t.partnerReceivedBack&&n(t.partnerRecv)>0&&t.partnerRecvAccount){
    const desc='partner 收回：'+(t.desc||t.counterparty||t.category||'記帳拆帳');
    const d=t.partnerRecvDate||today();
    let income=t.partnerRecvTxId?S.transactions.find(x=>x.id===t.partnerRecvTxId):null;
    if(income&&!income.deleted){
      income.type='收入';income.category='退款／代付收回';income.account=t.partnerRecvAccount;income.amount=n(t.partnerRecv);
      income.desc=desc;income.date=d;income.updatedAt=stamp(income.updatedAt);Sync.queue('transactions',income);
    }else{
      const nw={id:uid('t'),date:d,type:'收入',category:'退款／代付收回',account:t.partnerRecvAccount,amount:n(t.partnerRecv),desc,notes:'由記帳拆帳 partner 應收自動入帳',updatedAt:stamp()};
      S.transactions.push(nw);Sync.queue('transactions',nw);
      t.partnerRecvTxId=nw.id;t.updatedAt=stamp(t.updatedAt);Sync.queue('transactions',t);
    }
  }else if(!t.partnerReceivedBack&&t.partnerRecvTxId){
    const income=S.transactions.find(x=>x.id===t.partnerRecvTxId);
    if(income&&!income.deleted)tombstone('transactions',t.partnerRecvTxId);
    t.partnerRecvTxId=null;t.updatedAt=stamp(t.updatedAt);Sync.queue('transactions',t);
  }
}
const depositsHeld=()=>live(S.wishlist).filter(w=>w.status==='訂咗'&&n(w.deposit)>0).reduce((s,w)=>s+n(w.deposit),0);
const isSpend=t=>t.type==='支出'||t.type==='分期還款';
const isRefund=t=>t.type==='收入'&&t.category==='退款／代付收回';
const OFFSET_SUB='轉做分期（抵銷全數）';
const isOffset=t=>isRefund(t)||(t.type==='轉帳'&&t.sub===OFFSET_SUB);
const monthTx=m=>live(S.transactions).filter(t=>(t.date||'').startsWith(m));
const sheetOf=t=>(t.src||'').replace(/^xlsx:/,'').split('!')[0];

/* ---------- 畫面 ---------- */
const TITLES={overview:'總覽',tx:'記帳',accounts:'帳戶',inst:'分期',loan:'貸款',fixed:'每月固定支出',wish:'宅',recv:'partner 應收',pay:'人工／預測',restore:'糧／復常'};
function render(){
  $('#title').textContent=TITLES[tab];
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('#view').innerHTML=({overview:vOverview,tx:vTx,accounts:vAccounts,inst:vInst,loan:vLoan,fixed:vFixed,wish:vWish,recv:vRecv,pay:vPay,restore:vRestore})[tab]();
  updateReserveBanner();
  Sync.badge();
  if(tab==='loan')loanAnimate();
  checkReserveNotify();
  if(tab==='wish'&&wishAnchorOnOpen){
    wishAnchorOnOpen=false;
    requestAnimationFrame(()=>{const el=$('#wish-anchor-now');if(el)el.scrollIntoView({block:'start',behavior:'auto'})});
  }
}
function rerender(keepScroll){
  if(settingsOpen&&$('#dlg')&&$('#dlg').open){syncRerenderPending=keepScroll?2:1;return}
  const y=window.scrollY;render();window.scrollTo(0,keepScroll?y:0)
}

/* ---------- 15號糧 → 復常（一眼睇晒糧分配） ---------- */
const SALARY_RESTORE_LS='hhledger.salaryRestore';
const SALARY_RESTORE={
  label:'2026-10',
  asOf:'2026-10-15',
  salary:35100,
  partnerParking:2000, // partner 停車應收／月（由今次）
  noteCardInst:'卡分期（Citi ≈$6,281／月 · HSBC ≈$1,827／月）已入卡結單，唔好再用糧重複付。',
  plans:{
    A:{id:'A',name:'復常（建議）',hsbcAmt:13778.74,hsbcLabel:'HSBC 結單全數'},
    B:{id:'B',name:'只守最低',hsbcAmt:8577,hsbcLabel:'HSBC 最低'}
  },
  items:[
    {id:'hsbc',pri:'1',name:'HSBC 應繳',note:'到期 11-06 · 儲蓄 → HSBC VISA',kind:'hsbc',checkable:false},
    {id:'mum',pri:'2',name:'屋企（Mum）',amt:5500,note:'HSBC／Bank · 約月初',kind:'fixed',checkable:true},
    {id:'ins',pri:'3',name:'保險保誠 ×5',amt:3937,note:'Bank 自動轉賬 · ④約 25 號',kind:'fixed',checkable:true},
    {id:'cncbi',pri:'4',name:'CNCBI 分期',amt:1900,note:'每月 27 號',kind:'fixed',checkable:false},
    {id:'citi',pri:'✓',name:'Citi 循環最低',amt:0,note:'循環已清',kind:'info',checkable:false,doneFixed:true},
    {id:'dbs',pri:'11月',name:'DBS 私人貸',amt:12243,note:'由 11 月起 · 今個月唔計',kind:'skip',checkable:false}
  ]
};
function salaryRestoreState(){
  let st={plan:'A',done:{},partnerOn:true,ym:SALARY_RESTORE.label};
  try{const j=JSON.parse(localStorage.getItem(SALARY_RESTORE_LS)||'{}');if(j&&typeof j==='object')st=Object.assign(st,j)}catch(_){}
  if(st.ym!==SALARY_RESTORE.label){st.ym=SALARY_RESTORE.label;st.done={}}
  if(st.plan!=='A'&&st.plan!=='B')st.plan='A';
  if(typeof st.partnerOn!=='boolean')st.partnerOn=true;
  if(!st.done||typeof st.done!=='object')st.done={};
  return st;
}
function salaryRestoreSave(st){try{localStorage.setItem(SALARY_RESTORE_LS,JSON.stringify(st))}catch(_){}}
function salaryRestoreCalc(st){
  const R=SALARY_RESTORE, plan=R.plans[st.plan]||R.plans.A;
  const rows=[];
  let must=0, skippedDone=0;
  R.items.forEach(it=>{
    if(it.kind==='skip'){rows.push({...it,amt:it.amt,active:false,done:false,skip:true});return}
    if(it.kind==='info'){rows.push({...it,amt:n(it.amt),active:false,done:!!it.doneFixed,skip:false});return}
    const amt=it.kind==='hsbc'?plan.hsbcAmt:n(it.amt);
    const done=it.checkable?!!st.done[it.id]:false;
    const active=!done;
    if(active)must+=amt; else skippedDone+=amt;
    rows.push({...it,amt,active,done,skip:false,hsbcLabel:it.kind==='hsbc'?plan.hsbcLabel:null});
  });
  const partner=st.partnerOn?n(R.partnerParking):0;
  const left=n(R.salary)-must+partner;
  return {plan,rows,must,skippedDone,partner,left,salary:n(R.salary)};
}
window.toggleRestoreDone=(id)=>{
  const st=salaryRestoreState();
  st.done[id]=!st.done[id];
  salaryRestoreSave(st);rerender(1);
};
window.setRestorePlan=(p)=>{
  const st=salaryRestoreState();
  st.plan=p==='B'?'B':'A';
  salaryRestoreSave(st);rerender(1);
};
window.toggleRestorePartner=()=>{
  const st=salaryRestoreState();
  st.partnerOn=!st.partnerOn;
  salaryRestoreSave(st);rerender(1);
};
function salaryRestoreTeaserHtml(){
  const st=salaryRestoreState(), c=salaryRestoreCalc(st);
  const leftCls=c.left<5000?'neg':(c.left<12000?'amber-hi':'pos');
  return `<div class="card restore-teaser" onclick="tab='restore';history.replaceState(null,'','#restore');render()">
    <h2>💰 15號糧 → 復常 <span class="pill amber">${esc(SALARY_RESTORE.label)}</span></h2>
    <div class="restore-flow">
      <div><small class="note">糧入</small><b class="accent-num">${fmt0(c.salary)}</b></div>
      <span class="restore-arrow">→</span>
      <div><small class="note">已分配／仲要付</small><b>${fmt0(c.must)}</b></div>
      <span class="restore-arrow">→</span>
      <div><small class="note">剩可用</small><b class="restore-left ${leftCls}">${fmt0(c.left)}</b></div>
    </div>
    <div class="sub" style="margin-top:8px">${c.partner?`含 partner 停車 +${fmt0(c.partner)} · `:''}方案 ${esc(c.plan.name)} · 撳入必扣清單 →</div>
  </div>`;
}
function vRestore(){
  const R=SALARY_RESTORE, st=salaryRestoreState(), c=salaryRestoreCalc(st);
  const leftCls=c.left<5000?'neg':(c.left<12000?'amber-hi':'pos');
  const rowHtml=c.rows.map(it=>{
    if(it.skip) return `<div class="row restore-row skip"><div class="l"><span class="pill">${esc(it.pri)}</span> ${esc(it.name)}<small class="note">${esc(it.note)} · ${fmt0(it.amt)}</small></div><div class="r mute">今個月唔計</div></div>`;
    if(it.kind==='info') return `<div class="row restore-row"><div class="l"><span class="pill ok">${esc(it.pri)}</span> ${esc(it.name)}<small class="note">${esc(it.note)}</small></div><div class="r pos">${fmt0(it.amt)}</div></div>`;
    const title=it.hsbcLabel||it.name;
    const chk=it.checkable?`<label class="restore-chk" onclick="event.stopPropagation()"><input type="checkbox" ${it.done?'checked':''} onchange="toggleRestoreDone('${esc(it.id)}')"> 已扣</label>`:'';
    const stCls=it.done?'done':'';
    const right=it.done?`<span class="pill ok">已扣 · 唔重複</span>`:`<b class="${it.kind==='hsbc'?'neg':''}">${fmt0(it.amt)}</b>`;
    return `<div class="row restore-row ${stCls}"><div class="l"><span class="pill ${it.kind==='hsbc'?'amber':''}">${esc(it.pri)}</span> <b>${esc(title)}</b><small class="note">${esc(it.note)}</small>${chk}</div><div class="r">${right}</div></div>`;
  }).join('');
  return `
  <div class="actions" style="margin-bottom:8px"><button type="button" onclick="tab='overview';history.replaceState(null,'','#overview');render()">← 總覽</button></div>
  <div class="card restore-hero">
    <h2>一眼睇晒糧分配 · ${esc(R.label)}</h2>
    <div class="sub">對帳至 ${esc(R.asOf)} · 實際以銀行入帳為準</div>
    <div class="restore-hero-grid">
      <div><small class="note">糧入（估計）</small><div class="big accent-num">${fmt0(c.salary)}</div></div>
      <div><small class="note">仲要付／已分配</small><div class="big">${fmt0(c.must)}</div>
        ${c.skippedDone?`<div class="sub">已剔唔重複 ${fmt0(c.skippedDone)}</div>`:''}</div>
    </div>
    <div class="restore-left-box">
      <div class="label">剩可用（小心使）</div>
      <div class="big big-xxl restore-left ${leftCls}">${fmt0(c.left)}</div>
      <div class="sub">${c.partner?`已計 partner 停車 +${fmt0(c.partner)}`:''}${c.left<12000?' · 數字大＝提醒你慳使':''}</div>
    </div>
  </div>
  <div class="card">
    <h2>方案</h2>
    <div class="chips">
      <button type="button" class="${st.plan==='A'?'on':''}" onclick="setRestorePlan('A')">A · 還清結單（建議）</button>
      <button type="button" class="${st.plan==='B'?'on':''}" onclick="setRestorePlan('B')">B · 只守最低</button>
    </div>
    <div class="sub">${st.plan==='A'?'HSBC 用結單全數 '+fmt0(R.plans.A.hsbcAmt)+'（真復常）':'HSBC 只還最低 '+fmt0(R.plans.B.hsbcAmt)+' → 結單仲欠 ≈'+fmt0(R.plans.A.hsbcAmt-R.plans.B.hsbcAmt)+'，息會繼續'}</div>
  </div>
  <div class="card">
    <h2>必扣清單</h2>
    <div class="sub tip">Mum／保險月初已扣可剔「已扣」——15 號糧唔好再扣一次。卡分期已喺結單，唔重複。</div>
    ${rowHtml}
    <div class="sub" style="margin-top:8px">${esc(R.noteCardInst)}</div>
  </div>
  <div class="card">
    <h2>partner 停車應收</h2>
    <div class="row"><div class="l"><b>每月 $2,000</b><small class="note">由今次起 · 作收入／減輕糧壓</small>
      <label class="restore-chk"><input type="checkbox" ${st.partnerOn?'checked':''} onchange="toggleRestorePartner()"> 計入剩可用</label></div>
      <div class="r pos">+${fmt0(R.partnerParking)}</div></div>
  </div>
  <div class="card">
    <h2>「復常」定義</h2>
    <div class="sub">今個月：卡唔逾期、HSBC 最低（最好結單）準時、屋企同保險唔斷、CNCBI 準時；Citi 循環保持 $0；唔再滾新循環；扣完仲有生活錢去到月底。</div>
    <div class="sub" style="margin-top:8px"><b>若唔夠由上到下：</b> HSBC 最低 → 保險 → 屋企 → CNCBI → HSBC 結單多還 → 泊車／水電 → 訂閱雜項</div>
  </div>`;
}

function vOverview(){
  const mt=monthTx(ovMonth), spend=mt.filter(isSpend).reduce((s,t)=>s+n(t.amount),0);
  const inc=mt.filter(t=>t.type==='收入').reduce((s,t)=>s+n(t.amount),0);
  const byCat={};mt.filter(isSpend).forEach(t=>byCat[t.category]=(byCat[t.category]||0)+n(t.amount));
  const cs=cards(), exp=cs.reduce((s,a)=>s+exposure(a),0), aft=cs.reduce((s,a)=>s+afterPay(a),0);
  const warns=cs.filter(a=>a.dueDate&&a.dueDate<today()&&n(a.paidAfterStmt)<n(a.minPay))
    .map(a=>`⚠️ ${esc(a.name)}：到期日 ${a.dueDate} 已過，月結單後只還 ${fmt0(a.paidAfterStmt)}，低過最低還款 ${fmt(a.minPay)}（差 ${fmt(n(a.minPay)-n(a.paidAfterStmt))}）。`);
  const soon=cs.filter(a=>a.dueDate&&a.dueDate>=today()).map(a=>`${esc(a.name)} 到期 ${a.dueDate}（最低 ${fmt(a.minPay)}，已還 ${fmt0(a.paidAfterStmt)}）`);
  const cash=cashReserve(), netCard=cs.reduce((s,a)=>s+revolvingBal(a),0), fbNet=fmtBal(netCard);
  const instSum=cs.reduce((s,a)=>s+instRemain(a),0);
  const asOfs=live(S.accounts).map(a=>a.asOf||a.stmtDate).filter(Boolean).sort().reverse();
  const asOf=asOfs[0]||'', floor=reserveFloor();
  const cashCls=cash<floor?'neg':cash<reserveWarnFloor()?'':'pos';
  const cardRows=cs.map(a=>{
    const meta=[a.asOf?'截至 '+a.asOf:'',a.dueDate?'到期 '+a.dueDate:'',a.stmtDate?'月結單 '+a.stmtDate:''].filter(Boolean).join(' · ');
    return `<div style="margin-bottom:10px"><div class="row" style="margin-bottom:2px"><div class="l"><b>${esc(a.name)}</b>${meta?`<small class="note">${esc(meta)}</small>`:''}</div></div>${cardSplitHtml(a)}</div>`;
  }).join('');
  return `
  ${warns.map(w=>`<div class="warn">${w}</div>`).join('')}
  ${reserveStatusHtml()}
  ${salaryRestoreTeaserHtml()}
  <div class="card hero-home">
    <h2>而家嘅家底</h2>
    <div class="big big-xl ${cashCls||'pos'}">${fmt0(cash)}</div>
    <div class="sub">${asOf?'截至 '+esc(asOf)+' · ':''}${esc(coverQuip(cash,netCard,instSum))}</div>
    <div class="grid2" style="margin-top:10px">
      <div><small class="note">卡數現況（Live）</small><div class="sub" style="margin-top:4px">循環 <b class="${fbNet.cls}">${fbNet.txt}</b><br>分期合計 ${fmt(instSum)}</div></div>
      <div><small class="note">流動儲備</small><div class="big ${cashCls||'pos'}">${fmt0(cash)}</div></div>
    </div>
  </div>
  <div class="card"><h2>信用卡 Live</h2>
    <div class="sub" style="margin-bottom:6px">循環結餘／結欠同分期剩餘永遠分開顯示（唔撈埋一個數）</div>
    ${cardRows||'<div class="sub">未有信用卡帳戶</div>'}
    ${soon.length?`<div class="sub" style="margin-top:6px">📅 ${soon.join('<br>📅 ')}</div>`:''}
  </div>
  <details class="card"><summary><b>月結單參考（唔再放封面）</b></summary>
    <div class="sub" style="margin:6px 0">歷史月結單加總（含未入帳分期）— 已還清嘅結單唔再當而家欠數</div>
    <div class="big neg">${fmt0(exp)}</div>
    <div class="sub">扣月結單後還款 ≈ <b>${fmt0(aft)}</b>（未計新簽帳及利息，只係估算）</div>
    ${cs.map(a=>`<div class="row"><div class="l">${esc(a.name)}<small class="note">結欠 ${fmt(a.stmtBal)} + 未入帳分期 ${fmt(a.unposted)}${a.totalAcct!=null?'（Total Acct '+fmt(a.totalAcct)+'）':''} · 已還 ${fmt0(a.paidAfterStmt)}</small></div><div class="r">${fmt0(exposure(a))}<small class="note">→ ${fmt0(afterPay(a))}</small></div></div>`).join('')}
  </details>
  <div class="month"><span class="sub">月份</span><input type="month" value="${ovMonth}" onchange="ovMonth=this.value;render()"></div>
  <div class="grid2">
    <div class="card"><h2>本月支出</h2><div class="big">${fmt0(spend)}</div><div class="sub">${mt.length} 筆 · 收入 ${fmt0(inc)}</div></div>
    <div class="card"${loanMode()?` onclick="tab='loan';render()"`:''}><h2>每月分期負擔</h2><div class="big">${fmt0(burden())}</div><div class="sub">${burdenParts().map(([k,v])=>esc(k)+' '+fmt0(v)).join(' · ')}${loanMode()&&loanStats().last?`<br>🏁 還清日 ${ym(loanStats().last)} →`:''}</div></div>
  </div>
  ${live(S.recurring).length?(()=>{const f=fxStats();return `<div class="card" onclick="tab='fixed';history.replaceState(null,'','#fixed');render()"><h2>📌 每月固定支出</h2><div class="big">${fmt0(f.total)}</div><div class="sub">💸 貸款／分期 ${fmt0(f.loans)} + 📺 其他 ${fmt0(f.other)}（訂閱 ${fmt0(f.subs)}）→</div></div>`})():''}
  <div class="grid2">
    <div class="card" onclick="tab='recv';history.replaceState(null,'','#recv');render()"><h2>partner 應收</h2><div class="big pos">${fmt0(receivable())}</div><div class="sub">代付待收 · 撳入睇明細 →</div></div>
    <div class="card"><h2>已付訂金（未到貨）</h2><div class="big">${fmt0(depositsHeld())}</div><div class="sub">訂金已付、尾數未找</div></div>
  </div>
  <div class="card"><h2>本月分類支出</h2>${Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="row"><div class="l">${esc(c)}</div><div class="r">${fmt(v)}</div></div>`).join(''):'<div class="sub">本月未有支出紀錄 — 去「記帳」加一筆。</div>'}</div>
  ${vYear()}`;
}

function vYear(){
  const all=live(S.transactions); const years=[...new Set(all.map(t=>(t.date||'').slice(0,4)).filter(Boolean))].sort().reverse();
  if(!years.length) return '';
  if(!years.includes(ovYear)) ovYear=years[0];
  const yt=all.filter(t=>(t.date||'').startsWith(ovYear));
  const sp=yt.filter(isSpend).reduce((s,t)=>s+n(t.amount),0), rf=yt.filter(isOffset).reduce((s,t)=>s+n(t.amount),0);
  const months=[...Array(12)].map((_,i)=>{const m=ovYear+'-'+String(i+1).padStart(2,'0');const L=yt.filter(t=>t.date.startsWith(m));return [m,L.filter(isSpend).reduce((s,t)=>s+n(t.amount),0)-L.filter(isOffset).reduce((s,t)=>s+n(t.amount),0)]});
  const mx=Math.max(1,...months.map(x=>x[1]));
  const byCat={};yt.filter(isSpend).forEach(t=>byCat[t.category]=(byCat[t.category]||0)+n(t.amount));
  return `<div class="card"><h2>年度摘要 <select onchange="ovYear=this.value;rerender(1)">${years.map(y=>`<option ${y===ovYear?'selected':''}>${y}</option>`).join('')}</select></h2>
   <div class="grid2" style="margin:0"><div><div class="sub">支出（連分期）</div><div class="big">${fmt0(sp)}</div></div><div><div class="sub">扣退款／代付收回／轉做分期後</div><div class="big">${fmt0(sp-rf)}</div></div></div>
   <div class="sub">${yt.length} 筆 · 按交易日期計（舊檔月結係按「找數月份」，所以同舊表每月總數唔會一模一樣）</div>
   ${months.map(([m,v])=>`<div class="row" onclick="tab='tx';txMonth='${m}';txQuery='';render()"><div class="l">${m}<div class="bar"><i style="width:${Math.max(0,v)/mx*100}%"></i></div></div><div class="r">${fmt0(v)}</div></div>`).join('')}
   <details><summary class="sub">分類</summary>${Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="row"><div class="l">${esc(c)}</div><div class="r">${fmt0(v)}</div></div>`).join('')}</details></div>`;
}

function vTx(){
  const q=txQuery.trim().toLowerCase();
  let list=(txMonth?monthTx(txMonth):live(S.transactions));
  if(txKind==='現金儲蓄') list=list.filter(isCashLikeTx);
  else if(txKind==='信用卡') list=list.filter(isCardLikeTx);
  if(q) list=list.filter(t=>[t.desc,t.sub,t.category,t.account,t.notes,t.tag,t.src].some(x=>String(x||'').toLowerCase().includes(q)));
  list=list.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const total=list.filter(isSpend).reduce((s,t)=>s+n(t.amount),0);
  const shown=list.slice(0,txLimit);
  const kindBtn=(k,label)=>`<button type="button" class="${txKind===k?'on':''}" onclick="txKind='${k}';txLimit=300;render()">${label}</button>`;
  return `<div class="month"><input type="month" value="${txMonth}" onchange="txMonth=this.value;txLimit=300;render()">
    <button onclick="txMonth='';txLimit=300;render()">全部月份</button><span class="sub">${list.length} 筆 · 支出 ${fmt0(total)}</span></div>
  <div class="chips">${kindBtn('全部','全部帳戶')}${kindBtn('現金儲蓄','現金／儲蓄')}${kindBtn('信用卡','信用卡')}</div>
  ${txKind==='現金儲蓄'?`<div class="sub tip">💰 只睇銀行／現金／儲蓄戶口流水（唔計入卡債壓力）。HSBC 直接付款授權可之後揀住入呢度。</div>`:''}
  <div class="month"><input type="search" placeholder="搜尋（描述／分類／帳戶／Sep-25…）" value="${esc(txQuery)}" onchange="txQuery=this.value;txLimit=300;render()"></div>
  <div class="card">${shown.length?shown.map(t=>`<div class="row" onclick="editTx('${esc(t.id)}')"><div class="l">${esc(txDisplayTitle(t))}
    <small class="note">${t.date}${t.dm?'（只知月份）':''} · ${esc(t.type)} · ${esc(t.category)} · ${esc(t.account)}${t.counterparty?' · '+esc(t.counterparty):''}${t.tag?' · '+esc(t.tag):''}${t.hist?' · 舊檔 '+esc(sheetOf(t)):''}</small></div>
    <div class="r ${t.type==='收入'?'pos':''}">${t.type==='收入'?'+':''}${fmt(t.amount)}</div></div>`).join(''):'<div class="sub">呢個月未有紀錄。撳右下角 ＋ 記一筆。</div>'}
    ${list.length>txLimit?`<div class="actions"><button onclick="txLimit+=300;rerender(1)">顯示多 300 筆（仲有 ${list.length-txLimit} 筆）</button></div>`:''}</div>
  <button class="fab" onclick="editTx()">＋</button>`;
}

function vAccounts(){
  return live(S.accounts).map(a=>{
    const isCard=a.stmtBal!=null;
    const bal=a.id==='recv'?receivable():a.balance;
    const go=a.id==='recv'?`onclick="tab='recv';history.replaceState(null,'','#recv');render()"`:`onclick="editAcct('${esc(a.id)}')"`;
    return `<div class="card" ${go}><h2>${esc(a.name)} <span class="pill">${esc(a.type)}</span>${a.hist?' <span class="pill">舊檔</span>':''}</h2>${a.id==='recv'?`<div class="sub">撳入睇每筆應收／標已俾 →</div>`:''}
    ${isCard?(()=>{const lb=revolvingBal(a),fb=fmtBal(lb),ir=instRemain(a);
      const used=a.creditLimit!=null&&typeof a.availableCredit==='number'?Math.max(0,(a.creditLimit-n(a.availableCredit))/a.creditLimit):a.creditLimit?Math.max(0,Math.max(0,lb)+ir)/a.creditLimit:null;
      const sumSU=n(a.stmtBal)+instRemain(a);
      const outNote=(typeof a.outstanding==='number'&&isFinite(a.outstanding)&&Math.abs(a.outstanding-sumSU)>0.5)
        ?`<div class="sub">App 總佔用 ${fmt(a.outstanding)}（同循環+分期 ${fmt(sumSU)} 唔同，分開睇）</div>`:'';
      const tip=lb<0&&ir>0?'<div class="sub">循環多付中，但分期仲佔信用額</div>':lb>0&&ir>0?'<div class="sub">循環結欠 + 分期剩餘＝卡上兩筆要分開睇</div>':'';
      const limRow=(a.creditLimit!=null&&typeof a.availableCredit==='number')
        ?`<div class="row"><div class="l">額度佔用</div><div class="r">${fmt(Math.max(0,n(a.creditLimit)-n(a.availableCredit)))}<small class="note">可用 ${fmt(a.availableCredit)}</small></div></div>`:'';
      return `<div class="grid2" style="margin:6px 0 8px">
        <div><small class="note">循環結餘／結欠</small><div class="big ${fb.cls}">${fb.txt}</div></div>
        <div><small class="note">分期剩餘</small><div class="big">${fmt(ir)}</div></div>
      </div>
      ${tip}${limRow}
      <div class="row"><div class="l">月結單循環結欠（${a.stmtDate||'—'}）</div><div class="r">${fmt(a.stmtBal)}</div></div>
      <div class="row"><div class="l">分期剩餘（未入帳）</div><div class="r">${fmt(typeof a.unposted==='number'?a.unposted:ir)}</div></div>
      ${outNote}
      <div class="row"><div class="l">最低還款 · 到期 ${a.dueDate||'—'}</div><div class="r">${fmt(a.minPay)}</div></div>
      <div class="row"><div class="l">月結單後已還</div><div class="r">${fmt(a.paidAfterStmt)} ${n(a.paidAfterStmt)<n(a.minPay)?'<span class="pill red">低過最低</span>':'<span class="pill ok">已達最低</span>'}</div></div>
      <div class="row"><div class="l">估算（月結單+分期−已還）</div><div class="r"><b>${fmt(afterPay(a))}</b><small class="note">唔係「全部」單一數字</small></div></div>
      ${a.creditLimit?`<div class="sub">信用額 ${fmt0(a.creditLimit)}${typeof a.availableCredit==='number'?' · 可用 '+fmt(a.availableCredit):''} · 使用率 ${used!=null?(used*100).toFixed(0):'—'}%</div><div class="bar"><i style="width:${Math.min(100,(used||0)*100)}%"></i></div>`:''}`})()
    :`<div class="big">${a.hist&&a.balance==null?'—':fmt(bal)}</div>${a.asOf?`<div class="sub">截至 ${a.asOf}</div>`:''}`}
    ${a.notes?`<small class="note">${esc(a.notes)}</small>`:''}</div>`}).join('')+
    `<div class="actions"><button onclick="editAcct()">＋ 新增帳戶</button></div>`;
}

function instCard(i){
  const pc=i.total?Math.min(100,n(i.paid)/i.total*100):0, rem=i.total?i.total-n(i.paid):null;
  const lk=live(S.loans).some(l=>(l.instIds||[]).includes(i.id));
  return `<div class="row" onclick="editInst('${esc(i.id)}')"><div class="l">${esc(i.name)} ${lk?'<span class="pill">🔗 貸款 tab</span>':''}${i.countInBurden?(loanMode()?'<span class="pill amber">月結單合計（參考）</span>':'<span class="pill ok">計入月供</span>'):''}
    <small class="note">${esc(i.card)} · ${esc(i.product)}${i.total?` · ${n(i.paid)}/${i.total} 期（剩 ${rem}）`:''}${i.end?' · 完 '+String(i.end).slice(0,7):''} · ${esc(i.status)}</small>
    ${i.total?`<div class="bar"><i style="width:${pc}%"></i></div>`:''}</div>
    <div class="r">${i.monthly!=null?fmt(i.monthly)+'/月':''}${i.outstanding!=null?`<small class="note">未入帳 ${fmt0(i.outstanding)}</small>`:i.principal!=null?`<small class="note">本金 ${fmt0(i.principal)}</small>`:''}
    ${i.total&&rem>0?`<br><button onclick="event.stopPropagation();bump('${esc(i.id)}')">+1 期</button>`:''}</div></div>`;
}
function vInst(){
  const L=live(S.installments);
  const v=L.filter(i=>(i.verified||i.countInBurden)&&!i.hist), o=L.filter(i=>!(i.verified||i.countInBurden)&&!i.hist), h=L.filter(i=>i.hist);
  return `<div class="card"><h2>每月分期負擔合計${loanMode()?'（以 💸 貸款 tab 為準）':''}</h2><div class="big">${fmt(burden())}</div>
    <div class="sub">${loanMode()?`${burdenParts().map(([k,v])=>esc(k)+' '+fmt0(v)).join(' + ')}。現行貸款逐條（利率、期數、還清日）睇 <a href="#loan" onclick="tab='loan';render();return false">💸 貸款</a>；呢頁嘅月結單合計同舊檔明細只作參考，唔會重複計。月結單核對數：`:''}${Object.entries(S.burden||{}).map(([k,v])=>esc(k.toUpperCase())+' '+fmt0(v)).join(' + ')}${loanMode()?'':'（月結單核對數）。下面舊檔明細唔重複計。'}</div></div>
  <div class="card"><h2>已核對（2026-09 月結單）／計入月供</h2>${v.map(instCard).join('')}</div>
  <div class="card"><h2>舊檔明細（推算，要對月結單）</h2>${o.map(instCard).join('')}</div>
  ${h.length?`<div class="card"><h2>已完成（舊檔分期表）</h2>${h.map(instCard).join('')}</div>`:''}
  <button class="fab" onclick="editInst()">＋</button>`;
}


/* ---------- partner 應收明細 ---------- */
function vRecv(){
  const items=recvItems(), unpaid=items.filter(w=>!w.receivedBack), paid=items.filter(w=>w.receivedBack);
  const total=unpaid.reduce((s,w)=>s+n(w.receivable),0);
  const row=w=>{
    const st=w.receivedBack?'已收':'未收';
    const srcTag=w._kind==='tx'?'記帳拆帳':'宅';
    return `<div class="row" onclick="openRecvItem('${esc(w.id)}','${esc(w._kind||'wish')}')"><div class="l"><b>${esc(parseShopOrderItem(w.item,w.store).title)}</b>
      <small class="note">${esc(srcTag)}${w.forWhom?' · '+esc(w.forWhom):''}${(w.store||w.orderRef)?' · ':''}${esc(w.store||'')}${w.orderRef?(w.store?' · ':'')+'#'+esc(w.orderRef):''}${w.date?' · '+esc(w.date):''}</small>
      <small class="note">${esc(chargeLabel(w))}</small></div>
      <div class="r ${w.receivedBack?'pos':''}">${fmt0(w.receivable)}<small class="note">${st}${w.receivedBack&&w.recvAccount?' → '+esc(w.recvAccount):''}</small></div></div>`;
  };
  return `<div class="card"><h2>未收合計</h2><div class="big pos">${fmt0(total)}</div>
    <div class="sub">${unpaid.length} 筆未收 · ${paid.length} 筆已收 · 撳一筆標已俾／未俾，同睇「欠喺邊度」</div></div>
  <div class="card"><h2>未收</h2>${unpaid.length?unpaid.map(row).join(''):'<div class="sub">全部收齊 ✓</div>'}</div>
  ${paid.length?`<div class="card"><h2>已收</h2>${paid.map(row).join('')}</div>`:''}
  <div class="actions"><button type="button" onclick="tab='overview';history.replaceState(null,'','#overview');render()">← 總覽</button>
    <button type="button" onclick="tab='wish';history.replaceState(null,'','#wish');wishAnchorOnOpen=true;render()">← 宅</button></div>`;
}
function openRecvItem(id,kind){
  kind=kind||'wish';
  if(kind==='tx'){openRecvTxItem(id);return}
  const w=S.wishlist.find(x=>x.id===id); if(!w)return;
  const f=$('#dlgForm'), opts=chargeAcctOpts().filter(Boolean), ch=chargeAcctOf(w);
  const paid=!!w.receivedBack;
  const acctOpts=['',...opts].map(o=>`<option value="${esc(o)}" ${o===(w.recvAccount||'')?'selected':''}>${o?esc(o):'（請揀銀行／信用卡戶口）'}</option>`).join('');
  /* 已俾／未俾：兩掣永遠顯示，選中 .on；唔好只 render 相反嗰個 */
  f.innerHTML=`<h3 style="margin:0">${esc(wishDisplayTitle(w))}</h3>
    <div class="sub">${fmt0(w.receivable)}${w.forWhom?' · 幫 '+esc(w.forWhom):''}${w.store?' · '+esc(w.store):''}${w.orderRef?' · #'+esc(w.orderRef):''}</div>
    <div class="sub"><b>${esc(chargeLabel(w))}</b>${ch?'':' — 可撳「改資料」設代付支出戶口'}</div>
    <label>狀態（partner 已俾／未俾）
      <div class="choice-chips" id="recvPaidChips">
        <button type="button" class="choice-btn${!paid?' on':''}" data-v="0">未俾</button>
        <button type="button" class="choice-btn${paid?' on':''}" data-v="1">已俾</button>
      </div>
    </label>
    <label>收回入帳戶口（partner 已俾入邊度）<select id="recvAcctSel" name="recvAccount">${acctOpts}</select></label>
    <label>收回日期<input name="recvDate" id="recvDateInp" type="date" value="${esc(w.recvDate||today())}"></label>
    <div class="sub">標「已俾」會自動加／更新一筆收入：分類「退款／代付收回」${paid&&w.recvAccount?' · 而家 → '+esc(w.recvAccount):''}</div>
    <div class="actions"><button value="cancel" formnovalidate>關閉</button>
      <button type="button" id="editWishFromRecv">改資料</button></div>`;
  const dlg=$('#dlg'); dlg.onclose=null; dlg.returnValue='';
  const goEdit=()=>{dlg.close();editWish(id)};
  const editBtn=$('#editWishFromRecv'); if(editBtn)editBtn.onclick=goEdit;
  const markPaid=()=>{
    const acct=($('#recvAcctSel')||{}).value||'';
    if(!String(acct).trim()){toast('請先揀收回入帳戶口');return false}
    w.receivedBack=true; w.recvAccount=String(acct).trim();
    w.recvDate=(($('#recvDateInp')||{}).value)||today();
    w.updatedAt=stamp(w.updatedAt); Sync.queue('wishlist',w);
    ensureRecvIncome(w); save(); dlg.close(); rerender(1);
    toast('已標已俾 → '+w.recvAccount); return true;
  };
  const markUnpaid=()=>{
    if(!w.receivedBack)return true;
    if(!confirm('改返未俾？已入帳嘅收入會標刪（墓碑，方便同步）。'))return false;
    w.receivedBack=false; w.updatedAt=stamp(w.updatedAt); Sync.queue('wishlist',w);
    ensureRecvIncome(w); save(); dlg.close(); rerender(1); toast('已改返未俾'); return true;
  };
  const box=$('#recvPaidChips');
  if(box){
    box.querySelectorAll('button[data-v]').forEach(btn=>{
      btn.onclick=e=>{
        e.preventDefault();
        const want=btn.getAttribute('data-v')==='1';
        if(want===!!w.receivedBack)return;
        if(want){if(!markPaid())return}
        else{if(!markUnpaid())return}
      };
    });
  }
  dlg.showModal();
}
function openRecvTxItem(id){
  const t=S.transactions.find(x=>x.id===id); if(!t||t.deleted)return;
  const row=txToRecvRow(t);
  const f=$('#dlgForm'), opts=chargeAcctOpts().filter(Boolean), ch=row.chargeAccount;
  const paid=!!t.partnerReceivedBack;
  const acctOpts=['',...opts].map(o=>`<option value="${esc(o)}" ${o===(t.partnerRecvAccount||'')?'selected':''}>${o?esc(o):'（請揀銀行／信用卡戶口）'}</option>`).join('');
  /* 已俾／未俾：兩掣永遠顯示，選中 .on */
  f.innerHTML=`<h3 style="margin:0">${esc(parseShopOrderItem(row.item,row.store).title)}</h3>
    <div class="sub">${fmt0(row.receivable)}${row.forWhom?' · 幫 '+esc(row.forWhom):''}${row.store?' · '+esc(row.store):''} · 記帳拆帳</div>
    <div class="sub"><b>${esc(chargeLabel(row))}</b>${ch?'':' — 可撳「改資料」改支出帳戶'}</div>
    <label>狀態（partner 已俾／未俾）
      <div class="choice-chips" id="recvPaidChips">
        <button type="button" class="choice-btn${!paid?' on':''}" data-v="0">未俾</button>
        <button type="button" class="choice-btn${paid?' on':''}" data-v="1">已俾</button>
      </div>
    </label>
    <label>收回入帳戶口（partner 已俾入邊度）<select id="recvAcctSel" name="recvAccount">${acctOpts}</select></label>
    <label>收回日期<input name="recvDate" id="recvDateInp" type="date" value="${esc(t.partnerRecvDate||today())}"></label>
    <div class="sub">標「已俾」會自動加／更新一筆收入：分類「退款／代付收回」${paid&&t.partnerRecvAccount?' · 而家 → '+esc(t.partnerRecvAccount):''}</div>
    <div class="actions"><button value="cancel" formnovalidate>關閉</button>
      <button type="button" id="editTxFromRecv">改資料</button></div>`;
  const dlg=$('#dlg'); dlg.onclose=null; dlg.returnValue='';
  const goEdit=()=>{dlg.close();editTx(id)};
  const editBtn=$('#editTxFromRecv'); if(editBtn)editBtn.onclick=goEdit;
  const markPaid=()=>{
    const acct=($('#recvAcctSel')||{}).value||'';
    if(!String(acct).trim()){toast('請先揀收回入帳戶口');return false}
    t.partnerReceivedBack=true; t.partnerRecvAccount=String(acct).trim();
    t.partnerRecvDate=(($('#recvDateInp')||{}).value)||today();
    t.updatedAt=stamp(t.updatedAt); Sync.queue('transactions',t);
    ensureTxPartnerRecv(t); save(); dlg.close(); rerender(1);
    toast('已標已俾 → '+t.partnerRecvAccount); return true;
  };
  const markUnpaid=()=>{
    if(!t.partnerReceivedBack)return true;
    if(!confirm('改返未俾？已入帳嘅收入會標刪（墓碑，方便同步）。'))return false;
    t.partnerReceivedBack=false; t.updatedAt=stamp(t.updatedAt); Sync.queue('transactions',t);
    ensureTxPartnerRecv(t); save(); dlg.close(); rerender(1); toast('已改返未俾'); return true;
  };
  const box=$('#recvPaidChips');
  if(box){
    box.querySelectorAll('button[data-v]').forEach(btn=>{
      btn.onclick=e=>{
        e.preventDefault();
        const want=btn.getAttribute('data-v')==='1';
        if(want===!!t.partnerReceivedBack)return;
        if(want){if(!markPaid())return}
        else{if(!markUnpaid())return}
      };
    });
  }
  dlg.showModal();
}

/* 宅：按預計發售月排序（過去→而家→未來），打開時錨喺「而家」 */
/* 尾款／補款：只有年月、未知幾號 → 該月 01 置頂，標「尾款（日待定）」；知實日用 dueDate */
function wishMonthKey(w){
  const m=String(w.dueMonth||'').trim();
  if(/^\d{4}-\d{2}$/.test(m)) return m;
  const dd=String(w.dueDate||'').trim();
  if(/^\d{4}-\d{2}/.test(dd)) return dd.slice(0,7);
  const d=String(w.date||'').trim();
  if(/^\d{4}-\d{2}/.test(d)) return d.slice(0,7);
  return '9999-99';
}
function wishMonthLabel(k){
  if(k==='9999-99') return '未定發售月';
  const [y,mo]=k.split('-');
  return y+'年'+Number(mo)+'月';
}
function curWishMonth(){return today().slice(0,7)}
function wishPaid(w){return n(w.deposit)+n(w.finalPaid)}
function wishOwed(w){const p=n(w.price),paid=wishPaid(w);return p>0?Math.max(0,p-paid):null}
function wishIsDayTbd(w){
  if(w.dueDayTbd===true||w.dueDayTbd===1||w.dueDayTbd==='1'||w.dueDayTbd==='true') return true;
  const dd=String(w.dueDate||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(dd)) return false;
  const m=String(w.dueMonth||'').trim();
  return /^\d{4}-\d{2}$/.test(m);
}
function wishDueInfo(w){
  const dd=String(w.dueDate||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(dd)){
    const tbd=wishIsDayTbd(w);
    return {d:dd, dayTbd:tbd, pin:tbd};
  }
  const m=String(w.dueMonth||'').trim();
  if(/^\d{4}-\d{2}$/.test(m)) return {d:m+'-01', dayTbd:true, pin:true};
  return null;
}
function wishPendingFinal(w){
  const st=w.status||'';
  if(st!=='訂咗') return false;
  const owed=wishOwed(w);
  if(owed===0) return false;
  if(owed!=null&&owed>0) return true;
  return n(w.deposit)>0||n(w.price)>0; /* 售價未定但有訂金／項目，仍當未找尾款 */
}
function normalizeWishDue(o){
  const dd=String(o.dueDate||'').trim();
  const m=String(o.dueMonth||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(dd)){
    o.dueDate=dd; o.dueDayTbd=0;
    if(!/^\d{4}-\d{2}$/.test(m)) o.dueMonth=dd.slice(0,7);
  }else{
    o.dueDate='';
    if(/^\d{4}-\d{2}$/.test(m)){ o.dueMonth=m; o.dueDayTbd=1; }
    else { o.dueDayTbd=0; }
  }
}
function wishMoShort(w){
  const info=wishDueInfo(w);
  if(info&&info.dayTbd) return '尾款（日待定）';
  if(info){const [y,mo,d]=info.d.split('-');const cy=curWishMonth().slice(0,4);return (y===cy?(Number(mo)+'/'+d):(y.slice(2)+'/'+mo+'/'+d))+' 尾款'}
  const k=wishMonthKey(w);if(k==='9999-99')return'未定';const [y,mo]=k.split('-');const cy=curWishMonth().slice(0,4);return y===cy?(Number(mo)+'月'):(y.slice(2)+'/'+mo)
}
function setWishSt(id,st){
  const w=S.wishlist.find(x=>x.id===id); if(!w)return;
  if(w.status===st)return;
  w.status=st; w.updatedAt=stamp(w.updatedAt);
  /* 若 chip 篩住舊狀態，改完成行會消失 → 轉返「全部」，三掣仍然見到 */
  if(wishFilter!=='全部'&&wishFilter!==st) wishFilter='全部';
  Sync.queue('wishlist',w); save(); rerender(1); toast('已標「'+st+'」');
}
/* 一律四掣：想要／訂咗／收咗／棄單。而家嗰個 .on；其餘照顯示可撳。永唔好 filter 走當前狀態。 */
function wishQuickBtns(w){
  const cur=w.status||'', id=esc(w.id);
  return `<span class="wish-acts" onclick="event.stopPropagation()">${WISH_ST.map(st=>
    `<button type="button" class="wish-qbtn${st===cur?' on':''}" onclick="setWishSt('${id}','${st}')">${st}</button>`
  ).join('')}</span>`;
}

/* 顯示用：項目字串常係「店舖 - 單號 #（註）產品」→ 抽出產品名做主行；raw 仍留編輯用 */
function parseShopOrderItem(raw, storeHint){
  const s=String(raw||'').trim();
  if(!s) return {title:'（未命名）', raw:s};
  const hash=s.indexOf('#');
  if(hash>=0){
    let after=s.slice(hash+1).trim().replace(/^\([^)]*\)\s*/,'');
    if(after) return {title:after, raw:s};
  }
  const m=s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if(m){
    const left=m[1].trim(), rest=m[2].trim();
    const om=rest.match(/^(\d+(?:\s*\/\s*\d+)*)\s*(?:[-–—]\s*)?(.*)$/);
    if(om){
      let title=om[2].trim().replace(/^#\s*/,'').replace(/^\([^)]*\)\s*/,'');
      if(title) return {title, raw:s};
    }
    const st=String(storeHint||'').trim();
    const shopLike=st&&(left===st||left.startsWith(st)||st.startsWith(left)||left.toLowerCase().startsWith(st.toLowerCase()));
    if(shopLike&&rest&&!/^\d+$/.test(rest)) return {title:rest, raw:s};
    if(left.length<=18&&rest.length>2&&!/^\d+$/.test(left)&&!/^\d+$/.test(rest)) return {title:rest, raw:s};
  }
  return {title:s, raw:s};
}
function wishDisplayTitle(w){
  if(!w) return '（未命名）';
  return parseShopOrderItem(w.item, w.store).title;
}
function txDisplayTitle(t){
  if(!t) return '（未命名）';
  const raw=t.desc||t.sub||t.category||'';
  return parseShopOrderItem(raw, t.counterparty).title||'（未命名）';
}
function wishRow(w){
  const paid=wishPaid(w), owed=wishOwed(w), info=wishDueInfo(w);
  const owedTxt=owed==null?(n(w.price)?'—':(paid?'尾款未定':'—')):fmt0(owed);
  const owedCls=owed!=null&&owed>0?'neg':(owed===0?'pos':'');
  const tbd=info&&info.dayTbd;
  const ship=String(w.firstShip||'').trim();
  const metaCore=tbd?`<span class="wish-tbd">尾款（日待定）</span> · ${esc(wishMonthKey(w)==='9999-99'?'未定':wishMonthKey(w))} · ${esc(w.store||'未填店舖')}`:`${esc(wishMoShort(w))} · ${esc(w.store||'未填店舖')}`;
  const meta=ship?`${metaCore} · 首次出貨 ${esc(ship)}`:metaCore;
  return `<div class="row wish-row${tbd?' tbd':''}" onclick="editWish('${esc(w.id)}')"><div class="l"><b class="wish-name">${esc(wishDisplayTitle(w))}</b><span class="wish-meta">${meta}</span>${wishQuickBtns(w)}</div><div class="r wish-money"><span>已付 ${fmt0(paid)}</span><span class="${owedCls}">仲欠 ${owedTxt}</span></div></div>`;
}
function wishUpcomingFinals(){
  const t=today(), end=addDays(t,60), nowM=curWishMonth(), nextM=addMonths(t,1).slice(0,7);
  return live(S.wishlist).filter(w=>{
    if(!wishPendingFinal(w)) return false;
    const info=wishDueInfo(w);
    if(!info){const k=wishMonthKey(w);return k===nowM||k===nextM}
    if(info.d>=t&&info.d<=end) return true;
    /* 日待定：本月／下月即使 01 已過都仲要見到 */
    if(info.dayTbd){const km=info.d.slice(0,7);return km===nowM||km===nextM}
    return false;
  }).slice().sort((a,b)=>{
    const ia=wishDueInfo(a),ib=wishDueInfo(b);
    const da=ia?ia.d:(wishMonthKey(a)+'-01'), db=ib?ib.d:(wishMonthKey(b)+'-01');
    if(da!==db) return da.localeCompare(db);
    const pa=(ia&&ia.pin)?0:1,pb=(ib&&ib.pin)?0:1;if(pa!==pb)return pa-pb;
    return String(a.item||'').localeCompare(String(b.item||''),'zh-HK');
  });
}
function wishUpcomingBlock(){
  const items=wishUpcomingFinals();
  if(!items.length) return '';
  const sum=items.reduce((s,w)=>{const o=wishOwed(w);return s+(o!=null?o:0)},0);
  const rows=items.map(w=>{
    const owed=wishOwed(w), info=wishDueInfo(w);
    const when=info?(info.dayTbd?`<span class="wish-tbd">尾款（日待定）</span> · ${esc(info.d.slice(0,7))}`:`${esc(info.d.slice(5))}（${whenTxt(info.d)}）`):esc(wishMonthKey(w)==='9999-99'?'未定':wishMonthKey(w));
    return `<div class="row wish-row${info&&info.dayTbd?' tbd':''}" onclick="editWish('${esc(w.id)}')"><div class="l"><b class="wish-name">🎁 ${esc(wishDisplayTitle(w))}</b><span class="wish-meta">${when} · ${esc(w.store||'未填店舖')}</span></div><div class="r wish-money"><span class="${owed!=null&&owed>0?'neg':''}">${owed!=null?fmt0(owed):'尾款未定'}</span></div></div>`;
  }).join('');
  return `<div class="card wish-upcoming"><h2>⏳ 即將尾款</h2><div class="sub">未來約 60 日／本月＋下月未付 · 合共約 ${fmt0(sum)}（唔再出現喺「每月固定」）</div>${rows}</div>`;
}
function vWish(){
  const W=live(S.wishlist);
  const list=W.filter(w=>wishFilter==='全部'||w.status===wishFilter)
    .slice().sort((a,b)=>{
      const ka=wishMonthKey(a),kb=wishMonthKey(b);if(ka!==kb)return ka.localeCompare(kb);
      const ia=wishDueInfo(a),ib=wishDueInfo(b);
      const pa=(ia&&ia.pin)?0:1,pb=(ib&&ib.pin)?0:1;if(pa!==pb)return pa-pb;
      const da=ia?ia.d:'',db=ib?ib.d:'';if(da!==db)return da.localeCompare(db);
      return String(a.item||'').localeCompare(String(b.item||''),'zh-HK')});
  const cnt=s=>W.filter(w=>s==='全部'||w.status===s).length;
  const nowM=curWishMonth();
  let body='', last=null, anchored=false;
  const mark=()=>{if(anchored)return'';anchored=true;return `<div id="wish-anchor-now" class="wish-now-mark">▼ 而家（${nowM}）· 向上撈睇過去 · 向下睇未來</div>`};
  for(const w of list){
    const k=wishMonthKey(w);
    if(k!==last){
      if(!anchored && (k>=nowM || k==='9999-99')) body+=mark();
      last=k;
      const cls=k===nowM?'wish-mo now':(k!=='9999-99'&&k<nowM?'wish-mo past':'wish-mo');
      body+=`<div class="${cls}">${esc(wishMonthLabel(k))}${k===nowM?' · 本月':k!=='9999-99'&&k<nowM?' · 已過':''}</div>`;
    }
    body+=wishRow(w);
  }
  if(!anchored) body+=mark();
  return `<div class="chips">${['全部',...WISH_ST].map(s=>`<button class="${s===wishFilter?'on':''}" onclick="wishFilter='${s}';wishAnchorOnOpen=true;render()">${s} ${cnt(s)}</button>`).join('')}</div>
  <div class="grid2"><div class="card"><h2>已付訂金</h2><div class="big">${fmt0(depositsHeld())}</div></div>
  <div class="card" onclick="tab='recv';history.replaceState(null,'','#recv');render()"><h2>partner 應收</h2><div class="big pos">${fmt0(receivable())}</div><div class="sub">撳入明細 →</div></div></div>
  ${wishUpcomingBlock()}
  <div class="sub tip">📅 按發售月排；列表主行顯示產品名（店舖／單號喺第二行同編輯頁）。未知幾號嘅尾款掛該月 1 號置頂（標「日待定」）。每行狀態一律「想要／訂咗／收咗／棄單」，撳名睇詳情。</div>
  <div class="card">${list.length?body:'<div class="sub">冇項目</div>'}</div>
  <button class="fab" onclick="editWish()">＋</button>`;
}

/* ---------- 人工／預測／舊檔資料 ---------- */
const AR_KINDS={summary:'每月摘要',reserve:'Reserve／銀行',carousell:'Carousell',tsuhan:'通販訂單',inventory:'家居庫存',installment:'分期攤還表',comments:'註解',misc:'其他儲存格'};
function vPay(){
  const sal=live(S.salary).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const fc=live(S.forecast).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const cur=sal[sal.length-1];
  const row=(r,f)=>`<tr onclick="${f}('${esc(r.id)}')"><td>${r.date}${r.label?'<br><small>'+esc(r.label)+'</small>':''}</td><td>${esc(r.company||'')}<br><small>${esc(r.reason||'')}</small></td><td class="num">${fmt0(r.monthly)}</td><td class="num">${fmt0(r.net)}</td><td class="num ${n(r.raiseNet)<0?'neg':''}">${pct(r.raiseNet)}</td><td class="num">${pct(r.raiseGross)}</td><td class="num">${r.bonus?fmt0(r.bonus):''}${r.bonusMonths?'<br><small>'+r.bonusMonths+' 個月</small>':''}</td></tr>`;
  const head='<tr><th>生效日</th><th>公司／原因</th><th>月薪</th><th>扣 MPF</th><th>加幅（淨）</th><th>加幅（月薪）</th><th>花紅</th></tr>';
  const first=sal[0], cagr=first&&cur&&first.monthly&&cur.monthly?Math.pow(cur.monthly/first.monthly,1/((new Date(cur.date)-new Date(first.date))/3.15576e10))-1:null;
  const B=live(S.bonus).slice().sort((a,b)=>b.year-a.year);
  const kinds=[...new Set(live(S.archive).map(a=>a.kind))];
  if(kinds.length&&!kinds.includes(arKind)) arKind=kinds[0];
  const ofKind=live(S.archive).filter(a=>a.kind===arKind).sort((a,b)=>String(b.month||'').localeCompare(String(a.month||''))||(a.part||0)-(b.part||0));
  if(!ofKind.some(a=>a.id===arId)) arId=ofKind[0]?ofKind[0].id:'';
  const ar=ofKind.find(a=>a.id===arId);
  return `<div class="card"><h2>現時人工</h2>${cur?`<div class="big">${fmt0(cur.monthly)}<span class="sub"> /月</span></div>
    <div class="sub">${esc(cur.company||'')} · ${cur.date} ${esc(cur.reason||'')} · 扣 MPF 後 ${fmt0(cur.net)} · 年薪 ${fmt0(cur.annual)}</div>
    ${cagr!=null?`<div class="sub">由 ${first.date.slice(0,4)} 至今月薪平均每年 +${(cagr*100).toFixed(1)}%（${fmt0(first.monthly)} → ${fmt0(cur.monthly)}）</div>`:''}`:'<div class="sub">未有人工紀錄。撳下面「＋ 人工紀錄」加。</div>'}</div>
  <div class="card"><h2>加人工紀錄（${sal.length} 次）</h2><div class="tbl"><table>${head}${sal.map(r=>row(r,'editSal')).join('')}</table></div>
    <div class="sub">加幅（淨）＝舊表做法，用扣 MPF 後計；加幅（月薪）＝用月薪計。撳一行可以改。</div>
    <div class="actions"><button onclick="editSal()">＋ 人工紀錄</button></div></div>
  <div class="card"><h2>人工預測（${fc.length} 年）</h2><div class="tbl"><table>${head}${fc.map(r=>row(r,'editFc')).join('')}</table></div>
    <div class="sub">${esc(fc[0]&&fc[0].assumption||'')} — 舊表公式推算，唔係實數。</div>
    <div class="actions"><button onclick="editFc()">＋ 預測</button></div></div>
  <div class="card"><h2>花紅分配</h2>${B.length?B.map(b=>`<details><summary><b>${b.year}</b> 花紅 ${fmt0(b.bonus)}${b.formula?' <small>('+esc(b.formula)+')</small>':''} · 已分配 ${fmt0(b.allocated)} · 剩 ${fmt0(b.remaining)}</summary>
    ${(b.items||[]).map(i=>`<div class="row"><div class="l">${esc(i.label)}${i.note?'<small class="note">'+esc(i.note)+'</small>':''}</div><div class="r">${i.amount!=null?fmt0(i.amount):'—'}</div></div>`).join('')}</details>`).join(''):'<div class="sub">冇資料</div>'}</div>
  <div class="card"><h2>舊檔其他資料</h2>${kinds.length?`
    <div class="chips">${kinds.map(k=>`<button class="${k===arKind?'on':''}" onclick="arKind='${k}';arId='';rerender(1)">${esc(AR_KINDS[k]||k)}</button>`).join('')}</div>
    ${ofKind.length>1?`<select onchange="arId=this.value;rerender(1)">${ofKind.map(a=>`<option value="${esc(a.id)}" ${a.id===arId?'selected':''}>${esc(a.title)}</option>`).join('')}</select>`:''}
    ${ar?`<div class="sub">${esc(ar.title)}${ar.note?' — '+esc(ar.note):''}</div><div class="tbl"><table><tr>${(ar.cols||[]).map(c=>`<th>${esc(c)}</th>`).join('')}</tr>
      ${(ar.rows||[]).map(r=>`<tr>${r.map(c=>`<td class="${typeof c==='number'?'num':''}">${esc(typeof c==='number'?Number(c.toFixed(2)).toLocaleString('en-HK'):c)}</td>`).join('')}</tr>`).join('')}</table></div>`:''}`
    :'<div class="sub">未匯入舊檔資料</div>'}</div>`;
}

/* ---------- 表單 ---------- */
function form(title,fields,obj,onSave,onDel){
  const f=$('#dlgForm');
  f.innerHTML=`<h3 style="margin:0">${esc(title)}</h3>`+fields.map(d=>{
    const val=obj[d.k]??'';
    let inp;
    if(d.opts&&d.other){
      const opts=[...new Set((d.opts||[]).filter(Boolean))];
      const inList=val!==''&&val!=null&&opts.includes(val);
      const useOther=val!==''&&val!=null&&!inList;
      const sel=useOther?OTHER_STORE:(inList?val:'');
      inp=`<select name="${d.k}" data-other="${d.k}__custom" onchange="toggleStoreOther(this)">`+
        `<option value="">（揀店舖／商戶）</option>`+
        opts.map(o=>`<option value="${esc(o)}" ${o===sel?'selected':''}>${esc(o)}</option>`).join('')+
        `<option value="${OTHER_STORE}" ${useOther?'selected':''}>${OTHER_STORE}</option></select>`+
        `<input name="${d.k}__custom" type="text" placeholder="輸入自訂店舖／商戶名" value="${useOther?esc(val):''}" ${useOther?'':'hidden'} style="margin-top:6px">`;
    }else if(d.opts&&shouldChipOpts(d)){
      const opts=[...new Set([...(d.opts),...(val!==''&&val!=null&&!d.opts.includes(val)?[val]:[])])];
      /* 狀態／短枚舉：chips 一律全部顯示，選中 .on（唔用 select 收埋） */
      inp=choiceChipsHtml(opts,val,{name:d.k,emptyLab:'（未設定／請揀）'});
    }else if(d.opts) inp=`<select name="${d.k}">${[...new Set([...(d.opts),...(val!==''&&val!=null&&!d.opts.includes(val)?[val]:[])])].map(o=>`<option value="${esc(o)}" ${o==val?'selected':''}>${o===''?'（未設定／請揀）':esc(o)}</option>`).join('')}</select>`;
    else if(d.t==='area') inp=`<textarea name="${d.k}" rows="2">${esc(val)}</textarea>`;
    else if(d.t==='check') inp=`<input type="checkbox" name="${d.k}" ${val?'checked':''} style="width:auto">`;
    else inp=`<input name="${d.k}" type="${d.t||'text'}" ${d.t==='number'?'step="any" inputmode="decimal"':''} value="${esc(val)}" ${d.req?'required':''}>`;
    return `<label>${esc(d.l)}${inp}</label>`}).join('')+
    (obj.src?`<div class="sub">來源：${esc(obj.src)}</div>`:'')+
    `<div class="actions">${onDel?'<button type="button" id="delBtn" style="color:var(--warn);margin-right:auto">刪除</button>':''}<button value="cancel" formnovalidate>取消</button><button class="primary" value="ok">儲存</button></div>`;
  const dlg=$('#dlg');
  if(onDel) $('#delBtn').onclick=()=>{if(confirm('確定刪除？')){onDel();save();dlg.close();rerender(1)}};
  dlg.onclose=()=>{
    if(dlg.returnValue!=='ok') return;
    const fd=new FormData(f);
    fields.forEach(d=>{let v=fd.get(d.k);
      if(d.other&&v===OTHER_STORE){v=String(fd.get(d.k+'__custom')||'').trim();rememberShop(v)}
      else if(d.other&&v) rememberShop(v);
      if(d.t==='check') v=!!v; else if(d.t==='number') v=(v===''||v==null)?null:Number(v);
      obj[d.k]=v});
    obj.updatedAt=stamp(obj.updatedAt);
    onSave(obj);save();rerender(1);
  };
  dlg.returnValue='';dlg.showModal();
  bindChoiceChips(f);
}
/* 新增／修改／刪除（刪除＝墓碑 deleted:true，方便同步合併） */
function upsertLocal(key,o,isNew){if(isNew)S[key].push(o);Sync.queue(key,o)}
function tombstone(key,id){const o=S[key].find(x=>x.id===id);if(!o)return;
  const t={id:o.id,deleted:true,updatedAt:stamp(o.updatedAt)};S[key][S[key].indexOf(o)]=t;Sync.queue(key,t)}
const acctNames=()=>[...live(S.accounts).map(a=>a.name),'TBD（付款帳戶待確認）'];
function editTx(id){
  const t=id?S.transactions.find(x=>x.id===id):{id:uid('t'),date:today(),type:'支出',category:'餐飲',account:'Citibank VISA',amount:null,partnerRecv:null,partnerFor:''};
  form(id?'修改紀錄':'記一筆',[
    {k:'date',l:'日期',t:'date',req:1},{k:'type',l:'類型',opts:TX_TYPES},{k:'amount',l:'金額（HKD）',t:'number',req:1},
    {k:'partnerRecv',l:'partner 應收（拆帳金額）',t:'number'},
    {k:'partnerFor',l:'為誰（拆帳）'},
    {k:'category',l:'分類',opts:S.categories},{k:'sub',l:'細項'},{k:'account',l:'帳戶',opts:acctNames()},
    {k:'desc',l:'描述'},{k:'counterparty',l:'對方／商戶',opts:shopOpts(),other:1},{k:'tag',l:'標籤'},{k:'notes',l:'備註',t:'area'}],
    t,o=>{
      if(o.dm&&o.date&&!o.date.endsWith('-01'))delete o.dm;
      if(o.partnerFor!=null)o.partnerFor=String(o.partnerFor||'').trim();
      upsertLocal('transactions',o,!id);
      ensureTxPartnerRecv(o);
    },id?()=>tombstone('transactions',id):null);
}
function editAcct(id){
  const a=id?S.accounts.find(x=>x.id===id):{id:uid('a'),name:'',type:'銀行',balance:null};
  const isCard=a.stmtBal!=null;
  const f=[{k:'name',l:'名稱',req:1},{k:'type',l:'類型',opts:['信用卡','銀行','現金','八達通','信封／儲備','應收','貸款／分期','其他']}];
  if(isCard) f.push({k:'stmtDate',l:'月結單日',t:'date'},{k:'dueDate',l:'到期日',t:'date'},{k:'stmtBal',l:'月結單結欠',t:'number'},
    {k:'minPay',l:'最低還款',t:'number'},{k:'unposted',l:'未入帳分期',t:'number'},{k:'totalAcct',l:'Total Account Balance（如有）',t:'number'},
    {k:'paidAfterStmt',l:'月結單後已還',t:'number'},{k:'creditLimit',l:'信用額',t:'number'});
  else if(a.id!=='recv') f.push({k:'balance',l:'結餘',t:'number'},{k:'asOf',l:'截至日期',t:'date'});
  f.push({k:'notes',l:'備註',t:'area'});
  form(id?'修改帳戶':'新增帳戶',f,a,o=>upsertLocal('accounts',o,!id),id?()=>tombstone('accounts',id):null);
}
function editInst(id){
  const i=id?S.installments.find(x=>x.id===id):{id:uid('i'),name:'',card:'Citibank VISA',status:'進行中',paid:0,countInBurden:false};
  form(id?'修改分期':'新增分期',[{k:'name',l:'名稱',req:1},{k:'card',l:'卡／機構'},{k:'product',l:'產品'},
    {k:'monthly',l:'每月（HKD）',t:'number'},{k:'paid',l:'已供期數',t:'number'},{k:'total',l:'總期數',t:'number'},
    {k:'start',l:'首期',t:'date'},{k:'end',l:'預計完',t:'date'},{k:'principal',l:'本金估算',t:'number'},{k:'outstanding',l:'未入帳（核對）',t:'number'},
    {k:'status',l:'狀態',opts:['進行中','進行中（推算）','可能已完（待確認）','已完']},{k:'countInBurden',l:'計入每月分期負擔',t:'check'},{k:'notes',l:'備註',t:'area'}],
    i,o=>upsertLocal('installments',o,!id),id?()=>tombstone('installments',id):null);
}
function bump(id){const i=S.installments.find(x=>x.id===id);i.paid=n(i.paid)+1;if(i.total&&i.paid>=i.total)i.status='已完';i.updatedAt=stamp(i.updatedAt);Sync.queue('installments',i);save();rerender(1)}
function editWish(id){
  const base=id?S.wishlist.find(x=>x.id===id):null;
  const w=base?Object.assign({},base):{id:uid('w'),item:'',status:'訂咗',deposit:0,finalPaid:0,receivable:0,date:today()};
  if(w.chargeAccount==null&&(w.account||w.paidFrom))w.chargeAccount=w.account||w.paidFrom;
  /* 日待定時唔預填 dueDate=01，避免當成實日 */
  if(wishIsDayTbd(w)) w.dueDate='';
  form(id?'修改項目':'新增 宅',[{k:'item',l:'項目',req:1},{k:'status',l:'狀態',opts:WISH_ST},{k:'maker',l:'廠商'},
    {k:'price',l:'售價',t:'number'},{k:'deposit',l:'已付訂金',t:'number'},{k:'finalPaid',l:'已付尾數／全數',t:'number'},
    {k:'store',l:'店舖',opts:shopOpts(),other:1},{k:'orderRef',l:'單號'},{k:'forWhom',l:'為誰買'},
    {k:'chargeAccount',l:'代付支出戶口（欠喺邊度）',opts:chargeAcctOpts()},
    {k:'receivable',l:'應收（代付）',t:'number'},
    {k:'receivedBack',l:'已收返應收',t:'check'},{k:'recvAccount',l:'收回入帳戶口',opts:chargeAcctOpts()},
    {k:'recvDate',l:'收回日期',t:'date'},
    {k:'firstShip',l:'第一次最快出貨／發售（原文可，例如 2027年2月発送予定）'},
    {k:'dueMonth',l:'預計發售月（YYYY-MM；未知幾號會掛 1 號置頂）'},
    {k:'dueDate',l:'尾款／到貨實日（知就填；唔知留空→該月 1 號・日待定）',t:'date'},
    {k:'date',l:'訂購／入帳日',t:'date'},{k:'notes',l:'備註',t:'area'}],
    w,o=>{
      normalizeWishDue(o);
      if(base){Object.assign(base,o);upsertLocal('wishlist',base,false);ensureRecvIncome(base)}
      else{upsertLocal('wishlist',o,true);ensureRecvIncome(o)}
    },base?()=>tombstone('wishlist',id):null);
}
const SAL_F=[{k:'date',l:'生效日',t:'date',req:1},{k:'company',l:'公司'},{k:'reason',l:'原因（Review／Join／Transfer…）'},{k:'label',l:'標記（例如 Year 5 (38)）'},
  {k:'annual',l:'年薪',t:'number'},{k:'monthly',l:'月薪',t:'number'},{k:'mpf',l:'MPF（每月）',t:'number'},{k:'net',l:'扣 MPF 後',t:'number'},
  {k:'bonus',l:'花紅',t:'number'},{k:'bonusMonths',l:'花紅月數',t:'number'},{k:'notes',l:'備註',t:'area'}];
function recalcRaises(key){const L=live(S[key==='forecast'?'forecast':'salary']);const all=[...live(S.salary),...live(S.forecast)].sort((a,b)=>a.date.localeCompare(b.date));
  all.forEach((r,i)=>{const p=all[i-1];if(!p)return;const rn=p.net?Math.round((r.net-p.net)/p.net*1e4)/1e4:null,rg=p.monthly?Math.round((r.monthly-p.monthly)/p.monthly*1e4)/1e4:null;
    if(r.raiseNet!==rn||r.raiseGross!==rg){r.raiseNet=rn;r.raiseGross=rg;r.updatedAt=stamp(r.updatedAt);Sync.queue(S.salary.includes(r)?'salary':'forecast',r)}})}
function editSalGeneric(key,id){
  const r=id?S[key].find(x=>x.id===id):{id:uid(key==='salary'?'sal':'fc'),date:today()};
  form(id?(key==='salary'?'修改人工紀錄':'修改預測'):(key==='salary'?'新增人工紀錄':'新增預測'),SAL_F,r,o=>{
    if(o.monthly&&!o.annual)o.annual=Math.round(o.monthly*12*100)/100; if(o.monthly&&o.mpf!=null&&o.net==null)o.net=o.monthly-o.mpf;
    upsertLocal(key,o,!id);recalcRaises(key)},id?()=>tombstone(key,id):null);
}
const editSal=id=>editSalGeneric('salary',id), editFc=id=>editSalGeneric('forecast',id);

/* ---------- 貸款 ---------- */
let loanSort='end', loanGroup=true, lastLoanPct=0;
const LOAN_TYPES=['私人貸款','卡分期','其他'], LOAN_ST=['進行中','已還清','待確認'], RATE_TYPES=['實際年利率 APR','月平息','手續費',''];
const LOAN_ICON={'私人貸款':'🏦','卡分期':'💳','其他':'🤝'};
const RM=()=>window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const isRev=l=>!!l.revolving;
const lRem=l=>l.totalPeriods?Math.max(0,n(l.totalPeriods)-n(l.paidPeriods)):null;
const lPct=l=>l.totalPeriods?Math.min(1,n(l.paidPeriods)/l.totalPeriods):0;
const lDone=l=>!isRev(l)&&!!l.totalPeriods&&lRem(l)===0;
const fixedLoans=()=>live(S.loans).filter(l=>!isRev(l)&&l.status!=='待確認'&&l.totalPeriods);
const activeLoans=()=>fixedLoans().filter(l=>lRem(l)>0);
const loanMode=()=>fixedLoans().length>0;
function addMonths(iso,k){const [y,m,d]=String(iso).split('-').map(Number);const t=new Date(Date.UTC(y,m-1+k,1));
  const dim=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();return t.toISOString().slice(0,8)+String(Math.min(d||1,dim)).padStart(2,'0')}
const mdiff=(a,b)=>(+b.slice(0,4)-+a.slice(0,4))*12+(+b.slice(5,7)-+a.slice(5,7));
const lEnd=l=>l.endDate||(lRem(l)!=null?addMonths(today(),Math.max(0,lRem(l)-1)):null);
function loanDerive(l){if(isRev(l))return l;const r=lRem(l);
  if(r!=null){l.remainingPeriods=r;if(l.monthly!=null)l.remainingAmount=Math.round(n(l.monthly)*r*100)/100}
  if(l.startDate&&l.totalPeriods)l.endDate=addMonths(l.startDate,n(l.totalPeriods)-1);
  if(r===0&&l.status==='進行中')l.status='已還清';else if(r>0&&l.status==='已還清')l.status='進行中';return l}
/* 用嚟上色／排序嘅年利率（月平息冇 APR 就用經驗公式粗估） */
const lApr=l=>{if(l.rate==null||l.rate==='')return null;if(/月平息/.test(l.rateType||'')){if(l.aprEst!=null&&l.aprEst!=='')return n(l.aprEst);const N=n(l.totalPeriods)||12;return n(l.rate)*12*2*N/(N+1)}return n(l.rate)};
function rateBadge(l){const a=lApr(l);
  if(a==null)return `<span class="rb unk">利率 未知（補返）</span>`;
  const c=a<6?'lo':a<15?'mid':'hi', face=a<6?'😌':a<15?'😐':'🔥';
  const t=/月平息/.test(l.rateType||'')?`月平息 ${n(l.rate)}%${l.aprEst!=null?` ≈ APR ${l.aprEst}%`:''}`:`${/APR/.test(l.rateType||'')?'APR ':''}${n(l.rate)}%${/手續費/.test(l.rateType||'')?' 手續費':''}`;
  return `<span class="rb ${c}" title="${esc(l.rateNote||'')}">${face} ${t}${l.rateEst?' <b>估算</b>':''}</span>`}
const unk='<span class="unk">未知（補返）</span>';
function heroQuip(p){return p>=1?'🎉 無債一身輕！今晚飲返杯（汽水）慶祝下':p>=.9?'差少少！準備好開香檳 🍾':p>=.75?'見到山頂支旗喇，打大佬前最後幾關 🎮':p>=.5?'過咗半山！落斜（還款）會越嚟越快 🏃':p>=.25?'爬緊山腰，唔好望落去，望住支旗 🚩':p>=.1?'熱身完畢！每撳一下「+1 期」都係向山頂行一步 🥾':'萬事起頭難，肯開始已經贏咗一半 💪'}
function loanQuip(l){const r=lRem(l),p=lPct(l);if(r===0)return '畢業咗！🎓 再見唔送';if(r===1)return '最後一期！打完呢隻大佬就通關 👾';
  if(r<=3)return `仲有 ${r} 期，打大佬前最後幾關！`;if(r<=6)return '半年內畢業，頂住 💪';if(r<=12)return '一年內搞掂，見到隧道尾嘅光 🔦';
  if(p>=.5)return '過咗半場，下半場追分 ⚽';if(p>=.25)return '慢慢嚟，比較快 🐢';return '長跑模式啟動 🏃‍♂️ 記得補充水分'}
const runnerOf=p=>p>=1?'🎓':p>=.85?'🏇':p>=.5?'🏃':p>=.25?'🚶':'🐌';
const PLUS_MSG=['+1！又近咗一步 🎯','債務 HP −1 👾 繼續打！','Nice！供完一期，獎勵自己飲杯水 💧（唔好買嘢住 😂）','穩陣！將來嘅你多謝你 🙏','又一格！儲齊就換到自由 🆓'];
const ym=s=>s?String(s).slice(0,7):'—';
function durTxt(m){if(m<=0)return '今個月';const y=Math.floor(m/12),r=m%12;return `${m} 個月${y?`（${y} 年${r?` ${r} 個月`:''}）`:''}`}
/* 照供款日計，應該入咗幾多期但未撳 +1 */
function dueSince(l){if(!l.payDay||!l.paidAsOf||!(lRem(l)>0))return 0;const pd=n(l.payDay);let d=addMonths(l.paidAsOf.slice(0,7)+'-'+String(pd).padStart(2,'0'),0),k=0;
  if(d<=l.paidAsOf)d=addMonths(d,1);while(d<=today()&&k<lRem(l)){k++;d=addMonths(d,1)}return k}
function loanStats(){const F=fixedLoans(),A=activeLoans();
  const tot=F.reduce((s,l)=>s+n(l.monthly)*n(l.totalPeriods),0),paid=F.reduce((s,l)=>s+n(l.monthly)*Math.min(n(l.paidPeriods),n(l.totalPeriods)),0);
  const ends=A.map(lEnd).filter(Boolean).sort(),last=ends[ends.length-1]||null,first=ends[0]||null;
  const rated=A.filter(l=>lApr(l)!=null),w=rated.reduce((s,l)=>s+n(l.remainingAmount||n(l.monthly)*lRem(l)),0);
  return {F,A,pct:tot?paid/tot:(F.length?1:0),monthly:A.reduce((s,l)=>s+n(l.monthly),0),remain:A.reduce((s,l)=>s+n(l.monthly)*lRem(l),0),last,first,
    nextGrp:first?A.filter(l=>ym(lEnd(l))===ym(first)):[],done:F.filter(lDone).length,
    avgApr:w?rated.reduce((s,l)=>s+lApr(l)*n(l.remainingAmount||n(l.monthly)*lRem(l)),0)/w:null}}
/* 每月供款階梯（由下個月起） */
function loanSchedule(A){const start=addMonths(today().slice(0,7)+'-01',1).slice(0,7);let last=start;
  const sp=A.map(l=>{const e=ym(lEnd(l));const s=addMonths(e+'-01',-(lRem(l)-1)).slice(0,7);if(e>last)last=e;return {s,e,m:n(l.monthly),l}});
  const out=[];for(let m=start;m<=last;m=addMonths(m+'-01',1).slice(0,7))out.push({m,total:sp.filter(x=>x.s<=m&&m<=x.e).reduce((a,x)=>a+x.m,0)});
  const drops=[];for(let i=1;i<out.length;i++)if(out[i].total<out[i-1].total-0.005)drops.push({m:out[i].m,saved:out[i-1].total-out[i].total,now:out[i].total,names:sp.filter(x=>x.e===out[i-1].m).map(x=>x.l.name)});
  if(out.length)drops.push({m:addMonths(last+'-01',1).slice(0,7),saved:out[out.length-1].total,now:0,names:sp.filter(x=>x.e===last).map(x=>x.l.name),fin:1});
  return {pts:out,drops}}
const TRAIL=[[14,118],[48,98],[70,86],[95,93],[122,73],[150,57],[175,45],[198,55],[222,37],[247,22]];
function trailPt(p){const seg=[];let tot=0;for(let i=1;i<TRAIL.length;i++){const d=Math.hypot(TRAIL[i][0]-TRAIL[i-1][0],TRAIL[i][1]-TRAIL[i-1][1]);seg.push(d);tot+=d}
  let want=Math.max(0,Math.min(1,p))*tot;for(let i=0;i<seg.length;i++){if(want<=seg[i]){const f=seg[i]?want/seg[i]:0;return [TRAIL[i][0]+(TRAIL[i+1][0]-TRAIL[i][0])*f,TRAIL[i][1]+(TRAIL[i+1][1]-TRAIL[i][1])*f]}want-=seg[i]}return TRAIL[TRAIL.length-1]}
function chartSvg(sch){const P=sch.pts;if(!P.length)return '';const W=340,H=150,pl=6,pr=6,pt=18,pb=20,mx=Math.max(...P.map(p=>p.total),1);
  const xw=(W-pl-pr)/(P.length+1),X=i=>pl+i*xw,Y=v=>pt+(H-pt-pb)*(1-v/mx);
  let d=`M${X(0).toFixed(1)},${Y(P[0].total).toFixed(1)}`,len=0,px=X(0),py=Y(P[0].total);
  P.forEach((p,i)=>{const y=Y(p.total),x1=X(i+1);if(i>0){d+=`V${y.toFixed(1)}`;len+=Math.abs(y-py)}d+=`H${x1.toFixed(1)}`;len+=x1-px;px=x1;py=y});
  d+=`V${Y(0).toFixed(1)}`;len+=Math.abs(Y(0)-py);
  const area=d+`H${X(0).toFixed(1)}Z`;
  const top=sch.drops.filter(x=>!x.fin).slice().sort((a,b)=>b.saved-a.saved).slice(0,3).map(x=>x.m);
  const labs=[];
  const marks=sch.drops.map(dp=>{const i=P.findIndex(p=>p.m===dp.m);const ix=i<0?P.length:i;const x=X(ix),y=Y(dp.now);
    if(top.includes(dp.m)||dp.fin)labs.push({x,y,yp:Y(dp.now+n(dp.saved)),t:dp.fin?'🏁 清晒':'−'+fmt0(dp.saved),fin:dp.fin});
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" class="cm"/>`}).join('');
  /* 標籤放喺落級位右上，互相太近就推高，避免重疊 */
  labs.sort((a,b)=>a.x-b.x);const placed=[];
  const labTxt=labs.map(L=>{/* 落級標籤放喺圓點左邊（曲線下面嘅空位）；終點旗放喺最後一級上面 */
    let lx=L.fin?L.x-6:L.x-6,ly=L.fin?L.yp-6:L.y+4;
    while(placed.some(q=>Math.abs(q.x-lx)<48&&Math.abs(q.y-ly)<12))ly+=13;placed.push({x:lx,y:ly});
    return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="cl${L.fin?' fin':''}">${L.t}</text>`}).join('');
  const yrs=P.map((p,i)=>p.m.endsWith('-01')?`<text x="${X(i).toFixed(1)}" y="${H-5}" class="cx">${p.m.slice(0,4)}</text><line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${pt}" y2="${H-pb}" class="cg"/>`:'').join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="每月供款階梯圖"><defs><linearGradient id="cgf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--pri)" stop-opacity=".35"/><stop offset="1" stop-color="var(--pri)" stop-opacity="0"/></linearGradient></defs>
    ${yrs}<path d="${area}" fill="url(#cgf)"/><path d="${d}" class="cline" style="--len:${Math.ceil(len)}"/>${marks}${labTxt}
    <text x="${pl}" y="11" class="cx">${fmt0(mx)}/月</text></svg>`}
function loanCard(l){const r=lRem(l),p=lPct(l),due=dueSince(l);
  return `<div class="loan${lDone(l)?' done':''}" onclick="editLoan('${esc(l.id)}')">
   <div class="lh"><span class="li">${LOAN_ICON[l.type]||'💸'}</span><div class="lt"><b>${esc(l.name)}</b><small>${esc(l.lender||'')}${l.product?' · '+esc(l.product):''}</small></div>
     <div class="lm">${l.monthly!=null?fmt(l.monthly):unk}<small>/月</small></div></div>
   ${l.totalPeriods?`<div class="track"><i style="width:${(p*100).toFixed(1)}%"></i><span class="runner" style="left:${(p*100).toFixed(1)}%">${runnerOf(p)}</span><span class="goal">🏁</span></div>`:''}
   <div class="lmeta">${l.totalPeriods?`<span>第 <b>${n(l.paidPeriods)}/${l.totalPeriods}</b> 期</span> · <span>仲有 <b>${r}</b> 期</span> · <span>仲要俾 ${fmt0(n(l.monthly)*r)}</span> · <span>完 ${ym(lEnd(l))}</span>`:'期數 未知（補返）'}</div>
   <div class="lfoot">${rateBadge(l)}<span class="sub">本金 ${l.principal!=null&&l.principal!==''?fmt0(l.principal)+(l.principalEst?'（估算）':''):unk}${l.balance!=null&&l.balance!==''?` · 餘額 ${fmt0(l.balance)}${l.balanceAsOf?'（'+esc(l.balanceAsOf)+'）':''}`:''}</span>
     ${r>0?`<button class="plus" onclick="event.stopPropagation();bumpLoan('${esc(l.id)}',this)">+1 期</button>`:''}</div>
   <div class="quip">${loanQuip(l)}</div>
   ${due?`<div class="nudge">📅 照供款日（每月 ${n(l.payDay)} 號）計，應該已經入咗第 ${n(l.paidPeriods)+due} 期 → 撳「+1 期」</div>`:''}</div>`}
function vLoan(){
  const st=loanStats(),L=live(S.loans),rev=L.filter(isRev),pend=L.filter(l=>!isRev(l)&&(l.status==='待確認'||!l.totalPeriods)),grads=st.F.filter(lDone);
  if(!L.length)return `<div class="card hero"><h2>💸 貸款</h2><div class="sub">未有貸款紀錄。撳右下角 ＋ 加一條（私人貸款、卡分期都得）。</div></div><button class="fab" onclick="editLoan()">＋</button>`;
  const months=st.last?mdiff(today(),st.last):0, sch=loanSchedule(st.A), pct=Math.round(st.pct*1000)/10;
  const badges=[['🥾','起步',st.pct>0],['🥉','四分一',st.pct>=.25],['🥈','半山',st.pct>=.5],['🥇','四分三',st.pct>=.75],['🎓','首條畢業',st.done>0],['🏆','無債',st.pct>=1&&st.F.length>0]];
  const sorter={end:(a,b)=>(lEnd(a)||'9').localeCompare(lEnd(b)||'9'),rate:(a,b)=>(lApr(b)??-1)-(lApr(a)??-1),amt:(a,b)=>n(b.monthly)*lRem(b)-n(a.monthly)*lRem(a)}[loanSort];
  const A=st.A.slice().sort(sorter);
  let list='';
  if(loanGroup){const g={};A.forEach(l=>{const k=l.card||l.lender||'其他';(g[k]=g[k]||[]).push(l)});
    list=Object.entries(g).sort((a,b)=>b[1].reduce((s,l)=>s+n(l.monthly),0)-a[1].reduce((s,l)=>s+n(l.monthly),0)).map(([k,ls])=>{
      const m=ls.reduce((s,l)=>s+n(l.monthly),0),t=ls.reduce((s,l)=>s+n(l.monthly)*n(l.totalPeriods),0),pd=ls.reduce((s,l)=>s+n(l.monthly)*n(l.paidPeriods),0),e=ls.map(lEnd).filter(Boolean).sort().pop();
      return `<details class="lgrp" open><summary><span>${/citi/i.test(k)?'💳':/hsbc/i.test(k)?'💳':'🏦'} <b>${esc(k)}</b> · ${ls.length} 條</span><span class="r">${fmt(m)}/月</span>
        <div class="bar thin"><i style="width:${t?(pd/t*100).toFixed(1):0}%"></i></div><small class="note">已供 ${t?(pd/t*100).toFixed(0):0}% · 最遲 ${ym(e)} 完</small></summary>${ls.map(loanCard).join('')}</details>`}).join('')}
  else list=A.map(loanCard).join('');
  const rp=st.F.length?Math.round(st.pct*100):0;
  return `<div class="card hero">
    <div class="hrow"><svg class="ring" viewBox="0 0 120 120" aria-label="整體已供 ${pct}%"><circle cx="60" cy="60" r="50" class="rbg"/><circle id="lnRing" cx="60" cy="60" r="50" class="rfg" data-p="${st.pct}" stroke-dasharray="314.16" stroke-dashoffset="${(314.16*(1-lastLoanPct)).toFixed(2)}" transform="rotate(-90 60 60)"/>
      <text x="60" y="60" class="rpct" id="lnPct">${pct}%</text><text x="60" y="80" class="rlbl">已供</text></svg>
     <div class="hinfo"><div class="sub">🏁 還清日（最後一條）</div><div class="big">${st.last?ym(st.last):'—'}</div><div class="sub">${st.last?'仲有 <b>'+durTxt(months)+'</b>':'未有進行中嘅貸款'}</div></div></div>
    ${mountainSvg()}
    <div class="hquip">${heroQuip(st.pct)}</div>
    <div class="hstats"><div><small>每月供款</small><b>${fmt0(st.monthly)}</b></div><div><small>仲要俾（連手續費）</small><b>${fmt0(st.remain)}</b></div><div><small>進行中</small><b>${st.A.length} 條</b></div></div>
    ${st.nextGrp.length?`<div class="next">🎓 下一位畢業生：<b>${esc(st.nextGrp.map(l=>l.name).join('、'))}</b>（${ym(st.first)}，仲有 ${lRem(st.nextGrp[0])} 期）→ 每月慳 ${fmt0(st.nextGrp.reduce((s,l)=>s+n(l.monthly),0))}</div>`:''}
    <div class="badges">${badges.map(([e,t,on])=>`<span class="bdg${on?' on':''}" title="${on?'已解鎖':'未解鎖'}">${e} ${t}</span>`).join('')}</div>
  </div>
  ${sch.pts.length?`<div class="card"><h2>📉 每月供款階梯（由 ${sch.pts[0].m} 起）</h2>${chartSvg(sch)}
    <div class="drops">${sch.drops.slice(0,4).map(dp=>`<div class="row"><div class="l">${dp.fin?'🏁 <b>'+dp.m+' 起全部還清</b>':`<b>${dp.m}</b> 起每月慳 <b class="pos">${fmt0(dp.saved)}</b>`}<small class="note">${esc(dp.names.slice(0,3).join('、'))}${dp.names.length>3?` 等 ${dp.names.length} 條`:''} 畢業</small></div><div class="r">${fmt0(dp.now)}/月</div></div>`).join('')}
    ${sch.drops.length>4?`<details><summary class="sub">睇晒 ${sch.drops.length} 個慳錢里程碑</summary>${sch.drops.slice(4).map(dp=>`<div class="row"><div class="l">${dp.fin?'🏁 '+dp.m+' 起全部還清':`${dp.m} 起每月慳 <b class="pos">${fmt0(dp.saved)}</b>`}<small class="note">${esc(dp.names.slice(0,3).join('、'))}${dp.names.length>3?` 等 ${dp.names.length} 條`:''}</small></div><div class="r">${fmt0(dp.now)}/月</div></div>`).join('')}</details>`:''}</div></div>`:''}
  <div class="card"><div class="chips">${[['end','⏳ 最快完'],['rate','🔥 利率最貴'],['amt','💰 餘額最大']].map(([k,t])=>`<button class="${loanSort===k?'on':''}" onclick="loanSort='${k}';rerender(1)">${t}</button>`).join('')}
    <button class="${loanGroup?'on':''}" onclick="loanGroup=!loanGroup;rerender(1)">🗂️ 按銀行分組</button></div>
    ${list||'<div class="sub">冇進行中嘅貸款 🎉</div>'}</div>
  ${rev.length?`<div class="card boss"><h2>👹 大魔王：循環卡數（冇固定期數，唔計入還清日同每月供款）</h2>${rev.map(l=>{const a=l.acctId&&acctById(l.acctId);const bal=a&&typeof a.balance==='number'&&isFinite(a.balance)?a.balance:l.balance;const asOf=a&&a.asOf?a.asOf:(a&&a.stmtDate?a.stmtDate:l.balanceAsOf);const ok=bal!=null&&bal<=0;
      return `<div class="loan" onclick="editLoan('${esc(l.id)}')"><div class="lh"><span class="li">${ok?'🎉':'👹'}</span><div class="lt"><b>${esc(l.name)}</b><small>${ok?'現時多付／結清':'現時結欠'} ${bal!=null?fmt(Math.abs(bal))+(bal<0?'（多付）':''):unk}${asOf?'（截至 '+esc(asOf)+'）':''}${l.minPay!=null?' · 最低還款 '+fmt(l.minPay):''}</small></div></div>
        <div class="lfoot">${rateBadge(l)}</div><div class="quip">${ok?'卡數已多付／結清，唔使再驚大佬 🎉':(lApr(l)!=null&&st.avgApr?`年利率 ${n(l.rate)}%，大約係你啲分期平均（${st.avgApr.toFixed(1)}%）嘅 ${Math.round(lApr(l)/st.avgApr)} 倍 — 有閒錢應該先打呢隻大佬`:'利息最貴，有閒錢先打佢')}</div>${l.notes?`<small class="note">${esc(l.notes)}</small>`:''}</div>`}).join('')}</div>`:''}
  ${pend.length?`<div class="card"><h2>❓ 待確認</h2>${pend.map(l=>`<div class="loan" onclick="editLoan('${esc(l.id)}')"><div class="lh"><span class="li">${LOAN_ICON[l.type]||'💸'}</span><div class="lt"><b>${esc(l.name)}</b><small>${l.balance!=null?'舊檔餘額 '+fmt0(l.balance)+(l.balanceAsOf?'（'+esc(l.balanceAsOf)+'）':''):'餘額 未知（補返）'} · 每月 ${l.monthly!=null?fmt(l.monthly):'未知（補返）'}</small></div></div><small class="note">${esc(l.notes||'')}</small></div>`).join('')}</div>`:''}
  ${grads.length?`<details class="card"><summary><b>🎓 畢業生（${grads.length}）</b></summary>${grads.map(loanCard).join('')}</details>`:''}
  <div class="sub tip">📌 呢頁係<b>現行貸款嘅正本</b>：總覽嘅「每月分期負擔」用呢度計。🗓️ 分期 tab 嘅月結單合計同舊檔逐條明細只作參考（已連結 🔗），唔會重複計。「估算」= 由月結單數字推算，唔係銀行報價。</div>
  <button class="fab" onclick="editLoan()">＋</button>`}
function mountainSvg(){const [x,y]=trailPt(lastLoanPct);
  return `<svg class="mtn" viewBox="0 0 300 124" aria-hidden="true"><defs><linearGradient id="mgr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8e0cf"/><stop offset="1" stop-color="#2f8f75"/></linearGradient></defs>
   <polygon points="0,124 0,104 40,84 70,70 100,90 140,52 175,34 200,50 250,14 300,58 300,124" fill="url(#mgr)"/>
   <polygon points="250,14 236,32 244,29 251,35 259,29 266,30" fill="#fff" opacity=".92"/>
   <polyline points="${TRAIL.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 4" opacity=".85"/>
   <text x="244" y="13" font-size="16">🚩</text><text x="268" y="120" font-size="11" fill="#fff" opacity=".9">還清山</text>
   <text id="lnClimber" x="${x.toFixed(1)}" y="${(y-2).toFixed(1)}" font-size="20" text-anchor="middle">🧗</text></svg>`}
function loanAnimate(){const ring=$('#lnRing');if(!ring)return;const to=+ring.dataset.p||0,from=lastLoanPct,rm=RM();
  const setC=p=>{const [x,y]=trailPt(p);const c=$('#lnClimber');if(c){c.setAttribute('x',x.toFixed(1));c.setAttribute('y',(y-2).toFixed(1))}const t=$('#lnPct');if(t)t.textContent=(Math.round(p*1000)/10)+'%'};
  if(rm||Math.abs(to-from)<1e-4){ring.style.strokeDashoffset=(314.16*(1-to)).toFixed(2);setC(to);lastLoanPct=to;return}
  requestAnimationFrame(()=>{ring.style.transition='stroke-dashoffset 1.2s cubic-bezier(.3,.7,.3,1)';ring.style.strokeDashoffset=(314.16*(1-to)).toFixed(2)});
  const t0=performance.now(),D=1200;const step=t=>{const k=Math.min(1,(t-t0)/D),e=1-Math.pow(1-k,3);setC(from+(to-from)*e);if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step);lastLoanPct=to}
function toast(msg,ms=2600){const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);requestAnimationFrame(()=>t.classList.add('on'));setTimeout(()=>{t.classList.remove('on');setTimeout(()=>t.remove(),400)},ms)}
function confetti(x,y,count=36,big=false){if(RM())return;const box=document.createElement('div');box.className='confetti';document.body.appendChild(box);
  const col=['#1f6f5c','#4fb39a','#f2b134','#e4572e','#7b61ff','#29a3d6','#ff7eb6'];
  for(let i=0;i<count;i++){const p=document.createElement('i');p.style.left=x+'px';p.style.top=y+'px';p.style.background=col[i%col.length];if(i%3===0)p.style.borderRadius='50%';box.appendChild(p);
    const a=Math.random()*Math.PI*2,v=(big?160:80)+Math.random()*(big?220:110),dx=Math.cos(a)*v,up=(big?240:130)+Math.random()*80;
    p.animate([{transform:'translate(0,0) rotate(0)',opacity:1},{transform:`translate(${dx*.7}px,${-up}px) rotate(${Math.random()*360}deg)`,opacity:1,offset:.35},{transform:`translate(${dx}px,${big?380:220}px) rotate(${Math.random()*900}deg)`,opacity:0}],{duration:(big?1900:1200)+Math.random()*600,easing:'cubic-bezier(.2,.6,.4,1)',fill:'forwards'})}
  setTimeout(()=>box.remove(),2900)}
function graduate(l){const o=document.createElement('div');o.className='grad';o.innerHTML=`<div class="gbox"><div class="gemo">🎓</div><div class="gt">畢業！</div><div>${esc(l.name)}</div><div class="sub">由下個月起每月慳返 <b>${fmt(l.monthly)}</b> 🎉</div></div>`;
  o.onclick=()=>o.remove();document.body.appendChild(o);requestAnimationFrame(()=>o.classList.add('on'));confetti(innerWidth/2,innerHeight/2.6,90,true);setTimeout(()=>{o.classList.remove('on');setTimeout(()=>o.remove(),400)},3200)}
function bumpLoan(id,btn){const l=S.loans.find(x=>x.id===id);if(!l||!(lRem(l)>0))return;
  const rc=btn&&btn.getBoundingClientRect?btn.getBoundingClientRect():{left:innerWidth/2,top:innerHeight/2,width:0,height:0};
  l.paidPeriods=n(l.paidPeriods)+1;l.paidAsOf=today();loanDerive(l);l.updatedAt=stamp(l.updatedAt);Sync.queue('loans',l);save();rerender(1);
  if(lRem(l)===0)graduate(l);else{confetti(rc.left+rc.width/2,rc.top+rc.height/2);toast(lRem(l)<=3?`仲有 ${lRem(l)} 期！打大佬前最後幾關 👾`:PLUS_MSG[Math.floor(Math.random()*PLUS_MSG.length)])}}
function editLoan(id){
  const l=id?S.loans.find(x=>x.id===id):{id:uid('L'),name:'',lender:'',type:'卡分期',card:'',status:'進行中',paidPeriods:0,paidAsOf:today(),startDate:today()};
  const before=n(l.paidPeriods), remBefore=lRem(l);
  form(id?'修改貸款':'新增貸款',[
    {k:'name',l:'名稱',req:1},{k:'lender',l:'貸款機構／銀行'},{k:'type',l:'類型',opts:LOAN_TYPES},{k:'card',l:'分組（例如 Citibank VISA）'},{k:'product',l:'產品（PayLite／BT IPP…）'},
    {k:'monthly',l:'每月供款（HKD）',t:'number'},{k:'totalPeriods',l:'總期數',t:'number'},{k:'paidPeriods',l:'已供期數',t:'number'},{k:'payDay',l:'每月供款日（幾號）',t:'number'},
    {k:'startDate',l:'第 1 期日期',t:'date'},{k:'principal',l:'本金（唔知就留空）',t:'number'},{k:'principalEst',l:'本金係估算',t:'check'},
    {k:'rate',l:'利率 %（唔知就留空）',t:'number'},{k:'rateType',l:'利率類型',opts:RATE_TYPES},{k:'rateEst',l:'利率係估算',t:'check'},{k:'aprEst',l:'折合實際年利率 %（估算，月平息先用）',t:'number'},
    {k:'balance',l:'尚欠本金（月結單）',t:'number'},{k:'balanceAsOf',l:'餘額日期'},{k:'status',l:'狀態',opts:LOAN_ST},
    {k:'revolving',l:'循環結欠（冇固定期數，例如卡數）',t:'check'},{k:'minPay',l:'最低還款（循環結欠用）',t:'number'},
    {k:'rateNote',l:'利率備註',t:'area'},{k:'source',l:'來源',t:'area'},{k:'notes',l:'備註',t:'area'}],
    l,o=>{if(o.paidPeriods!==before)o.paidAsOf=today();if(o.totalPeriods&&n(o.paidPeriods)>n(o.totalPeriods))o.paidPeriods=o.totalPeriods;
      loanDerive(o);upsertLocal('loans',o,!id);if(remBefore>0&&lDone(o))setTimeout(()=>graduate(o),50)},
    id?()=>tombstone('loans',id):null);
}

/* ---------- 每月固定支出（訂閱、水電煤、電話上網、保險、租金、泊車…；貸款／分期直接讀 💸 貸款，唔另存） ---------- */
let fxDay='', fxShowOff=false, fxFilter='life';
const RC_KINDS=['訂閱','水電煤','電話上網','保險','租金管理費','泊車','其他'];
const RC_CATS=['AI','工具','娛樂','成人','雲端儲存','遊戲','其他'];
const RC_ST=['生效中','試用中','可能已停','已取消','待確認','搵唔到紀錄，請補'];
const RC_CYCLES=['每月','每週','每兩月','每季','每四個月','每半年','每年','不定期'];
const RC_STEP={'每月':1,'每兩月':2,'每季':3,'每四個月':4,'每半年':6,'每年':12};
const RC_PER_MONTH={'每週':52/12,'每月':1,'每兩月':1/2,'每季':1/3,'每四個月':1/4,'每半年':1/6,'每年':1/12};
const RC_ICON={'訂閱':'📺','水電煤':'💡','電話上網':'📶','保險':'🛡️','租金管理費':'🏠','泊車':'🅿️','其他':'📦'};
const CAT_ICON={'AI':'🤖','工具':'🛠️','娛樂':'🎬','成人':'🔒','雲端儲存':'☁️','遊戲':'🎮','其他':'✨'};
const ST_PILL={'生效中':'ok','試用中':'amber','可能已停':'red','已取消':'','待確認':'amber','搵唔到紀錄，請補':'red'};
const ICHIBAN=80;   // 一番賞一抽大約 $80（講笑用）
const rcOn=r=>r.status==='生效中'||r.status==='試用中';
const rcAdult=r=>!!r.adult||r.category==='成人';
const rcPerMonth=r=>RC_PER_MONTH[r.cycle||'每月']||0;
const rcHas=r=>r.hkd!=null&&r.hkd!==''&&isFinite(r.hkd);
const rcCounted=r=>rcOn(r)&&rcHas(r)&&rcPerMonth(r)>0;
const rcMonthly=r=>rcCounted(r)?n(+r.hkd)*rcPerMonth(r):0;
const rcName=r=>rcAdult(r)?'🔒 私人項目':r.name;
const isoD=s=>/^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
const withDay=(iso,day)=>{if(!day)return iso;const [y,m]=iso.split('-').map(Number);const dim=new Date(Date.UTC(y,m,0)).getUTCDate();return iso.slice(0,8)+String(Math.min(n(+day),dim)).padStart(2,'0')};
const addDays=(iso,k)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+k);return d.toISOString().slice(0,10)};
const dayDiff=(a,b)=>Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/864e5);
/* 某個月份（YYYY-MM）入面會扣數嘅日子 */
function rcOccur(r,m){
  if(!rcOn(r)||r.cycle==='不定期')return [];
  const anchor=isoD(r.lastDate)?r.lastDate:isoD(r.nextDate)?r.nextDate:null;
  if(r.cycle==='每週'){if(!anchor)return [];let d=anchor;const s=m+'-01';while(d<s)d=addDays(d,7);while(addDays(d,-7)>=s)d=addDays(d,-7);const out=[];while(d.startsWith(m)){out.push(d);d=addDays(d,7)}return out}
  const st=RC_STEP[r.cycle||'每月']||1;
  if(!anchor){return st===1&&r.day?[withDay(m+'-01',r.day)]:[]}
  const k=mdiff(anchor,m+'-01');if(k%st!==0)return [];
  return [withDay(m+'-01',r.day||+anchor.slice(8,10))]}
/* 下次扣數（今日或之後） */
function rcNext(r){
  if(!rcOn(r)||r.cycle==='不定期')return '';const t=today();
  if(isoD(r.nextDate)&&r.nextDate>=t&&(!isoD(r.lastDate)||r.nextDate>r.lastDate))return r.nextDate;
  let m=t.slice(0,7);for(let i=0;i<14;i++){const ds=rcOccur(r,m).filter(d=>d>=t&&(!isoD(r.lastDate)||d>r.lastDate));if(ds.length)return ds[0];m=addMonths(m+'-01',1).slice(0,7)}
  return ''}
const loanOccur=(l,m)=>{if(!l.payDay)return [];const d=withDay(m+'-01',l.payDay);const e=lEnd(l);return (!e||ym(d)<=ym(e))&&(lRem(l)>0)?[d]:[]};
const loanNext=l=>{const t=today();let m=t.slice(0,7);for(let i=0;i<3;i++){const d=loanOccur(l,m).find(x=>x>=t);if(d)return d;m=addMonths(m+'-01',1).slice(0,7)}return ''};
function fxEvents(m){
  const ev=[];live(S.recurring).forEach(r=>rcOccur(r,m).forEach(d=>ev.push({d,name:rcName(r),amt:rcHas(r)?n(+r.hkd):null,icon:rcAdult(r)?'🔒':(r.kind==='訂閱'?CAT_ICON[r.category]||'📺':RC_ICON[r.kind]||'📦'),id:r.id,loan:0,kind:r.kind||'其他',pin:0})));
  activeLoans().forEach(l=>loanOccur(l,m).forEach(d=>ev.push({d,name:l.name,amt:n(l.monthly),icon:'💸',id:l.id,loan:1,kind:'貸款',pin:0})));
  /* v28：玩具尾款／訂金補款只喺「宅」tab，唔再塞入每月固定支出日曆 */
  return ev.sort((a,b)=>(b.pin|0)-(a.pin|0)||a.d.localeCompare(b.d)||n(b.amt)-n(a.amt))}
const fxKeep=e=>fxFilter==='all'?1:fxFilter==='loan'?e.loan: !e.loan;
const FX_FILT=[['life','生活固定'],['loan','貸款分期'],['all','全部']];
const whenTxt=d=>{const k=dayDiff(today(),d);return k===0?'今日':k===1?'聽日':k===2?'後日':k+' 日後'};
function fxStats(){
  const R=live(S.recurring), on=R.filter(rcCounted);
  const other=on.reduce((s,r)=>s+rcMonthly(r),0), loans=loanMode()?activeLoans().reduce((s,l)=>s+n(l.monthly),0):burden();
  const subs=on.filter(r=>r.kind==='訂閱').reduce((s,r)=>s+rcMonthly(r),0);
  const pend=R.filter(r=>r.status==='待確認'||r.status==='搵唔到紀錄，請補');
  return {R,on,other,loans,total:other+loans,subs,pend,pendAmt:pend.filter(r=>rcHas(r)&&rcPerMonth(r)).reduce((s,r)=>s+n(+r.hkd)*rcPerMonth(r),0)}}
function setRcSt(id,st){
  const r=S.recurring.find(x=>x.id===id); if(!r)return;
  if((r.status||'生效中')===st)return;
  if(st==='已取消'&&!confirm(`標記「${rcAdult(r)?'呢個私人項目':r.name}」為已取消？（只係改紀錄，唔會幫你取消訂閱）`))return;
  const wasOn=rcOn(r);
  r.status=st;
  if(st==='已取消'&&!r.cancelledAt)r.cancelledAt=today();
  r.updatedAt=stamp(r.updatedAt); Sync.queue('recurring',r); save(); rerender(1);
  if(st==='已取消'&&wasOn) toast('已標記為已取消 ✂️ 每月慳返 '+fmt0(n(+r.hkd)*rcPerMonth(r)));
  else toast('已標「'+st+'」');
}
/* 一律全部狀態掣：選中 .on；唔好只顯示「標記已取消」／收埋而家嗰個 */
function rcQuickBtns(r){
  const cur=r.status||'生效中', id=esc(r.id);
  return `<span class="wish-acts" onclick="event.stopPropagation()">${RC_ST.map(st=>
    `<button type="button" class="wish-qbtn${st===cur?' on':''}" onclick="setRcSt('${id}','${st}')">${st}</button>`
  ).join('')}</span>`;
}
function rcRow(r){
  const nx=rcNext(r), pm=rcPerMonth(r);
  const cyc=r.cycle&&r.cycle!=='每月'?r.cycle:'';
  const amt=rcHas(r)?fmt(+r.hkd)+(cyc?`<small class="note">${esc(cyc)}${pm&&r.cycle!=='每週'?' ≈ '+fmt0(n(+r.hkd)*pm)+'/月':''}</small>`:'<small class="note">/月</small>'):'<span class="unk">金額未知</span>';
  const fx=r.currency&&r.currency!=='HKD'&&r.amount!=null&&r.amount!==''?` · ${esc(r.currency)} ${esc(r.amount)}`:'';
  const ic=r.kind==='訂閱'?(CAT_ICON[r.category]||'📺'):(RC_ICON[r.kind]||'📦');
  return `<div class="row rc${rcOn(r)?'':' off'}" onclick="editRc('${esc(r.id)}')"><div class="l"><span class="rci">${ic}</span>${esc(r.name)}
    ${r.flag?`<span class="pill red">⚠️ ${esc(r.flag)}</span>`:''}${r.est?' <span class="pill">估算</span>':''}
    <small class="note">${r.day&&(r.cycle||'每月')==='每月'?'每月 '+esc(r.day)+' 號 · ':''}${nx?'下次 '+nx+'（'+whenTxt(nx)+'）':r.lastDate?'上次 '+esc(r.lastDate):''}${r.account?' · '+esc(r.account):''}${fx}</small>
    ${rcQuickBtns(r)}</div>
    <div class="r">${amt}</div></div>`}
function loanFxRow(l){const nx=loanNext(l);
  return `<div class="row rc" onclick="tab='loan';history.replaceState(null,'','#loan');rerender()"><div class="l"><span class="rci">💸</span>${esc(l.name)} <span class="pill">第 ${n(l.paidPeriods)}/${n(l.totalPeriods)} 期</span>
    <small class="note">${l.payDay?'每月 '+n(l.payDay)+' 號 · ':''}${nx?'下次 '+nx+'（'+whenTxt(nx)+'）· ':''}仲有 ${lRem(l)} 期 · ${esc(l.card||l.lender||'')}</small></div><div class="r">${fmt(l.monthly)}<small class="note">/月 →</small></div></div>`}
function vFixed(){
  const st=fxStats(), t=today(), m=t.slice(0,7), allEv=fxEvents(m), nextM=addMonths(m+'-01',1).slice(0,7);
  const ev=allEv.filter(fxKeep);
  const up=[...allEv,...fxEvents(nextM)].filter(e=>e.d>=t&&fxKeep(e)), nxt=up[0];
  const dim=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).getUTCDate();
  const byDay={};ev.forEach(e=>(byDay[e.d]=byDay[e.d]||[]).push(e));
  const strip=[...Array(dim)].map((_,i)=>{const d=m+'-'+String(i+1).padStart(2,'0'),L=byDay[d]||[],s=L.reduce((a,e)=>a+n(e.amt),0);
    return `<button class="cday${d===t?' today':''}${d<t?' past':''}${L.length?' has':''}${fxDay===d?' sel':''}" onclick="fxDay=fxDay==='${d}'?'':'${d}';rerender(1)"><b>${i+1}</b><i>${L.length?(L.length>3?'●●●':'●'.repeat(L.length)):''}</i><small>${s?fmt0(s).replace('$',''):''}</small></button>`}).join('');
  const sel=fxDay&&fxDay.startsWith(m)?(byDay[fxDay]||[]):null;
  const dayList=sel?`<div class="sub" style="margin-top:6px"><b>${fxDay}</b>：${sel.length?sel.map(e=>`${e.pin?'📌 ':''}${e.icon} ${esc(e.name)} ${e.amt!=null?fmt0(e.amt):'金額未知'}`).join('、'):'冇扣數'}</div>`:'';
  const tl=up.filter(e=>dayDiff(t,e.d)<=31);
  const filt=FX_FILT.map(([k,lab])=>`<button class="${fxFilter===k?'on':''}" onclick="fxFilter='${k}';rerender(1)">${lab}</button>`).join('');
  const R=st.R, adult=R.filter(rcAdult), normal=R.filter(r=>!rcAdult(r));
  const shown=normal.filter(r=>fxShowOff||r.status!=='已取消'&&r.status!=='可能已停'), offN=normal.length-normal.filter(r=>r.status!=='已取消'&&r.status!=='可能已停').length;
  const grp=(title,L,open=true)=>{if(!L.length)return '';const s=L.reduce((a,r)=>a+rcMonthly(r),0);
    return `<details class="lgrp"${open?' open':''}><summary><span>${title} · ${L.length} 項</span><span class="r">${fmt0(s)}/月</span></summary>${L.sort((a,b)=>(rcOn(b)-rcOn(a))||rcMonthly(b)-rcMonthly(a)).map(rcRow).join('')}</details>`};
  const subs=shown.filter(r=>r.kind==='訂閱');
  const subGroups=RC_CATS.filter(c=>c!=='成人').map(c=>grp(`${CAT_ICON[c]} ${c}`,subs.filter(r=>(r.category||'其他')===c))).join('')+grp('✨ 其他',subs.filter(r=>!RC_CATS.includes(r.category)));
  const kindGroups=RC_KINDS.filter(k=>k!=='訂閱').map(k=>grp(`${RC_ICON[k]} ${k}`,shown.filter(r=>r.kind===k))).join('')+grp('📦 未分類',shown.filter(r=>!RC_KINDS.includes(r.kind)));
  const A=activeLoans().slice().sort((a,b)=>(loanNext(a)||'9').localeCompare(loanNext(b)||'9'));
  const aOn=adult.filter(rcCounted), aAmt=aOn.reduce((s,r)=>s+rcMonthly(r),0);
  const draws=Math.round(st.subs/ICHIBAN);
  const lifeN=ev.length, lifeSum=ev.reduce((s,e)=>s+n(e.amt),0);
  return `<div class="card hero fx">
    <h2>📌 每月固定開支合計</h2><div class="big">${fmt0(st.total)}<span class="sub"> /月</span></div>
    <div class="fxsplit"><div onclick="tab='loan';history.replaceState(null,'','#loan');rerender()"><small>💸 貸款／分期 →</small><b>${fmt0(st.loans)}</b></div><div><small>📺 其他固定支出</small><b>${fmt0(st.other)}</b></div><div><small>一年合計</small><b>${fmt0(st.total*12)}</b></div></div>
    <div class="bar fxbar"><i style="width:${st.total?(st.loans/st.total*100).toFixed(1):0}%"></i></div>
    ${nxt?`<div class="next">⏭️ 下一筆${fxFilter==='life'?'生活固定':fxFilter==='loan'?'貸款':''}：<b>${esc(nxt.name)}</b> ${nxt.amt!=null?fmt(nxt.amt):'金額未知'} · ${nxt.d}（${whenTxt(nxt.d)}）</div>`:''}
    ${st.subs?`<div class="hquip">🎰 每月訂閱食咗你 ${fmt0(st.subs)}，等於 ${draws} 抽一番賞（一抽當 $${ICHIBAN}）；一年 ${fmt0(st.subs*12)}</div>`:''}
    ${st.pend.length?`<div class="sub">❓ 未計入：${st.pend.length} 項待確認／搵唔到紀錄${st.pendAmt?`（估計約 ${fmt0(st.pendAmt)}/月）`:''}，喺下面逐項補返。</div>`:''}
  </div>
  <div class="card"><h2>🗓️ ${m.slice(0,4)} 年 ${+m.slice(5,7)} 月扣數日曆</h2>
    <div class="chips">${filt}</div>
    <div class="sub" style="margin:0 0 6px">${fxFilter==='life'?'顯示訂閱、水電、電話、保險、泊車、家用等（唔包貸款分期）':fxFilter==='loan'?'只顯示貸款／分期月供':'生活固定 + 貸款分期'}</div>
    <div class="cstrip">${strip}</div>${dayList}
    <div class="sub">本月合共 ${lifeN} 筆 · ${fmt0(lifeSum)}（撳日子睇明細；只計訂閱／水電／保險等生活固定＋貸款）</div></div>
  <div class="card"><h2>⏳ ${fxFilter==='life'?'生活固定時間軸':fxFilter==='loan'?'貸款分期時間軸':'扣數時間軸'}（未來 31 日）</h2>${tl.length?tl.map(e=>`<div class="row tl${e.pin?' pin':''}"><div class="l"><span class="tld">${e.pin?'📌 ':''}${e.d.slice(5)}</span>${e.icon} ${esc(e.name)}<small class="note">${whenTxt(e.d)}${e.kind&&!e.loan?' · '+esc(e.kind):''}</small></div><div class="r">${e.amt!=null?fmt(e.amt):'金額未知'}</div></div>`).join(''):`<div class="sub">${fxFilter==='life'?'未來一個月冇已知嘅訂閱／水電等扣數':'未來一個月冇已知扣數'}</div>`}</div>
  <div class="card"><h2>📺 訂閱</h2>${subGroups||'<div class="sub">未有訂閱紀錄。撳右下角 ＋ 加。</div>'}
    ${adult.length?`<details class="lgrp rc-private"><summary><span>🔒 私人 · ${adult.length} 項</span><span class="r">${fmt0(aAmt)}/月</span></summary><div class="sub">撳開先顯示名稱。</div>${adult.sort((a,b)=>(rcOn(b)-rcOn(a))||rcMonthly(b)-rcMonthly(a)).map(rcRow).join('')}</details>`:''}</div>
  <div class="card"><h2>🏠 其他固定支出</h2>${kindGroups||'<div class="sub">未有紀錄</div>'}</div>
  <div class="card"><h2>💸 貸款／分期（讀自貸款 tab，唔重複儲存）</h2>
    <details class="lgrp"><summary><span>${A.length} 條進行中</span><span class="r">${fmt0(st.loans)}/月</span></summary>${A.map(loanFxRow).join('')||'<div class="sub">冇進行中嘅貸款</div>'}</details>
    <div class="sub">撳任何一條跳去 💸 貸款 tab 改期數。循環卡數冇固定月供，唔計入。</div></div>
  <div class="actions">${offN?`<button onclick="fxShowOff=!fxShowOff;rerender(1)">${fxShowOff?'收埋':'顯示'}已停／已取消（${offN}）</button>`:''}<button onclick="editRc()">＋ 新增固定支出</button></div>
  <div class="sub tip">📌 每月合計只計「生效中／試用中」而有金額嘅項目；年費÷12、每週×52÷12。貸款／分期直接用 💸 貸款 tab（同總覽「每月分期負擔」一樣），呢度唔會再存一次，所以唔會重複計。日曆預設「生活固定」：訂閱、水電、電話、保險、泊車、家用；要睇貸款撳上面「貸款分期」。</div>
  <button class="fab" onclick="editRc()">＋</button>`}
function cancelRc(id){const r=S.recurring.find(x=>x.id===id);if(!r||!confirm(`標記「${rcAdult(r)?'呢個私人項目':r.name}」為已取消？（只係改紀錄，唔會幫你取消訂閱）`))return;
  r.status='已取消';r.cancelledAt=today();r.updatedAt=stamp(r.updatedAt);Sync.queue('recurring',r);save();rerender(1);toast('已標記為已取消 ✂️ 每月慳返 '+fmt0(n(+r.hkd)*rcPerMonth(r)))}
function editRc(id){
  const r=id?S.recurring.find(x=>x.id===id):{id:uid('rc-'),kind:'訂閱',category:'其他',name:'',cycle:'每月',currency:'HKD',status:'生效中',firstSeen:today()};
  form(id?'修改固定支出':'新增固定支出',[
    {k:'name',l:'名稱',req:1},{k:'kind',l:'種類',opts:RC_KINDS},{k:'category',l:'訂閱分類（只限訂閱）',opts:['',...RC_CATS]},
    {k:'hkd',l:'每次扣數（HKD）',t:'number'},{k:'amount',l:'原幣金額',t:'number'},{k:'currency',l:'貨幣（HKD／USD／JPY…）'},
    {k:'cycle',l:'週期',opts:RC_CYCLES},{k:'day',l:'每月扣數日（幾號）',t:'number'},{k:'account',l:'卡／帳戶',opts:['',...acctNames(),'PayPal 餘額']},
    {k:'merchant',l:'帳單商戶名',opts:shopOpts(),other:1},{k:'lastDate',l:'上次扣數',t:'date'},{k:'nextDate',l:'下次扣數（留空自動計）',t:'date'},{k:'firstSeen',l:'第一次見',t:'date'},
    {k:'status',l:'狀態',opts:RC_ST},{k:'flag',l:'提示（例如 重複？）'},{k:'est',l:'金額係估算',t:'check'},{k:'adult',l:'私人（收埋喺 🔒 分組）',t:'check'},
    {k:'evidence',l:'證據（交易／電郵）',t:'area'},{k:'txIds',l:'連結交易 id（逗號分隔）',t:'area'},{k:'notes',l:'備註',t:'area'}],
    r,o=>{if(o.status==='已取消'&&!o.cancelledAt)o.cancelledAt=today();upsertLocal('recurring',o,!id)},id?()=>tombstone('recurring',id):null);
  const ids=String(r.txIds||'').split(/[,\s]+/).filter(Boolean);
  if(ids.length){const m=new Map(live(S.transactions).map(t=>[t.id,t]));const L=ids.map(i=>m.get(i)).filter(Boolean).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const box=document.createElement('div');box.className='sub';box.innerHTML=`🔗 已連結 ${L.length} 筆交易：<br>`+L.slice(0,12).map(t=>`${t.date} ${fmt(t.amount)} · ${esc(t.account)}`).join('<br>')+(L.length>12?`<br>…仲有 ${L.length-12} 筆`:'');
    const act=$('#dlgForm .actions');if(act)act.before(box)}
}

/* ---------- 雲端同步（Google Sheets，Apps Script web app） ---------- */
const TABLES={transactions:'Transactions',accounts:'Accounts',installments:'Installments',wishlist:'Wishlist',salary:'Salary',forecast:'Forecast',bonus:'Bonus',archive:'Archive',loans:'Loans',recurring:'Recurring'};
const TBL_LABEL={transactions:'交易',accounts:'帳戶',installments:'分期',wishlist:'宅',salary:'人工',forecast:'預測',bonus:'花紅',archive:'舊檔',loans:'貸款',recurring:'固定支出'};
const fmtInt=x=>Number(x||0).toLocaleString('en-HK');
const syncErr=(code,extra)=>Object.assign(new Error(code),{code},extra||{});
const Sync={
  PAGE_ROWS:1200, CHUNK:1000, CHUNK_BYTES:300000, RETRY_MS:1500,
  cfg(){try{return JSON.parse(localStorage.getItem(SYNC_KEY)||'{}')}catch(_){return {}}},
  setCfg(p){const c={...this.cfg(),...p};if(!lsSet(SYNC_KEY,JSON.stringify(c)))console.warn('同步設定存唔落 localStorage');return c},
  on(){const c=this.cfg();return !!(c.url&&c.token)},
  q(){try{return JSON.parse(localStorage.getItem(SYNCQ_KEY)||'[]')}catch(_){return []}},
  setQ(q){if(lsSet(SYNCQ_KEY,JSON.stringify(q)))return true;this.status(false,'排隊清單太大，存唔落本機。請撳「首次上載全部資料」。');return false},
  /* 分批：每批最多 CHUNK 筆、約 CHUNK_BYTES（iPhone 流動網絡一次過上載／下載幾 MB 好易斷） */
  chunks(recs){const out=[];let cur=[],b=0;for(const r of recs){const js=JSON.stringify(r),l=js.length+js.replace(/[\x00-\x7f]/g,'').length*2;   // 約 UTF-8 bytes

    if(cur.length&&(cur.length>=this.CHUNK||b+l>this.CHUNK_BYTES)){out.push(cur);cur=[];b=0}cur.push(r);b+=l}if(cur.length)out.push(cur);return out},
  async sendRecs(by,onProg){let last=null,done=0;const tot=Object.values(by).reduce((s,a)=>s+a.length,0);
    for(const [k,recs] of Object.entries(by)){for(const part of this.chunks(recs)){
      const j=await this.retry(()=>this.call('POST',{action:'upsert',table:TABLES[k],records:part}));last=j.serverTime||last;done+=part.length;if(onProg)onProg(k,done,tot)}}
    return last},
  busy:false, syncing:null, _prog:'',
  queue(key,rec){
    if(!this.on()||!TABLES[key]) return;
    const q=this.q().filter(x=>!(x.t===key&&x.r.id===rec.id)); q.push({t:key,r:rec}); if(!this.setQ(q))return;
    clearTimeout(this._tm); this._tm=setTimeout(()=>this.flush(),800);
  },
  async call(method,body,params,timeout=90000){
    const c=this.cfg(); let url=c.url;
    const opt={method,redirect:'follow',cache:'no-store'};
    if(method==='GET'){const u=new URL(url);u.searchParams.set('token',c.token);Object.entries(params||{}).forEach(([k,v])=>u.searchParams.set(k,v));url=u.toString()}
    else{opt.headers={'Content-Type':'text/plain;charset=utf-8'};opt.body=JSON.stringify({token:c.token,...body})}
    const ac=typeof AbortController==='function'?new AbortController():null; let tm=null;
    if(ac){opt.signal=ac.signal;tm=setTimeout(()=>ac.abort(),timeout)}
    const aborted=()=>!!(ac&&ac.signal.aborted);
    let res,txt;
    try{res=await fetch(url,opt)}catch(e){clearTimeout(tm);throw syncErr(aborted()?'TIMEOUT':'OFFLINE',{raw:String(e&&e.message||e)})}
    // Safari：header 收到、body 下載到一半斷線 → res.text() 會 throw「Load failed」，一定要喺度接住
    try{txt=await res.text()}catch(e){clearTimeout(tm);throw syncErr(aborted()?'TIMEOUT':'BODY',{raw:String(e&&e.message||e)})}
    clearTimeout(tm);
    let j;
    try{j=JSON.parse(txt)}catch(_){throw syncErr(/<html/i.test(txt)?'HTML':!txt?'EMPTY':res.ok?'TRUNC':'HTTP',{status:res.status})}
    if(!j||!j.ok) throw syncErr('SERVER',{server:String(j&&j.error||'未知')});
    return j;
  },
  ERR:{
    OFFLINE:'連唔到雲端（可能冇網或者網絡唔穩）。未上載嘅改動會留喺部機排隊，有網會自動再試。',
    TIMEOUT:'雲端太耐冇回應（網絡太慢或者 Google 忙緊）。轉用 Wi-Fi 再撳「立即同步」試吓。',
    BODY:'下載到一半斷咗線（網絡唔穩）。轉用 Wi-Fi 或者去訊號好啲嘅地方，再撳「立即同步」。',
    TRUNC:'收到嘅資料唔完整（傳到一半斷咗）。再撳「立即同步」試吓。',
    EMPTY:'雲端回咗空白回應。再撳「立即同步」試吓。',
    HTML:'雲端回咗網頁而唔係資料：檢查同步網址（要用 Deploy 之後嘅 /exec 網址，存取權限要「Anyone」）。',
    OLDBIG:'舊版雲端程式要一次過下載成個約 3 MB 嘅資料，iPhone 流動網絡好易中途斷線。請更新 Apps Script（Manage deployments → 編輯 → New version），之後會自動改用分頁下載；暫時可以轉用 Wi-Fi 再試。',
    PAGING:'雲端分頁資料前後唔一致（可能有人同時上載緊）。等一陣再撳「立即同步」。'
  },
  errMsg(e){
    const c=e&&e.code;
    if(c==='SERVER'){const s=e.server;
      if(s==='unauthorized')return '密碼（token）唔啱，雲端拒絕咗。去設定再貼一次密碼，或者再撳一次同步連結。';
      if(/^busy/.test(s))return '雲端忙緊（可能另一部機同步緊），等一陣再撳「立即同步」。';
      if(/unknown action/.test(s))return '雲端程式版本太舊，唔識呢個動作。請更新 Apps Script（Manage deployments → 編輯 → New version）。';
      if(/cell too long/.test(s))return '有一格資料太長（超過 5 萬字），Google Sheet 存唔落。';
      if(/unknown table/.test(s))return '雲端唔認得呢個分頁名。';
      if(/quota|too many times|timed out|exceeded|Service/i.test(s))return 'Google 雲端暫時超出用量或者逾時，等幾分鐘再試。';
      return /[\u3400-\u9fff]/.test(s)?'雲端錯誤：'+s:'雲端出錯（'+s+'），等一陣再試。'}
    if(c==='HTTP')return `雲端暫時有問題（HTTP ${e.status}），等一陣再試。`;
    if(c&&this.ERR[c])return this.ERR[c];
    const m=String(e&&e.message||e);
    if(/load failed|failed to fetch|network ?error|connection was lost|internet connection/i.test(m))return this.ERR.BODY;
    return /[\u3400-\u9fff]/.test(m)?m:'同步出錯（'+m+'）。再撳「立即同步」試吓；如果仲係咁，先喺設定匯出備份。';
  },
  /* 失敗會自動再試（預設最多試 3 次）；token 錯／網址錯就唔使再試 */
  async retry(fn,tries=3){let err;
    for(let i=0;i<tries;i++){try{return await fn()}catch(e){err=e;
      if(e.code==='HTML'||(e.code==='SERVER'&&!/^busy|timed out|Service|quota|exceeded/i.test(e.server)))throw e;
      if(i<tries-1){const p=this._prog;if(p)this.progress(p+`（網絡唔穩，重試緊 ${i+1}/${tries-1}…）`);this._prog=p;
        await new Promise(r=>setTimeout(r,this.RETRY_MS*(i+1)))}}}
    throw err},
  progress(msg){this._prog=msg||'';const el=$('#syncStatus');if(el&&msg)el.textContent=msg;
    let b=$('#syncProg');
    if(msg){if(!b){b=document.createElement('div');b.id='syncProg';b.className='syncprog';b.setAttribute('role','status');document.body.appendChild(b)}b.textContent='☁︎ '+msg}
    else if(b)b.remove();
    const bd=$('#syncBadge');if(bd&&msg)bd.textContent='☁︎⇣'},
  status(ok,msg){const c=this.setCfg(ok?{lastSync:nowISO(),lastError:''}:{lastError:msg,lastErrorAt:nowISO()});this.badge();const el=$('#syncStatus');if(el&&!this._prog)el.innerHTML=this.statusHtml()},
  statusHtml(){const c=this.cfg(),q=this.q().length;
    return `${c.lastSync?'上次同步：'+new Date(c.lastSync).toLocaleString('zh-HK',{hour12:false}):'未同步過'}${q?` · 排緊隊：${q} 項`:''}${c.serverVersion?` · 雲端程式 v${c.serverVersion}${c.serverVersion<2?'（舊版：建議更新 Apps Script，分頁下載會穩陣好多）':''}`:''}${c.lastError?`<br><span style="color:var(--warn)">⚠️ ${esc(c.lastError)}</span>`:''}`},
  badge(){const b=$('#syncBadge');if(!b)return;if(!this.on()){b.textContent='';return}
    const c=this.cfg(),q=this.q().length;b.textContent=c.lastError?'☁︎⚠️':q?'☁︎'+q:'☁︎✓';b.title=c.lastError||'雲端同步'},
  async flush(){
    if(!this.on()) return true; if(this.busy) return true; const q=this.q(); if(!q.length) return true;
    this.busy=true;
    try{
      const by={}; q.forEach(x=>(by[x.t]=by[x.t]||[]).push(x.r));
      await this.sendRecs(by);
      const sent=new Set(q.map(x=>x.t+'\u0001'+x.r.id+'\u0001'+(x.r.updatedAt||'')));
      this.setQ(this.q().filter(x=>!sent.has(x.t+'\u0001'+x.r.id+'\u0001'+(x.r.updatedAt||''))));
      this.status(true); return true;
    }catch(e){this.status(false,this.errMsg(e)); return false}
    finally{this.busy=false}
  },
  /* 每筆紀錄 last-write-wins（updatedAt），墓碑（deleted）照計 */
  mergeTable(loc,rem){
    const m=new Map();(loc||[]).forEach(r=>m.set(r.id,r));const push=[];const seen=new Set();
    (rem||[]).forEach(r=>{seen.add(r.id);const l=m.get(r.id);const ru=r.updatedAt||'',lu=l?(l.updatedAt||''):'';
      if(!l||ru>lu)m.set(r.id,r);else if(lu>ru)push.push(l)});
    (loc||[]).forEach(l=>{if(!seen.has(l.id))push.push(l)});
    return {out:[...m.values()],push};
  },
  mergeInc(loc,rem){ // 增量：只合併雲端有變嘅紀錄
    if(!rem||!rem.length)return loc||[];
    const m=new Map((loc||[]).map(r=>[r.id,r]));
    rem.forEach(r=>{const l=m.get(r.id);if(!l||(r.updatedAt||'')>=(l.updatedAt||''))m.set(r.id,r)});return [...m.values()];
  },
  mergeExtras(local,remote){
    if(Array.isArray(remote.categories)){const set=new Set(remote.categories);local.categories=[...remote.categories,...(local.categories||[]).filter(c=>!set.has(c))]}
    if(remote.meta&&(remote.meta.updatedAt||'')>(local.metaUpdatedAt||'')){Object.assign(local,remote.meta.values||{});local.metaUpdatedAt=remote.meta.updatedAt}
  },
  mergeState(local,remote,full){
    const pushes={};
    for(const k of Object.keys(TABLES)){
      if(full){const r=this.mergeTable(local[k],remote[k]);local[k]=r.out;if(r.push.length)pushes[k]=r.push}
      else local[k]=this.mergeInc(local[k],remote[k]);
    }
    this.mergeExtras(local,remote);
    return pushes;
  },
  // 本機有、雲端冇（或者本機較新）嘅紀錄：直接由記憶體上載（唔塞入排隊清單，費事爆 localStorage）
  async sendPushes(pushes){
    const cnt=Object.values(pushes).reduce((s,a)=>s+a.length,0); if(!cnt)return;
    try{await this.sendRecs(pushes,(k,d,t)=>t>2000&&this.progress(`上載緊本機紀錄 ${fmtInt(d)}／${fmtInt(t)}…`))}catch(e){
      if(cnt<=500){for(const [k,recs] of Object.entries(pushes)) recs.forEach(r=>this.queue(k,r))}
      else throw new Error(`有 ${cnt} 筆本機紀錄未上載（${this.errMsg(e)}）。有網時撳「立即同步」或「首次上載全部資料」。`)}
  },
  /* 先 ping：新版雲端程式（version ≥ 2）支援分頁 → 逐頁下載；舊版 → 一次過下載 */
  async serverInfo(){
    const j=await this.retry(()=>this.call('GET',null,{action:'ping'},30000));
    const v=Number(j.version)||1; this.setCfg({serverVersion:v}); return {version:v,paging:v>=2&&!!j.paging};
  },
  async pull(full){const info=await this.serverInfo();return info.paging?this.pullPaged(full):this.pullOnce(full)},
  async pullOnce(full){
    const c=this.cfg(); const params={action:'pull'}; if(!full&&c.serverTime)params.since=c.serverTime;
    this.progress(params.since?'下載緊雲端改動…':'下載緊全部資料（舊版雲端程式要一次過下載，可能要等一陣）…');
    let j;
    try{j=await this.call('GET',null,params,180000)}
    catch(e){if(!params.since&&['BODY','TRUNC','TIMEOUT','EMPTY'].includes(e.code))throw syncErr('OLDBIG',{raw:e.raw||e.code});throw e}
    const pushes=this.mergeState(S,j.state,!params.since);
    normalize(); save(); this.setCfg({serverTime:j.serverTime});
    await this.sendPushes(pushes);
    return j;
  },
  /* 逐個表、逐頁下載；每個表下載完即刻交俾 onTable 合併 */
  async fetchPaged(since,onTable){
    this.progress(since?'檢查緊雲端有咩改動…':'準備下載…');
    const info=await this.retry(()=>this.call('GET',null,since?{action:'tables',since}:{action:'tables'},60000));
    const list=(info.tables||[]).filter(t=>TABLES[t.key]);
    const grand=list.reduce((s,t)=>s+(t.rows||0),0); let got=0;
    for(const t of list){
      const rows=[];
      if(t.rows>0){let off=0;
        while(off!=null){
          this.progress(`下載緊 ${TBL_LABEL[t.key]||t.key} ${fmtInt(Math.min(off,t.rows))}／${fmtInt(t.rows)}…`+(grand>3000?`（${Math.floor(got/grand*100)}%）`:''));
          const q={action:'pull',table:t.name,offset:off,limit:this.PAGE_ROWS}; if(since)q.since=since;
          const p=await this.retry(()=>this.call('GET',null,q,60000));
          for(const r of p.rows)rows.push(r); got+=p.rows.length;
          if(p.next!=null&&!(p.next>off))throw syncErr('PAGING');
          off=p.next;
        }}
      await onTable(t.key,rows);
    }
    for(const k of Object.keys(TABLES))if(!list.some(t=>t.key===k))await onTable(k,[]);   // 雲端未有嘅表當空表
    return info;
  },
  async pullPaged(full){
    const c=this.cfg(); const since=(!full&&c.serverTime)?c.serverTime:''; const pushes={};
    const info=await this.fetchPaged(since,async(k,rows)=>{
      if(since)S[k]=this.mergeInc(S[k],rows);
      else{const r=this.mergeTable(S[k],rows);S[k]=r.out;if(r.push.length)pushes[k]=r.push}});
    this.mergeExtras(S,info);
    normalize(); save(); this.setCfg({serverTime:info.serverTime});
    this.progress('');
    await this.sendPushes(pushes);
    return info;
  },
  async syncNow(full){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    if(this.syncing)return this.syncing;
    this.syncing=(async()=>{
      try{await this.flush();await this.pull(full);const b=await this.flush();if(b)this.status(true);rerender(1)}
      catch(e){this.status(false,this.errMsg(e))}
      finally{this.progress('');this.syncing=null;const el=$('#syncStatus');if(el)el.innerHTML=this.statusHtml();this.badge()}})();
    return this.syncing;
  },
  async auto(){
    if(!this.on()) return;
    await this.syncNow(false);
    window.addEventListener('online',()=>this.flush());
    setInterval(()=>this.flush(),60000);
  },
  metaOf(st){const v={};['version','burden','source','generatedAt','historyImport'].forEach(k=>{if(st[k]!==undefined)v[k]=st[k]});return {values:v,updatedAt:st.metaUpdatedAt||nowISO()}},
  /* 首次上載：先清空雲端（push 空表 + 分類 + meta），再分批 upsert，每批 < 300 KB */
  async pushAll(){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    if(!confirm('會用呢部機嘅全部資料取代雲端 Google Sheet 入面嘅資料。確定？'))return;
    let started=false;
    try{const st={},by={};Object.keys(TABLES).forEach(k=>{st[k]=[];if((S[k]||[]).length)by[k]=S[k]});
      st.categories=S.categories;st.meta=this.metaOf(S);
      this.progress('上載緊（清空雲端舊資料）…');
      const j=await this.retry(()=>this.call('POST',{action:'push',state:st},null,120000),2); started=true;
      const last=await this.sendRecs(by,(k,d,t)=>this.progress(`上載緊 ${fmtInt(d)}／${fmtInt(t)} 筆…`));
      this.setQ([]);this.setCfg({serverTime:last||j.serverTime});this.progress('');this.status(true);
      alert('上載完成：'+Object.keys(TABLES).filter(k=>(S[k]||[]).length).map(k=>(TBL_LABEL[k]||k)+' '+fmtInt(S[k].length)).join('、'))}
    catch(e){this.progress('');const m=this.errMsg(e);this.status(false,m);alert('上載失敗：'+m+(started?'\n雲端資料可能唔齊，請再撳一次「首次上載全部資料」。':''))}
  },
  async pullReplace(){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    if(!confirm('會用雲端資料覆蓋呢部機（未上載嘅改動會冇咗，建議先匯出備份）。確定？'))return;
    try{const info=await this.serverInfo();let st,serverTime;
      if(info.paging){const got={};const t=await this.fetchPaged('',async(k,rows)=>{got[k]=rows});st={...got,categories:t.categories,meta:t.meta};serverTime=t.serverTime}
      else{this.progress('下載緊全部資料（舊版雲端程式要一次過下載，可能要等一陣）…');
        let j;try{j=await this.call('GET',null,{action:'pull'},180000)}catch(e){if(['BODY','TRUNC','TIMEOUT','EMPTY'].includes(e.code))throw syncErr('OLDBIG');throw e}
        st=j.state;serverTime=j.serverTime}
      const ns={...S};
      Object.keys(TABLES).forEach(k=>ns[k]=st[k]||[]);if(Array.isArray(st.categories))ns.categories=st.categories;
      if(st.meta){Object.assign(ns,st.meta.values||{});ns.metaUpdatedAt=st.meta.updatedAt}
      S=ns;normalize();save();this.setQ([]);this.setCfg({serverTime});this.progress('');this.status(true);settingsOpen=false;closeDlgSafe($('#dlg'));rerender();alert('已由雲端下載')}
    catch(e){this.progress('');this.status(false,this.errMsg(e));alert('下載失敗：'+this.errMsg(e))}
  }
};

/* ---------- 設定／匯出匯入 ---------- */
async function forceAppRefresh(){
  try{
    if(confirm('會清 App 快取同重新載入最新版。本機家計簿資料唔會刪（除非你之前未同步又清咗網站資料）。繼續？')){
      if('caches' in window){const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)))}
      if('serviceWorker' in navigator){const regs=await navigator.serviceWorker.getRegistrations();await Promise.all(regs.map(r=>r.unregister()))}
      location.replace(location.pathname+location.search+location.hash+(location.search||location.hash?'&':'?')+'_='+Date.now());
    }
  }catch(e){alert('刷新失敗，請用 Safari 開網站再加入主畫面。');location.reload()}
}
function settings(){
  const f=$('#dlgForm'), c=Sync.cfg();
  tabBeforeSettings=tab;
  settingsOpen=true;
  f.innerHTML=`<h3 style="margin:0">設定／備份</h3>
  <div class="sub">App 程式版本：${APP_VER}（宅四狀態含「想要」· 首次出貨欄；要 v32+）</div>
  <button type="button" class="primary" id="forceRefreshBtn">🔃 強制刷新 App（拎最新版）</button>
  <button type="button" class="primary" id="expBtn">⬇️ 匯出 JSON 備份</button>
  <button type="button" id="impBtn">⬆️ 匯入 JSON</button>
  <button type="button" id="rstBtn" style="color:var(--warn)">↺ 重設為種子資料（會清走本機改動）</button>
  <div class="sub">資料存喺呢部機嘅瀏覽器。換機／清瀏覽器資料前記得匯出。<br>種子：${esc(S.source||'')} · ${esc(S.generatedAt||'')}<br>
  共 ${live(S.transactions).length} 筆交易${S.historyImport?'（包括舊檔 '+S.historyImport.tx+' 筆，'+esc(S.historyImport.range)+'）':''}${storageNote?'<br>'+esc(storageNote):''}</div>
  <h3 style="margin:8px 0 0">儲備安全線</h3>
  <label>流動儲備安全線（HKD）<input id="rFloor" type="number" min="0" step="1000" value="${reserveFloor()}" placeholder="預設 max(10000, 每月固定)"></label>
  <div class="sub">低過呢條線會喺各頁顯示警告，同每日最多一次通知。清空再儲存＝用預設（約一個月固定支出，下限 $10,000）。而家預設計出：${fmt0(Math.max(10000,Math.round((()=>{try{return n(fxStats().total)}catch(_){return 0}})())))}。</div>
  <button type="button" id="rFloorSave">💾 儲存儲備安全線</button>
  <h3 style="margin:8px 0 0">☁︎ 雲端同步（Google Sheets）</h3>
  <label>同步網址（Apps Script /exec）<input id="syUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url||'')}"></label>
  <label>密碼（token）<input id="syTok" type="password" autocomplete="off" value="${esc(c.token||'')}"></label>
  <div class="sub">網址同密碼只會存喺呢部機，唔會上載去 GitHub。唔設定都可以照用（純本機）。</div>
  <button type="button" id="sySave">💾 儲存同步設定</button>
  <button type="button" class="primary" id="syNow">🔄 立即同步</button>
  <button type="button" id="syPush">⬆️ 首次上載全部資料（覆蓋雲端）</button>
  <button type="button" id="syPull">⬇️ 由雲端下載覆蓋本機</button>
  <div class="sub" id="syncStatus">${Sync.on()?Sync.statusHtml():'未設定'}</div>
  <div class="actions"><button type="button" id="syClose" formnovalidate>關閉</button></div>`;
  const dlg=$('#dlg');dlg.onclose=null;
  const finishSettingsClose=()=>{
    settingsOpen=false;
    const prev=tabBeforeSettings;
    tabBeforeSettings=null;
    // 關閉後唔好留喺被 ghost-click 誤觸嘅「每月固定支出」；返回開設定前嗰個 tab／總覽
    if(prev&&TITLES[prev]&&tab!==prev){
      tab=prev;history.replaceState(null,'','#'+prev);
    }
    const pending=syncRerenderPending;syncRerenderPending=0;
    if(pending)rerender(pending===2);
    else rerender(1);
  };
  dlg.onclose=()=>{finishSettingsClose()};
  const closeSettings=e=>{if(e){e.preventDefault();e.stopPropagation()}
    settingsOpen=false; // 允許 close 期間嘅邏輯唔再 defer
    closeDlgSafe(dlg);
  };
  $('#syClose').onclick=closeSettings;
  $('#forceRefreshBtn').onclick=()=>forceAppRefresh();
  $('#expBtn').onclick=()=>{const b=new Blob([JSON.stringify(S,null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`家計簿備份_${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)};
  $('#impBtn').onclick=()=>$('#importFile').click();
  $('#rstBtn').onclick=async()=>{if(confirm('確定重設？本機改動會消失（建議先匯出）')){localStorage.removeItem(KEY);localStorage.removeItem(IDB_FLAG);S=null;settingsOpen=false;dlg.onclose=null;closeDlgSafe(dlg);await load()}};
  $('#rFloorSave').onclick=()=>{const v=$('#rFloor').value.trim();
    if(v===''||isNaN(+v)){try{localStorage.removeItem('hhledger.reserveFloor')}catch(_){}toast('已重設為預設安全線（約一個月固定支出，下限 $10,000）')}
    else{lsSet('hhledger.reserveFloor',String(Math.max(0,Math.round(+v))));toast('已儲存儲備安全線 '+fmt0(+v))}
    updateReserveBanner();checkReserveNotify()};
  const saveCfg=()=>{const url=$('#syUrl').value.trim(),token=$('#syTok').value.trim(),c=Sync.cfg();
    // 網址／密碼有改先重新全量同步；唔係每次撳「立即同步」都下載晒成個資料庫
    Sync.setCfg(url!==c.url||token!==c.token?{url,token,serverTime:'',serverVersion:0}:{url,token});return !!(url&&token)};
  $('#sySave').onclick=()=>{saveCfg();$('#syncStatus').innerHTML=Sync.on()?'已儲存。撳「立即同步」試吓。':'已清除同步設定（純本機模式）';Sync.badge()};
  $('#syNow').onclick=async()=>{saveCfg();$('#syncStatus').textContent='同步緊…';await Sync.syncNow(false);const el=$('#syncStatus');if(el)el.innerHTML=Sync.statusHtml()};
  $('#syPush').onclick=async()=>{saveCfg();$('#syncStatus').textContent='上載緊…';await Sync.pushAll();const el=$('#syncStatus');if(el)el.innerHTML=Sync.statusHtml()};
  $('#syPull').onclick=async()=>{saveCfg();await Sync.pullReplace()};
  dlg.returnValue='';
  dlg.showModal();
}
$('#menuBtn').onclick=settings;
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{const next=b.dataset.tab;if(next==='wish'&&tab!=='wish')wishAnchorOnOpen=true;tab=next;history.replaceState(null,'','#'+tab);rerender()});
{const h=location.hash.slice(1);if(TITLES[h]){tab=h;if(h==='wish')wishAnchorOnOpen=true}}
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').then(reg=>{
    reg.update().catch(()=>{});
    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;location.reload()});
  }).catch(()=>{});
}
load();
