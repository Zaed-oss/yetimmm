# السلوك الحالي (v4.8.0 / EA 2.23) — الوثيقة الوحيدة المعتمدة لما يحدث الآن
> الـ CHANGELOG سجل تاريخي. أي تعارض بينه وبين هذه الوثيقة، الصحيح هذه.

## الإعدادات الافتراضية
| الإدخال | القيمة | المعنى |
|---|---|---|
| `InpEntryMode` | `ENTRY_PENDING` | أمرا Buy Stop و Sell Stop حقيقيان على السيرفر |
| `InpBreachPolicy` | `BREACH_WAIT` | بعد SL يُعاد تسليح الزوج؛ `WAITING_REENTRY` حتى يمكن وضع الأمرين. Market Reversal مطفأ |
| `InpRiskPolicy` | `STRICT` | لا تتجاوز المخاطرة المطلوبة أبداً |
| `InpOrderCheck` | `true` | `OrderCheck` قبل كل أمر معلّق |
| `InpMaxSpread` | `0` (مطفأ) | فوقه: أوامر جديدة تنتظر `WAITING_SPREAD` |
| `InpTpResetNetOnly` | `true` | TP يصفّر التسلسل فقط إذا غطّى صافي الصفقة الخسارة المتراكمة |
| `InpTgViaWorker` | `true` | إشعارات عبر الـ Worker؛ لا Token في MT5؛ لا polling |
| `InpCmdTtlSec` | `30` | أمر أقدم من ذلك = EXPIRED |
| `InpTgMenu` | `false` | (v2.25) لا تُرفق لوحة أزرار START/STOP/… برسائل البوت. الأوامر `/start /stop …` وردود الأزرار القديمة تعمل كما هي، و`/menu` يعرض اللوحة عند الطلب |

## سلسلة حساب اللوت (EA = المرجع الوحيد)
خسارة اللوت عند SL (`OrderCalcProfit`/Tick Value) → `raw = المخاطرة ÷ خسارة اللوت` → تقريب **لأسفل** إلى `min + k·step` → حدّ `min` → حدّ `max` → `SYMBOL_VOLUME_LIMIT` (مفتوح + معلّق بنفس الاتجاه، دون أوامر البوت نفسه) → الهامش → `OrderCheck`.
- `raw < min`: `STRICT` ⇒ `WAITING_VOLUME` (بلا أمر/خطأ/إيقاف، تنبيه واحد). `CLAMP_TO_MIN` ⇒ أقل لوت **مع إظهار المخاطرة الفعلية**.
- `raw > max` أو تجاوز Volume Limit ⇒ `WAITING_VOLUME`. هامش غير كافٍ ⇒ `WAITING_MARGIN`.
- مثال: خسارة اللوت 145، مخاطرة 1 ⇒ raw 0.0069 < 0.01 ⇒ STRICT ينتظر (أقل مخاطرة قابلة للتنفيذ 1.45)؛ CLAMP_TO_MIN ينفّذ 0.01 بمخاطرة فعلية 1.45.

## حالات الانتظار (`wcode`) — ليست أخطاء
`WAITING_VOLUME` · `WAITING_MARGIN` · `WAITING_SPREAD` · `WAITING_MARKET` · `WAITING_BROKER` · `WAITING_PRICE` · `WAITING_REENTRY` · `WAITING_SEQCAP` · `WAITING_RISKCAP` (حارس خطة التعويض، v2.24). الخطأ الحقيقي (`ERROR`) يبقى فقط لتكرار فشل إرسال غير قابل للتعافي (8 مرات متتالية).

## التحقق
- `PAIR_NOT_EXECUTABLE`: عرض المنطقة < `2 × Stops Level + Spread الحي` ⇒ يُرفض عند التطبيق (وضع PENDING).
- مدة الأمر من `SYMBOL_EXPIRATION_MODE` (GTC ثم DAY ثم SPECIFIED).

## ما تعرضه الواجهة
`S.bs` (BrokerSpec حي) و`S.rk` (المخاطرة المطلوبة/أقل مخاطرة/الفعلية/السياسة/الحالة). الواجهة لا تمنع Start/Apply في Live بحسابها؛ المعاينة تقدير بنفس الحساب ومعنونة. المحاكاة تستخدم ملف وسيط صريح (`?profile=` / `YetimmmAPI.simProfile()`).

## الإشعارات والأوامر
EA → Worker (`ev[]` بمعرّف `login:magic:seq`) → `Notify.emit` (منع تكرار دائم) → Telegram؛ الـ Worker يعيد `evack`. الأوامر تصل بـ `age`؛ المنتهية تُسجَّل EXPIRED ولا تُنفَّذ. أول مزامنة بعد تشغيل الـ EA تتجاهل الأوامر المتراكمة (مقصود).
