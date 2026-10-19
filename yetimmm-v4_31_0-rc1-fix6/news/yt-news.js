/* Yetimmm — Economic calendar, market sessions, news alerts, order alerts, notification center.
   Data + alert engine live on the server (worker/news.js). This file is UI only: it never decides whether an alert fires. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const L=()=>typeof LG!=="undefined"&&LG?1:0;
const Ti=a=>a[L()];
/* ── i18n ── */
Object.assign(D,{n_nav:["الأخبار","News"],n_ses:["جلسات السوق","Market sessions"],n_cur:["الجلسة الحالية","CURRENT SESSION"],n_clo:["مغلقة","Closed"],n_opens:["تفتح بعد {0}","opens in {0}"],n_clin:["تغلق بعد {0}","closes in {0}"],n_ovl:["تداخل جلستين: سيولة أعلى عادة","Session overlap: usually higher liquidity"],
n_tz:["عرض بتوقيت","Display time"],n_mkt:["توقيت المنصة","Market time"],n_you:["توقيتك","Your time"],n_week:["هذا الأسبوع","THIS WEEK"],n_wk:["الأسبوع","WEEK"],n_left:["أيام متبقية","Days left"],n_cnt:["الأخبار","Events"],n_hi:["عالية التأثير","High impact"],
n_next:["الخبر الاقتصادي القادم","Next economic event"],n_in:["يبدأ بعد","Starts in"],n_none:["لا أخبار قادمة هذا الأسبوع","No more events this week"],n_cal:["التقويم الاقتصادي","Economic Calendar"],n_today:["اليوم","TODAY"],n_noev:["لا توجد أخبار","No events"],
n_f0:["الكل","All"],n_f1:["متوسط+","Medium+"],n_f2:["عالي","High"],n_prev:["السابق","Previous"],n_fc:["المتوقع","Forecast"],n_ac:["الفعلي","Actual"],n_na:["غير متوفر","N/A"],
n_s_up:["قادم","Upcoming"],n_s_soon:["قريباً","Soon"],n_s_rel:["صدر","Released"],n_s_pass:["انتهى","Passed"],n_s_wait:["بانتظار النتيجة","Awaiting"],
n_imp_high:["تأثير عالٍ","High"],n_imp_medium:["تأثير متوسط","Medium"],n_imp_low:["تأثير منخفض","Low"],n_imp_holiday:["عطلة","Holiday"],
n_down:["بيانات الأخبار غير متاحة مؤقتاً","News data temporarily unavailable"],n_upd:["آخر تحديث {0}","Last updated {0}"],n_src:["المصدر","Source"],n_retry:["إعادة المحاولة تلقائياً","Retrying automatically"],
n_aT:["ضبط تنبيه الخبر","Set News Alert"],n_aQ:["هل تريد استلام إشعار عند اقتراب/حدوث هذا الخبر؟","Do you want a notification as this event approaches / happens?"],n_allow:["السماح","Allow"],n_cancel:["إلغاء","Cancel"],n_upd2:["تحديث التنبيه","Update alert"],n_rm:["إلغاء التنبيه","Remove alert"],
n_o0:["عند وقت الخبر","At event time"],n_o1:["قبل دقيقة","1 min before"],n_o5:["قبل 5 دقائق","5 min before"],n_o15:["قبل 15 دقيقة","15 min before"],n_o30:["قبل 30 دقيقة","30 min before"],n_pick:["اختر وقتاً واحداً على الأقل","Pick at least one time"],
n_aOn:["تم تفعيل التنبيه","Alert enabled"],n_aOff:["تم إلغاء التنبيه","Alert removed"],n_ended:["انتهى هذا الخبر","This event has ended"],n_aAct:["التنبيه مفعّل","Alert on"],
n_oT:["تنبيه تفعيل الأوردر","Order Activation Alert"],n_oQ:["هل تريد استلام إشعار عند تفعيل هذا الأوردر؟","Do you want a notification when this order is activated?"],n_oOn:["سيصلك إشعار عند تفعيل الأوردر","You'll be notified when it activates"],n_oOff:["تم إلغاء تنبيه الأوردر","Order alert removed"],n_oGone:["الأوردر لم يعد موجوداً","This order no longer exists"],
n_nc:["مركز الإشعارات","Notification Center"],n_hist:["سجل التنبيهات","Notification History"],n_readAll:["تعليم الكل كمقروء","Mark all read"],n_noN:["لا توجد إشعارات بعد","No notifications yet"],n_t_news:["خبر","News"],n_t_order:["أوردر","Order"],n_t_system:["نظام","System"],n_unr:["غير مقروء","Unread"],
n_info:["معلومات الخبر","Event info"],n_why:["لماذا هذا الخبر مهم؟","Why does it matter?"],n_mk:["الأسواق والعملات المحتملة التأثر","Markets & currencies possibly affected"],n_pm:["رد الفعل المحتمل للسوق","Possible Market Reaction"],
n_above:["إذا جاءت أعلى من المتوقع","If higher than forecast"],n_below:["إذا جاءت أقل من المتوقع","If lower than forecast"],n_eq:["إذا جاءت مطابقة","If in line"],n_afd:["الفرق بين Actual و Forecast","Actual vs Forecast"],
n_afdT:["Forecast هو توقع المحللين قبل الصدور، و Actual هو الرقم الفعلي عند الصدور. الحركة غالباً تأتي من حجم الفرق (المفاجأة) لا من الرقم وحده، لأن السوق يكون قد سعّر التوقع مسبقاً.","Forecast is the analysts' expectation before release; Actual is the real figure. Moves usually come from the size of the surprise, not the number alone, because the market has already priced the forecast."],
n_why2:["لماذا قد تتحرك الأسواق بقوة؟","Why can the move be sharp?"],n_why2T:["عند الصدور تتغير توقعات أسعار الفائدة والنمو فجأة، وتتزامن أوامر كثيرة، فتتسع فروق الأسعار وتزداد السرعة والانزلاق.","Rate and growth expectations reprice at once, many orders hit together, spreads widen and slippage rises."],
n_warn:["تنبيه: هذه سيناريوهات محتملة وليست توقعاً مؤكداً أو توصية. قد يتحرك السوق عكسها، ولا اتجاه مضمون.","Note: these are possible scenarios, not a forecast or advice. Markets can move the opposite way; no direction is guaranteed."],
n_gold:["الذهب XAUUSD يُسعَّر بالدولار، لذا قد تؤثر بيانات الدولار فيه، وغالباً بعلاقة عكسية جزئية وليست ثابتة.","Gold (XAUUSD) is priced in USD, so USD data can influence it, often with a partial, non-constant inverse link."],
n_tzs:["المنطقة الزمنية","Time zone"],n_load:["جارٍ تحميل التقويم…","Loading calendar…"],n_sess:["جلسة","Session"],n_live:["مباشر من حسابك","Live from your account"]});
Object.assign(D,{n_asia:["آسيا","Asia"],n_lon:["لندن","London"],n_ny:["نيويورك","New York"]});
/* ── time (server-synced: never trust a drifting device clock) ── */
const N={ev:[],rev:"",off:0,loaded:false,loading:false,stale:true,err:"",src:"",upd:0,hasAct:false,alerts:{},pref:{},mtz:"UTC",moff:null,msrv:"",live:false,fails:0,flt:(typeof UI!=="undefined"&&UI.nf)||0,notifs:[],unread:0,seenN:null,first:true};
const now=()=>Date.now()+N.off;
const devTz=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"}catch(e){return"UTC"}};
const dtz=()=>N.pref.tz||devTz();
const FM={};const fmt=(tz,o)=>{const k=tz+JSON.stringify(o);return FM[k]||(FM[k]=new Intl.DateTimeFormat("en-GB",{timeZone:tz,...o}))};
const parts=(ts,tz)=>{const o={};fmt(tz,{hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(new Date(ts)).forEach(p=>o[p.type]=+p.value);return o};
const tzOff=(tz,ts)=>{const p=parts(ts,tz);return(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ts/1000)*1000)};
const wall=(tz,y,m,d,h,mi)=>{const g=Date.UTC(y,m-1,d,h,mi);let r=g-tzOff(tz,g);const o2=tzOff(tz,r);return g-o2};   // wall-clock in tz -> UTC ms (DST-safe)
const hm=(ts,tz)=>{const p=parts(ts,tz);return String(p.hour).padStart(2,"0")+":"+String(p.minute).padStart(2,"0")};
const dkey=(ts,tz)=>{const p=parts(ts,tz);return p.year+"-"+String(p.month).padStart(2,"0")+"-"+String(p.day).padStart(2,"0")};
/* platform (MT5 server) time: a fixed offset reported by the EA of the logged-in account; falls back to the MARKET_TZ zone */
const gmtl=o=>{const m=Math.round(o/60),a=Math.abs(m),h=Math.floor(a/60),mm=a%60;return"GMT"+(m===0?"":(m<0?"-":"+")+h+(mm?":"+String(mm).padStart(2,"0"):""))};
const mhm=ts=>{if(N.moff==null)return hm(ts,N.mtz);const d=new Date(ts+N.moff*1000),z=n=>String(n).padStart(2,"0");return z(d.getUTCHours())+":"+z(d.getUTCMinutes())};
const mlab=()=>N.moff==null?N.mtz:gmtl(N.moff);
const mdiff=n=>N.moff==null?tzOff(N.mtz,n)!==tzOff(dtz(),n):N.moff*1000!==tzOff(dtz(),n);
/* currencies of the symbol this account trades (XAUUSD -> USD): events that move it get a tag */
const symCur=()=>{const y=String((typeof S!=="undefined"&&S.sym)||"XAUUSD").toUpperCase().replace(/[^A-Z]/g,"");return[y.slice(0,3),y.slice(3,6)].filter(c=>FLG[c])};
const loc=()=>L()?"en-US":"ar-u-nu-latn";
const dname=(key,o)=>new Date(key+"T12:00:00Z").toLocaleDateString(loc(),{timeZone:"UTC",...o});
const cd=ms=>{ms=Math.max(0,Math.floor(ms/1000));const d=Math.floor(ms/86400),h=Math.floor(ms%86400/3600),m=Math.floor(ms%3600/60),s=ms%60,z=n=>String(n).padStart(2,"0");return(d?d+(L()?"d ":"ي "):"")+z(h)+":"+z(m)+":"+z(s)};
const isoWeek=key=>{const d=new Date(key+"T00:00:00Z"),n=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-n+3);const y=new Date(Date.UTC(d.getUTCFullYear(),0,4));return 1+Math.round(((d-y)/86400000-3+((y.getUTCDay()+6)%7))/7)};
const addDays=(key,n)=>{const d=new Date(key+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
/* ── sessions (exchange-local hours, so DST of Tokyo/London/New York is handled by the time-zone database) ── */
const SES=[{k:"asia",n:"n_asia",tz:"Asia/Tokyo",o:[9,0],c:[18,0],ic:"sunr",col:"#f0a23c"},{k:"lon",n:"n_lon",tz:"Europe/London",o:[8,0],c:[17,0],ic:"bank",col:"#5cc8ff"},{k:"ny",n:"n_ny",tz:"America/New_York",o:[8,0],c:[17,0],ic:"sky",col:"#b88cff"}];
function sesWin(s,t){const p=parts(t,s.tz);let key=p.year+"-"+String(p.month).padStart(2,"0")+"-"+String(p.day).padStart(2,"0");
  for(let i=-1;i<7;i++){const k=addDays(key,i),wd=new Date(k+"T12:00:00Z").getUTCDay();if(wd===0||wd===6)continue;const[y,m,d]=k.split("-").map(Number),o=wall(s.tz,y,m,d,s.o[0],s.o[1]),c=wall(s.tz,y,m,d,s.c[0],s.c[1]);if(t<c)return{o,c,open:t>=o}}return{o:0,c:0,open:false}}
/* ── assets: icons + flags (inline SVG, no external images) ── */
const SYM='<symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/></symbol><symbol id="i-cal" viewBox="0 0 24 24"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/></symbol><symbol id="i-sunr" viewBox="0 0 24 24"><path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 6v3M5.6 10.6L7 12M18.4 10.6L17 12"/></symbol><symbol id="i-bank" viewBox="0 0 24 24"><path d="M3 20h18M6 20V11M10 20V11M14 20V11M18 20V11M3 10l9-6 9 6z"/></symbol><symbol id="i-sky" viewBox="0 0 24 24"><path d="M3 20h18M6 20v-9h4v9M12 20V4h4v16M18 20v-6h3"/></symbol>';
const r=(x,y,w,h,f)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`,c=(x,y,q,f)=>`<circle cx="${x}" cy="${y}" r="${q}" fill="${f}"/>`;
const FLG={USD:()=>[0,1,2,3,4,5,6].map(i=>r(0,i*15/7,22,15/7+.1,i%2?"#fff":"#c8283b")).join("")+r(0,0,9.5,8.6,"#2a3f8f")+c(2.5,2,.6,"#fff")+c(5,2,.6,"#fff")+c(7.5,2,.6,"#fff")+c(3.7,4.3,.6,"#fff")+c(6.2,4.3,.6,"#fff")+c(2.5,6.5,.6,"#fff")+c(5,6.5,.6,"#fff")+c(7.5,6.5,.6,"#fff"),
EUR:()=>r(0,0,22,15,"#2a47a5")+[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>c(11+4.6*Math.cos(i*Math.PI/6),7.5+4.6*Math.sin(i*Math.PI/6),.8,"#f7d046")).join(""),
GBP:()=>r(0,0,22,15,"#233c8a")+'<path d="M0 0L22 15M22 0L0 15" stroke="#fff" stroke-width="3"/><path d="M0 0L22 15M22 0L0 15" stroke="#c8283b" stroke-width="1"/>'+r(8.5,0,5,15,"#fff")+r(0,5,22,5,"#fff")+r(9.4,0,3.2,15,"#c8283b")+r(0,5.9,22,3.2,"#c8283b"),
JPY:()=>r(0,0,22,15,"#fff")+c(11,7.5,4.3,"#c8283b"),
AUD:()=>r(0,0,22,15,"#233c8a")+r(0,0,11,7.5,"#233c8a")+r(4.6,0,1.8,7.5,"#fff")+r(0,2.8,11,1.8,"#fff")+r(5,0,.9,7.5,"#c8283b")+r(0,3.2,11,.9,"#c8283b")+c(16,4,.9,"#fff")+c(18.5,8,.9,"#fff")+c(15,11,.9,"#fff")+c(5.5,11.5,1.4,"#fff"),
CAD:()=>r(0,0,22,15,"#fff")+r(0,0,5.5,15,"#d52b3a")+r(16.5,0,5.5,15,"#d52b3a")+c(11,7.5,2.6,"#d52b3a"),
CHF:()=>r(0,0,22,15,"#d52b3a")+r(9.2,3,3.6,9,"#fff")+r(6.5,5.7,9,3.6,"#fff"),
NZD:()=>r(0,0,22,15,"#233c8a")+r(0,0,11,7.5,"#233c8a")+r(4.6,0,1.8,7.5,"#fff")+r(0,2.8,11,1.8,"#fff")+r(5,0,.9,7.5,"#c8283b")+r(0,3.2,11,.9,"#c8283b")+c(16,4,.9,"#d52b3a")+c(18.5,8,.9,"#d52b3a")+c(15,11,.9,"#d52b3a")+c(19,12,.9,"#d52b3a"),
CNY:()=>r(0,0,22,15,"#d52b3a")+c(4.5,4,2.3,"#f7d046")+c(8.5,1.8,.7,"#f7d046")+c(10,4,.7,"#f7d046")+c(10,6.5,.7,"#f7d046")+c(8.5,8.5,.7,"#f7d046")};
const flag=cur=>FLG[cur]?`<svg class="fl" viewBox="0 0 22 15" aria-label="${cur}">${FLG[cur]()}</svg>`:`<span class="fl cc">${esc(cur)}</span>`;
const ico=n=>`<svg class="ic i3 i-${n}"><use href="#i-${n}"/></svg>`;
const impB=i=>`<span class="imp ${i}"><i><u></u><u></u><u></u></i>${t("n_imp_"+i)}</span>`;
/* ── knowledge base for the info popup (educational text only, always "possible", never guaranteed) ── */
const KB=[
[/cpi|inflation|ppi|pce|price index/i,{n:["التضخم","Inflation"],why:["يقيس تغيّر الأسعار، وهو أحد أهم مدخلات قرار البنك المركزي بشأن الفائدة.","Measures price changes, a key input for central-bank rate decisions."],mk:["العملة المعنية، السندات، المؤشرات، والذهب","The currency, bonds, equity indices and gold"],a:["قد يرفع توقعات رفع/تثبيت الفائدة فيدعم العملة أحياناً، وقد يضغط على الأسهم والذهب.","May lift expectations of higher/held rates, which can support the currency and weigh on equities and gold."],b:["قد يعزز توقعات خفض الفائدة، فتضعف العملة أحياناً ويتحسن الذهب والأسهم.","May strengthen rate-cut expectations: the currency can soften while gold and equities may gain."]}],
[/non.?farm|payroll|employment|unemployment|jobless|jolts|adp|claims|jobs/i,{n:["سوق العمل","Labour market"],why:["قوة التوظيف تعكس صحة الاقتصاد وتؤثر في سياسة الفائدة.","Employment strength reflects the economy and shapes rate policy."],mk:["العملة المعنية، الفوركس، السندات، الذهب","The currency, FX pairs, bonds, gold"],a:["قد يدعم العملة ويرفع عوائد السندات، مع احتمال ضغط على الذهب.","May support the currency and bond yields, with possible pressure on gold."],b:["قد يضعف العملة ويزيد توقعات التيسير، وقد يدعم الذهب.","May weaken the currency and raise easing expectations; gold could benefit."]}],
[/interest rate|rate decision|fomc|fed funds|mpc|cash rate|monetary policy|refinancing|bank rate|policy rate|boe|ecb|boj|rba|snb|boc|rbnz/i,{n:["قرار الفائدة","Rate decision"],why:["أقوى حدث للعملة: يحدد تكلفة المال، ولهجة البيان تهم بقدر القرار نفسه.","The strongest currency event: it sets the cost of money, and the statement tone matters as much as the decision."],mk:["العملة المعنية، السندات، الأسهم، الذهب","The currency, bonds, equities, gold"],a:["فائدة أعلى أو لهجة متشددة قد تدعم العملة وتضغط على الذهب والأسهم.","A higher rate or hawkish tone may support the currency and pressure gold and equities."],b:["فائدة أقل أو لهجة تيسيرية قد تضعف العملة وتدعم الذهب.","A lower rate or dovish tone may weaken the currency and support gold."]}],
[/gdp|growth/i,{n:["النمو الاقتصادي","Growth (GDP)"],why:["أشمل مقياس لحجم الاقتصاد ونموه.","The broadest gauge of economic output."],mk:["العملة المعنية والأسهم","The currency and equities"],a:["قد يدعم العملة والأسهم.","May support the currency and equities."],b:["قد يضعف العملة ويرفع توقعات التيسير.","May weaken the currency and raise easing expectations."]}],
[/pmi|ism|manufacturing|services|industrial|factory/i,{n:["مؤشرات النشاط","Activity surveys (PMI)"],why:["مؤشر مبكر للنشاط؛ فوق 50 يعني توسعاً عادةً.","An early read on activity; above 50 usually means expansion."],mk:["العملة المعنية والأسهم","The currency and equities"],a:["قد يدعم العملة والأسهم الدورية.","May support the currency and cyclical equities."],b:["قد يضغط على العملة ويزيد القلق من التباطؤ.","May weigh on the currency and add slowdown worries."]}],
[/retail|consumer spending|sales|durable/i,{n:["الإنفاق الاستهلاكي","Consumer spending"],why:["الاستهلاك محرّك رئيسي للنمو.","Consumption is a main growth driver."],mk:["العملة المعنية والأسهم","The currency and equities"],a:["قد يدعم العملة وتوقعات النمو.","May support the currency and growth expectations."],b:["قد يضعف العملة ويثير مخاوف التباطؤ.","May weaken the currency and raise slowdown fears."]}],
[/speaks|speech|testimony|press conference|minutes|statement|governor|chair/i,{n:["تصريحات / محاضر","Speech / minutes"],why:["لا رقم هنا؛ قد تكشف نبرة المسؤول عن اتجاه الفائدة.","No figure: the tone can reveal the rate path."],mk:["العملة المعنية، السندات، الذهب","The currency, bonds, gold"],a:["نبرة متشددة قد تدعم العملة.","A hawkish tone may support the currency."],b:["نبرة تيسيرية قد تضعف العملة.","A dovish tone may weaken the currency."]}],
[/trade balance|current account|exports|imports/i,{n:["التجارة الخارجية","Trade"],why:["يعكس الطلب الخارجي وتدفقات العملة.","Reflects external demand and currency flows."],mk:["العملة المعنية","The currency"],a:["فائض أكبر قد يدعم العملة.","A bigger surplus may support the currency."],b:["عجز أكبر قد يضغط على العملة.","A bigger deficit may weigh on the currency."]}]];
const KG={n:["حدث اقتصادي","Economic event"],why:["بيانات تغيّر توقعات المستثمرين حول الاقتصاد والفائدة.","Data that shifts expectations about the economy and rates."],mk:["العملة المعنية وأزواجها","The currency and its pairs"],a:["قد يدعم العملة إن عزّز توقعات الاقتصاد.","May support the currency if it strengthens the outlook."],b:["قد يضعف العملة إن أضعف التوقعات.","May weaken the currency if it dims the outlook."]};
const kb=title=>{for(const[r,v]of KB)if(r.test(title))return v;return KG};
const IMPEXP={high:["تأثير عالٍ: من الأخبار التي تحرّك السوق عادةً بقوة وتوسّع فروق الأسعار.","High impact: usually moves markets sharply and widens spreads."],medium:["تأثير متوسط: قد يحرّك السعر بشكل معتدل، خصوصاً إذا خالف التوقع.","Medium impact: can move price moderately, especially on a surprise."],low:["تأثير منخفض: حركة محدودة غالباً.","Low impact: usually a limited move."],holiday:["عطلة: قد تقل السيولة ويتسع السبريد.","Holiday: liquidity may thin and spreads widen."]};
/* ── data layer ── */
const api=(p,b)=>Bridge.req(p,{method:"POST",body:JSON.stringify(b||{})});
const ready=()=>typeof Verify!=="undefined"&&Verify.ok&&typeof Login!=="undefined"&&Login.has();
async function load(force){
  if(N.loading||!ready())return;N.loading=true;
  try{const d=await api("/news/calendar");if(!d||!d.ok)throw new Error("x");
    N.off=d.now-Date.now();N.loaded=true;N.fails=0;N.stale=!!d.stale;N.err=d.error||"";N.src=d.source||"";N.upd=d.updated||0;N.hasAct=!!d.has_actual;N.mtz=d.market_tz||"UTC";N.moff=typeof d.market_off==="number"?d.market_off:null;N.msrv=d.market_srv||"";N.live=!!d.mt5_live;N.alerts=d.alerts||{};N.pref=d.pref||{};
    if(d.rev!==N.rev||force){N.rev=d.rev;N.ev=d.events||[]}paint(true)}
  catch(e){N.fails++;N.stale=true;if(!N.loaded)N.err="net";paint(true)}
  N.loading=false;
}
let pollT=0;function schedule(){clearTimeout(pollT);const ms=N.fails?Math.min(60000,8000*2**Math.min(N.fails,3)):60000;pollT=setTimeout(()=>{if(typeof tab!=="undefined"&&tab===2&&!document.hidden)load();schedule()},ms)}
/* ── render: sessions ── */
let root,sigS="",sigC="";
function ensure(){if(root)return;root=$("newsRoot");root.innerHTML='<div class="card" id="nSes"></div><div class="card wk" id="nWk"></div><div class="card" id="nNx"></div><div class="chips" id="nFl" style="margin:12px 0 0"></div><div id="nBn"></div><div id="nCal"></div>';
  $("nFl").onclick=e=>{const b=e.target.closest("[data-f]");if(!b)return;vib();N.flt=+b.dataset.f;try{UI.nf=N.flt;saveUI()}catch(x){}sigC="";paint(true)};
  root.onclick=e=>{const b=e.target.closest("[data-i],[data-a]");if(!b)return;vib();b.dataset.i?infoPop(b.dataset.i):alertPop(b.dataset.a)};
  $("nSes").onchange=e=>{if(e.target.id==="nTz"){const v=e.target.value;N.pref.tz=v;sigC="";sigS="";paint(true);api("/news/pref",{tz:v}).catch(()=>toast("❌ "+t("e_srv")))}}}
function tzOpts(){const cur=dtz(),l=[...new Set([cur,devTz(),"UTC","Asia/Baghdad","Asia/Riyadh","Asia/Dubai","Africa/Cairo","Europe/Istanbul","Europe/London","Europe/Paris","America/New_York","Asia/Tokyo","Asia/Kolkata"])];return l.map(z=>`<option value="${z}"${z===cur?" selected":""}>${z}</option>`).join("")}
function drawSes(){
  const n=now(),tz=dtz(),W=SES.map(s=>({s,w:sesWin(s,n)})),open=W.filter(x=>x.w.open),sig=W.map(x=>x.w.o+"|"+x.w.open).join()+tz+L();
  const sg=sig+"|"+(open.length);
  if(sg!==sigS){sigS=sg;
    $("nSes").innerHTML=`<h3><span class="hl">${ico("globe")||""}${t("n_ses")}</span><span class="mu num" id="nClk"></span></h3><div class="sess">`+W.map(({s,w})=>`<div class="ses${w.open?" on":""}" data-k="${s.k}"><div class="sg" style="--c:${s.col}">${ico(s.ic)}</div><b>${t(s.n)}</b><div class="tm num">${hm(w.o,tz)} — ${hm(w.c,tz)}</div><span class="sti"><i></i><span class="st">${w.open?t("n_cur"):t("n_clo")}</span></span><small class="rm num"></small></div>`).join("")+`</div>`+(open.length>1?`<div class="ovl">${t("n_ovl")} · ${open.map(x=>t(x.s.n)).join(" + ")}</div>`:"")+`<div class="tzr"><span>${t("n_tz")}: <select id="nTz">${tzOpts()}</select></span><span>${t("n_mkt")}: <b class="num" id="nMk">${mhm(n)}</b> ${esc(mlab())}</span></div>`;
    ensureSym()}
  const mk=$("nMk");if(mk)mk.textContent=mhm(n);const ck=$("nClk");if(ck)ck.textContent=hm(n,tz)+" · "+tz;
  document.querySelectorAll("#nSes .ses").forEach((el,i)=>{const w=W[i].w,r=el.querySelector(".rm");r.textContent=w.open?t("n_clin",cd(w.c-n)):(w.o-n<86400000?t("n_opens",cd(w.o-n)):"")});
}
/* ── render: week bar, next event, calendar ── */
const fltOk=e=>N.flt===0||(N.flt===1?(e.impact==="high"||e.impact==="medium"):e.impact==="high");
const nextEv=()=>{const n=now();return N.ev.filter(e=>e.ts>n&&e.impact!=="holiday"&&fltOk(e)).sort((a,b)=>a.ts-b.ts)[0]};
function drawWk(){
  const n=now(),tz=dtz(),tk=dkey(n,tz),wd=(new Date(tk+"T12:00:00Z").getUTCDay()+6)%7,mon=addDays(tk,-wd),sun=addDays(mon,6),wk=isoWeek(tk),nx=nextEv();
  const hi=N.ev.filter(e=>e.impact==="high").length,left=Math.max(0,4-wd);
  $("nWk").innerHTML=`<div class="r1"><div><h4>${t("n_wk")} ${wk} · ${t("n_week")}</h4><div class="dt">${dname(tk,{weekday:"long",month:"long",day:"numeric"})}</div><small class="mu">${dname(mon,{month:"short",day:"numeric"})} — ${dname(sun,{month:"short",day:"numeric"})}</small></div></div><div class="stt"><div><small>${t("n_cnt")}</small><b class="num">${N.ev.length}</b></div><div><small>${t("n_hi")}</small><b class="num dn">${hi}</b></div><div><small>${t("n_left")}</small><b class="num">${left}</b></div></div>`;
  $("nNx").innerHTML=nx?`<h3><span class="hl">${ico("clock")}${t("n_next")}</span>${impB(nx.impact)}</h3><div class="nx"><div class="inf"><b>${flag(nx.cur)} ${esc(nx.title)}</b><small class="num">${esc(nx.country)} · ${nx.cur} · ${hm(nx.ts,tz)}</small><div style="margin-top:6px;font-size:11px;color:var(--mute)">${t("n_in")}</div><div class="cdn num" id="nCd">${cd(nx.ts-n)}</div></div>${alBtn(nx)}</div>`:`<h3><span class="hl">${ico("clock")}${t("n_next")}</span></h3><div class="empty" style="padding:6px">${t("n_none")}</div>`;
}
const alOn=e=>{const a=N.alerts[e.id];return a&&a.status!=="off"&&a.offsets&&a.offsets.length};
function alBtn(e){const on=alOn(e),ended=now()>e.ts+600000;return`<button class="ib al${on?" on":""}" data-a="${e.id}" aria-label="${t(on?"n_aAct":"n_aT")}"${ended?" disabled":""}>${ico("bell")}</button>`}
function stat(e){const n=now(),d=e.ts-n;if(e.actual!=null)return["rel",t("n_s_rel")];if(d>0)return d<1800000?["soon",t("n_s_soon")]:["",t("n_s_up")];if(N.hasAct&&-d<7200000)return["soon",t("n_s_wait")];return["",t("n_s_pass")]}
function vals(e){const v=x=>x==null?t("n_na"):esc(x),n=now();const ac=e.actual!=null?esc(e.actual):(e.ts>n||N.hasAct?"—":t("n_na"));return`<span>${t("n_prev")}<b>${v(e.previous)}</b></span><span>${t("n_fc")}<b>${v(e.forecast)}</b></span><span class="act">${t("n_ac")}<b>${ac}</b></span>`}
function drawCal(force){
  const n=now(),tz=dtz(),tk=dkey(n,tz),sg=N.rev+tz+L()+N.flt+JSON.stringify(N.alerts)+Math.floor(n/30000)+N.stale;if(sg===sigC&&!force)return;sigC=sg;
  const wd=(new Date(tk+"T12:00:00Z").getUTCDay()+6)%7,mon=addDays(tk,-wd),G={};
  N.ev.filter(fltOk).forEach(e=>{(G[dkey(e.ts,tz)]=G[dkey(e.ts,tz)]||[]).push(e)});
  const days=[0,1,2,3,4].map(i=>addDays(mon,i));Object.keys(G).forEach(k=>{if(!days.includes(k))days.push(k)});days.sort();
  const mdf=mdiff(n),sc2=symCur(),sy=String((typeof S!=="undefined"&&S.sym)||"XAUUSD").toUpperCase();
  $("nFl").innerHTML=[0,1,2].map(i=>`<button class="chip" data-f="${i}"${N.flt===i?' style="border-color:var(--gold);color:var(--gold2)"':""}>${t("n_f"+i)}</button>`).join("");
  let h="";if(!N.loaded&&!N.ev.length)h=`<div class="sk2"></div><div class="sk2"></div><div class="sk2"></div>`;
  else h=days.map(k=>{const es=(G[k]||[]).sort((a,b)=>a.ts-b.ts),td=k===tk;
    return`<div class="day${td?" today":k<tk?" past":""}" id="day-${k}"><h5><span>${dname(k,{weekday:"long"})}${td?" — "+t("n_today"):""} <span class="cn num">${dname(k,{month:"short",day:"numeric"})}</span></span><span class="cn">${es.length?es.length+" · "+t("n_hi")+" "+es.filter(x=>x.impact==="high").length:""}</span></h5>`+(es.length?es.map(e=>{const[sc,sl]=stat(e);return`<div class="ev ${sc}"><div class="tm num">${hm(e.ts,tz)}${mdf?`<small>${t("n_mkt")} ${mhm(e.ts)}</small>`:""}</div><div class="nm"><b>${flag(e.cur)}<span>${esc(e.title)}</span></b><small class="mu">${esc(e.country)} · ${e.cur}${sc2.includes(e.cur)&&e.impact!=="holiday"?` · <span class="sy">${esc(sy)}</span>`:""}</small></div><div class="bt">${impB(e.impact)}<span class="bb"><button class="ib al" data-i="${e.id}" aria-label="${t("n_info")}">${ico("info")}</button>${alBtn(e)}</span></div><div class="vals"><span class="stl ${sc}">${sl}</span>${vals(e)}</div></div>`}).join(""):`<div class="empty" style="padding:12px">${t("n_noev")}</div>`)+`</div>`}).join("");
  $("nCal").innerHTML=h;
  $("nBn").innerHTML=(N.stale&&(N.loaded||N.err))?`<div class="bn">${ico("alert")}<div><b>${t("n_down")}</b><small>${N.upd?t("n_upd",hm(N.upd,tz)+":"+String(parts(N.upd,tz).second).padStart(2,"0")):""} · ${t("n_retry")}</small></div></div>`:(N.src?`<div class="tzr" style="margin-top:8px"><span>${t("n_src")}: ${esc(N.src)}${N.live?` <i class="lv" title="${t("n_live")}"></i>`:""}</span><span>${t("n_upd",hm(N.upd,tz))}</span></div>`:"");
  if(N.first&&N.ev.length){N.first=false;const el=$("day-"+tk);el&&setTimeout(()=>el.scrollIntoView({block:"start",behavior:"smooth"}),150)}
}
function paint(f){if(!root)return;drawSes();drawWk();drawCal(f)}
function ensureSym(){}
/* ── popups ── */
const open=h=>{$("sheet").className="sheet pop";$("sheet").innerHTML=h;$("ov").classList.add("show")};
const evById=id=>N.ev.find(e=>e.id===id);
function infoPop(id){const e=evById(id);if(!e)return;const k=kb(e.title),tz=dtz(),d=dname(dkey(e.ts,tz),{weekday:"long",month:"long",day:"numeric"});
  open(`<div class="hd2">${flag(e.cur)}<div><b>${esc(e.title)}</b><small class="mu num">${esc(e.country)} · ${d} · ${hm(e.ts,tz)}</small></div></div><div class="tl">${impB(e.impact)}<span>${Ti(k.n)}</span><span>${e.cur}</span></div><p style="margin-top:8px">${Ti(IMPEXP[e.impact]||IMPEXP.low)}</p>
  <h4>${t("n_why")}</h4><p>${Ti(k.why)}</p><h4>${t("n_mk")}</h4><p>${Ti(k.mk)}</p>${e.cur==="USD"?`<p class="mu">${t("n_gold")}</p>`:""}
  <div class="kv" style="margin-top:12px"><div><small>${t("n_prev")}</small><b class="num">${e.previous==null?t("n_na"):esc(e.previous)}</b></div><div><small>${t("n_fc")}</small><b class="num">${e.forecast==null?t("n_na"):esc(e.forecast)}</b></div><div><small>${t("n_ac")}</small><b class="num">${e.actual==null?"—":esc(e.actual)}</b></div></div>
  <h4>${t("n_pm")}</h4><div class="scn"><b>${t("n_above")}</b>${Ti(k.a)}</div><div class="scn"><b>${t("n_below")}</b>${Ti(k.b)}</div><div class="scn"><b>${t("n_eq")}</b>${L()?"The reaction is often milder, though other details or prior pricing can still move price.":"قد يكون رد الفعل أقل حدة، مع بقاء احتمال الحركة بسبب تفاصيل أخرى أو تسعير مسبق."}</div>
  <h4>${t("n_afd")}</h4><p>${t("n_afdT")}</p><h4>${t("n_why2")}</h4><p>${t("n_why2T")}</p><div class="wn">${t("n_warn")}</div><div class="mu" style="font-size:10.5px;margin-top:8px">${t("n_src")}: ${esc(e.source||N.src)}</div><div class="btns"><button class="btn w" id="pcl">${t("back")}</button></div>`);
  $("pcl").onclick=shut}
function alertPop(id){const e=evById(id);if(!e)return;if(now()>e.ts+600000)return toast("❌ "+t("n_ended"));
  const a=N.alerts[id],on=alOn(e),sel=on?a.offsets:[15,0],tz=dtz(),d=dname(dkey(e.ts,tz),{weekday:"long"});
  open(`<b>${t("n_aT")}</b><p>${esc(e.title)} — ${esc(e.country)}<br><span class="num">${d} — ${hm(e.ts,tz)}</span></p><p>${t("n_aQ")}</p>`+[30,15,5,1,0].map(o=>`<label class="chk2"><input type="checkbox" value="${o}"${sel.includes(o)?" checked":""}>${t("n_o"+o)}</label>`).join("")+`<div class="btns"><button class="btn" id="aNo">${t("n_cancel")}</button><button class="btn go" id="aYes">${t(on?"n_upd2":"n_allow")}</button>${on?`<button class="btn dg w" id="aRm">${t("n_rm")}</button>`:""}</div>`);
  const save=async(en)=>{const offs=[...document.querySelectorAll("#sheet .chk2 input:checked")].map(x=>+x.value);if(en&&!offs.length)return toast("❌ "+t("n_pick"));
    $("aYes").disabled=true;if($("aRm"))$("aRm").disabled=true;
    try{const d=await api("/news/alert",{event_id:id,offsets:en?offs:[],enabled:en});if(d.ok){N.alerts[id]=d.alert&&en?d.alert:{offsets:[],status:"off"};if(!en)delete N.alerts[id];shut();sigC="";paint(true);toast(t(en?"n_aOn":"n_aOff"))}else throw 0}
    catch(x){$("aYes").disabled=false;if($("aRm"))$("aRm").disabled=false;toast("❌ "+t(x&&x.status===409?"n_ended":"e_srv"))}};
  $("aNo").onclick=shut;$("aYes").onclick=()=>save(true);if($("aRm"))$("aRm").onclick=()=>save(false)}
/* order alerts: account-bound, evaluated on the server against every EA sync */
const oOn=k=>(S.oalerts||[]).some(a=>a.key===k&&a.status==="armed");
function obell(k,dis){const on=oOn(k);return`<button class="ib al${on?" on":""}" aria-label="${t("n_oT")}" onclick="YTN.orderAsk('${k}')"${dis||""}>${ico("bell")}</button>`}
function orderAsk(k){const on=oOn(k);
  open(`<b>${t("n_oT")}</b><p>${t(on?"n_oOn":"n_oQ")}</p><div class="btns"><button class="btn" id="oNo">${t("n_cancel")}</button>${on?`<button class="btn dg" id="oRm">${t("n_rm")}</button>`:`<button class="btn go" id="oYes">${t("n_allow")}</button>`}</div>`);
  const go=async(en)=>{[$("oYes"),$("oRm")].forEach(b=>b&&(b.disabled=true));
    try{await api("/order-alert",{key:k,enabled:en});shut();toast(t(en?"n_oOn":"n_oOff"));Bridge.pull()}
    catch(x){[$("oYes"),$("oRm")].forEach(b=>b&&(b.disabled=false));toast("❌ "+t(x&&x.status===404?"n_oGone":"e_srv"))}};
  $("oNo").onclick=shut;$("oYes")&&($("oYes").onclick=()=>go(true));$("oRm")&&($("oRm").onclick=()=>go(false))}
/* notification center + history (server-side records; status = real delivery state) */
async function pullN(){if(!ready())return;try{const d=await api("/news/notifs",{limit:60});if(!d.ok)return;
  const ids=new Set(d.items.map(x=>x.id));
  if(N.seenN){d.items.filter(x=>!x.read&&!N.seenN.has(x.id)).slice(0,2).forEach(x=>{toast(x.title);try{YT&&YT.onToast(false)}catch(e){}})}
  N.seenN=ids;N.notifs=d.items;N.unread=d.unread;const b=$("ntN");if(b){b.hidden=!d.unread;b.textContent=d.unread>9?"9+":d.unread}}catch(e){}}
function ncPop(){
  const row=x=>`<div class="ni${x.read?"":" un"}"><div style="flex:1;min-width:0"><b>${esc(x.title)}</b><small>${esc(x.body)}</small><div class="mt"><span>${t("n_t_"+(x.type||"system"))}</span><span class="${x.status}">${esc(x.status)}</span><span class="num">${dname(dkey(x.at,dtz()),{month:"short",day:"numeric"})} ${hm(x.at,dtz())}</span>${x.account?`<span class="num">#${esc(x.account)}</span>`:""}${x.read?"":`<span style="color:var(--gold2)">${t("n_unr")}</span>`}</div></div></div>`;
  open(`<div style="display:flex;justify-content:space-between;align-items:center"><b>${t("n_nc")}</b><button class="chip" id="nRa">${t("n_readAll")}</button></div><p>${t("n_hist")}</p>`+(N.notifs.length?N.notifs.map(row).join(""):`<div class="empty">${ico("bell")}<br>${t("n_noN")}</div>`)+`<div class="btns"><button class="btn w" id="pcl">${t("back")}</button></div>`);
  $("pcl").onclick=shut;$("nRa").onclick=async()=>{try{await api("/news/read",{all:true});N.notifs.forEach(x=>x.read=true);N.unread=0;$("ntN").hidden=true;ncPop()}catch(e){toast("❌ "+t("e_srv"))}}}
/* ── lifecycle ── */
function init(){
  const sp=document.querySelector("svg defs");if(sp)sp.insertAdjacentHTML("beforeend",SYM+'<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></symbol>');
  const nb=$("ntB");if(nb)nb.onclick=()=>{vib();ncPop()};
  document.querySelectorAll("[data-t]").forEach(e=>e.textContent=t(e.dataset.t));
  const sl=window.setLang;if(typeof sl==="function")window.setLang=function(v){sl(v);try{sigS="";sigC="";root&&paint(true);if(!document.getElementById("ov").classList.contains("show")){}}catch(e){}};
  setInterval(()=>{if(!ready())return;if(!N.loaded&&!N.loading)load();if(typeof tab!=="undefined"&&tab===2&&root){drawSes();const x=nextEv(),c=$("nCd");if(c&&x)c.textContent=cd(x.ts-now());if(x&&x.ts<=now()+500||(c&&!x))drawWk();drawCal(false)}},1000);
  setInterval(()=>{if(!document.hidden)pullN()},30000);
  setTimeout(pullN,2500);schedule();
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){pullN();if(typeof tab!=="undefined"&&tab===2)load()}});
}
window.YTN={open(){ensure();paint(true);load();},obell,orderAsk,refresh(){sigS="";sigC="";root&&paint(true)},state:N};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
