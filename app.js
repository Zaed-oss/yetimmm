/* v4.18 anti-clickjacking (a <meta> CSP cannot set frame-ancestors): framed by anything other than Telegram itself = the app refuses to run. Telegram Web frames Mini Apps; phones / desktop run them top-level. */
(()=>{try{if(window.top!==window&&location.ancestorOrigins&&location.ancestorOrigins.length&&![...location.ancestorOrigins].every(o=>/^https:\/\/([a-z0-9-]+\.)*(telegram\.org|t\.me)$/.test(o))){document.documentElement.textContent="";throw new Error("framed")}}catch(e){if(e&&e.message==="framed")throw e}})();
/* ═════════════ 1) CONFIG — internal only, never shown in the UI ═════════════
   mode "sim"  : local price simulation + local engine (demo)
   mode "live" : server is the source of truth (MT5 bridge / bot backend)
     GET  {baseUrl}/state    -> JSON state (price, state, pos, hist, buy, sell, risk, cur, acc, ...)
     POST {baseUrl}/command  -> {cmd:"start|stop|close|apply|reset|settings|delete", ...params}   (delete: {ticket, side})
   Telegram token: for production keep it on YOUR server and call it from there. */
const CONFIG={
  mode:"live",
  sessionStore:"local",                        // "local" = stay signed in across launches (default) | "session" = token lives only until the app is closed (safer if XSS ever happens; you sign in again each launch)
  staleSec:20,                                 // FALLBACK only: the server reports the real timeout (eaStaleSec in /state) so Worker and app can never disagree
  api:{baseUrl:"https://yetimmm-bridge.sayfhazeem078.workers.dev",pollMs:1000,headers:{}},
  telegram:{token:"",chatId:"",notify:true},
  origins:[]                                   // allowed origins for window.postMessage commands
};

/* ═════════════ 2) I18N — [Arabic, English] ═════════════ */
const D={
sub:["XAUUSD · الذهب مقابل الدولار","XAUUSD · Gold / US Dollar"],demo:["حساب تجريبي","Demo account"],live:["مباشر","Live"],offl:["غير متصل","Offline"],
dB:["المسافة إلى Buy Stop","Distance to Buy Stop"],dS:["المسافة إلى Sell Stop","Distance to Sell Stop"],rng:["نطاق الدورة","Cycle range"],
ordT:["الأوامر المعلقة وإدارة المخاطرة","Pending orders & risk"],buyL:["Buy Stop — أمر شراء معلق","Buy Stop — pending buy"],sellL:["Sell Stop — أمر بيع معلق","Sell Stop — pending sell"],
abv:["أعلى من السعر","Above price"],blw:["أدنى من السعر","Below price"],riskL:["المخاطرة لكل صفقة (Risk $)","Risk per trade (Risk $)"],apply:["تطبيق الأوامر","Apply orders"],
nav0:["التداول","Trade"],nav1:["سجل الصفقات","History"],nav2:["الإعدادات","Settings"],
st_STOPPED:["البوت متوقف","Bot stopped"],sx_STOPPED:["شغّل البوت لوضع الأوامر المعلقة","Start the bot to place pending orders"],
st_IDLE:["بانتظار الأوامر","Waiting for orders"],sx_IDLE:["لا توجد أوامر معلقة حالياً","No pending orders right now"],
st_TP_RESET:["تم جني الأرباح","Take profit hit"],sx_TP_RESET:["أدخل مستويات جديدة لمتابعة التداول","Enter new levels to continue"],
st_ARMED:["الأوامر المعلقة نشطة","Pending orders active"],sx_ARMED:["Buy Stop و Sell Stop بانتظار السعر","Buy Stop & Sell Stop are waiting for price"],
st_BUY_ACTIVE:["صفقة شراء مفتوحة","Buy trade open"],sx_BUY_ACTIVE:["تم حذف أمر Sell Stop","Sell Stop order removed"],
st_SELL_ACTIVE:["صفقة بيع مفتوحة","Sell trade open"],sx_SELL_ACTIVE:["تم حذف أمر Buy Stop","Buy Stop order removed"],
st_WAITING_REENTRY:["بانتظار عودة السعر","Waiting for price to return"],sx_WAITING_REENTRY:["السعر خارج نطاق الأوامر المعلقة","Price is outside the pending range"],
st_ERROR:["خطأ — يلزم تدخل","Error — action needed"],sx_ERROR:["راجع الرسالة أدناه","See the message below"],
stopB:["إيقاف البوت","Stop bot"],startB:["تشغيل البوت","Start bot"],closeB:["إغلاق الصفقة","Close trade"],buy:["شراء BUY","BUY"],sell:["بيع SELL","SELL"],
flt:["الربح / الخسارة العائمة","Floating P/L"],slS:["وقف الخسارة","Stop loss"],tpS:["جني الأرباح","Take profit"],entry:["سعر الدخول","Entry"],slK:["وقف الخسارة SL","Stop loss SL"],tpK:["جني الأرباح TP","Take profit TP"],
lot:["حجم اللوت","Lot size"],riskK:["المخاطرة","Risk"],expK:["الربح المتوقع","Expected profit"],rmT:["إدارة المخاطرة","Risk management"],seq:["الصفقة {0} في التسلسل","Trade {0} in sequence"],
curR:["المخاطرة الحالية","Current risk"],accL:["الخسائر المتراكمة","Accumulated loss"],
net:["صافي الأرباح والخسائر (Net P/L)","Net profit / loss (Net P/L)"],tot:["إجمالي الصفقات","Total trades"],win:["صفقات رابحة","Winning trades"],rate:["نسبة الربح","Win rate"],
logT:["سجل الصفقات — هذا الأسبوع","Trade history — this week"],wkR:["من الاثنين 00:00 إلى الأحد 23:59 (توقيت السيرفر) · يُحتفظ بالسجل الكامل داخلياً","Monday 00:00 – Sunday 23:59 (server time) · the full history is kept internally"],e_generic:["تعذر تنفيذ العملية حالياً. يرجى المحاولة مرة أخرى.","The operation could not be completed right now. Please try again."],cyc_q:["إيقاف / إعادة ضبط الدورة","Stop / reset the cycle"],cyc_b:["سيتم حذف حالة الدورة المحفوظة{0}. لن يُحذف سجل الصفقات التاريخي.","The saved cycle state will be cleared{0}. The historical trade log is NOT deleted."],cyc_o:[" وإلغاء {0} أمر معلّق"," and {0} pending order(s) cancelled"],cyc_y:["متابعة","Continue"],cyc_blk:["لا يمكن إعادة ضبط الدورة الآن لأن هناك عملية تداول نشطة.","The cycle cannot be reset now: a trade is active."],cyc_pnd:["هناك أمر قيد التنفيذ. انتظر قليلاً ثم أعد المحاولة.","A command is still in progress. Wait a moment and try again."],cyc_ok:["أُرسل طلب إعادة ضبط الدورة","Cycle reset requested"],cyc_btn:["دورة جديدة","New cycle"],none:["لا توجد سجلات بعد","Nothing logged yet"],buyW:["شراء","Buy"],sellW:["بيع","Sell"],lots:["لوت","lots"],
r_SL:["وقف الخسارة","Stop loss"],r_TP:["جني الأرباح","Take profit"],r_MANUAL:["إغلاق يدوي","Manual close"],
tgt:["هدف الربح الصافي بعد التعويض ($)","Net profit target after recovery ($)"],tgtN:["تُسدَّد كل الخسائر السابقة ثم يبقى هذا الربح الصافي. يُحسب جني الأرباح تلقائياً من اللوت الفعلي ومواصفات الرمز والتكاليف. المخاطرة تزداد 5% بعد كل خسارة","All earlier losses are repaid, then this NET profit remains. Take profit is computed automatically from the actual lot, symbol spec and costs. Risk grows 5% after every loss"],
rrL:["نسبة المخاطرة إلى العائد (احتياطي فقط)","Risk-to-reward (fallback only)"],rrN:["لا تُستخدم إلا إن تعذّر حساب لوت قابل للتنفيذ؛ الهدف الفعلي يُحسب من اللوت","Used only while no executable lot exists; the real target is computed from the lot"],
dev:["أقصى انزلاق سعري (نقطة)","Max slippage (points)"],save:["حفظ الإعدادات","Save settings"],reset:["إعادة ضبط تسلسل المخاطرة","Reset risk sequence"],
e_pos:["الأسعار يجب أن تكون أرقاماً موجبة","Prices must be positive numbers"],e_ord:["سعر Buy Stop يجب أن يكون أعلى من سعر Sell Stop","Buy Stop must be above Sell Stop"],
e_lot0:["تعذّر حساب حجم اللوت","Can't calculate lot size"],e_lotMin:["حجم اللوت المطلوب أقل من الحد الأدنى للوسيط ({0})","Required lot is below the broker minimum ({0})"],e_lotMax:["حجم اللوت يتجاوز الحد الأقصى للوسيط","Lot size exceeds the broker maximum"],
e_buyP:["Buy Stop يجب أن يكون أعلى من السعر الحالي","Buy Stop must be above the current price"],e_sellP:["Sell Stop يجب أن يكون أدنى من السعر الحالي","Sell Stop must be below the current price"],
e_risk:["المخاطرة يجب أن تكون أكبر من صفر","Risk must be greater than zero"],e_tneg:["هدف الربح بعد التعويض لا يكون سالباً","Recovery profit target can't be negative"],e_rr:["النسبة يجب أن تكون أكبر من صفر","Ratio must be greater than zero"],e_neg:["القيم يجب ألا تكون سالبة","Values can't be negative"],
aSL:["وقف الخسارة (تلقائي)","Stop loss (auto)"],aTP:["جني الأرباح TP","Take profit TP"],
pv:["حجم اللوت {0} · أقصى خسارة ${1} · الربح الصافي المطلوب ${2}","Lot {0} · Max loss ${1} · Required net profit ${2}"],pvA:[" · يُطبَّق بعد إغلاق الصفقة"," · applies after the trade closes"],
t_start:["تم تشغيل البوت","Bot started"],t_startF:["❌ تعذّر التشغيل: {0}","❌ Can't start: {0}"],t_stop:["تم إيقاف البوت وحذف الأوامر المعلقة","Bot stopped and pending orders removed"],
t_exec:["تم تنفيذ {0} عند {1}","{0} executed at {1}"],t_ob:["أمر الشراء","Buy order"],t_os:["أمر البيع","Sell order"],
t_sl:["وقف الخسارة {0}$ · المخاطرة التالية ${1}","Stop loss {0}$ · next risk ${1}"],t_tp:["تم جني الأرباح {0}$","Take profit {0}$"],
t_applied:["تم تحديث الأوامر المعلقة","Pending orders updated"],t_pend:["تم الحفظ — تُطبَّق بعد إغلاق الصفقة الحالية","Saved — applies after the current trade closes"],
t_reset:["تمت إعادة ضبط تسلسل المخاطرة","Risk sequence reset"],t_noReset:["لا يمكن أثناء وجود صفقة مفتوحة","Not possible while a trade is open"],
l_sim:["وضع تجريبي (محاكاة)","Demo mode (simulation)"],l_wait:["جارٍ الاتصال بالخادم…","Connecting…"],
l_srv:["تعذّر الوصول إلى الخادم","Server unreachable"],l_srvS:["تحقق من الإنترنت — جارٍ إعادة المحاولة","Check your internet — retrying"],
l_auth:["انتهت الجلسة","Session expired"],l_authS:["سجّل الدخول من جديد","Please sign in again"],
l_off:["الـ EA غير متصل","EA offline"],l_offS:["شغّل Yetimmm على شارت XAUUSD داخل MT5","Run Yetimmm on an XAUUSD chart in MT5"],l_last:["آخر اتصال قبل {0}","last seen {0} ago"],
l_okWait:["البوت متصل · بانتظار الأوامر","Bot connected · waiting for commands"],l_okRun:["البوت متصل · يعمل","Bot connected · running"],
l_okTrade:["البوت متصل · صفقة مفتوحة","Bot connected · trade open"],l_okErr:["البوت متصل · يوجد خطأ","Bot connected · error"],l_upd:["آخر تحديث قبل {0}","updated {0} ago"],
noLink:["لا يمكن إرسال الأوامر — البوت غير متصل","Can't send — the bot is not connected"],t_sent:["تم إرسال الأمر إلى البوت…","Command sent to the bot…"],
r_STOP:["إيقاف يدوي","Manual stop"],r_CANCEL:["إلغاء","Cancel"],r_EXT:["إغلاق خارجي","External close"],r_SO:["Stop Out","Stop Out"],r_DEV:["رفض الانزلاق","Slippage reject"],r_EXTRA:["إغلاق صفقة زائدة","Extra position closed"],r_PROT:["إغلاق حماية","Protection close"],r_OTH:["أخرى","Other"],
back:["رجوع","Back"],q_open:["توجد صفقة مفتوحة","A trade is open"],q_openB:["سيتم إغلاق الصفقة ({0} $) ثم إيقاف البوت.","The trade ({0} $) will be closed, then the bot stops."],q_openY:["إغلاق وإيقاف","Close & stop"],
q_close:["إغلاق الصفقة","Close trade"],q_closeB:["الربح/الخسارة الحالية: {0} $. لن يعيد البوت إنشاء الأوامر تلقائياً بعد الإغلاق اليدوي.","Current P/L: {0} $. The bot won't recreate orders automatically after a manual close."],
q_reset:["إعادة ضبط تسلسل المخاطرة","Reset risk sequence"],q_resetY:["إعادة ضبط","Reset"],q2T:["تأكيد نهائي","Final confirmation"],q_stop:["إيقاف التداول","Stop trading"],q_stopB:["يوقف البوت ويحذف الأوامر المعلّقة. لا يُصفّر الخسائر المتراكمة ({0} $).","Stops the bot and deletes pending orders. It does not clear the accumulated loss ({0} $)."],q_stopY:["إيقاف","Stop"],q2_stop:["هل أنت متأكد من إيقاف البوت الآن؟{0}","Are you sure you want to stop the bot now?{0}"],q2_stopR:[" تنبيه: بدء التشغيل بعد الإيقاف يصفّر الخسائر المتراكمة حسب إعداد الـ EA."," Note: starting again after a stop clears the accumulated loss (EA setting)."],q2_open:["تأكيد أخير: تُغلق الصفقة بسعر السوق الآن ثم يتوقف البوت.{0}","Last check: the trade is closed at market now, then the bot stops.{0}"],q2_close:["تأكيد أخير: تُغلق الصفقة بسعر السوق الآن. لا يتوقف البوت ولا تُحذف الأوامر ولا تُصفَّر الخسائر.","Last check: the trade is closed at market now. The bot is not stopped, no orders are deleted and losses are not cleared."],q_resetB2:["يُصفَّر التسلسل (Seq {1}) والخسارة التراكمية {2} $ وتعود المخاطرة إلى ${0}.","The sequence (Seq {1}) and the accumulated loss {2} $ are cleared and risk returns to ${0}."],q2_reset:["تأكيد أخير: لا يمكن التراجع. هذا ليس إيقافاً ولا إغلاقاً للصفقة.","Last check: this cannot be undone. It is not a stop and it does not close a trade."],
oB:["Buy Stop","Buy Stop"],oS:["Sell Stop","Sell Stop"],q_delY:["حذف","Delete"],
fillM:["تعبئة أسعار صالحة من السوق","Fill valid levels from market"],fillE:["لا يوجد سعر حي من البوت","No live price from the bot"],mkB:["Buy Stop {0} تحت السعر الحالي (Ask {1}): يُقبل ويبقى بالانتظار، ويُوضع تلقائياً عندما يهبط Ask إلى {2} أو أقل","Buy Stop {0} is under the market (Ask {1}): accepted, it waits and is placed automatically when Ask falls to {2} or lower"],mkS:["Sell Stop {0} فوق السعر الحالي (Bid {1}): يُقبل ويبقى بالانتظار، ويُوضع تلقائياً عندما يصعد Bid إلى {2} أو أعلى","Sell Stop {0} is above the market (Bid {1}): accepted, it waits and is placed automatically when Bid rises to {2} or higher"],oldEA:["الـ EA المحمّل على MT5 نسخة قديمة: يرفض المستويات ولا يدعم الانتظار الذكي. ترجم Yetimmm.mq5 (v2.20) بـ F7 وأعد تحميله على الشارت.","The EA running in MT5 is an old version: it rejects levels and has no smart waiting. Compile Yetimmm.mq5 (v2.20) with F7 and reload it on the chart."],wB:["Ask الآن {0} · يُفعَّل عندما يهبط إلى {1} أو أقل · المتبقي {2}","Ask now {0} · activates when it falls to {1} or lower · {2} to go"],wS:["Bid الآن {0} · يُفعَّل عندما يصعد إلى {1} أو أعلى · المتبقي {2}","Bid now {0} · activates when it rises to {1} or higher · {2} to go"],
fillA:["ضُبطت مستويات حسب السعر الحالي","Levels set from the live price"],ea_wb:["Buy Stop {0} بالانتظار: Ask الآن {1}، يُوضع تلقائياً عندما يهبط إلى {2} أو أقل","Buy Stop {0} waiting: Ask is {1}, placed automatically when it falls to {2} or lower"],ea_ws:["Sell Stop {0} بالانتظار: Bid الآن {1}، يُوضع تلقائياً عندما يصعد إلى {2} أو أعلى","Sell Stop {0} waiting: Bid is {1}, placed automatically when it rises to {2} or higher"],ea_buy:["Buy Stop {0} مرفوض: يجب أن يكون أعلى من Ask ({1})","Buy Stop {0} rejected: must be above Ask ({1})"],ea_sell:["Sell Stop {0} مرفوض: يجب أن يكون أدنى من Bid ({1})","Sell Stop {0} rejected: must be below Bid ({1})"],ea_conn:["لا يوجد اتصال بين MT5 وخادم الوسيط","MT5 has no connection to the broker server"],ea_at:["زر AutoTrading في MT5 متوقف","AutoTrading is disabled in MT5"],
addB:["إضافة أمر {0}","Add {0} order"],okB:["تأكيد","Confirm"],acT:["الحساب","Account"],aBal:["الرصيد","Balance"],aEq:["الإكوتي","Equity"],aFl:["الربح العائم","Floating P/L"],aMg:["الهامش","Margin"],aFm:["الهامش الحر","Free margin"],aLev:["الرافعة","Leverage"],
sxT:["إحصائيات مفصلة","Detailed statistics"],sPf:["معامل الربح","Profit factor"],sAw:["متوسط الربح","Avg win"],sAl:["متوسط الخسارة","Avg loss"],sMw:["أكبر ربح","Best trade"],sMl:["أكبر خسارة","Worst trade"],sBs:["شراء / بيع","Buy / Sell"],sVol:["الحجم الكلي","Total volume"],sCm:["العمولة + السواب","Comm. + swap"],sSt:["السلسلة الحالية","Current streak"],stM:["البوت متوقف","Bot stopped"],stMB:["تم تجميد السعر عند {0} · لا أوامر ولا صفقات ولا تحديثات حتى تعيد التشغيل","Price frozen at {0} · no orders, trades or updates until you restart"],rst:["إعادة التشغيل","Restart"],vw:["عرض فقط","View only"],frzL:["السعر مجمّد","Price frozen"],};
let LG=0;                                             // 0 = Arabic, 1 = English
Object.assign(D,{
op_ing:["جارٍ الحذف…","Deleting…"],
op_busy:["العملية قيد التنفيذ، انتظر نتيجتها","An operation is already in progress, wait for its result"],
op_delOk:["تم حذف الأمر من MT5 وتأكد اختفاؤه","Order deleted from MT5 and verified"],
op_delFail:["لم يُحذف الأمر: {0}","The order was not deleted: {0}"],
op_filled:["لم يُحذف الأمر لأنه نُفّذ فعلاً وصار صفقة","Not deleted: the order was already filled and is now a trade"],
op_unver:["لم يتأكد الحذف خلال المهلة. الأمر معروض كما يظهر في MT5 الآن","Delete not confirmed in time. The order is shown as MT5 reports it now"],
op_unverG:["لم يصل تأكيد العملية من البوت. تحقق من الحالة ثم أعد المحاولة","No confirmation from the bot. Check the status, then retry"],
op_wait:["بانتظار تنفيذ MT5…","Waiting for MT5…"],
out_ing:["جارٍ الخروج…","Signing out…"],
out_ic:["ستُنهى الجلسة على هذا الجهاز ويُطلب إبطالها من الخادم.","This device's session will be ended and revoked on the server."],
lg_busy:["جارٍ التحقق…","Verifying…"]
});
const _e=x=>String(x==null?"":x).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),   /* v4.18: everything that is not a dictionary text is escaped: server values can never become markup */
  t=(k,...a)=>(D[k]?D[k][LG]:_e(String(k).replace(/^(r|st|sx)_/,""))).replace(/\{(\d)\}/g,(_,i)=>_e(a[i]));

