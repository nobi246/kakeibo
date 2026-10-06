'use strict';
const KEY='hhledger.v1';
const TX_TYPES=['支出','收入','轉帳','分期還款'];
const WISH_ST=['想買','已訂','已付訂金','已買'];
let S=null, tab='overview', txMonth=null, wishFilter='全部', ovMonth=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>typeof x==='number'&&isFinite(x)?x:0;
const fmt=(x,d=2)=>x==null||x===''||isNaN(x)?'TBD':'$'+Number(x).toLocaleString('en-HK',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt0=x=>fmt(x,0);
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const save=()=>localStorage.setItem(KEY,JSON.stringify(S));

async function load(){
  const raw=localStorage.getItem(KEY);
  if(raw){try{S=JSON.parse(raw)}catch(e){S=null}}
  if(!S){S=await (await fetch('data/seed.json',{cache:'no-store'})).json();save()}
  txMonth=ovMonth=today().slice(0,7);
  render();
}

/* ---------- 計算 ---------- */
const cards=()=>S.accounts.filter(a=>a.stmtBal!=null);
const exposure=a=>a.totalAcct!=null?a.totalAcct:n(a.stmtBal)+n(a.unposted);
const afterPay=a=>exposure(a)-n(a.paidAfterStmt);
const burdenList=()=>S.installments.filter(i=>i.countInBurden&&!/已完/.test(i.status||''));
const burden=()=>burdenList().reduce((s,i)=>s+n(i.monthly),0);
const receivable=()=>S.wishlist.filter(w=>!w.receivedBack).reduce((s,w)=>s+n(w.receivable),0);
const depositsHeld=()=>S.wishlist.filter(w=>w.status==='已付訂金').reduce((s,w)=>s+n(w.deposit),0);
const isSpend=t=>t.type==='支出'||t.type==='分期還款';
const monthTx=m=>S.transactions.filter(t=>(t.date||'').startsWith(m));

/* ---------- 畫面 ---------- */
const TITLES={overview:'總覽',tx:'記帳',accounts:'帳戶',inst:'分期',wish:'Wishlist'};
function render(){
  $('#title').textContent=TITLES[tab];
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('#view').innerHTML=({overview:vOverview,tx:vTx,accounts:vAccounts,inst:vInst,wish:vWish})[tab]();
  window.scrollTo(0,0);
}

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
    <div class="card"><h2>每月分期負擔</h2><div class="big">${fmt0(burden())}</div><div class="sub">${burdenList().map(i=>esc(i.card.split(/[ （]/)[0])+' '+fmt0(i.monthly)).join(' · ')}</div></div>
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
  <div class="card"><h2>本月分類支出</h2>${Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="row"><div class="l">${esc(c)}</div><div class="r">${fmt(v)}</div></div>`).join(''):'<div class="sub">本月未有支出紀錄 — 去「記帳」加一筆。</div>'}</div>`;
}

function vTx(){
  const list=monthTx(txMonth).sort((a,b)=>b.date.localeCompare(a.date));
  const total=list.filter(isSpend).reduce((s,t)=>s+n(t.amount),0);
  return `<div class="month"><input type="month" value="${txMonth}" onchange="txMonth=this.value;render()">
    <button onclick="txMonth='';render()">全部</button><span class="sub">支出 ${fmt0(total)}</span></div>
  <div class="card">${list.length?list.map(t=>`<div class="row" onclick="editTx('${t.id}')"><div class="l">${esc(t.desc||t.sub||t.category)}
    <small class="note">${t.date} · ${esc(t.type)} · ${esc(t.category)} · ${esc(t.account)}${t.tag?' · '+esc(t.tag):''}</small></div>
    <div class="r ${t.type==='收入'?'pos':''}">${t.type==='收入'?'+':''}${fmt(t.amount)}</div></div>`).join(''):'<div class="sub">呢個月未有紀錄。撳右下角 ＋ 記一筆。</div>'}</div>
  <button class="fab" onclick="editTx()">＋</button>`;
}

function vAccounts(){
  return S.accounts.map(a=>{
    const isCard=a.stmtBal!=null;
    const bal=a.id==='recv'?receivable():a.balance;
    return `<div class="card" onclick="editAcct('${a.id}')"><h2>${esc(a.name)} <span class="pill">${esc(a.type)}</span></h2>
    ${isCard?`<div class="big neg">${fmt(exposure(a))}</div>
      <div class="row"><div class="l">月結單結欠（${a.stmtDate}）</div><div class="r">${fmt(a.stmtBal)}</div></div>
      <div class="row"><div class="l">未入帳分期</div><div class="r">${fmt(a.unposted)}</div></div>
      <div class="row"><div class="l">最低還款 · 到期 ${a.dueDate}</div><div class="r">${fmt(a.minPay)}</div></div>
      <div class="row"><div class="l">月結單後已還</div><div class="r">${fmt(a.paidAfterStmt)} ${n(a.paidAfterStmt)<n(a.minPay)?'<span class="pill red">低過最低</span>':'<span class="pill ok">已達最低</span>'}</div></div>
      <div class="row"><div class="l">估算餘額（扣已還）</div><div class="r"><b>${fmt(afterPay(a))}</b></div></div>
      ${a.creditLimit?`<div class="sub">信用額 ${fmt0(a.creditLimit)} · 使用率 ${(exposure(a)/a.creditLimit*100).toFixed(0)}%</div><div class="bar"><i style="width:${Math.min(100,exposure(a)/a.creditLimit*100)}%"></i></div>`:''}`
    :`<div class="big">${fmt(bal)}</div>${a.asOf?`<div class="sub">截至 ${a.asOf}</div>`:''}`}
    ${a.notes?`<small class="note">${esc(a.notes)}</small>`:''}</div>`}).join('')+
    `<div class="actions"><button onclick="editAcct()">＋ 新增帳戶</button></div>`;
}

function instCard(i){
  const pct=i.total?Math.min(100,n(i.paid)/i.total*100):0, rem=i.total?i.total-n(i.paid):null;
  return `<div class="row" onclick="editInst('${esc(i.id)}')"><div class="l">${esc(i.name)} ${i.countInBurden?'<span class="pill ok">計入月供</span>':''}
    <small class="note">${esc(i.card)} · ${esc(i.product)}${i.total?` · ${n(i.paid)}/${i.total} 期（剩 ${rem}）`:''}${i.end?' · 完 '+i.end.slice(0,7):''} · ${esc(i.status)}</small>
    ${i.total?`<div class="bar"><i style="width:${pct}%"></i></div>`:''}</div>
    <div class="r">${i.monthly!=null?fmt(i.monthly)+'/月':''}${i.outstanding!=null?`<small class="note">未入帳 ${fmt0(i.outstanding)}</small>`:i.principal!=null?`<small class="note">本金 ${fmt0(i.principal)}</small>`:''}
    ${i.total&&rem>0?`<br><button onclick="event.stopPropagation();bump('${esc(i.id)}')">+1 期</button>`:''}</div></div>`;
}
function vInst(){
  const v=S.installments.filter(i=>i.verified||i.countInBurden), o=S.installments.filter(i=>!(i.verified||i.countInBurden));
  return `<div class="card"><h2>每月分期負擔合計</h2><div class="big">${fmt(burden())}</div>
    <div class="sub">${Object.entries(S.burden||{}).map(([k,v])=>esc(k.toUpperCase())+' '+fmt0(v)).join(' + ')}（月結單核對數）。下面舊檔明細唔重複計。</div></div>
  <div class="card"><h2>已核對（2026-09 月結單）／計入月供</h2>${v.map(instCard).join('')}</div>
  <div class="card"><h2>舊檔明細（推算，要對月結單）</h2>${o.map(instCard).join('')}</div>
  <button class="fab" onclick="editInst()">＋</button>`;
}

function vWish(){
  const list=S.wishlist.filter(w=>wishFilter==='全部'||w.status===wishFilter);
  const cnt=s=>S.wishlist.filter(w=>s==='全部'||w.status===s).length;
  return `<div class="chips">${['全部',...WISH_ST].map(s=>`<button class="${s===wishFilter?'on':''}" onclick="wishFilter='${s}';render()">${s} ${cnt(s)}</button>`).join('')}</div>
  <div class="grid2"><div class="card"><h2>已付訂金</h2><div class="big">${fmt0(depositsHeld())}</div></div>
  <div class="card"><h2>partner 應收</h2><div class="big pos">${fmt0(receivable())}</div></div></div>
  <div class="card">${list.length?list.map(w=>`<div class="row" onclick="editWish('${w.id}')"><div class="l">${esc(w.item)}
    <span class="pill ${w.status==='已買'?'ok':w.status==='已付訂金'?'amber':''}">${esc(w.status)}</span>
    ${n(w.receivable)?`<span class="pill ${w.receivedBack?'ok':'red'}">${w.receivedBack?'已收返':'應收 '+fmt0(w.receivable)}</span>`:''}
    <small class="note">${esc(w.store)}${w.orderRef?' · '+esc(w.orderRef):''}${w.forWhom?' · 為 '+esc(w.forWhom):''}${w.date?' · '+w.date:''}${w.notes?'<br>'+esc(w.notes):''}</small></div>
    <div class="r">${w.price!=null?'售價 '+fmt0(w.price)+'<br>':''}${n(w.deposit)?'訂金 '+fmt0(w.deposit)+'<br>':''}${n(w.finalPaid)?'已付 '+fmt0(w.finalPaid):''}</div></div>`).join(''):'<div class="sub">冇項目</div>'}</div>
  <button class="fab" onclick="editWish()">＋</button>`;
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
    else inp=`<input name="${d.k}" type="${d.t||'text'}" ${d.t==='number'?'step="0.01" inputmode="decimal"':''} value="${esc(val)}" ${d.req?'required':''}>`;
    return `<label>${esc(d.l)}${inp}</label>`}).join('')+
    `<div class="actions">${onDel?'<button type="button" id="delBtn" style="color:var(--warn);margin-right:auto">刪除</button>':''}<button value="cancel" formnovalidate>取消</button><button class="primary" value="ok">儲存</button></div>`;
  const dlg=$('#dlg');
  if(onDel) $('#delBtn').onclick=()=>{if(confirm('確定刪除？')){onDel();save();dlg.close();render()}};
  dlg.onclose=()=>{
    if(dlg.returnValue!=='ok') return;
    const fd=new FormData(f);
    fields.forEach(d=>{let v=fd.get(d.k);
      if(d.t==='check') v=!!v; else if(d.t==='number') v=(v===''||v==null)?null:Number(v);
      obj[d.k]=v});
    onSave(obj);save();render();
  };
  dlg.returnValue='';dlg.showModal();
}
const acctNames=()=>[...S.accounts.map(a=>a.name),'TBD（付款帳戶待確認）'];
function editTx(id){
  const t=id?S.transactions.find(x=>x.id===id):{id:uid('t'),date:today(),type:'支出',category:'餐飲',account:'Citibank VISA',amount:null};
  form(id?'修改紀錄':'記一筆',[
    {k:'date',l:'日期',t:'date',req:1},{k:'type',l:'類型',opts:TX_TYPES},{k:'amount',l:'金額（HKD）',t:'number',req:1},
    {k:'category',l:'分類',opts:S.categories},{k:'sub',l:'細項'},{k:'account',l:'帳戶',opts:acctNames()},
    {k:'desc',l:'描述'},{k:'counterparty',l:'對方／商戶'},{k:'tag',l:'標籤'},{k:'notes',l:'備註',t:'area'}],
    t,o=>{if(!id)S.transactions.push(o)},id?()=>S.transactions=S.transactions.filter(x=>x.id!==id):null);
}
function editAcct(id){
  const a=id?S.accounts.find(x=>x.id===id):{id:uid('a'),name:'',type:'銀行',balance:null};
  const isCard=a.stmtBal!=null||(!id&&false);
  const f=[{k:'name',l:'名稱',req:1},{k:'type',l:'類型',opts:['信用卡','銀行','現金','八達通','信封／儲備','應收','貸款／分期']}];
  if(isCard) f.push({k:'stmtDate',l:'月結單日',t:'date'},{k:'dueDate',l:'到期日',t:'date'},{k:'stmtBal',l:'月結單結欠',t:'number'},
    {k:'minPay',l:'最低還款',t:'number'},{k:'unposted',l:'未入帳分期',t:'number'},{k:'totalAcct',l:'Total Account Balance（如有）',t:'number'},
    {k:'paidAfterStmt',l:'月結單後已還',t:'number'},{k:'creditLimit',l:'信用額',t:'number'});
  else if(a.id!=='recv') f.push({k:'balance',l:'結餘',t:'number'},{k:'asOf',l:'截至日期',t:'date'});
  f.push({k:'notes',l:'備註',t:'area'});
  form(id?'修改帳戶':'新增帳戶',f,a,o=>{if(!id)S.accounts.push(o)},id?()=>S.accounts=S.accounts.filter(x=>x.id!==id):null);
}
function editInst(id){
  const i=id?S.installments.find(x=>x.id===id):{id:uid('i'),name:'',card:'Citibank VISA',status:'進行中',paid:0,countInBurden:false};
  form(id?'修改分期':'新增分期',[{k:'name',l:'名稱',req:1},{k:'card',l:'卡／機構'},{k:'product',l:'產品'},
    {k:'monthly',l:'每月（HKD）',t:'number'},{k:'paid',l:'已供期數',t:'number'},{k:'total',l:'總期數',t:'number'},
    {k:'start',l:'首期',t:'date'},{k:'end',l:'預計完',t:'date'},{k:'principal',l:'本金估算',t:'number'},{k:'outstanding',l:'未入帳（核對）',t:'number'},
    {k:'status',l:'狀態',opts:['進行中','進行中（推算）','可能已完（待確認）','已完']},{k:'countInBurden',l:'計入每月分期負擔',t:'check'},{k:'notes',l:'備註',t:'area'}],
    i,o=>{if(!id)S.installments.push(o)},id?()=>S.installments=S.installments.filter(x=>x.id!==id):null);
}
function bump(id){const i=S.installments.find(x=>x.id===id);i.paid=n(i.paid)+1;if(i.total&&i.paid>=i.total)i.status='已完';save();render()}
function editWish(id){
  const w=id?S.wishlist.find(x=>x.id===id):{id:uid('w'),item:'',status:'想買',deposit:0,finalPaid:0,receivable:0,date:today()};
  form(id?'修改項目':'新增 Wishlist',[{k:'item',l:'項目',req:1},{k:'status',l:'狀態',opts:WISH_ST},{k:'maker',l:'廠商'},
    {k:'price',l:'售價',t:'number'},{k:'deposit',l:'已付訂金',t:'number'},{k:'finalPaid',l:'已付尾數／全數',t:'number'},
    {k:'store',l:'店舖'},{k:'orderRef',l:'單號'},{k:'forWhom',l:'為誰買'},{k:'receivable',l:'應收（代付）',t:'number'},
    {k:'receivedBack',l:'已收返應收',t:'check'},{k:'date',l:'日期',t:'date'},{k:'notes',l:'備註',t:'area'}],
    w,o=>{if(!id)S.wishlist.push(o)},id?()=>S.wishlist=S.wishlist.filter(x=>x.id!==id):null);
}

