const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin SDK
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: Read from environment variable
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Loading Firebase credentials from environment variable");
  } catch (error) {
    console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT:", error.message);
    process.exit(1);
  }
} else if (fs.existsSync("./firebase-service-account.json")) {
  // Development: Read from local file
  serviceAccount = require("./firebase-service-account.json");
  console.log("✅ Loading Firebase credentials from local file");
} else {
  console.error(
    "❌ Firebase credentials not found! Set FIREBASE_SERVICE_ACCOUNT environment variable or create firebase-service-account.json",
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "ambulance-app-572b2",
});

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL || "https://aaeglgmzusasbxatjkjl.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZWdsZ216dXNhc2J4YXRqa2psIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE0MTM0MCwiZXhwIjoyMDg3NzE3MzQwfQ.P-F1jvG_XrXZ9oyXciOV3YW1dn8xG4Z6mSLr2U5Oy6c",
);

// Deduplication cache: Store recent mission notifications to prevent duplicates
// Key: missionNumber, Value: {timestamp, count}
const notificationCache = new Map();
const DEDUPE_WINDOW_MS = 5000; // 5 second window to catch duplicate requests

// Send notification to specific user
app.post("/send-notification", async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get FCM token from Supabase (or your database)
    // For now, you can test with a static token
    const fcmToken = req.body.fcmToken; // Pass token in request or fetch from DB

    if (!fcmToken) {
      return res.status(400).json({ error: "FCM token not found" });
    }

    // Send message
    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: data || {},
      token: fcmToken,
    };

    const response = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: response,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send to multiple users
