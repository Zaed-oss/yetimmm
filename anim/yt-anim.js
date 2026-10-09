/* Yetimmm Animated 3D UI layer. Presentation only: reads S/link() (read-only), never touches trading, API or auth. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
/* ── Assets (reusable): shared gradients + bot / logo markup ── */
const DEFS='<svg class="yt-defs" aria-hidden="true"><defs><radialGradient id="ybd" cx=".32" cy=".25" r=".95"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#dfe6ea"/><stop offset="1" stop-color="#8f9ba3"/></radialGradient><linearGradient id="ybv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26323a"/><stop offset=".55" stop-color="#0d1318"/><stop offset="1" stop-color="#05090c"/></linearGradient><linearGradient id="ybr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#5d6a72" stop-opacity=".9"/></linearGradient><linearGradient id="ybt" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff2b8"/><stop offset=".5" stop-color="#e0aa2e"/><stop offset="1" stop-color="#9b6a10"/></linearGradient><linearGradient id="ybc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa7ae"/><stop offset="1" stop-color="#4b565d"/></linearGradient></defs></svg>';
const BOT='<svg class="b3" viewBox="0 0 120 120" aria-hidden="true"><ellipse class="sh" cx="60" cy="112" rx="26" ry="5"/><g class="fl"><g class="an"><line x1="60" y1="24" x2="60" y2="11"/><circle class="bulb" cx="60" cy="8" r="5"/><circle class="bgl" cx="58.6" cy="6.4" r="1.4"/></g><path class="col" d="M42 98h36l-5 10H47z"/><circle class="ear" cx="19" cy="62" r="7"/><circle class="ear" cx="101" cy="62" r="7"/><circle class="ear2" cx="19" cy="62" r="3"/><circle class="ear2" cx="101" cy="62" r="3"/><rect class="hd3" x="24" y="22" width="72" height="78" rx="31"/><rect class="rim" x="24" y="22" width="72" height="78" rx="31"/><path class="seam" d="M36 91q24 8 48 0"/><rect class="vis" x="32" y="37" width="56" height="44" rx="21"/><rect class="vtr" x="32" y="37" width="56" height="44" rx="21"/><path class="glr" d="M40 44q20-9 40 0q-20 3-40 0z"/><g class="eyes"><rect class="ey" x="43" y="49" width="9" height="15" rx="4.5"/><rect class="ey" x="68" y="49" width="9" height="15" rx="4.5"/><circle class="gl" cx="46.5" cy="53" r="1.6"/><circle class="gl" cx="71.5" cy="53" r="1.6"/></g><path class="m m-s" d="M50 70q10 9 20 0"/><path class="m m-f" d="M52 72h16"/><path class="m m-o" d="M57 71a3 3 0 1 0 6 0a3 3 0 1 0-6 0"/><path class="m m-d" d="M50 75q10-8 20 0"/><ellipse class="hl" cx="46" cy="31" rx="15" ry="4.5"/><circle class="bd" cx="96" cy="92" r="12"/><path class="bi bi-ok" d="M90 92l4 4 7-8"/><path class="bi bi-x" d="M91 87l10 10M101 87l-10 10"/><path class="bi bi-bolt" d="M97 83l-6 10h6l-2 8 7-11h-6z"/><path class="bi bi-z" d="M90 86h8l-8 10h8"/></g><ellipse class="rg" cx="60" cy="62" rx="54" ry="20"/><g class="pt"><circle cx="60" cy="60" r="2.6"/><circle cx="60" cy="60" r="2"/><circle cx="60" cy="60" r="3"/></g></svg>';
const LOGO='<svg viewBox="0 0 46 46" aria-hidden="true"><defs><linearGradient id="yl1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6c9"/><stop offset=".45" stop-color="#f0c24a"/><stop offset="1" stop-color="#b57a12"/></linearGradient><linearGradient id="yl2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a6ffd2"/><stop offset=".5" stop-color="#43d18c"/><stop offset="1" stop-color="#15814f"/></linearGradient><radialGradient id="yl4" cx=".5" cy=".95" r=".8"><stop offset="0" stop-color="#f0c24a" stop-opacity=".35"/><stop offset="1" stop-color="#f0c24a" stop-opacity="0"/></radialGradient></defs><rect x="0" y="0" width="46" height="46" fill="url(#yl4)"/><path d="M6 39.5h34" stroke="#f0c24a" stroke-opacity=".45" stroke-width="1" stroke-linecap="round"/><rect class="lb1" x="8" y="24" width="8" height="14" rx="2.5" fill="url(#yl1)"/><rect class="lb2" x="19" y="16" width="8" height="22" rx="2.5" fill="url(#yl2)"/><rect class="lb3" x="30" y="9" width="8" height="29" rx="2.5" fill="url(#yl1)"/><path class="lln" d="M8 20L19 12L28 17L38 6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/><circle class="ldot" cx="38" cy="6" r="2.8" fill="#fff"/><circle class="ldot" cx="38" cy="6" r="5" fill="none" stroke="#fff" stroke-opacity=".35"/></svg>';
/* ── i18n labels (state names, for long-press info) ── */
const L={idle:["جاهز","Ready"],connecting:["جارٍ الاتصال","Connecting"],connected:["متصل","Connected"],waiting:["بانتظار الأوامر","Waiting for orders"],analyzing:["يحلّل السوق","Analyzing"],signal:["تم رصد إشارة","Signal detected"],placed:["تم وضع الأمر","Order placed"],filled:["تم تنفيذ الأمر","Order filled"],trade:["صفقة مفتوحة","Trade open"],profit:["ربح","Profit"],loss:["خسارة","Loss"],error:["خطأ","Error"],closed:["السوق مغلق","Market closed"],stopped:["البوت متوقف","Bot stopped"]};
const lab=s=>(L[s]||L.idle)[typeof LG!=="undefined"&&LG?1:0];
/* ── AnimatedBot ── */
const bots=[],io="IntersectionObserver" in window?new IntersectionObserver(es=>es.forEach(e=>e.target.classList.toggle("off",!e.isIntersecting))):null;
function AnimatedBot(host,opt){
  opt=opt||{};const el=document.createElement("div");el.className="bot "+(opt.size||"");el.innerHTML=BOT;el.setAttribute("role","img");
  const o={el,steady:opt.state||"idle",tm:0,
    set(s){this.steady=s;if(!this.tm)this.show(s)},
    show(s){el.dataset.s=s;el.setAttribute("aria-label",lab(s))},
    once(s,ms){clearTimeout(this.tm);this.show(s);this.tm=setTimeout(()=>{this.tm=0;this.show(this.steady)},ms||1600)}};
  o.show(o.steady);host.appendChild(el);io&&io.observe(el);bots.push(o);
  let lp=0;el.addEventListener("pointerdown",()=>{lp=setTimeout(()=>{lp=0;typeof toast==="function"&&toast(lab(o.steady))},520)});
  ["pointerup","pointerleave","pointercancel"].forEach(ev=>el.addEventListener(ev,()=>{if(lp){clearTimeout(lp);lp=0;el.classList.remove("pulse");void el.offsetWidth;el.classList.add("pulse");try{navigator.vibrate&&navigator.vibrate(8)}catch(e){}}}));
  return o;
}
/* ── Loading / Success / Error ── */
const LoadingAnimation=()=>'<span class="ldg" aria-hidden="true"><i></i><i></i><i></i></span>';
function SuccessAnimation(el){if(!el)return;const s=document.createElement("span");s.className="sx";el.appendChild(s);setTimeout(()=>s.remove(),1100)}
function ErrorAnimation(el){if(!el)return;el.classList.remove("shk");void el.offsetWidth;el.classList.add("shk")}
/* ── AnimatedIcon: the 3D class is added by ic() in index.html; this keeps one place for the registry ── */
const AnimatedIcon=n=>`<svg class="ic i3 i-${n}"><use href="#i-${n}"/></svg>`;
/* ── InteractiveButton: ripple + pop on every pressable ── */
const PRESS=".btn,.ib,.sm,.chip,.nav button,#lg .go,#vf .go";
document.addEventListener("pointerdown",e=>{
  const b=e.target.closest&&e.target.closest(PRESS);if(!b||b.disabled)return;
  const r=b.getBoundingClientRect(),d=Math.max(r.width,r.height)*2,s=document.createElement("span");
  s.className="rip";s.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;b.appendChild(s);setTimeout(()=>s.remove(),650);
},{passive:true});
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest(".btn");if(b){b.classList.remove("pop");void b.offsetWidth;b.classList.add("pop")}},true);
/* ── StatusAnimation: real app state -> bot state ── */
let main=null,pendUntil=0,prev=null,badAt=0;
function steady(){
  if(Date.now()<pendUntil&&S.state==="STOPPED")return"connecting";
  const k=typeof link==="function"?link():"sim";
  if(k==="wait")return"connecting";
  if(k==="srv"||k==="auth")return"error";
  if(k==="off")return"stopped";
  if(Date.now()-badAt<2500)return"error";
  if(/market closed/i.test(S.msg||""))return"closed";
  if(S.frz||S.state==="STOPPED")return"stopped";
  if(S.state==="ERROR")return"error";
  if(S.state==="BUY_ACTIVE"||S.state==="SELL_ACTIVE")return"trade";
  if(S.state==="ARMED"||S.state==="WAITING_REENTRY")return"analyzing";
  return"waiting";
}
function sync(){
  if(!main)return;
  const st=steady(),ready=S.price>0,hk=S.hist&&S.hist[0]?S.hist[0].no+"|"+S.hist[0].ts+"|"+S.hist[0].pnl:"",no=(S.orders||[]).length;
  main.set(st);
  if(st==="trade"){const fl=typeof floating==="function"?floating():0;main.el.style.setProperty("--ec",fl>=0?"var(--up)":"var(--dn)")}else main.el.style.removeProperty("--ec");
  if(ready&&prev&&prev.ready){
    const act=x=>x==="BUY_ACTIVE"||x==="SELL_ACTIVE";
    if(hk&&hk!==prev.hk){const p=S.hist[0].pnl;main.once(p>=0?"profit":"loss",2400);if(p>=0)SuccessAnimation(main.el)}
    else if(act(S.state)&&!act(prev.state)){main.once("signal",800);setTimeout(()=>{main.once("filled",1800);SuccessAnimation(main.el)},800)}
    else if(no>prev.no&&S.state==="ARMED")main.once("placed",1500);
    else if(prev.st!==st&&/^(stopped|error|connecting)$/.test(prev.st)&&/^(waiting|analyzing)$/.test(st)){main.once("connected",1700);SuccessAnimation(main.el)}
  }
  prev={ready,hk,no,state:S.state,st};
}
/* hooks used by index.html */
function pend(){pendUntil=Date.now()+9000;sync()}
function onToast(bad){
  const t=$("toast");
  if(bad){badAt=Date.now();pendUntil=0;ErrorAnimation(t);main&&main.once("error",1600);setTimeout(sync,2600)}
  else{SuccessAnimation(t);main&&main.el.classList.add("pulse");main&&setTimeout(()=>main.el.classList.remove("pulse"),700)}
}
/* ── Mount ── */
function mountAuth(){
  const lg=$("lg"),vf=$("vf");
  if(lg){const h=document.createElement("div");h.style.display="contents";lg.querySelector(".box").prepend(h);const b=AnimatedBot(h,{state:"waiting"});
    const f=()=>{const c=lg.className;b.set(c==="w"?"connecting":c==="ok"?"connected":"waiting")};new MutationObserver(f).observe(lg,{attributes:true,attributeFilter:["class"]});
    new MutationObserver(()=>{if($("lgEr").textContent)b.once("error",1500)}).observe($("lgEr"),{childList:true,characterData:true,subtree:true});
    const sp=lg.querySelector(".spn");if(sp)sp.outerHTML=LoadingAnimation()}
  if(vf){const h=document.createElement("div");h.style.display="contents";vf.querySelector(".box").prepend(h);const b=AnimatedBot(h,{state:"connecting"});
    new MutationObserver(()=>{const r=vf.querySelectorAll(".rw");const run=vf.querySelector(".rw.run"),no=vf.querySelector(".rw.no");
      b.set(run?"connecting":no?($("vfM").textContent.length&&!vf.querySelector("#vfB.ok")&&vf.querySelector("#vfS.ok")?"stopped":"error"):"connected")}).observe(vf,{subtree:true,attributes:true,attributeFilter:["class"]})}
}
function init(){
  document.body.insertAdjacentHTML("afterbegin",DEFS);
  const lg3=$("logo3");if(lg3)lg3.innerHTML=LOGO;
  const hm=$("botMain");if(hm){main=AnimatedBot(hm,{size:"",state:"connecting"})}
  mountAuth();
  document.addEventListener("visibilitychange",()=>document.body.classList.toggle("yt-hid",document.hidden));
  /* re-sync after every app render without touching render()'s logic */
  const r0=window.render;if(typeof r0==="function"){window.render=function(){r0.apply(this,arguments);try{sync()}catch(e){}}}
  sync();
}
window.YT={AnimatedIcon,AnimatedBot,StatusAnimation:{sync,pend,steady,labels:L},InteractiveButton:{selector:PRESS},LoadingAnimation,SuccessAnimation,ErrorAnimation,pend,onToast};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