/* ═════════════ 3) STATE + helpers ═════════════ */

Object.assign(D,{plc:["جارٍ وضع الأمر في MT5…","Placing the order in MT5…"],pdT:["الأوامر المعلقة","Pending orders"],editBoth:["تعديل الأمرين","Edit both"],delBoth:["حذف الأمرين","Delete both"],q_delBoth:["حذف الأمرين معًا؟","Delete both orders?"],q_delBothB:["سيُحذف Buy Stop و Sell Stop معًا من MT5 في خطوة واحدة. الصفقة المفتوحة (إن وجدت) تبقى.","Buy Stop and Sell Stop will be deleted from MT5 together in one step. An open trade (if any) stays."],mpT:["تعديل الأمرين","Edit both orders"]});
Object.assign(D,{lg_t:["تسجيل الدخول","Sign in"],lg_s:["ادخل رقم حساب MT5 وكلمة السر للتحكم بالبوت","Enter your MT5 account number and password to control the bot"],lg_acc:["رقم حساب MT5","MT5 account number"],lg_pw:["كلمة السر","Password"],lg_show:["إظهار","Show"],lg_go:["تسجيل الدخول","Sign in"],
lg_hint:["اكتب رقم حساب MT5 وكلمة السر. البوت لازم يكون شغّال على MT5، وبعد الدخول يبقى حسابك مسجَّلاً تلقائياً.","Enter your MT5 account number and the password. The bot must be running on MT5; after signing in you stay signed in automatically."],
lg_wait:["جاري الاتصال بالبوت…","Connecting to the bot…"],lg_waitS:["انتظر لحظات","Please wait"],lg_ok:["تم تسجيل الدخول","Signed in"],
e_login:["رقم الحساب غير صحيح","Invalid account number"],e_pw_short:["كلمة السر غير صحيحة","Wrong password"],
e_bad_pw:["كلمة السر غير صحيحة","Wrong password"],
e_ea_offline:["البوت غير شغّال على هذا الحساب. شغّل البوت على MT5 وتأكد أن AutoTrading مفعّل.","The bot is not running on this account. Start it on MT5 and make sure AutoTrading is ON."],
e_pair_closed:["الحساب غير مربوط بعد ونافذة الربط انتهت. أعد تشغيل البوت على MT5 ثم حاول.","This account is not paired yet and the pairing window has closed. Restart the bot on MT5, then try again."],
e_srv:["تعذّر الاتصال بالخادم","Could not reach the server"],e_not_configured:["الخادم غير مهيّأ: لم تُضبط كلمة السر بعد (wrangler secret put APP_PASSWORD)","Server not configured: no password set yet (wrangler secret put APP_PASSWORD)"],e_too_large:["الطلب كبير جداً","Request too large"],
e_relogin:["انتهت الجلسة. سجّل الدخول من جديد.","Your session ended. Please sign in again."],e_tg_only:["افتح التطبيق من داخل بوت تلجرام لتسجيل الدخول","Open the app from inside the Telegram bot to sign in"],
e_tg_stale:["انتهت صلاحية إثبات تلجرام. أغلق التطبيق وافتحه من البوت من جديد","Your Telegram proof expired. Close the app and open it again from the bot"],e_too_many_sessions:["عدد الجلسات المفتوحة لهذا الحساب وصل الحد الأقصى الآمن. سجّل الخروج من جهاز قديم ثم أعد المحاولة","This account reached the safe maximum of open sessions. Sign out on an old device and try again"],e_pw_empty:["اكتب كلمة السر","Enter the password"],
q_out:["تسجيل الخروج","Sign out"],q_outB:["ستخرج من الحساب وتعود لصفحة تسجيل الدخول، ويُعاد تحميل كل شيء من جديد.","You will leave this account and return to the sign-in page; everything reloads from scratch."],q_outY:["خروج","Sign out"],outB:["خروج","Sign out"],
offT:["الـ EA مطفي","The EA is off"],offB:["يرجى تشغيل Yetimmm على شارت XAUUSD داخل MT5 (وتأكد أن AutoTrading مفعّل). بعد التشغيل ستدخل تلقائياً.","Please start Yetimmm on an XAUUSD chart in MT5 (and make sure AutoTrading is ON). After it starts you will be signed in automatically."],
st_ea:["البوت (EA)","EA"],st_br:["الجسر (Worker)","Bridge"],st_mt:["منصة MT5","MT5"],st_tr:["التداول","Trading"],
v_on:["يعمل","Online"],v_off:["متوقف","Offline"],v_con:["متصل","Connected"],v_dis:["غير متصل","Disconnected"],v_unk:["غير معروف","Unknown"],v_en:["مفعّل","Enabled"],v_dsb:["معطّل","Disabled"],
tr_auto:["زر AutoTrading في MT5 مطفي","AutoTrading is OFF in MT5"],tr_exp:["التداول الآلي غير مسموح لهذا الـ EA (راجع إعدادات الـ EA)","Algo trading is not allowed for this EA (check the EA settings)"],tr_acc:["الحساب لا يسمح بالتداول","Trading is disabled on this account"],tr_exa:["الحساب لا يسمح بالتداول عبر الخبراء (EA)","This account does not allow Expert Advisors"],tr_tm:["السوق مغلق أو الرمز لا يقبل أوامر الآن","Market closed or the symbol is not tradable right now"],
trOffT:["التداول معطّل في MT5","Trading is disabled in MT5"],
wfT:["بانتظار السعر","WAITING FOR PRICE"],wfR:["السبب","Reason"],wfR1:["السعر خارج منطقة وضع الأوامر — ستوضع الأوامر تلقائياً عند دخول السعر المنطقة","Price is outside the placement zone — the orders are placed automatically when the market enters it"],wfR2:["بانتظار دخول السوق إلى منطقة وضع الأوامر","Waiting for the market to enter the placement zone"],
rrHi:["ℹ️ نسبة فعلية 1:{0} — الهدف TP يبعد {0} ضعف مسافة الوقف ({1}$) · شراء TP {2} · بيع TP {3}","ℹ️ Effective ratio 1:{0} — TP is {0}× the SL distance (${1}) · BUY TP {2} · SELL TP {3}"],
aVol:["حجم الصفقات المفتوحة","Open volume"],aNp:["الصفقات المفتوحة","Open positions"],aMl:["مستوى الهامش","Margin level"],aSrv:["السيرفر","Server"],aLot:["لوت","lots"]});
const $=i=>document.getElementById(i);
const ic=n=>`<svg class="ic i3 i-${n}"><use href="#i-${n}"/></svg>`;
const idn=v=>{const n=Math.trunc(Number(v));return Number.isFinite(n)&&n>=0?String(n):"0"};   /* ticket / trade numbers are printed ONLY through this */
const _n=v=>{const n=Number(v);return Number.isFinite(n)?n:0},_sd=v=>{const s=String(v==null?"":v).toUpperCase();return s[0]==="B"?"BUY":s[0]==="S"?"SELL":""};
function cleanState(d){   /* v4.18: type every field the UI prints (the Worker does it too: defence in depth) */
  if(!d||typeof d!=="object")return d;
  delete d["__proto__"];delete d.constructor;      /* an own "__proto__" key from JSON.parse would make Object.assign(S,d) replace S's prototype */
  if(d.pos&&typeof d.pos==="object"){for(const k of["pid","entry","sl","tp","lot","est","risk","no","profit"])if(k in d.pos)d.pos[k]=_n(d.pos[k]);d.pos.side=_sd(d.pos.side)}
  const L=(a,nums)=>Array.isArray(a)?a.filter(o=>o&&typeof o==="object").map(o=>{for(const k of nums)if(k in o)o[k]=_n(o[k]);o.side=_sd(o.side);return o}):a;
  d.orders=L(d.orders,["ticket","price","lot","sl","tp"]);d.waits=L(d.waits,["level","trig","now","dist"]);
  if(Array.isArray(d.hist))d.hist=L(d.hist,["no","entry","exit","lot","pnl","ts"]).map(h=>{h.reason=String(h.reason==null?"":h.reason).slice(0,60);return h});
  return d}
