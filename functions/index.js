// functions/index.js
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// --- إعدادات عامة وثوابت ---
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHATID;
const APP_ID = process.env.APP_CONFIG_APPID || "default-app-id";
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || "د.ع";

// !! هام جداً: هذا هو معرف المستخدم (UID من Firebase Authentication) لصاحب النظام
const appOwnerUserId = "12818792613782511468"; // <--- استبدل هذا بالـ UID الصحيح لصاحب النظام

// --- دالة مساعدة لإرسال الرسائل إلى تليجرام ---
async function sendTelegramMessageV2(text, parseMode = "Markdown") {
    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("Telegram token or chat ID is missing for sending message.", {text, structuredData: true});
        return;
    }
    const telegramApiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(telegramApiUrl, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: parseMode,
        });
        logger.info("Message sent to Telegram successfully.", {textLength: text.length, structuredData: true});
    } catch (error) {
        let errorMessage = "Error sending message to Telegram: ";
        if (error.response) {
            errorMessage += `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            errorMessage += "No response received from Telegram.";
        } else {
            errorMessage += error.message;
        }
        logger.error(errorMessage, {error, structuredData: true});
    }
}

// --- الدالة المجدولة لإرسال تنبيهات انتهاء الاشتراكات ---
exports.sendSubscriptionReminders = onSchedule({
    schedule: "every day 09:00",
    timeZone: "Asia/Baghdad",
}, async (event) => {
    logger.info("Running subscription reminder check...", {eventTime: event.time, structuredData: true});

    if (!BOT_TOKEN || !CHAT_ID) {
        logger.error("CRITICAL ERROR: Telegram Bot Token or Chat ID not found in environment variables.", { BOT_TOKEN_EXISTS: !!BOT_TOKEN, CHAT_ID_EXISTS: !!CHAT_ID, structuredData: true });
        return null;
    }
    if (!APP_ID || APP_ID === "default-app-id") {
        logger.warn(`Warning: APP_ID is using default value "${APP_ID}". Ensure this is intended.`, { structuredData: true });
    }
    if (!appOwnerUserId || appOwnerUserId === "YOUR_ACTUAL_OWNER_UID_HERE" ) { // تأكد من تعديل هذا الشرط إذا لزم الأمر
         logger.error("CRITICAL ERROR: appOwnerUserId is not set correctly or is using a placeholder.", { appOwnerUserId, structuredData: true });
         await sendTelegramMessageV2(`🚨 *خطأ حرج في دالة تنبيهات الاشتراكات:*\nلم يتم تعيين `+"`appOwnerUserId`"+` بشكل صحيح في كود الدالة. يرجى مراجعة الإعدادات فورًا.`);
         return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reminderDaysWindow = 2;
    const cutOffDate = new Date(today);
    cutOffDate.setDate(today.getDate() + reminderDaysWindow);
    cutOffDate.setHours(23, 59, 59, 999);

    try {
        const subscriptionsPath = `artifacts/${APP_ID}/users/${appOwnerUserId}/subscriptions`;
        logger.info(`Querying subscriptions at path: ${subscriptionsPath} for user UID: ${appOwnerUserId}`, { structuredData: true });
        
        const subscriptionsRef = db.collection(subscriptionsPath);
        const querySnapshot = await subscriptionsRef
            .where("status", "==", "active")
            .where("expiryDate", ">=", admin.firestore.Timestamp.fromDate(today))
            .where("expiryDate", "<=", admin.firestore.Timestamp.fromDate(cutOffDate))
            .orderBy("expiryDate", "asc")
            .get();

        if (querySnapshot.empty) {
            logger.info(`No subscriptions expiring in the next ${reminderDaysWindow} days for user: ${appOwnerUserId}.`, { structuredData: true });
            return null;
        }

        let reminderMessages = [];
        querySnapshot.forEach(doc => {
            const sub = doc.data();
            const expiryDate = sub.expiryDate.toDate();
            const daysRemaining = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
            const expiryDateString = expiryDate.toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" });
            const phoneNumber = sub.phoneNumber || "غير محدد";
            const price = sub.price !== undefined && sub.price !== null ? `${sub.price.toLocaleString()} ${CURRENCY_SYMBOL}` : "لم يحدد";

            let reminderText = `📞 *${phoneNumber}*`;
            reminderText += `\n   - ينتهي في: *${expiryDateString}* (باقي ${daysRemaining} يوم/أيام)`;
            if (sub.price !== undefined) reminderText += `\n   - السعر: ${price}`;
            if (sub.notes) reminderText += `\n   - ملاحظات: ${sub.notes.substring(0, 50)}${sub.notes.length > 50 ? "..." : ""}`;
            reminderMessages.push(reminderText);
        });

        if (reminderMessages.length > 0) {
            const fullMessage = `🔔 *تنبيهات انتهاء الاشتراكات القادمة:*\n\n${reminderMessages.join("\n\n")}`;
            await sendTelegramMessageV2(fullMessage);
            logger.info(`${reminderMessages.length} reminder messages sent successfully to Telegram.`, { structuredData: true });
        }

    } catch (error) {
        logger.error("Error processing subscription reminders:", error, { structuredData: true });
        await sendTelegramMessageV2(`⚙️ *حدث خطأ أثناء معالجة تنبيهات الاشتراكات:*\n\`\`\`\n${error.message}\n\`\`\``);
    }
    return null;
});

