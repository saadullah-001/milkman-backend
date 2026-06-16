const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

admin.initializeApp();

const AWS_ACCESS_KEY_ID = defineSecret("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = defineSecret("AWS_SECRET_ACCESS_KEY");

const S3_BUCKET = "milkman-s3-bucket";
const AWS_REGION = "us-east-1";
const FUNCTIONS_REGION = "us-east1";
const ALLOWED_ROLES = new Set(["rider", "seller", "vet", "pet_shop"]);

function s3Client(accessKeyId, secretAccessKey) {
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
  throw new HttpsError("permission-denied", "Not allowed to view this document.");
}

exports.getRegistrationUploadUrl = onCall(
  {
    secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
    region: FUNCTIONS_REGION,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const { role, docKey, mimeType } = request.data ?? {};
    if (!ALLOWED_ROLES.has(role)) {
      throw new HttpsError("invalid-argument", "Invalid role.");
    }
    if (!docKey || typeof docKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(docKey)) {
      throw new HttpsError("invalid-argument", "Invalid docKey.");
    }
    if (!mimeType || !mimeType.startsWith("image/")) {
      throw new HttpsError("invalid-argument", "Only image uploads are allowed.");
    }

    const userId = request.auth.uid;
    const ext = extensionForMime(mimeType);
    const objectKey = `registration_docs/${userId}/${role}/${docKey}.${ext}`;

    const client = s3Client(
      AWS_ACCESS_KEY_ID.value(),
      AWS_SECRET_ACCESS_KEY.value(),
    );

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        ContentType: mimeType,
      }),
      { expiresIn: 900 },
    );

    return {
      uploadUrl,
      objectUrl: `s3://${S3_BUCKET}/${objectKey}`,
      objectKey,
    };
  },
);

exports.getRegistrationDocViewUrl = onCall(
  {
    secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
    region: FUNCTIONS_REGION,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const { objectUrl, objectKey: rawKey } = request.data ?? {};
    const objectKey = rawKey || parseObjectKey(objectUrl);
    if (!objectKey || !objectKey.startsWith("registration_docs/")) {
      throw new HttpsError("invalid-argument", "Invalid document reference.");
    }

    await assertCanViewDoc(request.auth.uid, objectKey);

    const client = s3Client(
      AWS_ACCESS_KEY_ID.value(),
      AWS_SECRET_ACCESS_KEY.value(),
    );

    const viewUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }),
      { expiresIn: 3600 },
    );

    return { viewUrl, objectKey };
  },
);