const f=(v,d=2)=>Number(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const sg=v=>(v>=0?"+":"−")+f(Math.abs(v)),cl=v=>v>=0?"up":"dn",r2=v=>Math.round(v*100)/100;
const num=v=>{const n=parseFloat(String(v).replace(",","."));return isNaN(n)?0:n};
const fp=v=>f(v,pd()),fv=v=>f(v,vd());
let S={price:4137.5,run:false,state:"STOPPED",msg:"",buy:4138,sell:4137,risk:1,cur:1,acc:0,seq:0,no:0,pend:null,pos:null,hist:[],target:20,rr:20,maxDev:30,warn:60,breach:"WAIT",orders:[],cmds:[]},prev,T,tab=0,UI={};
/*RISK-CORE-BEGIN*/
/* v4.8: the UI NEVER assumes contract / step / min / max / digits / currency. Live mode reads the BrokerSpec the EA publishes (S.bs) and shows the EA's own RiskResult (S.rk).
   The same arithmetic is used here ONLY for the preview and for the simulation, against an explicit, selectable broker profile. */
const SIM_PROFILES={
  "XAU-100-0.01":{contract:100,tick:.01,tvl:1,vmin:.01,vstep:.01,vmax:100,vlimit:0,vdig:2,digits:2,ccy:"USD",stops:0,point:.01,spr:0},
  "XAU-1-0.001":{contract:1,tick:.01,tvl:.01,vmin:.001,vstep:.001,vmax:100,vlimit:0,vdig:3,digits:2,ccy:"USD",stops:0,point:.01,spr:0},
  "XAU-100-0.1":{contract:100,tick:.01,tvl:1,vmin:.1,vstep:.1,vmax:1000,vlimit:0,vdig:1,digits:2,ccy:"USD",stops:0,point:.01,spr:0},
  "XAU-100-EUR":{contract:100,tick:.01,tvl:.92,vmin:.01,vstep:.01,vmax:100,vlimit:0,vdig:2,digits:2,ccy:"EUR",stops:0,point:.01,spr:0},
  "XAU-100-LIMIT1":{contract:100,tick:.01,tvl:1,vmin:.01,vstep:.01,vmax:100,vlimit:1,vdig:2,digits:2,ccy:"USD",stops:0,point:.01,spr:0}
};
let SIMP="XAU-100-0.01";
function perLotLoss(bs,d){return bs.tvl>0&&bs.tick>0?d/bs.tick*bs.tvl:d*bs.contract}
function calcRisk(bs,risk,entry,sl,policy){
  const d=Math.abs(entry-sl),o={ok:false,status:"NO_SPEC",req:risk,raw:0,vol:0,vmin:bs.vmin,eff:0,minRisk:0,perLot:0,clamped:false,policy:policy==="CLAMP_TO_MIN"?"CLAMP_TO_MIN":"STRICT",ccy:bs.ccy||"USD"};
  if(!(d>1e-12)||!(bs.vstep>0)||!(bs.vmin>0))return o;
  const pl=perLotLoss(bs,d);if(!(pl>0))return o;
  const cpl=bs.cpl>0?bs.cpl:0,pa=pl+cpl;   /* v4.16: loss at SL = price loss + round-trip commission per lot (same as the EA) */
  o.perLot=pl;o.cost=cpl;o.minRisk=bs.vmin*pa;o.raw=risk/pa;
  let lot;
  if(o.raw<bs.vmin-1e-9){if(o.policy==="CLAMP_TO_MIN"){lot=bs.vmin;o.clamped=true}else{o.status="BELOW_MIN";return o}}
  else lot=bs.vmin+Math.floor((o.raw-bs.vmin)/bs.vstep+1e-7)*bs.vstep;
  lot=Number(lot.toFixed(bs.vdig==null?8:bs.vdig));
  if(lot>bs.vmax+1e-9){o.status="ABOVE_MAX";return o}
  if(bs.vlimit>0&&lot>bs.vlimit+1e-9){o.status="ABOVE_LIMIT";return o}
  o.vol=lot;o.eff=lot*pa;o.ok=true;o.status=o.clamped?"CLAMPED":"OK";return o;
}
/*RISK-CORE-END*/
const spec=()=>live()?(S.bs||null):SIM_PROFILES[SIMP];
const ccyL=()=>{const b=spec();return(b&&b.ccy)||(S.acct&&S.acct.cur)||"USD"};
const cs=()=>ccyL()==="USD"?"$":ccyL()+" ";
const pd=()=>{const b=spec();return b&&b.digits!=null?b.digits:2};
const vd=()=>{const b=spec();return b&&b.vdig!=null?b.vdig:2};
const tickSz=()=>{const b=spec();return b&&b.tick>0?b.tick:.01};
const CS=()=>{const b=spec();return b&&b.contract>0?b.contract:100};
(function(){try{const q=new URLSearchParams(location.search).get("profile");if(q&&SIM_PROFILES[q])SIMP=q}catch(e){}})();
if(CONFIG.mode!=="live"){try{const r=localStorage.getItem("ytPro");if(r)Object.assign(S,JSON.parse(r))}catch(e){}}else{S.price=0;S.hist=[];S.state="STOPPED";
  /* v4.19: resume the SAME session: the last server snapshot saved on this device (same login only) is shown at once; the first live pull replaces it */
  try{const sn=JSON.parse(localStorage.getItem("ytSnap")||"null");if(sn&&sn.d&&typeof sn.d==="object"&&sn.l&&sn.l===localStorage.getItem("ytL")){cleanState(sn.d);Object.assign(S,sn.d)}}catch(e){}}
try{UI=JSON.parse(localStorage.getItem("ytUI"))||{}}catch(e){}
prev=S.price;const SP=S.price?[S.price]:[];
const save=()=>{try{localStorage.setItem("ytPro",JSON.stringify(S))}catch(e){}};
const saveUI=()=>{try{localStorage.setItem("ytUI",JSON.stringify(UI))}catch(e){}};
let tt;const toast=m=>{try{window.YT&&YT.onToast(String(m).startsWith("❌"))}catch(x){}try{const hf=TG.wa&&TG.wa.HapticFeedback;hf&&hf.notificationOccurred(String(m).startsWith("❌")?"error":"success")}catch(x){}const e=$("toast"),bad=m.startsWith("❌"),sp=document.createElement("span");e.innerHTML=ic(bad?"alert":"check");sp.textContent=bad?m.slice(1).trim():m;e.append(sp);e.classList.toggle("bad",bad);e.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>e.classList.remove("show"),2800)};
const vib=()=>{try{(!navigator.userActivation||navigator.userActivation.hasBeenActive)&&navigator.vibrate&&navigator.vibrate(12);const h=TG.wa&&TG.wa.HapticFeedback;h&&h.impactOccurred("light")}catch(e){}};

/* ═════════════ 4) EVENT BUS (hook for bots / external code) ═════════════
   events: cmd, start, stop, open, close, price, state                      */
const Bus={h:{},on(e,fn){(this.h[e]=this.h[e]||[]).push(fn)},emit(e,d){(this.h[e]||[]).concat(this.h["*"]||[]).forEach(fn=>{try{fn(d,e)}catch(x){console.error(x)}})}};

/* ═════════════ 5) TELEGRAM (internal) ═════════════ */
const TG={wa:null,
  init(){const w=window.Telegram&&Telegram.WebApp;if(!w)return;this.wa=w;w.ready();w.expand()},
  send(txt){const c=CONFIG.telegram;if(!c.notify||!c.token||!c.chatId)return;
    fetch("https://api.telegram.org/bot"+c.token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:c.chatId,text:txt,parse_mode:"HTML"})}).catch(()=>{})}
};
Bus.on("start",()=>TG.send("🟢 <b>Yetimmm</b> started"));
Bus.on("stop",()=>TG.send("🔴 <b>Yetimmm</b> stopped"));
Bus.on("open",p=>TG.send(`📌 <b>${_sd(p.side)}</b> #${idn(p.no)}\nEntry ${f(p.entry)} · SL ${f(p.sl)} · TP ${f(p.tp)}\nLot ${f(p.lot)} · Risk $${f(p.risk)}`));
Bus.on("close",h=>TG.send(`${h.pnl>=0?"✅":"❌"} #${idn(h.no)} ${_sd(h.side)} ${_e(h.reason)}\n${f(h.entry)} → ${f(h.exit)} · <b>${sg(h.pnl)}$</b>`));

/* ═════════════ 6) BRIDGE (live mode: bot / MT5 backend) ═════════════ */
const SES=(()=>{const st=()=>{try{return CONFIG.sessionStore==="session"?sessionStorage:localStorage}catch(e){return null}},ls=()=>{try{return localStorage}catch(e){return null}};
  const rd=(k)=>{try{return st().getItem(k)||""}catch(e){return""}};
  return{get l(){try{return ls().getItem("ytL")||""}catch(e){return""}},get s(){return rd("ytS")},
  set(l,x){try{ls().setItem("ytL",l);if(CONFIG.sessionStore==="session")ls().removeItem("ytS");st().setItem("ytS",x)}catch(e){}},
  clr(){try{ls().removeItem("ytSnap")}catch(e){}try{ls().removeItem("ytS")}catch(e){}try{sessionStorage.removeItem("ytS")}catch(e){}}}})();
const live=()=>CONFIG.mode==="live"&&!!CONFIG.api.baseUrl;
const snapSave=(()=>{let t=0;return d=>{const n=Date.now();if(n-t<3000||CONFIG.sessionStore==="session")return;t=n;try{const j=JSON.stringify(d);if(j.length<400000)localStorage.setItem("ytSnap",JSON.stringify({l:SES.l,t:n,d}))}catch(e){}}})();
/* ═════ v4.10 · command lifecycle (Ops) ═════
   sent → accepted (EA ack) → VERIFIED (state really changed) | failed | unverified (timeout).
   The UI never claims success before the live state confirms it; a row being deleted is shown as "deleting…", never silently removed. */
const Ops={m:new Map(),dids:new Set(),log:[],TO:{delete:15000,_:12000},
  key(c,p){p=p||{};return c==="delete"?"delete:"+(p.ticket>0?"t"+p.ticket:"s"+(p.side||"")):c},
  add(c,p){const k=this.key(c,p);if(this.m.has(k))return null;const o={k,c,p:p||{},at:Date.now(),id:null,rid:"o"+Date.now().toString(36)+Math.random().toString(36).slice(2,5)};this.m.set(k,o);this.note(o,"sent");return o},
  note(o,ev,why){this.log.unshift({t:new Date().toISOString(),op:o.rid,cmd:o.c,ev,id:o.id,ticket:(o.p&&o.p.ticket)||null,side:(o.p&&o.p.side)||null,why:why||""});if(this.log.length>120)this.log.length=120},
  end(o,ev,why){this.m.delete(o.k);this.note(o,ev,why)},
  active(){return this.m.size>0},
  delTk(tk){return this.m.has("delete:t"+tk)},
  delSd(sd){return this.m.has("delete:s"+sd)},
  byId(id){for(const o of this.m.values())if(o.id&&o.id===id)return o;return null},
  /* an EA acknowledgement (lastCmd) arrived */
  ack(lc){const o=this.byId(lc.id);if(!o)return false;o.ack=true;o.ok=!!lc.ok;o.cat=lc.cat||"";o.text=lc.text||"";this.note(o,lc.ok?"ea_ok":"ea_fail",lc.cat==="tech"?"technical":o.text);return true},
  /* evaluate every open operation against the freshest state */
  settle(){
    const now=Date.now();let changed=false;
    for(const o of [...this.m.values()]){
      const to=this.TO[o.c]||this.TO._,age=now-o.at;
      if(o.c==="delete"){
        const tk=o.p.ticket,gone=tk>0?!(S.orders||[]).some(x=>x.ticket==tk):!(S.waits||[]).some(w=>w.side===o.p.side);
        if(o.ack&&!o.ok){this.end(o,"failed",o.text);toast("❌ "+(o.cat==="tech"?t("e_generic"):t("op_delFail",trEA(o.text)||t("e_generic"))));changed=true;continue}
        if(gone&&o.id&&(o.ack||age>1500)){
          if(tk>0&&(S.pos&&String(S.pos.ticket||S.pos.id||"")===String(tk)||(S.pos&&!o.ack))){this.end(o,"filled_instead");toast("❌ "+t("op_filled"));changed=true;continue}
          this.end(o,"verified");toast(t("op_delOk"));changed=true;continue}
        if(age>to){this.end(o,"unverified");toast("❌ "+t("op_unver"));changed=true}
      }else{
        if(o.ack){this.end(o,o.ok?"verified":"failed",o.text);changed=true;continue}
        if(age>to){this.end(o,"unverified");toast("❌ "+t("op_unverG"));changed=true}
      }
    }
    return changed},
  snapshot(){return{open:[...this.m.values()].map(o=>({cmd:o.c,id:o.id,ageMs:Date.now()-o.at})),log:this.log.slice(0,60)}}
};
const Bridge={ok:null,auth:false,at:0,init:false,lc:"",mine:new Set(),dirty:false,applyId:null,busy:false,again:false,pend:[],
  async req(path,opt){
    const r=await fetch(CONFIG.api.baseUrl+path,{...opt,headers:{"Content-Type":"application/json","X-Login":SES.l,"X-Session":SES.s,...CONFIG.api.headers}});
    if(r.status===401){let w="";try{w=(await r.clone().json()).why||""}catch(e){}Login.out(false,w==="pw"||w==="revoked"?"e_pw_changed":w==="expired"?"e_expired":w==="acct"?"e_acct":"e_relogin")}
    if(!r.ok){const e=new Error(r.status);e.status=r.status;try{e.why=(await r.clone().json()).why||""}catch(x){}throw e}
    return r.json()},
  async pull(){
    if(this.busy){this.again=true;return}this.busy=true;
    try{
      const d=await this.req("/state");
      cleanState(d);prev=S.price||d.price;Object.assign(S,d);snapSave(d);this.pend=this.pend.filter(p=>Date.now()-p.at<900000);this.ok=true;this.auth=false;this.at=Date.now();
      const lc=d.lastCmd;
      if(!this.init){this.init=true;this.lc=lc?lc.id:"";fillInputs(true)}
      else if(lc&&lc.id!==this.lc){this.lc=lc.id;Ops.ack(lc);if(this.mine.has(lc.id)&&!Ops.dids.has(lc.id))toast(lc.cat==="tech"?"❌ "+t("e_generic"):(lc.ok?"":"❌ ")+trEA(String(lc.text||"").replace(/^[\u274C\u2705\u2139\u26A0\uFE0F\s]+/,"")));if(lc.ok&&lc.id===this.applyId)this.dirty=false}
      if(!this.dirty)fillInputs();else prevCalc();
      feed();
    }catch(e){this.ok=false;this.auth=(e.status===401||e.status===403||!SES.s)}
    Ops.settle();this.busy=false;setMode();render();
    if(this.again){this.again=false;setTimeout(()=>this.pull(),120)}
  },
  /* fast polling only while an operation is open (500 ms), so the result shows up as soon as MT5 reports it */
  fast(){if(this.fl)return;this.fl=true;const loop=async()=>{if(!Ops.active()){this.fl=false;render();return}await this.pull();setTimeout(loop,500)};setTimeout(loop,300)},
  async cmd(c,p){
    const o=Ops.add(c,p);
    if(!o){toast(t("op_busy"));return}            /* same operation already in flight: visible feedback, never a silent swallow */
    render();                                       /* the row switches to "deleting…" immediately, from the very first tap */
    try{
      const r=await this.req("/command",{method:"POST",body:JSON.stringify({cmd:c,...p})});
      o.id=(r&&r.id)||null;if(c==="delete"&&o.id)Ops.dids.add(o.id);Ops.note(o,"worker_accepted");
      if(r&&r.id)this.mine.add(r.id);if(c==="apply")this.applyId=r.id;trackCmd(r&&r.id,c,p,"sent");
      if(c!=="delete")toast(t(c==="newcycle"?"cyc_ok":"t_sent"));
      if(c==="newcycle")Ops.end(o,"sent");        /* newcycle is a two-step server command with its own guard */
      this.fast();
    }catch(e){
      Ops.end(o,"rejected","http "+(e.status||"network"));render();
      trackCmd(null,c,p,"fail",e.status===503?t("noLink"):t("l_srv"));
      if(c==="newcycle"&&e.status===409){toast("❌ "+t(e.why==="pending"?"cyc_pnd":"cyc_blk"));return}
      if(e.status===503)toast("❌ "+t("noLink"));
      else{this.ok=false;this.auth=(e.status===401||e.status===403||!SES.s);setMode();render();toast("❌ "+t(this.auth?"l_auth":"l_srv"))}
    }
  }
};

/* ── command log helpers: every command issued from this app is shown in the log ── */
const esc=x=>String(x==null?"":x).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function detOf(c,p){
  if(c==="apply"||c==="settings"){const a=[];if(p.buy!=null)a.push("Buy "+p.buy);if(p.sell!=null)a.push("Sell "+p.sell);if(p.risk!=null)a.push("Risk $"+p.risk);return a.join(" / ")}
  if(c==="modify"||c==="place")return (p.side?p.side+" Stop ":"")+(p.ticket?"#"+p.ticket+" ":"")+"@ "+p.price;
  if(c==="delete")return (p.side?p.side+" Stop ":"")+"#"+p.ticket;
  return "";
}
function trackCmd(id,c,p,st,msg){
  Bridge.pend.unshift({id:String(id!=null?id:"x"+Date.now()),cmd:c,det:detOf(c,p||{}),at:Date.now(),st:st||"sent",msg:msg||""});
  Bridge.pend=Bridge.pend.slice(0,10);
}
/* v4.7: the history list shows REAL closed trades only (current week, unique ids). Commands, waiting / superseded / failed events and technical text are internal diagnostics and never rendered here. */
function wkRange(){const w=S.week;if(!w)return"";const d=x=>new Date(x*1000).toISOString().slice(5,10);return d(w.from)+" → "+d(w.to)}
function logRows(){const seen=new Set();return (S.hist||[]).filter(x=>{const k=x.id||(x.no+"-"+x.ts);if(seen.has(k))return false;seen.add(k);return true}).map(x=>({...x,k:"t",ts:x.ts||0})).sort((a,b)=>b.ts-a.ts).slice(0,100)}
/* lifecycle of a command: sent → ok | wait → done | sup | cancel · fail | lost. A waiting row follows the live market until the bot activates it. */

