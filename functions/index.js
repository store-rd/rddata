// functions/index.js
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https"); // <--- تأكد من استيراد onRequest
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const cors = require("cors")({origin: true}); // <--- لإضافة CORS للسماح بالطلبات من المتصفح

admin.initializeApp();
const db = admin.firestore();

// الوصول إلى متغيرات البيئة التي تم تحميلها من ملف .env
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHATID;
const APP_ID = process.env.APP_CONFIG_APPID || "default-app-id";

// --- الدالة المجدولة الحالية (تبقى كما هي) ---
exports.sendSubscriptionReminders = onSchedule({
    schedule: "every day 09:00",
    timeZone: "Asia/Baghdad",
    // memory: "256MiB",
    // timeoutSeconds: 120,
}, async (event) => {
    logger.info("Running subscription reminder check (v2 - using process.env)...", { structuredData: true });

    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("CRITICAL ERROR (v2): Telegram Bot Token or Chat ID not found in process.env.", { BOT_TOKEN_EXISTS: !!BOT_TOKEN, CHAT_ID_EXISTS: !!CHAT_ID, structuredData: true });
        return null;
    }
    if (!APP_ID) {
        logger.warn("Warning (v2): APP_ID not found in process.env, using default.", { structuredData: true });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const twoDaysFromNow = new Date(today);
    twoDaysFromNow.setDate(today.getDate() + 2);
    twoDaysFromNow.setHours(23, 59, 59, 999);

    const appOwnerUserId = "12818792613782511468"; // <--- تأكد أن هذه هي القيمة الصحيحة

    if (!appOwnerUserId || appOwnerUserId === "استبدل_هذا_بمعرف_المستخدم_الخاص_بك_في_النظام") {
         logger.error("CRITICAL ERROR (v2): appOwnerUserId is not set correctly in the function code.", { structuredData: true });
         await sendTelegramMessageV2(`🚨 خطأ حرج في دالة تنبيهات الاشتراكات (v2): لم يتم تعيين appOwnerUserId بشكل صحيح.`);
         return null;
    }

    try {
        const subscriptionsPath = `artifacts/${APP_ID}/users/${appOwnerUserId}/subscriptions`;
        logger.info(`Querying subscriptions (v2) at path: ${subscriptionsPath}`, { structuredData: true });
        const subscriptionsRef = db.collection(subscriptionsPath);
        const querySnapshot = await subscriptionsRef
            .where("status", "==", "active")
            .where("expiryDate", ">=", admin.firestore.Timestamp.fromDate(today))
            .where("expiryDate", "<=", admin.firestore.Timestamp.fromDate(twoDaysFromNow))
            .get();

        if (querySnapshot.empty) {
            logger.info(`No subscriptions expiring (v2) in the next 2 days for user: ${appOwnerUserId}`, { structuredData: true });
            return null;
        }
        let messages = [];
        querySnapshot.forEach(doc => {
            const sub = doc.data();
            const expiryDate = sub.expiryDate.toDate().toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" });
            const phoneNumber = sub.phoneNumber || "رقم غير معروف";
            messages.push(`- اشتراك العميل ${phoneNumber} سينتهي في: ${expiryDate}.`);
        });
        if (messages.length > 0) {
            const fullMessage = `🔔 تنبيهات انتهاء الاشتراكات القادمة (v2):\n${messages.join("\n")}`;
            await sendTelegramMessageV2(fullMessage);
            logger.info("Reminder messages sent successfully (v2) to Telegram.", { structuredData: true });
        }
    } catch (error) {
        logger.error("Error processing subscription reminders (v2):", error, { structuredData: true });
        await sendTelegramMessageV2(`⚙️ حدث خطأ أثناء معالجة تنبيهات الاشتراكات (v2):\n${error.message}`);
    }
    return null;
});