// --- دالة لإرسال إشعار عند إضافة مشترك جديد ---
exports.notifyNewSubscriber = onRequest(
    {
        cors: true, 
    },
    async (req, res) => {
        logger.info("notifyNewSubscriber function triggered.", {body: req.body, method: req.method, structuredData: true});

        if (req.method === "OPTIONS") {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
            res.set("Access-Control-Max-Age", "3600");
            res.status(204).send("");
            return;
        }
        
        if (req.method !== "POST") {
            logger.warn("notifyNewSubscriber: Received non-POST request.", {method: req.method, structuredData: true});
            return res.status(405).json({success: false, message: "Method Not Allowed. Please use POST."});
        }

        if (!BOT_TOKEN || !CHAT_ID) {
            logger.error("notifyNewSubscriber: Telegram Bot Token or Chat ID not configured.", { BOT_TOKEN_EXISTS: !!BOT_TOKEN, CHAT_ID_EXISTS: !!CHAT_ID, structuredData: true });
            return res.status(500).json({success: false, message: "Server configuration error for Telegram."});
        }

        const {phoneNumber, price, startDate, expiryDate, duration} = req.body;

        if (!phoneNumber) {
            logger.warn("notifyNewSubscriber: phoneNumber not provided in request body.", {body: req.body, structuredData: true});
            return res.status(400).json({success: false, message: "Bad Request: phoneNumber is required."});
        }

        try {
            let messageText = `✅ *مشترك جديد تمت إضافته للنظام:*\n\n`;
            messageText += `📞 *رقم الهاتف:* \`${phoneNumber}\`\n`;

            if (price !== undefined && price !== null) {
                messageText += `💰 *السعر:* ${parseFloat(price).toLocaleString()} ${CURRENCY_SYMBOL}\n`;
            }
            if (startDate) {
                messageText += `🗓️ *تاريخ البدء:* ${new Date(startDate).toLocaleDateString("ar-EG", {day: "2-digit", month: "short", year: "numeric"})}\n`;
            }
            if (expiryDate) {
                messageText += `⌛ *تاريخ الانتهاء:* ${new Date(expiryDate).toLocaleDateString("ar-EG", {day: "2-digit", month: "short", year: "numeric"})}\n`;
            }
            if (duration) {
                messageText += `⏳ *مدة الاشتراك:* ${duration} يوم\n`;
            }
            
            messageText += `\n✨ بالتوفيق في خدمته!`;

            await sendTelegramMessageV2(messageText);
            logger.info(`Notification sent for new subscriber: ${phoneNumber}`, {data: req.body, structuredData: true});
            return res.status(200).json({success: true, message: "Notification sent successfully."});
        } catch (error) {
            logger.error(`Error sending new subscriber notification for ${phoneNumber}:`, error, {data: req.body, structuredData: true});
            return res.status(500).json({success: false, message: "Failed to send notification due to an internal error."});
        }
    },
);

// --- دالة اختبارية يتم استدعاؤها عبر HTTP لإرسال رسالة تليجرام ---
exports.testTelegramMessage = onRequest(
    { cors: true },
    async (req, res) => {
        logger.info("Test Telegram message function triggered.", {method: req.method, structuredData: true});

        if (req.method === "OPTIONS") {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type");
            res.status(204).send("");
            return;
        }

        if (!BOT_TOKEN || !CHAT_ID) {
            logger.error("Test function: Telegram Bot Token or Chat ID not available via environment variables.", { BOT_TOKEN_EXISTS: !!BOT_TOKEN, CHAT_ID_EXISTS: !!CHAT_ID, structuredData: true });
            res.status(500).send("CRITICAL: Telegram Bot Token or Chat ID not available. Check environment variables or .env file for local development.");
            return;
        }
        try {
            const now = new Date();
            const testText = `👋 *رسالة اختبارية من Firebase Function!*\n\nإذا استلمت هذه الرسالة، فالاتصال ببوت تليجرام يعمل بشكل صحيح من خلال دالة HTTP.\n\n*معلومات النظام:*\n- *APP_ID:* \`${APP_ID}\`\n- *UID المالك (مفترض):* \`${appOwnerUserId}\`\n- *رمز العملة:* ${CURRENCY_SYMBOL}\n\n*التوقيت الحالي:* ${now.toLocaleString("ar-EG", {timeZone: "Asia/Baghdad", hour12: true, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'})}`;
            await sendTelegramMessageV2(testText);
            res.status(200).send("Test message has been sent to your Telegram bot! Please check your Telegram.");
        } catch (error) {
            logger.error("Error sending test message from HTTPS function:", error, { structuredData: true });
            res.status(500).send("Failed to send test message to Telegram. Check Firebase Functions logs for details.");
        }
    },
);