/* ═════════════ 7) TRADING RULES + ENGINE (sim mode) ═════════════ */
const rkText=r=>r.status==="BELOW_MIN"?t("rk_BELOW_MIN",cs()+f(r.req),cs()+f(r.minRisk),fv(r.vmin)):r.status==="ABOVE_MAX"?t("rk_ABOVE_MAX"):r.status==="ABOVE_LIMIT"?t("rk_ABOVE_LIMIT"):r.status==="CLAMPED"?t("rk_CLAMPED",cs()+f(r.req),cs()+f(r.eff)):"";
function lotFor(risk,entry,sl){
  const d=Math.abs(entry-sl);if(d<1e-9)return{e:t("e_lot0")};
  const bs=spec();
  if(!bs)return{pending:true};                       /* live, no BrokerSpec yet (old EA / first sync): the EA decides, the UI never guesses */
  const r=calcRisk(bs,risk,entry,sl,(S.rk&&S.rk.policy==="CLAMP_TO_MIN")?"CLAMP_TO_MIN":"STRICT");
  if(live())return{lot:r.vol,est:r.eff,r,warn:r.ok&&!r.clamped?"":rkText(r)};   /* a volume condition is a WAIT shown as a note, never a blocking error */
  if(!r.ok)return{e:r.status==="BELOW_MIN"?t("e_lotMin",fv(bs.vmin)):t("e_lotMax"),r};
  return{lot:r.vol,est:r.eff,r};
}
function rkRows(k){
  const r=live()?S.rk:null;if(!r)return"";
  const bad=r.status!=="OK"&&r.status!=="CLAMPED",mn=cs()+f(r.minRisk);
  return `<div class="kv" style="margin-top:8px">${k(t("rkReq"),cs()+f(r.req))}${k(t("rkMin"),r.minRisk>0?mn:"—")}${k(t("rkEff"),r.vol>0?cs()+f(r.eff):"—",r.clamped?"dn":"")}${k(t("rkPol"),r.policy)}</div>`+(bad||r.clamped?`<div class="note${bad?"":" er"}" style="margin-top:8px">${bad?"⏳ ":"⚠️ "}${esc(rkText({status:r.status,req:r.req,minRisk:r.minRisk,vmin:r.vmin,eff:r.eff}))}</div>`:"");
}
function pairErr(b,s){const x=spec();if(!live()||!x||S.entry==="VIRTUAL"||!(b>s))return"";const need=2*(x.stops||0)*(x.point||0)+(x.spr||0);return b-s<need-1e-9?t("e_pair",fp(need)):""}
function vLevels(b,s){if(!(b>0&&s>0))return t("e_pos");if(b<=s)return t("e_ord");return""}
const r2c=x=>{const k=tickSz();return Number((Math.round(x/k)*k).toFixed(pd()))};
const mkLive=()=>live()&&link()==="ok"&&S.price>0&&!S.pos&&S.state!=="BUY_ACTIVE"&&S.state!=="SELL_ACTIVE"&&S.state!=="WAITING_REENTRY";
const sameOrd=(buy,p)=>(S.orders||[]).some(o=>isB(o.side)===buy&&Math.abs(o.price-p)<1e-9);
function mktNote(b,s){
  if(!mkLive())return"";
  const bid=S.price,ask=S.ask>0?S.ask:bid,md=Math.max(S.minDist||0,tickSz()),n=[];
  if(!(b>=r2c(ask+md)-1e-9)&&!sameOrd(true,b))n.push(t("mkB",f(b),f(ask),f(r2c(b-md))));
  if(!(s<=r2c(bid-md)+1e-9)&&!sameOrd(false,s))n.push(t("mkS",f(s),f(bid),f(r2c(s+md))));
  return n.join("\n");
}
const placeErr=(b,s)=>b<=S.price?t("e_buyP"):s>=S.price?t("e_sellP"):"";   // simulation only: the live bot keeps the level and waits for the price
const TECH=/retcode|\b100[0-4]\d\b|HTTP\s*\d{3}|exception|TypeError|ReferenceError|SyntaxError|\bJSON\b|stack\s*trace|traceback|parse error|internal error|server error|server rejected|\bundefined\b|\bNaN\b/i;   // same rule as the Worker: technical text is never displayed
function trEA(x){x=String(x==null?"":x);if(LG)return x;if(x.indexOf(" | ")>0&&/waits for the price|^(Activated|Superseded|Cancelled):/.test(x))return x.split(" | ").map(trEA).join("\n");let m;
  if(m=x.match(/^Activated: (Buy|Sell) Stop #(\d+) @ ([\d.]+) at ([\d:]+)(?: \((\d+) ms)?/i))return "فُعِّل: "+m[1]+" Stop #"+m[2]+" عند "+m[3]+" · "+m[4]+(m[5]?" · "+m[5]+"ms بعد وصول السعر":"");
  if(m=x.match(/^Superseded: (Buy|Sell) Stop ([\d.]+)/i))return "استُبدل: "+m[1]+" Stop "+m[2]+" بمستوى أحدث";
  if(m=x.match(/^Cancelled: (Buy|Sell) Stop ([\d.]+)/i))return "أُلغي: "+m[1]+" Stop "+m[2]+" (توقف البوت أو أُلغيت الأوامر)";
  if(m=x.match(/BUY STOP ([\d.]+) waits for the price: Ask ([\d.]+) must fall to ([\d.]+) or lower/i))return t("ea_wb",m[1],m[2],m[3]);
  if(m=x.match(/SELL STOP ([\d.]+) waits for the price: Bid ([\d.]+) must rise to ([\d.]+) or higher/i))return t("ea_ws",m[1],m[2],m[3]);
  if(m=x.match(/(?:BUY|Buy) STOP ([\d.]+) cannot be (?:placed|applied) now: Buy Stop must be above the Ask \(([\d.]+)\)/i))return t("ea_buy",m[1],m[2]);
  if(m=x.match(/SELL STOP ([\d.]+) cannot be (?:placed|applied) now: Sell Stop must be below the Bid \(([\d.]+)\)/i))return t("ea_sell",m[1],m[2]);
  if(/No connection to the trade server/i.test(x))return t("ea_conn");
  if(/AutoTrading is disabled/i.test(x))return t("ea_at");
  if(TECH.test(x))return t("e_generic");
  return x.replace(/^Invalid Price Configuration:\s*/i,"")}
const GROW=1.05;   /* v4.16 spec: R(n)=R(n-1)x1.05 after every losing trade (a risk in $, never the lot) */
const needNet=(tg)=>Math.max((S.acc||0)-(S.bank||0)+(tg==null?S.target:tg),0.01);   /* net profit the next winner must earn: all losses + the net target */
function tpDist(L,d,tg){   /* TP distance from the ACTUAL lot (rounded UP to the tick) */
  if(!(L&&L.lot>0&&L.r&&L.r.perLot>0&&d>0))return null;
  const unit=L.r.perLot/d,gross=needNet(tg)+L.lot*(L.r.cost||0),dist=gross/(L.lot*unit),k=tickSz();
  return Math.ceil(dist/k-1e-6)*k;
}
const expP=x=>x.exp!=null?x.exp:(S.bs&&live()&&x.tp&&x.entry&&x.lot?Math.abs(x.tp-x.entry)*perLotLoss(S.bs,1)*x.lot:x.est*S.rr);
const floating=()=>{const x=S.pos;if(!x)return 0;if(live()&&x.profit!=null)return x.profit;return(isB(x.side)?S.price-x.entry:x.entry-S.price)*x.lot*CS()};
function openPos(side,entry){
  const b=side==="BUY",sl=b?S.sell:S.buy,d=Math.abs(entry-sl),L=lotFor(S.cur,entry,sl);
  if(L.e){S.state="ERROR";S.msg=L.e;return}
  const td=tpDist(L,d),dd=td!=null?td:d*S.rr;
  S.pos={side,entry:r2(entry),sl,tp:r2(b?entry+dd:entry-dd),lot:L.lot,est:L.est,risk:S.cur,no:++S.no,exp:needNet()};
  S.state=b?"BUY_ACTIVE":"SELL_ACTIVE";S.msg="";toast(t("t_exec",t(b?"t_ob":"t_os"),f(entry)));Bus.emit("open",S.pos);
}
function closeTrade(reason,exit){
  const p=S.pos;if(!p)return 0;
  const pnl=(p.side==="BUY"?exit-p.entry:p.entry-exit)*p.lot*CS();
  S.hist.unshift({no:p.no,side:p.side,entry:p.entry,exit:r2(exit),lot:p.lot,pnl,reason,t:new Date().toLocaleTimeString("en-GB"),ts:Math.floor(Date.now()/1000)});
  S.hist=S.hist.slice(0,100);S.pos=null;Bus.emit("close",S.hist[0]);return pnl;
}
function engine(){
  const p=S.price,x=S.pos;
  if(S.state==="ARMED"){if(p>=S.buy)openPos("BUY",S.buy);else if(p<=S.sell)openPos("SELL",S.sell)}
  else if(S.state==="WAITING_REENTRY"){if(p<S.buy&&p>S.sell)S.state="ARMED"}
  else if(x){
    const b=isB(x.side);
    if(b?p<=x.sl:p>=x.sl){
      const pnl=closeTrade("SL",x.sl);S.acc=r2(S.acc-pnl);S.seq++;S.cur=S.cur*GROW;S.state="WAITING_REENTRY";
      toast(t("t_sl",sg(pnl),f(S.cur)));
      if(S.breach==="MARKET")openPos(b?"SELL":"BUY",S.price);
    }else if(b?p>=x.tp:p<=x.tp){
      const pnl=closeTrade("TP",x.tp),cyc=(S.bank||0)+pnl-S.acc;
      if(cyc>=S.target-0.01){S.acc=0;S.seq=0;S.bank=0;S.cur=S.risk}else S.bank=(S.bank||0)+pnl;   /* the cycle ends only when ALL losses are repaid AND the net target is left */
      toast(t("t_tp",sg(pnl)));
      if(S.pend){S.buy=S.pend.buy;S.sell=S.pend.sell;S.risk=S.pend.risk;if(S.pend.rr)S.rr=S.pend.rr;if(S.pend.target!=null)S.target=S.pend.target;S.cur=S.seq>0?S.cur:S.risk;S.pend=null;S.state="ARMED"}else S.state="TP_RESET";
    }
  }
}

/* ═════════════ 8) ACTIONS — single entry point: run(cmd, params) ═════════════ */
const ACT={
  start(){S.acc=0;S.seq=0;S.bank=0;S.cur=S.risk;S.run=true;S.state="ARMED";S.msg="";Bus.emit("start");toast(t("t_start"))},
  stop(){if(S.pos)closeTrade("MANUAL",S.price);S.run=false;S.state="STOPPED";S.pos=null;S.pend=null;S.msg="";Bus.emit("stop");toast(t("t_stop"))},
  close(){closeTrade("MANUAL",S.price);S.state="IDLE"},
  apply(p){
    if(S.pos){S.pend={buy:p.buy,sell:p.sell,risk:p.risk,target:p.target,rr:p.rr};toast(t("t_pend"))}
    else{S.buy=p.buy;S.sell=p.sell;S.risk=p.risk;S.target=p.target;S.rr=p.rr;S.cur=S.seq>0?S.cur:p.risk;if(S.run&&(S.state==="TP_RESET"||S.state==="IDLE"))S.state="ARMED";toast(t("t_applied"))}
  },
  reset(){if(S.pos)return toast(t("t_noReset"));S.acc=0;S.seq=0;S.bank=0;S.cur=S.risk;toast(t("t_reset"))},
  newcycle(){this.reset()}
};
function run(c,p={}){
  if(live()&&link()!=="ok"){trackCmd(null,c,p,"fail",t("noLink"));return toast("❌ "+t("noLink"))}
  Bus.emit("cmd",{cmd:c,...p});vib();
  if(live())return Bridge.cmd(c,p);
  S.cmds=[{id:"L"+Date.now(),cmd:c,det:detOf(c,p),ok:true,text:"",ts:Math.floor(Date.now()/1000),t:new Date().toLocaleTimeString("en-GB")}].concat(S.cmds||[]).slice(0,25);
  if(ACT[c])ACT[c](p);save();render();
}

/* ═════════════ 9) UI LAYER ═════════════ */
function ask(ti,b,y,fn){$("sheet").innerHTML=`<b>${ti}</b><p>${b}</p><div class="btns"><button class="btn" id="no">${t("back")}</button><button class="btn dg" id="yes">${y}</button></div>`;$("no").onclick=shut;$("yes").onclick=()=>{shut();fn()};$("ov").classList.add("show")}
/* v4.15: two-step confirmation for the dangerous commands (STOP / CLOSE / RESET), like Telegram. The second sheet names the exact consequence and its
   confirm button stays disabled for ~1.2 s so a double tap can never confirm both steps. */
function ask2(ti,b,y,b2,y2,fn){ask(ti,b,y,()=>{setTimeout(()=>{
  $("sheet").innerHTML=`<b>${t("q2T")}</b><p>${b2}</p><div class="btns"><button class="btn" id="no">${t("back")}</button><button class="btn dg" id="yes" disabled>${y2}</button></div>`;
  $("no").onclick=shut;const yb=$("yes");yb.onclick=()=>{shut();fn()};$("ov").classList.add("show");setTimeout(()=>{yb.disabled=false},1200)},150)})}
const shut=()=>$("ov").classList.remove("show");$("ov").onclick=e=>{if(e.target.id==="ov"&&!Login.outing)shut()};
(function(){const bb=()=>TG&&TG.wa&&TG.wa.BackButton,ov=$("ov");
  const sync=()=>{const on=ov.classList.contains("show"),b=bb();if(!b)return;try{if(on){b.onClick(shut);b.show()}else{b.offClick(shut);b.hide()}}catch(e){}};
  try{new MutationObserver(sync).observe(ov,{attributes:true,attributeFilter:["class"]})}catch(e){}
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&ov.classList.contains("show")&&!Login.outing)shut()})})();
const stIc={STOPPED:"pause",IDLE:"clock",TP_RESET:"target",ARMED:"bolt",BUY_ACTIVE:"up",SELL_ACTIVE:"dn",WAITING_REENTRY:"clock",ERROR:"alert"};
const stDot={STOPPED:"gd",IDLE:"gd",TP_RESET:"gd",ARMED:"up",BUY_ACTIVE:"up",SELL_ACTIVE:"dn",WAITING_REENTRY:"gd",ERROR:"dn"};

