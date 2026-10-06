'use strict';
const KEY='hhledger.v1', SYNC_KEY='hhledger.sync', SYNCQ_KEY='hhledger.syncq';
const TX_TYPES=['支出','收入','轉帳','分期還款'];
const WISH_ST=['想買','已訂','已付訂金','已買'];
let S=null, tab='overview', txMonth=null, wishFilter='全部', ovMonth=null, ovYear=null, txLimit=300, txQuery='', arKind='summary', arId='';
const $=s=>document.querySelector(s);
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

/* ---------- 儲存（localStorage；太大就自動轉 IndexedDB） ---------- */
const IDB_FLAG=KEY+'.idb';
function idb(){return new Promise((ok,no)=>{const r=indexedDB.open('hhledger',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})}
async function idbSet(k,v){const db=await idb();return new Promise((ok,no)=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>ok();t.onerror=()=>no(t.error)})}
async function idbGet(k){const db=await idb();return new Promise((ok,no)=>{const t=db.transaction('kv','readonly');const q=t.objectStore('kv').get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)})}
let storageNote='';
function save(){
  const js=JSON.stringify(S);
  if(!localStorage.getItem(IDB_FLAG)){
    try{localStorage.setItem(KEY,js);storageNote='';return}
    catch(e){/* 超出 localStorage 上限 → IndexedDB */}
  }
  idbSet(KEY,js).then(()=>{try{localStorage.removeItem(KEY);localStorage.setItem(IDB_FLAG,'1')}catch(_){}
    storageNote='資料量大，已改用 IndexedDB 儲存（仍然只喺呢部機）'}).catch(()=>alert('儲存失敗：部機儲存空間唔夠，請先匯出備份'));
}
async function readStored(){
  if(localStorage.getItem(IDB_FLAG)){try{const v=await idbGet(KEY);if(v)return v}catch(e){}}
  return localStorage.getItem(KEY);
}
async function load(){
  const raw=await readStored();
  if(raw){try{S=JSON.parse(raw)}catch(e){S=null}}
  if(!S){S=await (await fetch('data/seed.json',{cache:'no-store'})).json();save()}
  normalize();
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
  ['accounts','transactions','installments','wishlist','categories','salary','forecast','bonus','archive','loans'].forEach(k=>{if(!Array.isArray(S[k]))S[k]=[]});
  if(!S.burden)S.burden={};
}

/* ---------- 計算 ---------- */
const cards=()=>live(S.accounts).filter(a=>a.stmtBal!=null);
const exposure=a=>a.totalAcct!=null?a.totalAcct:n(a.stmtBal)+n(a.unposted);
const afterPay=a=>exposure(a)-n(a.paidAfterStmt);
const burdenList=()=>live(S.installments).filter(i=>i.countInBurden&&!/已完/.test(i.status||''));
/* 每月分期負擔：有貸款 tab 資料就以貸款為準（唔會同分期 tab 重複計） */
const burden=()=>loanMode()?activeLoans().reduce((s,l)=>s+n(l.monthly),0):burdenList().reduce((s,i)=>s+n(i.monthly),0);
const burdenParts=()=>{if(!loanMode())return burdenList().map(i=>[String(i.card||'').split(/[ （]/)[0],n(i.monthly)]);
  const g={};activeLoans().forEach(l=>{const k=String(l.card||l.lender||'其他').split(/[ （]/)[0];g[k]=(g[k]||0)+n(l.monthly)});return Object.entries(g).sort((a,b)=>b[1]-a[1])};
const receivable=()=>live(S.wishlist).filter(w=>!w.receivedBack).reduce((s,w)=>s+n(w.receivable),0);
const depositsHeld=()=>live(S.wishlist).filter(w=>w.status==='已付訂金').reduce((s,w)=>s+n(w.deposit),0);
const isSpend=t=>t.type==='支出'||t.type==='分期還款';
const isRefund=t=>t.type==='收入'&&t.category==='退款／代付收回';
const OFFSET_SUB='轉做分期（抵銷全數）';
const isOffset=t=>isRefund(t)||(t.type==='轉帳'&&t.sub===OFFSET_SUB);
const monthTx=m=>live(S.transactions).filter(t=>(t.date||'').startsWith(m));
const sheetOf=t=>(t.src||'').replace(/^xlsx:/,'').split('!')[0];