// --- دالة جديدة لإرسال إشعار عند إضافة مشترك جديد ---
exports.notifyNewSubscriber = onRequest(
    { cors: true }, // <--- تمكين CORS
    async (req, res) => {
    logger.info("notifyNewSubscriber function triggered.", { body: req.body, structuredData: true });

    // للتعامل مع CORS preflight requests
    // if (req.method === "OPTIONS") {
    //     res.set("Access-Control-Allow-Origin", "*"); // كن أكثر تحديدًا في الإنتاج
    //     res.set("Access-Control-Allow-Methods", "POST");
    //     res.set("Access-Control-Allow-Headers", "Content-Type");
    //     res.status(204).send("");
    //     return;
    // }
    // استخدام مكتبة cors يعالج هذا بشكل أفضل

    if (req.method !== "POST") {
        logger.warn("notifyNewSubscriber: Received non-POST request.", { method: req.method, structuredData: true });
        return res.status(405).send("Method Not Allowed. Please use POST.");
    }

    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("notifyNewSubscriber: Telegram Bot Token or Chat ID not configured.", { structuredData: true });
        return res.status(500).send("Server configuration error for Telegram.");
    }

    const phoneNumber = req.body.phoneNumber;
    const startDate = req.body.startDate; // تاريخ البدء (اختياري، يمكن إضافته للرسالة)
    const expiryDate = req.body.expiryDate; // تاريخ الانتهاء (اختياري، يمكن إضافته للرسالة)


    if (!phoneNumber) {
        logger.warn("notifyNewSubscriber: phoneNumber not provided in request body.", { body: req.body, structuredData: true });
        return res.status(400).send("Bad Request: phoneNumber is required.");
    }

    try {
        let messageText = `✅ مشترك جديد تمت إضافته:\n`;
        messageText += `رقم الهاتف: ${phoneNumber}\n`;
        if (startDate) messageText += `تاريخ البدء: ${new Date(startDate).toLocaleDateString("ar-EG")}\n`;
        if (expiryDate) messageText += `تاريخ الانتهاء: ${new Date(expiryDate).toLocaleDateString("ar-EG")}\n`;
        
        await sendTelegramMessageV2(messageText);
        logger.info(`Notification sent for new subscriber: ${phoneNumber}`, { structuredData: true });
        return res.status(200).send({success: true, message: "Notification sent."});
    } catch (error) {
        logger.error(`Error sending new subscriber notification for ${phoneNumber}:`, error, { structuredData: true });
        return res.status(500).send({success: false, message: "Failed to send notification."});
    }
});


// --- دالة مساعدة لإرسال الرسائل إلى تليجرام (تبقى كما هي) ---
async function sendTelegramMessageV2(text) {
    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("Telegram token or chat ID is missing for sending message (v2).", { text, structuredData: true });
        return;
    }
    const telegramApiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(telegramApiUrl, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: "Markdown"
        });
        logger.info("Message sent to Telegram successfully (v2).", { structuredData: true });
    } catch (error) {
        let errorMessage = "Error sending message to Telegram (v2): ";
        if (error.response) {
            errorMessage += `Status: ${error.response.status}, Description: ${error.response.data ? error.response.data.description : "No description"}`;
        } else if (error.request) {
            errorMessage += "No response received from Telegram (v2).";
        } else {
            errorMessage += error.message;
        }
        logger.error(errorMessage, { error, structuredData: true });
    }
}

// --- دالة اختبارية يتم استدعاؤها عبر HTTP (تبقى كما هي) ---
exports.testTelegramMessage = onRequest(
    { cors: true }, // <--- تمكين CORS هنا أيضًا للاختبار من المتصفح
    async (req, res) => {
    logger.info("Test Telegram message function (v2) triggered.", { structuredData: true });

    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("Test function (v2): Telegram Bot Token or Chat ID not available via process.env.", { structuredData: true });
        res.status(500).send("CRITICAL (v2): Telegram Bot Token or Chat ID not available from process.env. Check .env file.");
        return;
    }
    try {
        const testText = "👋 رسالة اختبارية من Firebase Function (v2 - .env direct)!\nإذا استلمت هذه الرسالة، فالاتصال ببوت تليجرام يعمل بشكل صحيح.\n\nالتوقيت الحالي: " + new Date().toLocaleString("ar-EG", {timeZone: "Asia/Baghdad"});
        await sendTelegramMessageV2(testText);
        res.status(200).send("Test message (v2) has been sent to your Telegram bot! Please check your Telegram.");
    } catch (error) {
        logger.error("Error sending test message from HTTPS function (v2):", error, { structuredData: true });
        res.status(500).send("Failed to send test message to Telegram (v2). Check Firebase Functions logs.");
    }
});