/* ---------- 設定／匯出匯入 ---------- */
function settings(){
  const f=$('#dlgForm');
  f.innerHTML=`<h3 style="margin:0">設定／備份</h3>
  <button type="button" class="primary" id="expBtn">⬇️ 匯出 JSON 備份</button>
  <button type="button" id="impBtn">⬆️ 匯入 JSON</button>
  <button type="button" id="rstBtn" style="color:var(--warn)">↺ 重設為種子資料（會清走本機改動）</button>
  <div class="sub">資料只存喺呢部機嘅瀏覽器（localStorage）。換機／清瀏覽器資料前記得匯出。<br>種子：${esc(S.source||'')} · ${esc(S.generatedAt||'')}</div>
  <div class="actions"><button value="cancel">關閉</button></div>`;
  const dlg=$('#dlg');dlg.onclose=null;
  $('#expBtn').onclick=()=>{const b=new Blob([JSON.stringify(S,null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`家計簿備份_${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)};
  $('#impBtn').onclick=()=>$('#importFile').click();
  $('#rstBtn').onclick=async()=>{if(confirm('確定重設？本機改動會消失（建議先匯出）')){localStorage.removeItem(KEY);S=null;dlg.close();await load()}};
  dlg.showModal();
}
$('#importFile').onchange=e=>{const file=e.target.files[0];if(!file)return;const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);if(!d.accounts||!d.transactions)throw 0;S=d;save();$('#dlg').close();render();alert('匯入成功')}catch(_){alert('檔案格式唔啱')}e.target.value=''};r.readAsText(file)};
$('#menuBtn').onclick=settings;
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;history.replaceState(null,'','#'+tab);render()});
{const h=location.hash.slice(1);if(TITLES[h])tab=h;}
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
load();
