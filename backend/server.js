require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PORT = process.env.PORT || 3000;
const S3_BUCKET = process.env.S3_BUCKET || "milkman-s3-bucket";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const ALLOWED_ROLES = new Set(["rider", "seller", "vet", "pet_shop"]);

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required.");
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function s3Client() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials are not configured.");
  }
  return new S3Client({
    region: AWS_REGION,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function extensionForMime(mimeType) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

function parseObjectKey(stored) {
  if (!stored || typeof stored !== "string") return null;
  if (stored.startsWith("s3://")) {
    const withoutScheme = stored.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) return null;
    return withoutScheme.slice(slash + 1);
  }
  if (stored.startsWith("registration_docs/")) return stored;
  return null;
}

function userIdFromObjectKey(objectKey) {
  const parts = objectKey.split("/");
  return parts.length >= 2 ? parts[1] : null;
}

async function callerIsAdmin(uid) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return snap.exists && snap.data().isAdmin === true;
}

async function assertCanViewDoc(uid, objectKey) {
  const ownerId = userIdFromObjectKey(objectKey);
  if (ownerId === uid) return;
  if (await callerIsAdmin(uid)) return;
  const err = new Error("Not allowed to view this document.");
  err.status = 403;
  throw err;
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const token = header.slice(7);
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

initFirebase();

const app = express();

const corsOrigins = process.env.CORS_ORIGINS;
app.use(
  cors({
    origin: corsOrigins ? corsOrigins.split(",").map((s) => s.trim()) : true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "milkman-api" });
});

app.post("/api/registration/upload-url", authMiddleware, async (req, res) => {
  try {
    const { role, docKey, mimeType } = req.body ?? {};

    if (!ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    if (!docKey || typeof docKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(docKey)) {
      return res.status(400).json({ error: "Invalid docKey." });
    }
    if (!mimeType || !mimeType.startsWith("image/")) {
      return res.status(400).json({ error: "Only image uploads are allowed." });
    }

    const userId = req.user.uid;
    const ext = extensionForMime(mimeType);
    const objectKey = `registration_docs/${userId}/${role}/${docKey}.${ext}`;

    const uploadUrl = await getSignedUrl(
      s3Client(),
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        ContentType: mimeType,
      }),
      { expiresIn: 900 },
    );

    res.json({
      uploadUrl,
      objectUrl: `s3://${S3_BUCKET}/${objectKey}`,
      objectKey,
    });
  } catch (err) {
    console.error("upload-url error:", err);
    res.status(500).json({ error: err.message || "Internal server error." });
  }
});

app.post("/api/registration/view-url", authMiddleware, async (req, res) => {
  try {
    const { objectUrl, objectKey: rawKey } = req.body ?? {};
    const objectKey = rawKey || parseObjectKey(objectUrl);

    if (!objectKey || !objectKey.startsWith("registration_docs/")) {
      return res.status(400).json({ error: "Invalid document reference." });
    }

    await assertCanViewDoc(req.user.uid, objectKey);

    const viewUrl = await getSignedUrl(
      s3Client(),
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }),
      { expiresIn: 3600 },
    );

    res.json({ viewUrl, objectKey });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("view-url error:", err);
    res.status(status).json({ error: err.message || "Internal server error." });
  }
});

app.listen(PORT, () => {
  console.log(`milkman-api listening on port ${PORT}`);
});
