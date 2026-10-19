# تنفيذ تقرير التدقيق الشامل — v4.8.0 / EA 2.23

المفتاح: ✅ منفّذ · 🟡 جزئي · ⛔ غير منفّذ (والسبب). **«EA غير مُترجم»**: الكود كُتب ودُقّق ببنيته (أقواس/فحص نصي) لكنه لم يُترجم لعدم وجود MetaEditor هنا.

| البنود | الموضوع | الحالة | أين / ملاحظة |
|---|---|---|---|
| 1-13 | مواصفات الوسيط والمخاطرة (min/step/max، floor، مثال 1$) | ✅ | `RiskCompute` + `RkJson` + اختبارات `risk-engine` |
| 14-16 | Requested vs Effective vs Min risk | ✅ | `rk` في الحالة + بطاقة الواجهة |
| 17-18 | BrokerSpec حي + اكتشاف التغيّر | ✅ (EA غير مُترجم) | `BsJson` يُرسل كل مزامنة ويسجّل التغيّر |
| 19-21 | Volume Limit / margin / OrderCheck | ✅ (EA غير مُترجم) | `DirVolume`, `PendingOrderCheck` |
| 22-24 | PAIR_NOT_EXECUTABLE / عرض أدنى | ✅ | `PairMinWidth`, `ValidateLevels`, `pairErr` بالواجهة |
| 25-27 | BREACH_WAIT افتراضي، Market Reversal OFF، MaxRevGap | ✅ | افتراضيات + `InpMaxRevGap` |
| 28-32 | خسارة/ربح متوقع عبر OrderCalcProfit | ✅ | `PerLotLossSL` + `est` في الحالة |
| 33-35 | Max Deviation كتسمية/حماية A-B-C | 🟡 | التسمية موجودة؛ أوضاع الحماية A/B/C لم تُنفَّذ |
| 36-42 | Waiting بدل خطأ، wcode | ✅ | `HandleLotError`, `RevEnterError`, بانر الواجهة |
| 43 | فلتر الأخبار | ⛔ | لم يُنفَّذ (يحتاج تصميماً وTester)؛ `InpMaxSpread` نُفّذ |
| 44-45 | آلة حالة الزوج / مركز واحد ذرّي | ⛔ | إعادة هيكلة عالية المخاطر بلا مترجم؛ الحماية الحالية `EnforceSinglePosition` باقية |
| 46-52 | أوامر TTL، مصدر واحد للإشعار، lastCmd بالمعرّف | ✅ | `age`+`InpCmdTtlSec`, `Bridge.mine` |
| 53-58 | إشعارات موحّدة بمعرّف حدث، Token خارج MT5، Telegram غير عام | ✅ | `EvEmit`, `events()`, `TgAuthorized` |
| 59 | قفل الدخول يمسح المالك | ✅ (كان صحيحاً أصلاً) | القفل لكل Telegram user/IP؛ اختبار جديد يثبت ذلك |
| 60-68 | PAIR_CODE إلزامي، CORS، جلسات | ✅ | 503 `pair_not_configured` |
| 69 | طبقة Session/سوق مغلق | 🟡 | `WAITING_MARKET` عبر OrderCheck فقط |
| 70-75 | توحيد الإصدار والوثائق | ✅ | `YT_VER`, `VERSION`, `check.mjs`, `CURRENT_BEHAVIOR.md` |
| 76-80 | محاسبة الاسترداد: صافي، TP جزئي | ✅ (EA غير مُترجم) | `InpTpResetNetOnly` |
| 81 | Partial fills | ⛔ | لم يُنفَّذ |
| 82-83 | دقة الأرقام/اللوت/العملة | ✅ | `vdig`, `r2n`, `cs()/fv()/fp()` |
| 84-85 | أرشيف تزايدي بدل إعادة المسح | ⛔ | لم يُنفَّذ |
| 86-91 | واجهة: حذف C/STEP/VMIN/VMAX، ملفات محاكاة، Bid/Ask، tick-aware | ✅ | `SIM_PROFILES`, `fillMkt`, `dB/dS` |
| 92-93 | فصل State Machine إلى 5 آلات | ⛔ | غير منفَّذ عمداً (خطر انحدار بلا مترجم) |
| 94-98 | Broker normalization / تغيّر خارجي | 🟡 | كشف تغيّر المواصفات فقط |
| 99-100 | REPLACE_TRANSACTION ذرّي | ⛔ | لم يُنفَّذ |
| 101-107 | اختبارات: Worker + Risk | ✅ | 43 + 13 + `npm run check` |
| 108 | مخاطرة كنسبة من الرصيد | ⛔ | لم يُنفَّذ |
| 109-111 | تكاليف قبل/بعد في تعريف المخاطرة | 🟡 | المحاسبة بالصافي؛ لا تقدير مسبق للعمولة |
| 112-113 | News filter / تفصيل الاتصال | ⛔ | لم يُنفَّذ |
| 114-119 | UX: بطاقات المخاطرة والانتظار | ✅ | `rkRows`, بانر `w_*` |
| 120-121 | Execution ID كامل | 🟡 | معرّف حدث الإشعار نعم؛ معرّف تنفيذ لكل أمر لا |
| 122-127 | حالات اختبار الحجم | ✅ | `tests/risk-engine.test.mjs` |
| 128-133 | MT5 Tester / Demo | ⛔ (يدوي) | `docs/MT5-TESTING.md` — لا يمكن تشغيله هنا |
| 134 | زر Use minimum lot في الواجهة | ⛔ | السياسة بإدخال EA فقط (`InpRiskPolicy`) |
| 135-149 | خطة التنفيذ والتسليم | ✅ | هذا الملف + CHANGELOG |

> ترقيم البنود تقريبي بحسب أقسام التقرير المرفوع، وهو مجمَّع حسب الموضوع.