function start(){const e=vLevels(S.buy,S.sell)||(live()?"":placeErr(S.buy,S.sell))||(live()?"":lotFor(S.risk,S.buy,S.sell).e);if(e)return toast(t("t_startF",e));window.YT&&YT.pend();run("start")}
function stop(){const rs=S.rstStart?t("q2_stopR"):"";S.pos?ask2(t("q_open"),t("q_openB",sg(floating())),t("q_openY"),t("q2_open",rs),t("q_openY"),()=>run("stop")):ask2(t("q_stop"),t("q_stopB",f(S.acc||0)),t("q_stopY"),t("q2_stop",rs),t("q_stopY"),()=>run("stop"))}
function closePos(){ask2(t("q_close"),t("q_closeB",sg(floating())),t("q_close"),t("q2_close"),t("q_close"),()=>run("close"))}
function pairSides(){const R={BUY:null,SELL:null};(S.orders||[]).forEach(o=>{R[isB(o.side)?"BUY":"SELL"]={px:o.price}});(S.waits||[]).forEach(w=>{if(!R[w.side])R[w.side]={px:w.level}});if(S.mode==="BOTH"){if(!R.BUY&&S.buy>0)R.BUY={px:S.buy};if(!R.SELL&&S.sell>0)R.SELL={px:S.sell}}return R}
function delPair(){ask(t("q_delBoth"),t("q_delBothB"),t("delBoth"),()=>run("cancel"))}
function modPair(){const P=pairSides();if(!(P.BUY&&P.SELL))return;
  $("sheet").innerHTML=`<b>${t("mpT")}</b><small style="display:block;margin:12px 0 4px">${t("oB")}</small><input class="inp" id="pxb" type="number" step="any" inputmode="decimal" value="${P.BUY.px}"><small style="display:block;margin:12px 0 4px">${t("oS")}</small><input class="inp" id="pxs" type="number" step="any" inputmode="decimal" value="${P.SELL.px}" style="margin-bottom:12px"><div class="btns"><button class="btn" id="no">${t("back")}</button><button class="btn pri" id="yes">${t("okB")}</button></div>`;
  $("no").onclick=shut;
  $("yes").onclick=()=>{const b=num($("pxb").value),s2=num($("pxs").value),e=vLevels(b,s2);if(e)return toast("⚠ "+e);shut();if(b===P.BUY.px&&s2===P.SELL.px)return;run("apply",{buy:b,sell:s2})};
  $("ov").classList.add("show")}
function priceSheet(ti,def,fn){$("sheet").innerHTML=`<b>${ti}</b><input class="inp" id="ps" type="number" step="any" inputmode="decimal" value="${def}" style="margin:12px 0"><div class="btns"><button class="btn" id="no">${t("back")}</button><button class="btn pri" id="yes">${t("okB")}</button></div>`;$("no").onclick=shut;$("yes").onclick=()=>{const v=num($("ps").value);if(!(v>0))return toast("❌ "+t("e_risk"));shut();fn(v)};$("ov").classList.add("show")}
function addOrder(side){const b=side==="BUY";priceSheet(t("addB",t(b?"oB":"oS")),b?S.buy:S.sell,v=>run("place",{side,price:v}))}
let stShown=false,stOff=false;
function renderStop(){
  const st=live()&&link()==="ok"&&S.run===false&&S.state==="STOPPED",o=$("sov");
  if(!st){stShown=false;stOff=false;o.classList.remove("show");return}
  $("ssh").innerHTML=`<div class="sico dn" style="width:56px;height:56px;margin:0 auto 12px;font-size:28px">${ic("pause")}</div><b style="display:block;text-align:center">${t("stM")}</b><p style="text-align:center" class="num">${t("stMB",f(S.price))}</p><div class="btns"><button class="btn" id="svw">${t("vw")}</button><button class="btn go" id="srs">${ic("play")}${t("rst")}</button></div>`;
  $("svw").onclick=()=>{stOff=true;o.classList.remove("show")};$("srs").onclick=()=>{o.classList.remove("show");start()};
  if(!stShown&&!stOff){stShown=true;o.classList.add("show")}
}
let ACP={};
function acctCard(k){
  const a=S.acct||{},c=a.cur||"USD",lg=a.login||SES.l||"",off=live()&&link()!=="ok",n=v=>(v==null||isNaN(v))?"—":f(v);
  const cells=[["bal",t("aBal"),S.acct?n(a.bal):"—",""],["eq",t("aEq"),S.acct?n(a.eq):"—",S.acct?cl(a.eq-a.bal):""],["fl",t("aFl"),S.acct?sg(a.fl)+"$":"—",S.acct?cl(a.fl):""],
    ["mg",t("aMg"),S.acct?n(a.mg):"—",""],["fm",t("aFm"),S.acct?n(a.fm):"—",""],["lev",t("aLev"),S.acct?"1:"+a.lev:"—",""],
    ["ovol",t("aVol"),S.acct?(a.ovol!=null?f(a.ovol)+" "+t("aLot"):"—"):"—",""],["np",t("aNp"),S.acct&&a.np!=null?String(a.np):"—",""],
    ["ml",t("aMl"),S.acct&&a.mg>0&&a.ml!=null?f(a.ml)+"%":"—",""]];
  const bodyA=cells.map(([id,l,v,cc])=>{const ch=ACP[id]!==undefined&&ACP[id]!==v&&v!=="—";ACP[id]=v;return `<div class="${ch?"flash":""}"><small>${l}</small><b class="num ${cc}">${v}</b></div>`});
  return `<div class="card acc${off?" stale":""}"><div class="top"><div><h3 style="margin:0"><span class="hl">${ic("dollar")}${t("acT")}</span></h3><small class="num">#${esc(lg)} · ${esc(c)}${a.srv?" · "+esc(a.srv):""}</small></div></div><div class="kv">${bodyA.slice(0,3).join("")}</div>${fold("acc",t("moreD"),`<div class="kv" style="margin-top:8px">${bodyA.slice(3,6).join("")}</div><div class="kv" style="margin-top:8px">${bodyA.slice(6).join("")}</div>`,0)}</div>`
}
const LOGOUT_IC='<svg class="ic" viewBox="0 0 24 24"><path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/></svg>';
function logoutAsk(){
  if(Login.outing)return;
  $("sheet").innerHTML=`<div class="sico dn lgo-ic">${LOGOUT_IC}</div><b class="lgo-t">${t("q_out")}</b><p class="lgo-p">${t("q_outB")}</p><div class="btns"><button class="btn" id="no">${t("back")}</button><button class="btn dg" id="yes">${t("q_outY")}</button></div>`;
  $("no").onclick=shut;
  $("yes").onclick=()=>{const y=$("yes"),n=$("no");if(y.disabled)return;y.disabled=true;n.disabled=true;y.innerHTML='<i class="spn2"></i>'+t("out_ing");Login.out(true)};
  $("ov").classList.add("show")}
function statsCard(){const x=S.stats;if(!x||x.pf==null)return"";const k=(l,v,c="")=>`<div><small>${l}</small><b class="num ${c}">${v}</b></div>`;return `<div class="card"><h3><span class="hl">${ic("chart")}${t("sxT")}</span></h3><div class="kv">${k(t("sPf"),f(x.pf))}${k(t("sAw"),"+"+f(x.avgW),"up")}${k(t("sAl"),"−"+f(x.avgL),"dn")}${k(t("sMw"),"+"+f(x.maxW),"up")}${k(t("sMl"),"−"+f(x.maxL),"dn")}${k(t("sBs"),x.buys+" / "+x.sells)}${k(t("sSt"),x.streak>0?"+"+x.streak:x.streak)}${k(t("sVol"),f(x.vol))}${k(t("sCm"),f(x.comm+x.swap))}</div></div>`}
function fillMkt(silent){
  if(!(S.price>0)){if(!silent)toast("❌ "+t("fillE"));return}
  const tk=tickSz(),dg=pd(),bid=S.price,ask=S.ask>0?S.ask:bid,md=Math.max(S.minDist||0,tk),sp=ask-bid,need=sp+2*md+10*tk;
  let gap=num($("in_b").value)-num($("in_s").value);if(!(gap>0&&gap<=50))gap=1;
  gap=Math.max(gap,need);const mid=(bid+ask)/2;
  $("in_b").value=(Math.ceil((mid+gap/2)/tk-1e-9)*tk).toFixed(dg);
  $("in_s").value=(Math.floor((mid-gap/2)/tk+1e-9)*tk).toFixed(dg);
  Bridge.dirty=true;prevCalc();if(silent)toast(t("fillA"));
}
function applyLevels(){
  const b=num($("in_b").value),s=num($("in_s").value),r=num($("in_r").value),tg=num($("in_t").value),rr=num($("in_rr").value);
  let e=vLevels(b,s)||pairErr(b,s)||(r>0?"":t("e_risk"))||(tg<0?t("e_tneg"):"")||(rr>0?"":t("e_rr"))||(live()?"":lotFor(r,b,s).e)||"";
  if(!e&&!live()&&S.state==="ARMED"&&!S.pos)e=placeErr(b,s);
  if(e){if(!(r>0)||tg<0||!(rr>0))openFold("adv");return toast("❌ "+e)}
  run("apply",{buy:b,sell:s,risk:r,target:tg,rr});
}

/* link diagnostics: "bot offline" is NOT one problem — show EA / Bridge / MT5 / Trading separately so the user knows what to fix */
function tradeWhy(){const m=S.mt;if(!m||link()!=="ok")return"";return!m.auto?"tr_auto":!m.exp?"tr_exp":!m.acc?"tr_acc":!m.ea?"tr_exa":m.tm===false?"tr_tm":""}
function linkRows(){
  const k=link(),eaOn=k==="ok",m=eaOn?S.mt:null,why=tradeWhy();
  const row=(l,v,g)=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0"><span>${l}</span><b class="${g===true?"up":g===false?"dn":"mu"}">${v}</b></div>`;
  const a=eaAge(),last=(!eaOn&&a!==null)?" · "+t("l_last",ago(a)):"";
  return `<div style="margin-top:8px;border-top:1px solid var(--bd,rgba(127,127,127,.25));padding-top:6px">`
    +row(t("st_ea"),t(eaOn?"v_on":"v_off")+last,eaOn)
    +row(t("st_br"),t(k==="srv"?"v_dis":"v_con"),k!=="srv")
    +row(t("st_mt"),m?t(m.conn?"v_con":"v_dis"):t("v_unk"),m?!!m.conn:null)
    +row(t("st_tr"),m?t(why?"v_dsb":"v_en"):t("v_unk"),m?!why:null)+`</div>`;
}
/* ═════ v4.13 · ONE order = ONE card (layer) · one delete · a real bar per order ═════
   An "order" is the Buy Stop + Sell Stop pair of one cycle. Everything shown here comes from what the EA reports
   (mode / orders / waits / pend / price) — never from the app's own input fields. Several layers stack, each with its own number. */
Object.assign(D,{thT:["المظهر واللغة","Appearance & language"],thD:["ليلي","Dark"],thL:["نهاري","Light"],thA:["تلقائي","Auto"],lgT:["اللغة","Language"],conT:["الاتصال والإصدارات","Connection & versions"],
  moreD:["تفاصيل إضافية","More details"],advT:["إعدادات متقدمة","Advanced"],alrMore:["تنبيهات أخرى ({0})","{0} more alert(s)"],rkMore:["تفاصيل المخاطرة","Risk details"],
  aId:["رقم الحساب","Account"],aSrv:["السيرفر","Server"],verA:["إصدار التطبيق","App version"],verE:["إصدار الإكسبرت (EA)","EA version"],
  hFAll:["الكل","All"],hFW:["رابحة","Wins"],hFL:["خاسرة","Losses"],hFB:["شراء","Buy"],hFS:["بيع","Sell"],hCsv:["نسخ CSV","Copy CSV"],hCsvOk:["تم نسخ السجل","History copied"],hCur:["منحنى الأسبوع","Week curve"],hDd:["أقصى تراجع","Max drawdown"],hFn:["لا صفقات مطابقة للفلتر","No trades match this filter"],
  lyT:["الأوردر #{0}","Order #{0}"],lyQ:["مجدول · الدورة القادمة","Queued · next cycle"],lyN:["طبقة {0} من {1}","Layer {0} of {1}"],
  lyDel:["حذف الأوردر","Delete order"],lyDelQ:["حذف الأوردر؟","Delete this order?"],lyDelB:["سيتم حذف Buy Stop و Sell Stop معًا من MT5 بأمر واحد. الصفقة المفتوحة (إن وجدت) تبقى.","Buy Stop and Sell Stop will be deleted from MT5 together with one command. An open trade (if any) stays."],
  lyDelQB:["سيُحذف هذا الأوردر المجدول بالكامل (Buy Stop و Sell Stop) ولن يُوضع لاحقاً.","This queued order (Buy Stop + Sell Stop) will be deleted and never placed."],
  lyLive:["نشط في MT5","Live in MT5"],lyWait:["بانتظار السعر","Waiting for price"],lyZone:["بانتظار دخول السعر المنطقة","Waiting for price to enter the zone"],lyQd:["مجدول","Queued"],
  lyOut:["السعر خارج النطاق","Price is outside the range"],lyPx:["السعر","Price"]});
function lyBar(buy,sell){
  const px=S.price;if(!(buy>sell&&px>0))return"";
  const raw=(px-sell)/(buy-sell)*100,pc=Math.max(0,Math.min(100,raw)),out=raw<0||raw>100;
  return `<div class="pb2" dir="ltr"><u class="${out?"out":""}" style="left:${pc}%"></u></div><div class="pl" dir="ltr"><span>Sell ${f(sell)}</span><span class="num">${f(px)}${out?" ⚠":""}</span><span>Buy ${f(buy)}</span></div>`}
function lyDist(buy,sell){
  const px=S.price,ak=S.ask>0?S.ask:S.price;if(!(px>0&&buy>0&&sell>0))return"";
  const db=buy-ak,ds=px-sell,k=(l,v,c)=>`<div><small>${l}</small><b class="num ${c||""}">${v}</b></div>`;
  return `<div class="kv" style="margin-top:10px">${k(t("dB"),f(db),db<0?"dn":"")}${k(t("dS"),f(ds),ds<0?"dn":"")}${k(t("rng"),f(buy-sell))}</div>`}
function orderLayers(){
  const OR=S.orders||[],WT=S.waits||[],L=[];
  let no=((S.pos&&S.pos.no)||S.no||0)+1;
  const mode=S.mode||((OR.length||WT.length)?"BOTH":"NONE");
  const armed=S.run&&!S.frz&&!S.pos&&(S.state==="ARMED"||S.state==="WAITING_REENTRY"||OR.length>0);
  if(mode!=="NONE"&&(armed||OR.length)){
    const sides=["BUY","SELL"].filter(sd=>mode==="BOTH"||mode===sd).map(sd=>{
      const o=OR.find(x=>(isB(x.side)?"BUY":"SELL")===sd),w=WT.find(x=>x.side===sd),lv=o?o.price:w?w.level:(sd==="BUY"?S.buy:S.sell);
      return{sd,o,w,lv}}).filter(x=>x.lv>0);
    if(sides.length){const bu=(sides.find(x=>x.sd==="BUY")||{}).lv||0,se=(sides.find(x=>x.sd==="SELL")||{}).lv||0;L.push({kind:"live",no:no++,sides,buy:bu,sell:se})}
  }
  if(S.pend&&S.pend.buy>0&&S.pend.sell>0)L.push({kind:"queued",no:no++,buy:S.pend.buy,sell:S.pend.sell});
  return L}
function delLayer(i){const y=orderLayers()[i];if(!y)return;
  if(y.kind==="queued")ask(t("lyDelQ"),t("lyDelQB"),t("q_delY"),()=>run("delpend"));
  else ask(t("lyDelQ"),t("lyDelB"),t("q_delY"),()=>run("cancel"))}
