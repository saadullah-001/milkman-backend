const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

function uidToAgoraUid(firebaseUid) {
  let hash = 0;
  for (let i = 0; i < firebaseUid.length; i++) {
    hash = (hash * 31 + firebaseUid.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483646) + 1;
}

function registerAgoraRoutes(app, { admin, authMiddleware }) {
  const db = admin.firestore();
  const appId = process.env.AGORA_APP_ID || "";
  const appCertificate = process.env.AGORA_APP_CERTIFICATE || "";

  app.post("/api/agora/token", authMiddleware, async (req, res) => {
    try {
      if (!appId || !appCertificate) {
        return res.status(503).json({
          error:
            "Agora is not configured. Set AGORA_APP_ID and AGORA_APP_CERTIFICATE on the server.",
        });
      }

      const appointmentId = req.body?.appointmentId;
      if (!appointmentId || typeof appointmentId !== "string") {
        return res.status(400).json({ error: "appointmentId required." });
      }

      const apptSnap = await db.collection("appointments").doc(appointmentId).get();
      if (!apptSnap.exists) {
        return res.status(404).json({ error: "Appointment not found." });
      }

      const appt = apptSnap.data();
      const callerId = req.user.uid;
      if (appt.userId !== callerId && appt.vetId !== callerId) {
        return res.status(403).json({ error: "Not allowed on this appointment." });
      }
      if (appt.type !== "videoCall") {
        return res.status(400).json({ error: "This appointment is not a video call." });
      }
      if (appt.status === "cancelled") {
        return res.status(400).json({ error: "Appointment was cancelled." });
      }
      if (appt.status === "completed") {
        return res.status(400).json({ error: "Appointment already completed." });
      }

      const channelName = appointmentId;
      const agoraUid = uidToAgoraUid(callerId);
      const expireSeconds = 3600;
      const privilegeExpiredTs =
        Math.floor(Date.now() / 1000) + expireSeconds;

      const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        agoraUid,
        RtcRole.PUBLISHER,
        privilegeExpiredTs,
      );

      res.json({
        token,
        appId,
        channelName,
        uid: agoraUid,
        expireAt: privilegeExpiredTs,
      });
    } catch (err) {
      console.error("agora token:", err);
      res.status(500).json({ error: err.message || "Failed to create Agora token." });
    }
  });
}

module.exports = { registerAgoraRoutes };
