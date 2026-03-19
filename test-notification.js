const http = require("http");

const fcmToken =
  "eif6EHT9SYuEqQBg88n1c_:APA91bGkHFEhYonQo9ipYSoQcFxrx_gly1RkZfeBNFsTt4BYN3Eg5qaKye_CSd0eMOta4PCpnaSAX0lWQZ6ywmkOQ1_HFGKA4RtDCfxMZaA2TLPFTXMu4rM";

const payload = JSON.stringify({
  userId: "test",
  fcmToken: fcmToken,
  title: "Test Mission",
  body: "Notification from Backend!",
  data: { missionId: "123" },
});

const options = {
  hostname: "localhost",
  port: 3000,
  path: "/send-notification",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
  },
};

const req = http.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => {
    data += chunk;
  });
  res.on("end", () => {
    console.log("✅ Response:", data);
  });
});

req.on("error", (e) => {
  console.error("❌ Error:", e.message);
});

req.write(payload);
req.end();