/* ---------- 畫面 ---------- */
const TITLES={overview:'總覽',tx:'記帳',accounts:'帳戶',inst:'分期',loan:'貸款',wish:'Wishlist',pay:'人工／預測'};
function render(){
  $('#title').textContent=TITLES[tab];
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('#view').innerHTML=({overview:vOverview,tx:vTx,accounts:vAccounts,inst:vInst,loan:vLoan,wish:vWish,pay:vPay})[tab]();
  Sync.badge();
  if(tab==='loan')loanAnimate();
}
function rerender(keepScroll){const y=window.scrollY;render();window.scrollTo(0,keepScroll?y:0)}

function vOverview(){
  const mt=monthTx(ovMonth), spend=mt.filter(isSpend).reduce((s,t)=>s+n(t.amount),0);
  const inc=mt.filter(t=>t.type==='收入').reduce((s,t)=>s+n(t.amount),0);
  const byCat={};mt.filter(isSpend).forEach(t=>byCat[t.category]=(byCat[t.category]||0)+n(t.amount));
  const cs=cards(), exp=cs.reduce((s,a)=>s+exposure(a),0), aft=cs.reduce((s,a)=>s+afterPay(a),0);
  const warns=cs.filter(a=>a.dueDate&&a.dueDate<today()&&n(a.paidAfterStmt)<n(a.minPay))
    .map(a=>`⚠️ ${esc(a.name)}：到期日 ${a.dueDate} 已過，月結單後只還 ${fmt0(a.paidAfterStmt)}，低過最低還款 ${fmt(a.minPay)}（差 ${fmt(n(a.minPay)-n(a.paidAfterStmt))}）。`);
  const soon=cs.filter(a=>a.dueDate&&a.dueDate>=today()).map(a=>`${esc(a.name)} 到期 ${a.dueDate}（最低 ${fmt(a.minPay)}，已還 ${fmt0(a.paidAfterStmt)}）`);
  return `
  ${warns.map(w=>`<div class="warn">${w}</div>`).join('')}
  <div class="month"><span class="sub">月份</span><input type="month" value="${ovMonth}" onchange="ovMonth=this.value;render()"></div>
  <div class="grid2">
    <div class="card"><h2>本月支出</h2><div class="big">${fmt0(spend)}</div><div class="sub">${mt.length} 筆 · 收入 ${fmt0(inc)}</div></div>
    <div class="card"${loanMode()?` onclick="tab='loan';render()"`:''}><h2>每月分期負擔</h2><div class="big">${fmt0(burden())}</div><div class="sub">${burdenParts().map(([k,v])=>esc(k)+' '+fmt0(v)).join(' · ')}${loanMode()&&loanStats().last?`<br>🏁 還清日 ${ym(loanStats().last)} →`:''}</div></div>
  </div>
  <div class="card"><h2>Citi + HSBC 卡數總額（月結單日，含未入帳分期）</h2>
    <div class="big neg">${fmt0(exp)}</div>
    <div class="sub">扣月結單後還款 ≈ <b>${fmt0(aft)}</b>（未計新簽帳及利息，只係估算）</div>
    ${cs.map(a=>`<div class="row"><div class="l">${esc(a.name)}<small class="note">結欠 ${fmt(a.stmtBal)} + 未入帳分期 ${fmt(a.unposted)}${a.totalAcct!=null?'（Total Acct '+fmt(a.totalAcct)+'）':''} · 已還 ${fmt0(a.paidAfterStmt)}</small></div><div class="r">${fmt0(exposure(a))}<small class="note">→ ${fmt0(afterPay(a))}</small></div></div>`).join('')}
    ${soon.length?`<div class="sub" style="margin-top:6px">📅 ${soon.join('<br>📅 ')}</div>`:''}
  </div>
  <div class="grid2">
    <div class="card"><h2>partner 應收</h2><div class="big pos">${fmt0(receivable())}</div><div class="sub">代付待收</div></div>
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
  if(q) list=list.filter(t=>[t.desc,t.sub,t.category,t.account,t.notes,t.tag,t.src].some(x=>String(x||'').toLowerCase().includes(q)));
  list=list.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const total=list.filter(isSpend).reduce((s,t)=>s+n(t.amount),0);
  const shown=list.slice(0,txLimit);
  return `<div class="month"><input type="month" value="${txMonth}" onchange="txMonth=this.value;txLimit=300;render()">
    <button onclick="txMonth='';txLimit=300;render()">全部</button><span class="sub">${list.length} 筆 · 支出 ${fmt0(total)}</span></div>
  <div class="month"><input type="search" placeholder="搜尋（描述／分類／帳戶／Sep-25…）" value="${esc(txQuery)}" onchange="txQuery=this.value;txLimit=300;render()"></div>
  <div class="card">${shown.length?shown.map(t=>`<div class="row" onclick="editTx('${esc(t.id)}')"><div class="l">${esc(t.desc||t.sub||t.category)}
    <small class="note">${t.date}${t.dm?'（只知月份）':''} · ${esc(t.type)} · ${esc(t.category)} · ${esc(t.account)}${t.tag?' · '+esc(t.tag):''}${t.hist?' · 舊檔 '+esc(sheetOf(t)):''}</small></div>
    <div class="r ${t.type==='收入'?'pos':''}">${t.type==='收入'?'+':''}${fmt(t.amount)}</div></div>`).join(''):'<div class="sub">呢個月未有紀錄。撳右下角 ＋ 記一筆。</div>'}
    ${list.length>txLimit?`<div class="actions"><button onclick="txLimit+=300;rerender(1)">顯示多 300 筆（仲有 ${list.length-txLimit} 筆）</button></div>`:''}</div>
  <button class="fab" onclick="editTx()">＋</button>`;
}

function vAccounts(){
  return live(S.accounts).map(a=>{
    const isCard=a.stmtBal!=null;
    const bal=a.id==='recv'?receivable():a.balance;
    return `<div class="card" onclick="editAcct('${esc(a.id)}')"><h2>${esc(a.name)} <span class="pill">${esc(a.type)}</span>${a.hist?' <span class="pill">舊檔</span>':''}</h2>
    ${isCard?`<div class="big neg">${fmt(exposure(a))}</div>
      <div class="row"><div class="l">月結單結欠（${a.stmtDate}）</div><div class="r">${fmt(a.stmtBal)}</div></div>
      <div class="row"><div class="l">未入帳分期</div><div class="r">${fmt(a.unposted)}</div></div>
      <div class="row"><div class="l">最低還款 · 到期 ${a.dueDate}</div><div class="r">${fmt(a.minPay)}</div></div>
      <div class="row"><div class="l">月結單後已還</div><div class="r">${fmt(a.paidAfterStmt)} ${n(a.paidAfterStmt)<n(a.minPay)?'<span class="pill red">低過最低</span>':'<span class="pill ok">已達最低</span>'}</div></div>
      <div class="row"><div class="l">估算餘額（扣已還）</div><div class="r"><b>${fmt(afterPay(a))}</b></div></div>
      ${a.creditLimit?`<div class="sub">信用額 ${fmt0(a.creditLimit)} · 使用率 ${(exposure(a)/a.creditLimit*100).toFixed(0)}%</div><div class="bar"><i style="width:${Math.min(100,exposure(a)/a.creditLimit*100)}%"></i></div>`:''}`
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

function vWish(){
  const W=live(S.wishlist);
  const list=W.filter(w=>wishFilter==='全部'||w.status===wishFilter);
  const cnt=s=>W.filter(w=>s==='全部'||w.status===s).length;
  return `<div class="chips">${['全部',...WISH_ST].map(s=>`<button class="${s===wishFilter?'on':''}" onclick="wishFilter='${s}';render()">${s} ${cnt(s)}</button>`).join('')}</div>
  <div class="grid2"><div class="card"><h2>已付訂金</h2><div class="big">${fmt0(depositsHeld())}</div></div>
  <div class="card"><h2>partner 應收</h2><div class="big pos">${fmt0(receivable())}</div></div></div>
  <div class="card">${list.length?list.map(w=>`<div class="row" onclick="editWish('${esc(w.id)}')"><div class="l">${esc(w.item)}
    <span class="pill ${w.status==='已買'?'ok':w.status==='已付訂金'?'amber':''}">${esc(w.status)}</span>
    ${n(w.receivable)?`<span class="pill ${w.receivedBack?'ok':'red'}">${w.receivedBack?'已收返':'應收 '+fmt0(w.receivable)}</span>`:''}
    <small class="note">${esc(w.store)}${w.orderRef?' · '+esc(w.orderRef):''}${w.forWhom?' · 為 '+esc(w.forWhom):''}${w.date?' · '+w.date:''}${w.notes?'<br>'+esc(w.notes):''}</small></div>
    <div class="r">${w.price!=null?'售價 '+fmt0(w.price)+'<br>':''}${n(w.deposit)?'訂金 '+fmt0(w.deposit)+'<br>':''}${n(w.finalPaid)?'已付 '+fmt0(w.finalPaid):''}</div></div>`).join(''):'<div class="sub">冇項目</div>'}</div>
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
    if(d.opts) inp=`<select name="${d.k}">${[...new Set([...(d.opts),...(val&&!d.opts.includes(val)?[val]:[])])].map(o=>`<option ${o==val?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
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
      if(d.t==='check') v=!!v; else if(d.t==='number') v=(v===''||v==null)?null:Number(v);
      obj[d.k]=v});
    obj.updatedAt=stamp(obj.updatedAt);
    onSave(obj);save();rerender(1);
  };
  dlg.returnValue='';dlg.showModal();
}
/* 新增／修改／刪除（刪除＝墓碑 deleted:true，方便同步合併） */
function upsertLocal(key,o,isNew){if(isNew)S[key].push(o);Sync.queue(key,o)}
function tombstone(key,id){const o=S[key].find(x=>x.id===id);if(!o)return;
  const t={id:o.id,deleted:true,updatedAt:stamp(o.updatedAt)};S[key][S[key].indexOf(o)]=t;Sync.queue(key,t)}
const acctNames=()=>[...live(S.accounts).map(a=>a.name),'TBD（付款帳戶待確認）'];
function editTx(id){
  const t=id?S.transactions.find(x=>x.id===id):{id:uid('t'),date:today(),type:'支出',category:'餐飲',account:'Citibank VISA',amount:null};
  form(id?'修改紀錄':'記一筆',[
    {k:'date',l:'日期',t:'date',req:1},{k:'type',l:'類型',opts:TX_TYPES},{k:'amount',l:'金額（HKD）',t:'number',req:1},
    {k:'category',l:'分類',opts:S.categories},{k:'sub',l:'細項'},{k:'account',l:'帳戶',opts:acctNames()},
    {k:'desc',l:'描述'},{k:'counterparty',l:'對方／商戶'},{k:'tag',l:'標籤'},{k:'notes',l:'備註',t:'area'}],
    t,o=>{if(o.dm&&o.date&&!o.date.endsWith('-01'))delete o.dm;upsertLocal('transactions',o,!id)},id?()=>tombstone('transactions',id):null);
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
  const w=id?S.wishlist.find(x=>x.id===id):{id:uid('w'),item:'',status:'想買',deposit:0,finalPaid:0,receivable:0,date:today()};
  form(id?'修改項目':'新增 Wishlist',[{k:'item',l:'項目',req:1},{k:'status',l:'狀態',opts:WISH_ST},{k:'maker',l:'廠商'},
    {k:'price',l:'售價',t:'number'},{k:'deposit',l:'已付訂金',t:'number'},{k:'finalPaid',l:'已付尾數／全數',t:'number'},
    {k:'store',l:'店舖'},{k:'orderRef',l:'單號'},{k:'forWhom',l:'為誰買'},{k:'receivable',l:'應收（代付）',t:'number'},
    {k:'receivedBack',l:'已收返應收',t:'check'},{k:'date',l:'日期',t:'date'},{k:'notes',l:'備註',t:'area'}],
    w,o=>upsertLocal('wishlist',o,!id),id?()=>tombstone('wishlist',id):null);
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
  ${rev.length?`<div class="card boss"><h2>👹 大魔王：循環卡數（冇固定期數，唔計入還清日同每月供款）</h2>${rev.map(l=>{const a=l.acctId&&live(S.accounts).find(x=>x.id===l.acctId);const bal=a&&a.stmtBal!=null?a.stmtBal:l.balance;const asOf=a&&a.stmtDate?a.stmtDate:l.balanceAsOf;
      return `<div class="loan" onclick="editLoan('${esc(l.id)}')"><div class="lh"><span class="li">👹</span><div class="lt"><b>${esc(l.name)}</b><small>結欠 ${bal!=null?fmt(bal):unk}${asOf?'（月結單 '+esc(asOf)+'）':''}${l.minPay!=null?' · 最低還款 '+fmt(l.minPay):''}</small></div></div>
        <div class="lfoot">${rateBadge(l)}</div><div class="quip">${lApr(l)!=null&&st.avgApr?`年利率 ${n(l.rate)}%，大約係你啲分期平均（${st.avgApr.toFixed(1)}%）嘅 ${Math.round(lApr(l)/st.avgApr)} 倍 — 有閒錢應該先打呢隻大佬`:'利息最貴，有閒錢先打佢'}</div>${l.notes?`<small class="note">${esc(l.notes)}</small>`:''}</div>`}).join('')}</div>`:''}
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

/* ---------- 雲端同步（Google Sheets，Apps Script web app） ---------- */
const TABLES={transactions:'Transactions',accounts:'Accounts',installments:'Installments',wishlist:'Wishlist',salary:'Salary',forecast:'Forecast',bonus:'Bonus',archive:'Archive',loans:'Loans'};
const Sync={
  cfg(){try{return JSON.parse(localStorage.getItem(SYNC_KEY)||'{}')}catch(_){return {}}},
  setCfg(p){const c={...this.cfg(),...p};localStorage.setItem(SYNC_KEY,JSON.stringify(c));return c},
  on(){const c=this.cfg();return !!(c.url&&c.token)},
  q(){try{return JSON.parse(localStorage.getItem(SYNCQ_KEY)||'[]')}catch(_){return []}},
  setQ(q){try{localStorage.setItem(SYNCQ_KEY,JSON.stringify(q));return true}catch(e){this.status(false,'排隊清單太大，存唔落本機。請撳「首次上載全部資料」。');return false}},
  async sendRecs(by){for(const [k,recs] of Object.entries(by)){for(let i=0;i<recs.length;i+=1500) await this.call('POST',{action:'upsert',table:TABLES[k],records:recs.slice(i,i+1500)})}},
  busy:false,
  queue(key,rec){
    if(!this.on()||!TABLES[key]) return;
    const q=this.q().filter(x=>!(x.t===key&&x.r.id===rec.id)); q.push({t:key,r:rec}); if(!this.setQ(q))return;
    clearTimeout(this._tm); this._tm=setTimeout(()=>this.flush(),800);
  },
  async call(method,body,params){
    const c=this.cfg(); let url=c.url;
    const opt={method,redirect:'follow'};
    if(method==='GET'){const u=new URL(url);u.searchParams.set('token',c.token);Object.entries(params||{}).forEach(([k,v])=>u.searchParams.set(k,v));url=u.toString()}
    else{opt.headers={'Content-Type':'text/plain;charset=utf-8'};opt.body=JSON.stringify({token:c.token,...body})}
    let res;
    try{res=await fetch(url,opt)}catch(e){throw new Error('OFFLINE')}
    const txt=await res.text(); let j;
    try{j=JSON.parse(txt)}catch(_){throw new Error(/<html/i.test(txt)?'雲端回咗網頁而唔係資料：檢查同步網址（要用 Deploy 之後嘅 /exec 網址，存取權限要「Anyone」）':'雲端回應格式唔啱')}
    if(!j.ok) throw new Error(j.error==='unauthorized'?'密碼（token）唔啱，雲端拒絕咗':('雲端錯誤：'+(j.error||'未知')));
    return j;
  },
  errMsg(e){return e.message==='OFFLINE'?'連唔到雲端（可能冇網）。改動已經排咗隊，有網會自動再試。':e.message},
  status(ok,msg){const c=this.setCfg(ok?{lastSync:nowISO(),lastError:''}:{lastError:msg,lastErrorAt:nowISO()});this.badge();const el=$('#syncStatus');if(el)el.innerHTML=this.statusHtml()},
  statusHtml(){const c=this.cfg(),q=this.q().length;
    return `${c.lastSync?'上次同步：'+new Date(c.lastSync).toLocaleString('zh-HK',{hour12:false}):'未同步過'}${q?` · 排緊隊：${q} 項`:''}${c.lastError?`<br><span style="color:var(--warn)">⚠️ ${esc(c.lastError)}</span>`:''}`},
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
  mergeState(local,remote,full){
    const pushes={};
    for(const k of Object.keys(TABLES)){
      if(full){const r=this.mergeTable(local[k],remote[k]);local[k]=r.out;if(r.push.length)pushes[k]=r.push}
      else{ // 增量：只合併雲端有變嘅紀錄
        const m=new Map((local[k]||[]).map(r=>[r.id,r]));
        (remote[k]||[]).forEach(r=>{const l=m.get(r.id);if(!l||(r.updatedAt||'')>=(l.updatedAt||''))m.set(r.id,r)});local[k]=[...m.values()];
      }
    }
    if(Array.isArray(remote.categories)){const set=new Set(remote.categories);local.categories=[...remote.categories,...(local.categories||[]).filter(c=>!set.has(c))]}
    if(remote.meta&&(remote.meta.updatedAt||'')>(local.metaUpdatedAt||'')){Object.assign(local,remote.meta.values||{});local.metaUpdatedAt=remote.meta.updatedAt}
    return pushes;
  },
  async pull(full){
    const c=this.cfg(); const params={action:'pull'}; if(!full&&c.serverTime)params.since=c.serverTime;
    const j=await this.call('GET',null,params);
    const pushes=this.mergeState(S,j.state,!params.since);
    normalize(); save(); this.setCfg({serverTime:j.serverTime});
    // 本機有、雲端冇（或者本機較新）嘅紀錄：直接由記憶體上載（唔塞入排隊清單，費事爆 localStorage）
    const cnt=Object.values(pushes).reduce((s,a)=>s+a.length,0);
    if(cnt){try{await this.sendRecs(pushes)}catch(e){
      if(cnt<=500){for(const [k,recs] of Object.entries(pushes)) recs.forEach(r=>this.queue(k,r))}
      else throw new Error(`有 ${cnt} 筆本機紀錄未上載（${this.errMsg(e)}）。有網時撳「立即同步」或「首次上載全部資料」。`)}}
    return j;
  },
  async syncNow(full){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    try{const a=await this.flush();await this.pull(full);const b=await this.flush();if(a&&b)this.status(true);rerender(1)}
    catch(e){this.status(false,this.errMsg(e))}
  },
  async auto(){
    if(!this.on()) return;
    await this.syncNow(false);
    window.addEventListener('online',()=>this.flush());
    setInterval(()=>this.flush(),60000);
  },
  metaOf(st){const v={};['version','burden','source','generatedAt','historyImport'].forEach(k=>{if(st[k]!==undefined)v[k]=st[k]});return {values:v,updatedAt:st.metaUpdatedAt||nowISO()}},
  async pushAll(){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    if(!confirm('會用呢部機嘅全部資料取代雲端 Google Sheet 入面嘅資料。確定？'))return;
    try{const st={};Object.keys(TABLES).forEach(k=>st[k]=S[k]);st.categories=S.categories;st.meta=this.metaOf(S);
      const j=await this.call('POST',{action:'push',state:st});this.setQ([]);this.setCfg({serverTime:j.serverTime});this.status(true);alert('上載完成：'+(j.counts?Object.entries(j.counts).map(([k,v])=>k+' '+v).join('、'):''))}
    catch(e){this.status(false,this.errMsg(e));alert('上載失敗：'+this.errMsg(e))}
  },
  async pullReplace(){
    if(!this.on()){alert('未設定同步網址同密碼');return}
    if(!confirm('會用雲端資料覆蓋呢部機（未上載嘅改動會冇咗，建議先匯出備份）。確定？'))return;
    try{const j=await this.call('GET',null,{action:'pull'});const st=j.state;const ns={...S};
      Object.keys(TABLES).forEach(k=>ns[k]=st[k]||[]);if(Array.isArray(st.categories))ns.categories=st.categories;
      if(st.meta){Object.assign(ns,st.meta.values||{});ns.metaUpdatedAt=st.meta.updatedAt}
      S=ns;normalize();save();this.setQ([]);this.setCfg({serverTime:j.serverTime});this.status(true);$('#dlg').close();rerender();alert('已由雲端下載')}
    catch(e){this.status(false,this.errMsg(e));alert('下載失敗：'+this.errMsg(e))}
  }
};

/* ---------- 設定／匯出匯入 ---------- */
function settings(){
  const f=$('#dlgForm'), c=Sync.cfg();
  f.innerHTML=`<h3 style="margin:0">設定／備份</h3>
  <button type="button" class="primary" id="expBtn">⬇️ 匯出 JSON 備份</button>
  <button type="button" id="impBtn">⬆️ 匯入 JSON</button>
  <button type="button" id="rstBtn" style="color:var(--warn)">↺ 重設為種子資料（會清走本機改動）</button>
  <div class="sub">資料存喺呢部機嘅瀏覽器。換機／清瀏覽器資料前記得匯出。<br>種子：${esc(S.source||'')} · ${esc(S.generatedAt||'')}<br>
  共 ${live(S.transactions).length} 筆交易${S.historyImport?'（包括舊檔 '+S.historyImport.tx+' 筆，'+esc(S.historyImport.range)+'）':''}${storageNote?'<br>'+esc(storageNote):''}</div>
  <h3 style="margin:8px 0 0">☁︎ 雲端同步（Google Sheets）</h3>
  <label>同步網址（Apps Script /exec）<input id="syUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url||'')}"></label>
  <label>密碼（token）<input id="syTok" type="password" autocomplete="off" value="${esc(c.token||'')}"></label>
  <div class="sub">網址同密碼只會存喺呢部機，唔會上載去 GitHub。唔設定都可以照用（純本機）。</div>
  <button type="button" id="sySave">💾 儲存同步設定</button>
  <button type="button" class="primary" id="syNow">🔄 立即同步</button>
  <button type="button" id="syPush">⬆️ 首次上載全部資料（覆蓋雲端）</button>
  <button type="button" id="syPull">⬇️ 由雲端下載覆蓋本機</button>
  <div class="sub" id="syncStatus">${Sync.on()?Sync.statusHtml():'未設定'}</div>
  <div class="actions"><button value="cancel">關閉</button></div>`;
  const dlg=$('#dlg');dlg.onclose=null;
  $('#expBtn').onclick=()=>{const b=new Blob([JSON.stringify(S,null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`家計簿備份_${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)};
  $('#impBtn').onclick=()=>$('#importFile').click();
  $('#rstBtn').onclick=async()=>{if(confirm('確定重設？本機改動會消失（建議先匯出）')){localStorage.removeItem(KEY);localStorage.removeItem(IDB_FLAG);S=null;dlg.close();await load()}};
  const saveCfg=()=>{const url=$('#syUrl').value.trim(),token=$('#syTok').value.trim();Sync.setCfg({url,token,serverTime:''});return !!(url&&token)};
  $('#sySave').onclick=()=>{saveCfg();$('#syncStatus').innerHTML=Sync.on()?'已儲存。撳「立即同步」試吓。':'已清除同步設定（純本機模式）';Sync.badge()};
  $('#syNow').onclick=async()=>{saveCfg();$('#syncStatus').textContent='同步緊…';await Sync.syncNow(false);$('#syncStatus').innerHTML=Sync.statusHtml()};
  $('#syPush').onclick=async()=>{saveCfg();$('#syncStatus').textContent='上載緊…';await Sync.pushAll();$('#syncStatus').innerHTML=Sync.statusHtml()};
  $('#syPull').onclick=async()=>{saveCfg();await Sync.pullReplace()};
  dlg.showModal();
}
$('#importFile').onchange=e=>{const file=e.target.files[0];if(!file)return;const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);if(!d.accounts||!d.transactions)throw 0;S=d;normalize();save();$('#dlg').close();render();alert('匯入成功'+(Sync.on()?'。如要放上雲端，去設定撳「首次上載全部資料」。':''))}catch(_){alert('檔案格式唔啱')}e.target.value=''};r.readAsText(file)};
$('#menuBtn').onclick=settings;
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;history.replaceState(null,'','#'+tab);rerender()});
{const h=location.hash.slice(1);if(TITLES[h])tab=h;}
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
load();