function layersHtml(dis){
  const LY=orderLayers();if(!LY.length)return"";
  return LY.map((y,i)=>{
    const live=y.kind==="live",bz=live?(Ops.m.has("cancel")||Ops.m.has("apply")):Ops.m.has("delpend");
    const rows=live?y.sides.map(x=>{const b=x.sd==="BUY",o=x.o,w=x.w;
      const sub=o?`#${idn(o.ticket)} · ${f(o.lot)} ${t("lots")} · SL ${f(o.sl)} · TP ${f(o.tp)}`:w?(w.placing?t("plc"):t(b?"wB":"wS",f(w.now),f(w.trig),f(w.dist))):t("lyZone");
      return `<div class="hi${bz?" busy":""}"><div class="hl2"><i class="hs ${o?(b?"up":"dn"):"gd"}">${ic(o?(b?"up":"dn"):"clock")}</i><div><b>${t(b?"oB":"oS")} · <span class="num">${f(x.lv)}</span></b><small class="num">${sub}</small></div></div><span class="mu" style="font-size:11px">${o?t("lyLive"):t("lyWait")}${window.YTN?YTN.obell(o?"t"+idn(o.ticket):"w"+x.sd,dis):""}</span></div>`}).join("")
      :[["BUY",y.buy],["SELL",y.sell]].map(([sd,lv])=>{const b=sd==="BUY";return `<div class="hi"><div class="hl2"><i class="hs gd">${ic("clock")}</i><div><b>${t(b?"oB":"oS")} · <span class="num">${f(lv)}</span></b><small>${t("lyQd")}</small></div></div></div>`}).join("");
    const both=live&&y.buy>0&&y.sell>0,one=live&&!both&&y.sides.length===1&&S.run&&!S.pos;
    const btns=`<div class="btns" style="margin-top:10px">${both?`<button class="btn" data-oc="modPair"${dis||(bz?" disabled":"")}>${ic("edit")}${t("editBoth")}</button>`:""}${one?`<button class="btn go" data-oc="addOrder" data-oa="${y.sides[0].sd==="BUY"?"SELL":"BUY"}"${dis}>${ic("bolt")}${t("addB",t(y.sides[0].sd==="BUY"?"oS":"oB"))}</button>`:""}<button class="btn dg${both||one?"":" w"}" data-oc="delLayer" data-oa="${i}"${dis||(bz?" disabled":"")}>${ic("trash")}${t("lyDel")}</button></div>`;
    return `<div class="card ly${live?"":" qd"}"><h3><span class="hl">${ic(live?"bolt":"clock")}${t("lyT",idn(y.no))}${live?"":" · "+t("lyQ")}</span>${LY.length>1?`<span class="mu num" style="font-size:11px">${t("lyN",i+1,LY.length)}</span>`:""}</h3>${rows}${y.buy>0&&y.sell>0?lyBar(y.buy,y.sell)+lyDist(y.buy,y.sell):""}${bz?`<small class="opw"><i class="spn2"></i>${t("op_ing")}</small>`:""}${btns}</div>`}).join("")}
let _dashH="",_tch=0,_late=false;
function setDash(h){if(h===_dashH)return;if(_tch&&Date.now()-_tch<1500){_late=true;return}_dashH=h;$("dash").innerHTML=h}
(function(){const dn=e=>{if(e.target&&e.target.closest&&e.target.closest("#dash"))_tch=Date.now()},up=()=>{if(!_tch)return;setTimeout(()=>{_tch=0;if(_late){_late=false;renderDash()}},80)};
  document.addEventListener("pointerdown",dn,true);document.addEventListener("pointerup",up,true);document.addEventListener("pointercancel",up,true)})();
function renderDash(){
  const dis=(live()&&link()!=="ok")?" disabled":"";
  const x=S.pos,k=(l,v,c="")=>`<div><small>${l}</small><b class="num ${c}">${v}</b></div>`;
  let h=`<div class="card"><div class="state"><div class="sico ${stDot[S.state]||"gd"}">${ic(stIc[S.state]||"pause")}</div><div><b>${t("st_"+S.state)}</b><small style="white-space:pre-line">${esc(trEA(S.msg))||t("sx_"+S.state)}</small></div></div><div class="btns">`;
  h+=S.run?`<button class="btn dg ${x?"":"w"}" data-oc="stop"${dis}>${ic("stop")}${t("stopB")}</button>`:`<button class="btn go w" data-oc="start"${dis}>${ic("play")}${t("startB")}</button>`;
  if(x)h+=`<button class="btn" data-oc="closePos"${dis}>${ic("xc")}${t("closeB")}</button>`;
  h+=`</div></div>`;
  const NT=[];
  if(live()&&link()==="off")NT.push(`<div class="note er"><b>${ic("alert")} ${t("offT")}</b><br>${t("offB")}${linkRows()}</div>`);
  else if(live()&&link()==="srv")NT.push(`<div class="note er"><b>${ic("alert")} ${t("l_srv")}</b><br>${t("l_srvS")}${linkRows()}</div>`);
  else if(live()&&link()==="ok"&&tradeWhy())NT.push(`<div class="note er"><b>${ic("alert")} ${t("trOffT")}</b><br>${t(tradeWhy())}${linkRows()}</div>`);
  if(live()&&link()==="ok"&&S.frz)NT.push(`<div class="note er" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${ic("pause")} ${t("frzL")} · ${f(S.price)}</span><button class="btn go" style="padding:8px 12px" data-oc="start">${t("rst")}</button></div>`);
  if(live()&&link()==="ok"&&S.wcode&&!S.frz&&D["w_"+S.wcode])NT.push(`<div class="note"><b>⏳ ${t("w_"+S.wcode)}</b>${S.msg?`<br><small>${esc(trEA(S.msg))}</small>`:""}</div>`);
  if(live()&&link()==="ok"&&!(parseFloat(S.ver)>=2.18))NT.push(`<div class="note er">${t("oldEA")}</div>`);
  h=alertsHtml(NT)+h;
  if(x){
    const b=isB(x.side),fl=floating(),lo=b?x.sl:x.tp,hi=b?x.tp:x.sl,pc=v=>Math.max(0,Math.min(100,(v-lo)/(hi-lo)*100)),z=pc(x.entry);
    const bg=b?`linear-gradient(90deg,var(--dn) ${z}%,var(--up) ${z}%)`:`linear-gradient(90deg,var(--up) ${z}%,var(--dn) ${z}%)`;
    h+=`<div class="card" style="background:linear-gradient(160deg,color-mix(in srgb,var(--${cl(fl)}) 9%,var(--surf)),var(--surf))"><div class="tk"><span class="badge ${b?"up":"dn"}">${ic(b?"up":"dn")}${t(b?"buy":"sell")}</span><span class="mu num">#${idn(x.no)}</span></div><div class="mu" style="font-size:12px">${t("flt")}</div><div class="big num ${cl(fl)}">${sg(fl)}$</div>
    <div class="pb" dir="ltr" style="background:${bg}"><u style="left:${pc(S.price)}%"></u></div><div class="pl" dir="ltr"><span>${t(b?"slS":"tpS")}</span><span>${t(b?"tpS":"slS")}</span></div>
    <div class="kv">${k(t("entry"),fp(x.entry))}${k(t("slK"),fp(x.sl),"dn")}${k(t("tpK"),fp(x.tp),"up")}${k(t("lot"),fv(x.lot))}${k(t("riskK"),cs()+f(x.risk))}${k(t("expK"),cs()+f(expP(x)),"up")}</div></div>`;
  }
  h+=layersHtml(dis);
  h+=acctCard(k);
  const L=lotFor(S.cur,S.buy,S.sell);
  h+=`<div class="card"><h3><span class="hl">${ic("shield")}${t("rmT")}</span><span style="display:flex;gap:8px;align-items:center"><span class="num">${t("seq",S.seq+1)}</span><button class="ib" style="width:36px;height:36px" aria-label="${t("reset")}" data-oc="resetUI"${dis}>${ic("refresh")}</button><button class="ib" style="width:36px;height:36px" aria-label="${t("cyc_btn")}" title="${t("cyc_btn")}" data-oc="newCycleUI">${ic("xc")}</button></span></h3><div class="kv">${k(t("curR"),cs()+f(S.cur),"gd")}${k(t("accL"),cs()+f(S.acc),S.acc>0?"dn":"")}${k(t("lot"),L.e||(!x&&!(L.lot>0))?"—":fv(x?x.lot:L.lot))}</div>${(()=>{const rr=rkRows(k);if(!rr)return"";const r=S.rk,bad=!!(r&&(r.status!=="OK"||r.clamped));return fold("rk",t("rkMore"),rr,0,bad)})()}</div>`;
  setDash(h);
}
let HF="all",_histH="";
const histPass=x=>HF==="all"||(HF==="win"&&x.pnl>0)||(HF==="loss"&&x.pnl<=0)||(HF==="buy"&&isB(x.side))||(HF==="sell"&&!isB(x.side));
function eqCurve(RW){const a=RW.slice().reverse();let c=0,pk=0,dd=0;const pts=[0];a.forEach(x=>{c+=x.pnl;pts.push(c);pk=Math.max(pk,c);dd=Math.max(dd,pk-c)});return{pts,dd}}
function eqSvg(pts){if(pts.length<3)return"";const mn=Math.min(...pts,0),mx=Math.max(...pts,0),sp=mx-mn||1,y=v=>(36-(v-mn)/sp*32).toFixed(1),P=pts.map((v,i)=>(i*200/(pts.length-1)).toFixed(1)+","+y(v)).join(" ");
  return `<svg class="eq ${pts[pts.length-1]>=0?"up":"dn"}" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><line class="z" x1="0" x2="200" y1="${y(0)}" y2="${y(0)}"/><polygon points="${P} 200,40 0,40"/><polyline points="${P}"/></svg>`}
function histCsv(){const RW=logRows().filter(histPass),q=v=>'"'+String(v==null?"":v).replace(/"/g,'""')+'"';
  return ["no,side,entry,exit,lot,pnl,reason,time"].concat(RW.map(x=>[x.no,isB(x.side)?"BUY":"SELL",x.entry,x.exit,x.lot,x.pnl,q(x.reason),x.ts?new Date(x.ts>1e12?x.ts:x.ts*1000).toISOString():""].join(","))).join("\n")}
document.addEventListener("click",e=>{
  const c=e.target.closest&&e.target.closest("#hF .chip");if(c){vib();HF=c.dataset.f;renderHist();return}
  const b=e.target.closest&&e.target.closest("#hCsv");if(!b)return;vib();const txt=histCsv();
  const done=()=>toast(t("hCsvOk")),fb=()=>{const a=document.createElement("textarea");a.value=txt;a.style.cssText="position:fixed;opacity:0";document.body.appendChild(a);a.select();try{document.execCommand("copy")}catch(x){}a.remove();done()};
  try{navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(txt).then(done,fb):fb()}catch(x){fb()}});
function renderHist(){
  const H=S.hist,ST=S.stats,net=ST?ST.net:H.reduce((a,x)=>a+x.pnl,0),w=ST?ST.wins:H.filter(x=>x.pnl>0).length,n=ST?ST.total:H.length,k=(l,v,c="")=>`<div><small>${l}</small><b class="num ${c}">${v}</b></div>`;
  const RW=logRows(),FR=RW.filter(histPass),eq=eqCurve(RW);
  const chips=[["all","hFAll"],["win","hFW"],["loss","hFL"],["buy","hFB"],["sell","hFS"]].map(([v,l])=>`<button class="chip${HF===v?" on":""}" type="button" data-f="${v}" aria-pressed="${HF===v}">${t(l)}</button>`).join("");
  const rows=FR.length?FR.map(x=>`<div class="hi"><div class="hl2"><i class="hs ${isB(x.side)?"up":"dn"}">${ic(isB(x.side)?"up":"dn")}</i><div><b>#${idn(x.no)} ${t(isB(x.side)?"buyW":"sellW")} · ${rsn(x.reason)}</b><small class="num">${f(x.entry)} → ${f(x.exit)} · ${f(x.lot)} ${t("lots")}</small></div></div><b class="p num ${cl(x.pnl)}">${sg(x.pnl)}$</b></div>`).join(""):`<div class="empty">${ic("hist")}<br>${t(RW.length?"hFn":"none")}</div>`;
  const h=`<div class="card"><h3><span class="hl">${ic("dollar")}${t("net")}</span><span class="mu num" style="font-size:11px">${wkRange()}</span></h3><div class="big num ${cl(net)}" style="margin-bottom:6px">${sg(net)}$</div>${eqSvg(eq.pts)}${eq.pts.length>2?`<div class="eqm"><span>${t("hCur")}</span><span>${t("hDd")} <b class="num dn">${eq.dd>0?"−"+f(eq.dd)+"$":"0$"}</b></span></div>`:""}<div class="kv" style="margin-top:12px">${k(t("tot"),n)}${k(t("win"),w,"up")}${k(t("rate"),(n?f(w/n*100,0):0)+"%")}</div></div>${statsCard()}<div class="card"><h3><span class="hl">${ic("hist")}${t("logT")}</span><button class="ib" id="hCsv" type="button" style="width:36px;height:36px" aria-label="${t("hCsv")}" title="${t("hCsv")}">${ic("save")}</button></h3><small class="mu" style="display:block;margin:-6px 0 10px">${t("wkR")}</small>${RW.length?`<div class="chips" id="hF">${chips}</div>`:""}${rows}</div>`;
  if(h!==_histH){_histH=h;$("hist").innerHTML=h}
}
function feed(){if(!(S.price>0)||S.frz)return;SP.push(S.price);if(SP.length>40)SP.shift()}
function renderPrice(){
  const d=S.frz?0:S.price-prev;$("qc").classList.toggle("frozen",!!S.frz);$("pr").textContent=S.price>0?fp(S.price):"—";$("pr").className="pr num "+(d>0?"up":d<0?"dn":"");$("chg").textContent=S.price>0?sg(d):"";$("chg").className="chg num "+cl(d);
  if(SP.length>1){const mn=Math.min(...SP),mx=Math.max(...SP),sp=mx-mn||1;const pts=SP.map((v,i)=>(i*200/(SP.length-1)).toFixed(1)+","+(36-(v-mn)/sp*32).toFixed(1)).join(" ");$("spl").setAttribute("points",pts);$("spa").setAttribute("points",pts+" 200,40 0,40")}
}
const isB=s=>String(s).toUpperCase().startsWith("B");
function rsn(r){r=String(r||"");const l=r.toLowerCase();
  const k=l==="sl"?"r_SL":l==="tp"?"r_TP":/^(manual stop|telegram stop)/.test(l)?"r_STOP":l.startsWith("telegram cancel")?"r_CANCEL":l.startsWith("manual")?"r_EXT":l.startsWith("stop out")?"r_SO":l.startsWith("deviation")?"r_DEV":l.startsWith("extra")?"r_EXTRA":l.startsWith("protection")?"r_PROT":l==="other"?"r_OTH":D["r_"+r]?"r_"+r:"";
  return k?t(k):_e(r)}
function fillInputs(force){
  const a=document.activeElement;if(!force&&a&&a.tagName==="INPUT")return;
  const m={in_b:S.buy,in_s:S.sell,in_r:S.risk,in_t:S.target,in_rr:S.rr};
  for(const id in m){const v=m[id];if(v==null||isNaN(v))continue;const s=(v>0||id==="in_t")?String(v):"";if($(id).value!==s)$(id).value=s}
  prevCalc();
}
const ago=s=>{s=Math.max(0,Math.round(s));return s<60?s+(LG?"s":"ث"):Math.floor(s/60)+(LG?"m":"د")};
const eaAge=()=>S.eaAge==null?null:S.eaAge+(Date.now()-Bridge.at)/1000;
/* sim | wait | srv | auth | off | ok */
function link(){
  if(!live())return"sim";
  if(Bridge.ok===null)return"wait";
  if(Bridge.ok===false)return Bridge.auth?"auth":"srv";
  const a=eaAge();
  if(S.eaOnline===false||a===null||a>(S.eaStaleSec||CONFIG.staleSec||20))return"off";
  return"ok";
}
function renderLink(){
  const k=link(),el=$("lnk");if(!el)return;
  let c="off",ti="",su="";
  if(k==="sim"){c="busy";ti=t("l_sim")}
  else if(k==="wait"){c="busy";ti=t("l_wait")}
  else if(k==="srv"){ti=t("l_srv");su=t("l_srvS")}
  else if(k==="auth"){ti=t("l_auth");su=t("l_authS")}
  else if(k==="off"){ti=t("l_off");su=t("l_offS");const a=eaAge();if(a!==null)su+=" · "+t("l_last",ago(a))}
  else{
    const trade=S.state==="BUY_ACTIVE"||S.state==="SELL_ACTIVE";
    c=trade?"busy":S.state==="ERROR"?"off":"ok";
    ti=t(S.state==="ERROR"?"l_okErr":trade?"l_okTrade":(S.state==="STOPPED"||S.state==="IDLE"||S.state==="TP_RESET")?"l_okWait":"l_okRun");
    su=t("l_upd",ago(eaAge()))+(S.spread!=null?" · Spread "+S.spread:"");
  }
  el.className="lnk "+c;$("lnkT").textContent=ti;$("lnkS").textContent=su;
  $("retryB").hidden=!(k==="srv"||k==="off");
  $("qc").classList.toggle("stale",k!=="ok"&&k!=="sim");
  $("applyB").disabled=live()&&k!=="ok";
}
/* v4.16: 80-trade plan (8 groups x 10) from the real formulas + the live broker spec. Lot = EA rule (rounded DOWN to the step, min/max honoured); never an assumed 1.00 lot. */
function planRows(){
  const bs=spec(),b=S.buy,s=S.sell,have=!!bs&&b>s&&s>0,pol=(S.rk&&S.rk.policy==="CLAMP_TO_MIN")?"CLAMP_TO_MIN":"STRICT",rows=[];let cum=0;
  for(let n=1;n<=80;n++){
    const risk=S.risk*Math.pow(GROW,n-1);let lot=0,loss=risk,note="";
    if(have){const r=calcRisk(bs,risk,b,s,pol);if(r.vol>0){lot=r.vol;loss=r.eff;if(r.clamped)note="⚠"}else note="·"}
    const need=cum+S.target;cum+=loss;rows.push({n,risk,lot,loss,cum,need,note});
  }
  return rows;
}
/* end planRows */
function render(){renderPrice();renderLink();renderDash();renderStop();renderMini();advSum();if(tab===1)renderHist();if(tab===3)renderSettings()}

/* order form */
$("t0").addEventListener("click",e=>{
  const n=e.target.dataset.n;
  if(n){vib();const k=n[0]==="b"?"in_b":"in_s";$(k).value=r2(num($(k).value)+parseFloat(n.slice(1)));Bridge.dirty=true;prevCalc()}
});
["in_b","in_s","in_r","in_t","in_rr"].forEach(i=>{$(i).addEventListener("input",()=>{Bridge.dirty=true;prevCalc()});$(i).addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();applyLevels()}})});
/* auto stops: Buy Stop's SL = Sell Stop price · Sell Stop's SL = Buy Stop price */
function autoSL(b,s,ok,td){   /* td = TP distance computed from the actual lot (null while no executable lot exists) */
  const d=b-s,row=(sl,tp)=>`<span>${t("aSL")}: <b class="num dn">${f(sl)}</b></span><span>${t("aTP")}: <b class="num up">${tp==null?"—":f(tp)}</b></span>`;
  $("aB").innerHTML=ok?row(s,td!=null?b+td:null):"";
  $("aS").innerHTML=ok?row(b,td!=null?s-td:null):"";
}
function prevCalc(){
  const b=num($("in_b").value),s=num($("in_s").value),r=num($("in_r").value),e=vLevels(b,s),p=$("prev"),tgIn=num($("in_t").value);
  if(e){autoSL(b,s,false,null);p.className="note er";p.textContent=e;return}
  const L=lotFor(r,b,s),me=mktNote(b,s),pe=pairErr(b,s),tg=tgIn>=0?tgIn:S.target,td=tpDist(L,b-s,tg);
  autoSL(b,s,true,td);
  p.className="note"+(L.e||pe?" er":"");
  if(L.e||pe){p.textContent=L.e||pe;return}
  if(L.pending){p.textContent=t("pvEA");return}
  p.textContent=(L.lot>0?t("pv",fv(L.lot),cs()+f(L.est),cs()+f(needNet(tg))):"")+(L.warn?(L.lot>0?"\n":"")+"⏳ "+L.warn:"")+(S.pos?t("pvA"):"")+(me?"\n"+me:"")+(td!=null&&td/(b-s)>=10?"\n"+t("rrHi",f(td/(b-s),1),fp(b-s),fp(b+td),fp(s-td)):"");
}
$("applyB").onclick=applyLevels;