app.post("/send-notification-bulk", async (req, res) => {
  try {
    const { userIds, title, body, data } = req.body;

    // Fetch FCM tokens for all users from database
    // Example: const tokens = await db.query('SELECT fcm_token FROM user_fcm_tokens WHERE user_id IN (...)')

    const messages = userIds.map((userId) => ({
      notification: { title, body },
      data: data || {},
      token: userId, // Replace with actual FCM token
    }));

    const response = await admin.messaging().sendAll(messages);

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send notification to ALL users
app.post("/send-notification-all", async (req, res) => {
  try {
    const { title, body, data, missionNumber, requestId } = req.body;

    console.log("═══════════════════════════════════════════════════");
    console.log("📢 NOTIFICATION REQUEST RECEIVED");
    console.log("Title:", title);
    console.log("Body:", body);
    console.log("Data:", data);
    console.log("Mission Number:", missionNumber);
    console.log("Request ID:", requestId);
    console.log("═══════════════════════════════════════════════════");

    // DEDUPLICATION CHECK: Prevent sending same mission notification twice
    if (missionNumber) {
      const now = Date.now();
      const cached = notificationCache.get(missionNumber);

      if (cached && now - cached.timestamp < DEDUPE_WINDOW_MS) {
        console.log(
          `⚠️  DUPLICATE DETECTED! Mission ${missionNumber} already sent ${cached.count} time(s) in last ${DEDUPE_WINDOW_MS}ms`,
        );
        console.log(
          "🚫 BLOCKING DUPLICATE REQUEST TO PREVENT 2X NOTIFICATIONS",
        );
        return res.json({
          success: false,
          blocked: true,
          reason: "Duplicate notification request (deduped)",
          sentCount: 0,
        });
      }

      // Update cache
      notificationCache.set(missionNumber, {
        timestamp: now,
        count: (cached?.count || 0) + 1,
        requestId,
      });
      console.log(
        `✅ Added to dedupe cache: ${missionNumber} (request #${requestId})`,
      );

      // Clean up old entries (older than 30 seconds)
      for (const [key, value] of notificationCache.entries()) {
        if (now - value.timestamp > 30000) {
          notificationCache.delete(key);
          console.log(`🧹 Cleaned cache entry: ${key}`);
        }
      }
    }

    if (!title || !body) {
      console.log("❌ Missing required fields: title or body");
      return res.status(400).json({ error: "Missing title or body" });
    }

    // Fetch all FCM tokens from Supabase
    console.log("🔄 Fetching FCM tokens from Supabase...");
    const { data: tokens, error } = await supabase
      .from("user_fcm_tokens")
      .select("fcm_token");

    if (error) {
      console.error("❌ Supabase error:", error);
      return res.status(500).json({ error: "Failed to fetch FCM tokens" });
    }

    console.log(`✅ Found ${tokens?.length || 0} FCM tokens in database`);

    if (!tokens || tokens.length === 0) {
      console.log("⚠️  No FCM tokens found in database!");
      console.log("This means no users have registered their devices yet.");
      return res.json({
        success: true,
        sentCount: 0,
        message: "No FCM tokens found",
      });
    }

    // Log all tokens (first 50 chars only for privacy)
    console.log("📋 FCM Tokens:");
    tokens.forEach((t, i) => {
      console.log(`  [${i + 1}] ${t.fcm_token.substring(0, 50)}...`);
    });

    // Create messages for all tokens with Android-specific styling
    const messages = tokens
      .filter((t) => t.fcm_token) // Filter out null tokens
      .map((t) => ({
        notification: { title, body },
        data: {
          ...data,
          missionNumber: missionNumber || "",
        },
        android: {
          // Android-specific notification styling
          priority: "high",
          notification: {
            title: title,
            body: body,
            // Ambulance blue color (#2962FF) - applied to the small icon
            color: "#2962FF",
            // Sound configuration
            sound: "default",
            // Channel ID must match Android settings
            channelId: "ambulance_channel",
            // Notification priority
            notificationPriority: "PRIORITY_HIGH",
            // Vibration pattern (ms on, off, on)
            vibrateTimingsMillis: [500, 300, 500],
            // LED pattern (color in #RRGGBB format, on ms, off ms)
            lightSettings: {
              color: "#2962FF", // Ambulance blue
              lightOnDurationMillis: 500,
              lightOffDurationMillis: 500,
            },
          },
        },
        webpush: {
          // Web push styling (if supported)
          notification: {
            title: title,
            body: body,
            badge: "ic_launcher",
          },
        },
        token: t.fcm_token,
      }));

    console.log(
      `\n📤 Sending ${messages.length} notifications via Firebase Cloud Messaging...`,
    );
    console.log("═══════════════════════════════════════════════════");

    // Try different Firebase Admin SDK methods depending on version
    let response;
    try {
      // Try sendMulticast first (newer SDK versions)
      if (typeof admin.messaging().sendMulticast === "function") {
        response = await admin.messaging().sendMulticast(messages);
      }
      // Fall back to sendAll (medium SDK versions)
      else if (typeof admin.messaging().sendAll === "function") {
        response = await admin.messaging().sendAll(messages);
      }
      // Fall back to manual send loop (older SDK versions)
      else {
        console.log("📤 Using send() method for each message...");
        const results = await Promise.all(
          messages.map((msg) =>
            admin
              .messaging()
              .send(msg)
              .catch((err) => ({ error: err })),
          ),
        );

        response = {
          successCount: results.filter((r) => !r.error).length,
          failureCount: results.filter((r) => r.error).length,
          responses: results,
        };
      }
    } catch (methodError) {
      // If all methods fail, return a helpful error
      console.error(
        "❌ All Firebase messaging methods failed:",
        methodError.message,
      );
      throw methodError;
    }

    console.log("═══════════════════════════════════════════════════");
    console.log(`✅ Notification batch sent!`);
    console.log(`   Success: ${response.successCount}`);
    console.log(`   Failed: ${response.failureCount}`);
    console.log(`   Total: ${response.successCount + response.failureCount}`);
    console.log("═══════════════════════════════════════════════════");

    res.json({
      success: true,
      sentCount: response.successCount,
      failedCount: response.failureCount,
      totalUsers: tokens.length,
    });
  } catch (error) {
    console.log("═══════════════════════════════════════════════════");
    console.error("❌ ERROR sending notifications:", error.message);
    console.error(error);
    console.log("═══════════════════════════════════════════════════");
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Notification server running on port ${PORT}`);
});