/* v4.7: explicit, guarded cycle reset. A restart of MT5 / the Worker / this app is RECOVERY (it never resets). Only this action clears the saved cycle, and never over a live trade. The Worker enforces the same checks. */
function newCycleUI(){
  if(S.pos||S.state==="BUY_ACTIVE"||S.state==="SELL_ACTIVE")return toast("❌ "+t("cyc_blk"));
  const n=(S.orders||[]).length;
  ask(t("cyc_q"),t("cyc_b",n?t("cyc_o",n):""),t("cyc_y"),()=>run("newcycle"))}
function resetUI(){ask2(t("q_reset"),t("q_resetB2",f(S.risk),S.seq||0,f(S.acc||0)),t("q_resetY"),t("q2_reset"),t("q_resetY"),()=>run("reset"))}

/* shell: tabs, theme, language */
/* ═════ v4.17 · shell helpers: smart folds, sticky mini quote, sliding nav indicator, settings tab ═════ */
const APP_V="4.17.0";
const FD=()=>UI.fold||(UI.fold={}),isFold=(k,d)=>{const v=FD()[k];return v===undefined?!!d:!!v};
function fold(k,label,body,def,force){const o=!!force||isFold(k,def);return `<div class="fd${o?" open":""}" data-fd="${k}"><button class="fdt" type="button" data-fdt="${k}" aria-expanded="${o}"><span>${label}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="fb"><div class="fi">${body}</div></div></div>`}
function applyFolds(){document.querySelectorAll(".fd[data-fd]").forEach(el=>{if(el.dataset.def===undefined)return;const o=isFold(el.dataset.fd,el.dataset.def==="1");el.classList.toggle("open",o);const b=el.querySelector(":scope>[data-fdt]");b&&b.setAttribute("aria-expanded",o)})}
function openFold(k){FD()[k]=true;saveUI();applyFolds()}
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest("[data-fdt]");if(!b)return;const box=b.closest(".fd"),o=!box.classList.contains("open");box.classList.toggle("open",o);b.setAttribute("aria-expanded",o);FD()[b.dataset.fdt]=o;saveUI();vib()});
function alertsHtml(N){if(!N.length)return"";return N[0]+(N.length>1?fold("alr",t("alrMore",N.length-1),N.slice(1).join(""),0):"")}
let mqOn=false;
function mqShow(){const m=$("mq");if(!m)return;const on=mqOn&&tab===0;m.classList.toggle("show",on);m.setAttribute("aria-hidden",on?"false":"true");m.tabIndex=on?0:-1;if(on)renderMini()}
(function(){const q=$("qc");if(q&&"IntersectionObserver" in window)new IntersectionObserver(es=>{mqOn=!es[0].isIntersecting;mqShow()},{rootMargin:"-76px 0px 0px 0px"}).observe(q);
  $("mq").onclick=()=>{vib();window.scrollTo({top:0,behavior:"smooth"})}})();
function renderMini(){
  if(!$("mq").classList.contains("show"))return;
  const p=$("pr"),c=$("chg"),k=link(),off=live()&&k!=="ok",kc=el=>el.classList.contains("up")?"up":el.classList.contains("dn")?"dn":"";
  $("mqP").textContent=p.textContent;$("mqP").className="mqp num "+kc(p);$("mqC").textContent=c.textContent;$("mqC").className="mqc num "+kc(c);
  $("mqS").textContent=off?t("offl"):t("st_"+S.state);$("mqD").className="mqd "+(off?"dn":(stDot[S.state]||"gd"));
}
function advSum(){const e=$("advS");if(e)e.textContent=cs()+f(S.risk)+" · +"+f(S.target,0)+" · RR "+f(S.rr,0)}
function navInd(){const n=$("nav"),b=n&&n.querySelector("button.on");if(!b)return;n.style.setProperty("--ix",(b.offsetLeft+b.offsetWidth*.3)+"px");n.style.setProperty("--iw",(b.offsetWidth*.4)+"px")}
window.addEventListener("resize",navInd);
let _setD="",_setA="";
function renderSettings(){
  const ac=$("setAccC");if(!ac)return;
  ac.hidden=!live();
  if(live()){const a=S.acct||{},lg=a.login||SES.l||"",h=`<div class="rw"><span class="lb">${t("aId")}</span><b class="num">#${esc(lg)}</b></div>`+(a.srv?`<div class="rw"><span class="lb">${t("aSrv")}</span><b class="num">${esc(a.srv)}${a.cur?" · "+esc(a.cur):""}</b></div>`:"")+`<button class="btn dg" style="width:100%;margin-top:12px" data-oc="logoutAsk">${LOGOUT_IC}${t("outB")}</button>`;
    if(h!==_setA){_setA=h;$("setAcc").innerHTML=h}}
  const lk=live()?linkRows():"",ver=`<div class="rw"><span class="lb">${t("verA")}</span><b class="num mu">${APP_V}</b></div><div class="rw"><span class="lb">${t("verE")}</span><b class="num mu">${S.ver?esc(S.ver):"—"}</b></div>`,
    h2=(lk?`<div class="dg2">${lk}</div>`:"")+ver;
  if(h2!==_setD){_setD=h2;$("setDiag").innerHTML=h2}
}

$("nav").onclick=e=>{const b=e.target.closest("button"),i=b&&b.dataset.k;if(i===undefined)return;vib();tab=+i;document.querySelectorAll(".tab").forEach((x,j)=>x.classList.toggle("on",j===tab));[...$("nav").children].forEach((c,j)=>c.classList.toggle("on",j===tab));if(tab===1)renderHist();if(tab===2&&window.YTN)YTN.open();if(tab===3)renderSettings();navInd();mqShow();window.scrollTo(0,0)};
function setMode(){
  const off=live()&&link()!=="ok";$("mode").classList.toggle("off",off);
  $("lvT").textContent=live()?(off?"OFFLINE":S.frz?"STOPPED":"LIVE"):"SIM";$("modeT").textContent=t(off?"offl":live()?"live":"demo");
}
const TH_BG={dark:"#0a0d12",light:"#f4f1e8"},mqLight=window.matchMedia?matchMedia("(prefers-color-scheme: light)"):{matches:false};
function applyTheme(v){
  const r=document.documentElement;
  if(r.dataset.theme!==v){r.classList.add("thx");clearTimeout(applyTheme.k);applyTheme.k=setTimeout(()=>r.classList.remove("thx"),450)}
  r.dataset.theme=v;$("tc").content=TH_BG[v];
  try{const w=TG.wa;if(w){w.setHeaderColor&&w.setHeaderColor(TH_BG[v]);w.setBackgroundColor&&w.setBackgroundColor(TH_BG[v]);w.setBottomBarColor&&w.setBottomBarColor(TH_BG[v])}}catch(e){}
  const sw=$("thB");if(sw)sw.setAttribute("aria-checked",v==="dark"?"true":"false");
  document.querySelectorAll("#thSeg button").forEach(b=>b.classList.toggle("on",b.dataset.th===(UI.th||"auto")));
}
function setTheme(v){
  if(v==="auto"||v==null)delete UI.th;else UI.th=v==="light"?"light":"dark";
  saveUI();applyTheme(UI.th||(mqLight.matches?"light":"dark"));
}
try{mqLight.addEventListener&&mqLight.addEventListener("change",()=>{if(!UI.th)setTheme("auto")})}catch(e){}
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest("#thSeg button");if(b){vib();setTheme(b.dataset.th)}});
function setLang(v){
  LG=v?1:0;UI.lg=LG;saveUI();
  document.documentElement.lang=LG?"en":"ar";document.documentElement.dir=LG?"ltr":"rtl";
  document.querySelectorAll("[data-t]").forEach(e=>e.textContent=t(e.dataset.t));lgEye();
  $("lgB").textContent=LG?"العربية":"English";navInd();
  setMode();prevCalc();render();
}
$("thB").onclick=()=>{vib();setTheme(document.documentElement.dataset.theme==="light"?"dark":"light")};
$("lgB").onclick=()=>{vib();UI.lgManual=1;setLang(LG?0:1)};

/* ═════════════ 10) PUBLIC API — for bots, Telegram Mini App, iframes ═════════════ */
window.YetimmmAPI={
  ops(){return Ops.snapshot()},      /* v4.10: command lifecycle log for diagnosis (no passwords / tokens) */
  config:CONFIG,
  on:(e,fn)=>Bus.on(e,fn),
  getState:()=>JSON.parse(JSON.stringify(S)),
  command:run,                                           // run("start") · run("apply",{buy,sell,risk}) ...
  setPrice(p){prev=S.price;S.price=+p;feed();if(!live())engine();render()},   // external price feed (MT5 / WebSocket)
  patch(o){Object.assign(S,o);render()},
  simProfile(n){if(SIM_PROFILES[n]){SIMP=n;render();return true}return false},
  profiles:()=>Object.keys(SIM_PROFILES),
  setLang:v=>setLang(v==="en"||v===1),
  setTheme
};
window.addEventListener("message",e=>{
  if(CONFIG.mode==="live"||!CONFIG.origins.includes(e.origin)||!e.data||!e.data.yetimmm)return;   /* v4.18: in LIVE mode no other window can drive the bot through postMessage */
  const d=e.data;if(d.cmd)run(d.cmd,d.params||{});if(d.price)YetimmmAPI.setPrice(d.price);
});

/* ═════════════ 11) INIT ═════════════ */
let sig=S.state+S.no+S.hist.length;
function tick(){prev=S.price;S.price=Math.max(100,r2(S.price+(Math.random()-.5)*.8));feed();engine();const s=S.state+S.no+S.hist.length;if(s!==sig){sig=s;save();Bus.emit("state",S.state)}render()}

/* ═════════════ LOGIN (MT5 account number + password) ═════════════ */
/* v4.19.1: Arabic keyboards type ٠-٩ — convert them to 0-9 instead of dropping them (the old \D strip left the field empty) */
const lgDigits=v=>String(v||"").replace(/[\u0660-\u0669]/g,c=>c.charCodeAt(0)-1632).replace(/[\u06F0-\u06F9]/g,c=>c.charCodeAt(0)-1776).replace(/\D/g,"");
function lgEye(hide){try{const p=$("lgP"),b=$("lgE");if(!p||!b)return;if(hide)p.type="password";const sh=p.type!=="password";b.setAttribute("aria-pressed",String(sh));b.setAttribute("aria-label",t(sh?"lg_hide":"lg_show"))}catch(e){}}
function lgMark(id){const el=$(id);if(!el)return;el.setAttribute("aria-invalid","true");try{el.focus({preventScroll:false})}catch(e){}}
function lgClean(){["lgA","lgP"].forEach(i=>$(i)&&$(i).removeAttribute("aria-invalid"))}
const Login={
  has(){return !!SES.s&&!!SES.l},
  show(msg){const g=$("lg");g.className="";g.hidden=false;$("lgA").value=SES.l||$("lgA").value;$("lgP").value="";$("lgEr").textContent=msg||"";$("lgEr").classList.toggle("okm",!!msg&&msg===t("out_ok"));$("lgGo").disabled=false;lgClean();lgEye(true);$("lgCaps").hidden=true;if(!msg&&!this.auto&&window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initData){this.auto=true;this.go(true)}},
  async out(call,msg){
    if(this.outing)return;this.outing=true;
    const l=SES.l,tok=SES.s;let rk=msg||(call!==false?"out_ok":"");   /* v4.11: user-initiated logout says so; if the server could not confirm the revoke, say that honestly */
    SES.clr();                                          /* no usable session stays on this device, whatever the network does next */
    if(call!==false&&tok){
      try{const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),2500);
        const r=await fetch(CONFIG.api.baseUrl+"/logout",{method:"POST",keepalive:true,signal:ac.signal,headers:{"X-Login":l,"X-Session":tok}});clearTimeout(tm);
        if(!r.ok&&r.status!==401){rk="out_warn";Ops.note({rid:"logout",c:"logout",p:{}},"revoke_unconfirmed","http "+r.status)}}   /* 401 = already invalid, which is the goal */
      catch(e){rk="out_warn";Ops.note({rid:"logout",c:"logout",p:{}},"revoke_unconfirmed",String(e&&e.name||e))}
    }
    try{sessionStorage.setItem("ytMsg",rk)}catch(e){}
    location.reload()          // everything restarts from scratch: no data of the previous account stays in memory
  },
  msg(){let m="";try{m=sessionStorage.getItem("ytMsg")||"";sessionStorage.removeItem("ytMsg")}catch(e){}return m&&D[m]?t(m):""},
  async go(auto){
    if(this.busy||$("lgGo").disabled)return;          /* Enter on the password field used to bypass the disabled button → duplicate login requests */
    const au=auto===true;   /* v4.14: inside Telegram the owner is recognised by Telegram itself: no account number, no password */
    const l=lgDigits($("lgA").value),p=$("lgP").value,er=$("lgEr");er.textContent="";lgClean();
    if(!au&&!/^\d{3,12}$/.test(l)){er.textContent=t("e_login");lgMark("lgA");return}
    if(!au&&!p){er.textContent=t("e_pw_empty");lgMark("lgP");return}
    const g=$("lg");g.className="w";$("lgGo").disabled=true;this.busy=true;let keep=false;
    const ac=new AbortController(),tmo=setTimeout(()=>ac.abort(),15000);
    try{
      const init=(window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initData)||"";
      const r=await fetch(CONFIG.api.baseUrl+"/login",{method:"POST",headers:{"Content-Type":"application/json"},signal:ac.signal,body:JSON.stringify({login:l,pw:p,init})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok){this.show("");$("lgA").value=l;if(au){return}
        const k="e_"+(d.error||"srv");er.textContent=D[k]?t(k):t("e_srv");if(d.error==="login")lgMark("lgA");else if(d.error==="bad_pw"||d.error==="pw_short"||d.error==="pw_empty")lgMark("lgP");return}
      keep=true;SES.set(d.login||l,d.sess);Verify.ok=true;g.className="ok";vib&&vib();
      setTimeout(()=>{this.busy=false;g.hidden=true;g.className="";Bridge.init=false;Bridge.ok=null;Bridge.pull()},1100);
    }catch(e){this.show();$("lgA").value=l;er.textContent=t("e_srv")}
    finally{clearTimeout(tmo);if(!keep)this.busy=false}
  }
};
$("lgGo").onclick=()=>Login.go();
$("lgP").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();Login.go()}});
$("lgA").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("lgP").focus()}});
$("lgE").onclick=()=>{const p=$("lgP");p.type=p.type==="password"?"text":"password";lgEye();p.focus()};
D.lg_hide=["إخفاء كلمة السر","Hide password"];D.lg_show=["إظهار كلمة السر","Show password"];
D.lg_caps=["الأحرف الكبيرة (Caps Lock) مفعّلة","Caps Lock is on"];
$("lgA").addEventListener("input",()=>{const a=$("lgA"),c=lgDigits(a.value);if(a.value!==c)a.value=c;a.removeAttribute("aria-invalid")});
$("lgP").addEventListener("input",()=>$("lgP").removeAttribute("aria-invalid"));
const lgCaps=e=>{try{$("lgCaps").hidden=!(e.getModifierState&&e.getModifierState("CapsLock"))}catch(x){}};
$("lgP").addEventListener("keydown",lgCaps);$("lgP").addEventListener("keyup",lgCaps);$("lgP").addEventListener("blur",()=>{$("lgCaps").hidden=true});
lgEye();
D.out_ok=["تم تسجيل الخروج بنجاح.","You have been signed out."];
D.out_warn=["تم الخروج من هذا الجهاز، لكن تعذّر تأكيد إنهاء الجلسة على الخادم. تنتهي تلقائياً بانتهاء مدتها.","Signed out on this device, but the server could not confirm ending the session. It will expire on its own."];
Object.assign(D,{rkReq:["المخاطرة المطلوبة","Requested risk"],rkMin:["أقل مخاطرة ينفّذها الوسيط","Broker minimum risk"],rkEff:["المخاطرة الفعلية","Effective risk"],rkPol:["السياسة","Policy"],
rk_BELOW_MIN:["المخاطرة المطلوبة {0} أقل من أقل مخاطرة يمكن للوسيط تنفيذها ({1}، أقل لوت {2}). البوت ينتظر حجماً صالحاً — ارفع المخاطرة أو وسّع المستويين أو فعّل CLAMP_TO_MIN في الـ EA.","Requested risk {0} is below the smallest risk the broker can execute ({1}, min lot {2}). The bot WAITS for a valid volume — raise the risk, widen the levels or enable CLAMP_TO_MIN in the EA."],
rk_ABOVE_MAX:["الحجم المطلوب يتجاوز الحد الأقصى للوسيط — البوت ينتظر","The required volume exceeds the broker maximum — the bot waits"],rk_ABOVE_LIMIT:["حد الحجم الإجمالي لدى الوسيط (Volume Limit) سيُتجاوز — البوت ينتظر","The broker's Volume Limit would be exceeded — the bot waits"],
rk_CLAMPED:["استُخدم أقل لوت للوسيط: المخاطرة المطلوبة {0} ← الفعلية {1}","Minimum lot used: requested {0} → effective {1}"],
w_WAITING_VOLUME:["بانتظار حجم صالح","Waiting for a valid volume"],w_WAITING_MARGIN:["بانتظار هامش كافٍ","Waiting for enough margin"],w_WAITING_SPREAD:["بانتظار انخفاض السبريد","Waiting for the spread to narrow"],w_WAITING_MARKET:["السوق مغلق — بانتظار الافتتاح","Market closed — waiting for the open"],
w_WAITING_SEQCAP:["بانتظار — بلغت الخسائر المتتالية السقف","Paused — consecutive-loss cap reached"],w_WAITING_RISKCAP:["بانتظار — المخاطرة التالية فوق سقف الرصيد","Paused — next risk is above the balance cap"],w_WAITING_BROKER:["بانتظار الوسيط","Waiting for the broker"],w_WAITING_PRICE:["بانتظار السعر","Waiting for the price"],w_WAITING_REENTRY:["بانتظار إعادة الدخول","Waiting to re-enter"],
e_pair:["لا يمكن وضع Buy Stop و Sell Stop معاً بهذا العرض. أقل عرض الآن = {0}","A Buy Stop and a Sell Stop cannot exist together at this width. Minimum width now = {0}"],
pvEA:["يحسب الـ EA اللوت والمخاطرة الفعلية بعد التطبيق","The EA calculates the lot and effective risk after Apply"]});
Object.assign(D,{vf_t:["التحقق من الاتصال","Connection check"],vf_s:["فحص سريع قبل الدخول التلقائي","Quick check before automatic sign-in"],
vf_a:["الحساب","Account"],vf_tg:["تلجرام","Telegram"],vf_b:["البوت","Bot"],vf_se:["الجلسة","Session"],vf_go:["تحقق اتصال","Check connection"],vf_alt:["تسجيل الدخول بحساب آخر","Sign in with another account"],
vf_run:["جارٍ الفحص…","Checking…"],vf_okM:["كل شيء سليم — جارٍ الدخول","All good — signing you in"],vf_cache:["رجعت لجلستك — تظهر آخر حالة محفوظة حتى يعود الاتصال","Back in your session — showing the last saved state until the connection returns"],vf_wait:["البوت مطفي. سيتم الدخول تلقائياً عند تشغيله.","The bot is off. You will be signed in automatically when it starts."],
e_pw_changed:["تم تغيير كلمة السر. سجّل الدخول من جديد.","The password was changed. Please sign in again."],e_expired:["انتهت صلاحية الجلسة. سجّل الدخول من جديد.","Your session expired. Please sign in again."],
e_acct:["تغيّر حساب أو سيرفر MT5. سجّل الدخول من جديد.","The MT5 account or server changed. Please sign in again."],e_tgchg:["حساب تلجرام غير مسجَّل لهذا الحساب. سجّل الدخول من جديد.","This Telegram account is not registered for this account. Please sign in again."]});




/* ═════════════ VERIFY (auto sign-in with a quick connection check) ═════════════
   Runs only while ENTERING the app with a saved session. All checks OK -> enters by itself.
   Hard failure (session / account / Telegram) -> sign-in screen. Soft failure (bot is off) -> waits and enters when it is back. */
const Verify={ok:false,busy:false,tm:null,tries:0,
  tgInit(){return new Promise(res=>{let n=0;const w=()=>{const x=window.Telegram&&Telegram.WebApp;if(x&&x.initData!==undefined&&(x.initData||n>12))return res(x.initData||"");if(++n>14)return res("");setTimeout(w,100)};w()})},
  row(id,st){const e=$(id);e.className="rw "+st;e.querySelector("i").textContent=""},
  show(){$("vf").hidden=false},hide(){$("vf").hidden=true;clearTimeout(this.tm)},
  async run(manual){
    if(this.busy)return;this.busy=true;clearTimeout(this.tm);this.show();
    ["vfA","vfT","vfB","vfS"].forEach(i=>this.row(i,"run"));$("vfGo").disabled=true;$("vfM").textContent=t("vf_run");
    let d=null;
    try{
      const init=await this.tgInit();
      const r=await fetch(CONFIG.api.baseUrl+"/verify",{method:"POST",headers:{"Content-Type":"application/json","X-Login":SES.l,"X-Session":SES.s},body:JSON.stringify({init})});
      d=await r.json().catch(()=>null);
      if(r.status===429||r.status>=500)d=null;
    }catch(e){d=null}
    this.busy=false;$("vfGo").disabled=false;
    if(!d){["vfA","vfT","vfB","vfS"].forEach(i=>this.row(i,"no"));if(this.snap()){this.resume();return}$("vfM").textContent=t("e_srv");this.next();return}
    const c=d.checks||{};
    this.row("vfS",c.session?"ok":"no");this.row("vfA",c.account?"ok":"no");this.row("vfT",c.session?(c.telegram?"ok":"no"):"no");this.row("vfB",c.bot?"ok":"no");
    if(d.ok){$("vfM").textContent=t("vf_okM");vib&&vib();setTimeout(()=>this.enter(),650);return}
    if(d.hard){      // different account / Telegram / expired / password changed -> normal sign-in
      const m=d.why==="pw"||d.why==="revoked"?"e_pw_changed":d.why==="expired"?"e_expired":d.why==="acct"?"e_acct":d.why==="tg"?"e_tgchg":"e_relogin";
      setTimeout(()=>Login.out(false,m),900);return}
    if(this.snap()){this.resume();return}$("vfM").textContent=t("vf_wait");this.next()},      // only the bot is off: keep trying, enter automatically
  next(){clearTimeout(this.tm);this.tries++;this.tm=setTimeout(()=>{if(!document.hidden)this.run()},this.tries<10?3000:8000)},
  snap(){try{const x=JSON.parse(localStorage.getItem("ytSnap")||"null");return!!(x&&x.d&&x.l&&x.l===SES.l)}catch(e){return false}},
  resume(){this.ok=true;this.hide();Bridge.init=false;Bridge.ok=null;Bridge.pull();try{toast(t("vf_cache"))}catch(e){}},
  enter(){this.ok=true;this.hide();Bridge.init=false;Bridge.ok=null;Bridge.pull()}
};
$("vfGo").onclick=()=>{vib&&vib();Verify.tries=0;Verify.run(true)};
$("vfAlt").onclick=()=>Login.out(true);
window.addEventListener("load",()=>{TG.init();navInd()});
setTheme(UI.th);
applyFolds();$("in_b").value=S.buy;$("in_s").value=S.sell;$("in_r").value=S.risk;$("in_t").value=S.target;$("in_rr").value=S.rr;
const phoneLang=()=>{try{const w=TG.wa||(window.Telegram&&Telegram.WebApp),u=w&&w.initDataUnsafe&&w.initDataUnsafe.user,l=String((u&&u.language_code)||navigator.language||(navigator.languages&&navigator.languages[0])||"ar").toLowerCase();return l.indexOf("ar")===0?0:1}catch(e){return 0}};
setLang(UI.lgManual?(UI.lg||0):phoneLang());   // phone language (Telegram / system) unless the user switched manually with the language button
window.addEventListener("load",()=>{if(!UI.lgManual){const v=phoneLang();if(v!==LG)setLang(v)}});   // the Telegram script loads async: re-check once it is there
if(live()){if(Login.has())Verify.run();else Login.show(Login.msg());setInterval(()=>{if(!document.hidden&&Login.has()&&Verify.ok)Bridge.pull()},CONFIG.api.pollMs);setInterval(()=>{setMode();renderLink()},1000);document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Login.has()&&Verify.ok)Bridge.pull()})}else setInterval(tick,1200);
/* ── v2 polish: tick flash, loading skeleton, retry, Esc, a11y, haptics ── */
(function(){
  document.body.classList.add("loading");
  const o=Bridge.pull.bind(Bridge);let lp=0;
  Bridge.pull=async function(){await o();document.body.classList.remove("loading")};
  const rp=renderPrice;renderPrice=function(){const old=lp;rp();if(old&&S.price>0&&!S.frz&&S.price!==old){const e=$("pr");e.classList.remove("tu","td");void e.offsetWidth;e.classList.add(S.price>old?"tu":"td")}lp=S.price};
  $("retryB").onclick=()=>{vib();Bridge.ok=null;if(Login.has()&&Verify.ok)Bridge.pull()};
  document.addEventListener("keydown",e=>{if(e.key==="Escape")shut()});
  $("sheet").setAttribute("role","dialog");$("sheet").setAttribute("aria-modal","true");$("ssh").setAttribute("role","alertdialog");$("toast").setAttribute("role","status");$("toast").setAttribute("aria-live","polite");
})();

/* ═════════════ v4.18 — delegated clicks (the page has NO inline event handlers, so CSP needs no 'unsafe-inline' for scripts) ═════════════ */
const OC={fillMkt:()=>fillMkt(),modPair:()=>modPair(),delPair:()=>delPair(),stop:()=>stop(),start:()=>start(),closePos:()=>closePos(),resetUI:()=>resetUI(),newCycleUI:()=>newCycleUI(),logoutAsk:()=>logoutAsk(),
  addOrder:a=>addOrder(a==="SELL"?"SELL":"BUY"),delLayer:a=>delLayer(Math.max(0,Math.trunc(Number(a))||0)),"YTN.orderAsk":a=>window.YTN&&window.YTN.orderAsk(String(a||""))};
document.addEventListener("click",e=>{const el=e.target.closest&&e.target.closest("[data-oc]");if(!el||el.disabled)return;const fn=OC[el.getAttribute("data-oc")];if(fn)fn(el.getAttribute("data-oa"))},true);
