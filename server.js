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
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

function parseObjectKey(stored) {
  if (!stored || typeof stored !== "string") return null;
  const trimmed = stored.trim();

  if (trimmed.startsWith("s3://")) {
    const withoutScheme = trimmed.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) return null;
    const bucket = withoutScheme.slice(0, slash);
    if (bucket !== S3_BUCKET) return null;
    return decodeURIComponent(withoutScheme.slice(slash + 1));
  }

  if (trimmed.startsWith("registration_docs/")) return trimmed;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const withoutQuery = trimmed.split("?")[0];
      const u = new URL(withoutQuery);
      const host = u.hostname.toLowerCase();
      const pathKey = u.pathname.startsWith("/")
        ? u.pathname.slice(1)
        : u.pathname;
      if (!pathKey) return null;

      const vhostMatch = host.match(/^(.+)\.s3[.-][a-z0-9-]+\.amazonaws\.com$/i);
      if (vhostMatch && vhostMatch[1] === S3_BUCKET) {
        return decodeURIComponent(pathKey);
      }

      if (/^s3[.-][a-z0-9-]+\.amazonaws\.com$/i.test(host)) {
        const parts = pathKey.split("/");
        if (parts[0] === S3_BUCKET && parts.length > 1) {
          return decodeURIComponent(parts.slice(1).join("/"));
        }
      }
    } catch (_) {
      return null;
    }
  }

  return null;
}

function userIdFromObjectKey(objectKey) {
  const parts = objectKey.split("/");
  return parts.length >= 2 ? parts[1] : null;
}

async function callerIsApprovedPetShop(uid) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return (
    snap.exists &&
    snap.data().role === "pet_shop" &&
    snap.data().isApproved === true
  );
}

const PET_SHOP_CATALOG = [
  {
    name: "Royal Canin Adult Dog Food",
    category: "food",
    brand: "Royal Canin",
    description: "Complete balanced nutrition for adult dogs",
    price: 3500,
    unit: "3 kg",
    emoji: "🐕",
    rating: 4.8,
    reviewCount: 245,
    isAvailable: true,
    isFeatured: true,
  },
  {
    name: "Whiskas Tuna Cat Food",
    category: "food",
    brand: "Whiskas",
    description: "Tender tuna pieces in jelly for cats",
    price: 1200,
    unit: "12 pouches",
    emoji: "🐱",
    rating: 4.6,
    reviewCount: 189,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Pedigree Puppy Milk Starter",
    category: "food",
    brand: "Pedigree",
    description: "Milk-based starter food for puppies",
    price: 850,
    unit: "400 g",
    emoji: "🐶",
    rating: 4.5,
    reviewCount: 98,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Adjustable Dog Collar",
    category: "accessories",
    brand: "PetZone",
    description: "Durable nylon collar with quick-release buckle",
    price: 450,
    unit: "piece",
    emoji: "🦮",
    rating: 4.3,
    reviewCount: 67,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Retractable Dog Leash 5m",
    category: "accessories",
    brand: "FlexiLeash",
    description: "5-meter retractable leash for medium to large dogs",
    price: 1800,
    unit: "piece",
    emoji: "🐕‍🦺",
    rating: 4.7,
    reviewCount: 134,
    isAvailable: true,
    isFeatured: true,
  },
  {
    name: "Cat Scratcher Toy",
    category: "toys",
    brand: "CatJoy",
    description: "Sisal rope scratching post with hanging feather",
    price: 950,
    unit: "piece",
    emoji: "😺",
    rating: 4.4,
    reviewCount: 52,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Interactive Dog Puzzle",
    category: "toys",
    brand: "SmartPet",
    description: "IQ-boosting treat puzzle for mental stimulation",
    price: 1400,
    unit: "piece",
    emoji: "🧩",
    rating: 4.6,
    reviewCount: 78,
    isAvailable: true,
    isFeatured: true,
  },
  {
    name: "Tick & Flea Spot-On Treatment",
    category: "health",
    brand: "Frontline",
    description: "Monthly tick and flea protection for dogs",
    price: 2200,
    unit: "3 pipettes",
    emoji: "💊",
    rating: 4.9,
    reviewCount: 312,
    isAvailable: true,
    isFeatured: true,
  },
  {
    name: "Vitamin & Mineral Supplement",
    category: "health",
    brand: "NutriPet",
    description: "Daily multivitamins for dogs and cats",
    price: 680,
    unit: "60 tablets",
    emoji: "🌿",
    rating: 4.5,
    reviewCount: 45,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Pet Grooming Brush",
    category: "grooming",
    brand: "GroomPro",
    description: "Self-cleaning slicker brush for all coat types",
    price: 780,
    unit: "piece",
    emoji: "✂️",
    rating: 4.4,
    reviewCount: 89,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Pet Shampoo (Oatmeal)",
    category: "grooming",
    brand: "PawSpa",
    description: "Gentle oatmeal shampoo for sensitive skin",
    price: 560,
    unit: "300 ml",
    emoji: "🛁",
    rating: 4.6,
    reviewCount: 103,
    isAvailable: true,
    isFeatured: false,
  },
  {
    name: "Stainless Steel Pet Bowl Set",
    category: "accessories",
    brand: "PetBasics",
    description: "Non-slip double bowl set for food and water",
    price: 720,
    unit: "set of 2",
    emoji: "🥣",
    rating: 4.5,
    reviewCount: 156,
    isAvailable: true,
    isFeatured: false,
  },
];

async function callerIsAdmin(uid) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return snap.exists && snap.data().isAdmin === true;
}

async function ensurePetShopCatalog(sellerId) {
  const db = admin.firestore();
  const existing = await db
    .collection("pet_products")
    .where("sellerId", "==", sellerId)
    .limit(1)
    .get();
  if (!existing.empty) return { count: 0, action: "already_setup" };

  const batch = db.batch();
  PET_SHOP_CATALOG.forEach((product) => {
    const ref = db.collection("pet_products").doc();
    batch.set(ref, {
      ...product,
      sellerId,
      isDummyListing: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  return { count: PET_SHOP_CATALOG.length, action: "seeded_catalog" };
}

function isAnimalMedicalDocKey(objectKey) {
  const fileName = objectKey.split("/").pop() || "";
  return fileName.startsWith("animalMedical_");
}

function isAnimalPhotoDocKey(objectKey) {
  const fileName = objectKey.split("/").pop() || "";
  return fileName.startsWith("animalPhoto_");
}

function isVetProfilePhotoKey(objectKey) {
  const parts = objectKey.split("/");
  if (parts.length < 4 || parts[0] !== "registration_docs" || parts[2] !== "vet") {
    return false;
  }
  const fileName = parts[3] || "";
  return fileName.startsWith("profilePhoto");
}

function isPetProductPhotoKey(objectKey) {
  const parts = objectKey.split("/");
  if (parts.length < 4 || parts[0] !== "registration_docs" || parts[2] !== "pet_shop") {
    return false;
  }
  const fileName = parts[3] || "";
  return fileName.startsWith("productPhoto_");
}

async function isCatalogLinkedMedia(db, refs) {
  const unique = [...new Set(refs.filter(Boolean))];
  for (const ref of unique) {
    const checks = await Promise.all([
      db.collection("animals").where("imageUrls", "array-contains", ref).limit(1).get(),
      db.collection("animals").where("imageUrl", "==", ref).limit(1).get(),
      db.collection("animals").where("medicalReportUrl", "==", ref).limit(1).get(),
      db.collection("products").where("imageUrl", "==", ref).limit(1).get(),
      db.collection("pet_products").where("imageUrl", "==", ref).limit(1).get(),
      db.collection("vets").where("photoUrl", "==", ref).limit(1).get(),
    ]);
    if (checks.some((snap) => !snap.empty)) return true;
  }
  return false;
}

async function assertCanViewDoc(uid, objectKey, originalRef) {
  if (await callerIsAdmin(uid)) return;

  const ownerId = userIdFromObjectKey(objectKey);
  if (ownerId && ownerId === uid) return;

  const db = admin.firestore();
  const s3Ref = `s3://${S3_BUCKET}/${objectKey}`;
  const refs = [s3Ref, objectKey, originalRef?.trim()].filter(Boolean);
  if (await isCatalogLinkedMedia(db, refs)) return;

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
    methods: ["GET", "POST", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  }),
);
app.options("*", cors());
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
    const isAnimalMedical = docKey.startsWith("animalMedical_");
    if (
      !mimeType ||
      (!mimeType.startsWith("image/") &&
        !(isAnimalMedical && mimeType === "application/pdf"))
    ) {
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

    if (!objectKey) {
      return res.status(400).json({ error: "Invalid document reference." });
    }

    await assertCanViewDoc(req.user.uid, objectKey, objectUrl);

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

app.post("/api/pet-shop/setup-catalog", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const isAdmin = await callerIsAdmin(uid);
    const isPetShop = await callerIsApprovedPetShop(uid);
    if (!isAdmin && !isPetShop) {
      return res.status(403).json({ error: "Approved pet shop required." });
    }

    const sellerId =
      isAdmin && typeof req.body?.sellerId === "string" && req.body.sellerId
        ? req.body.sellerId
        : uid;

    const result = await ensurePetShopCatalog(sellerId);
    res.json(result);
  } catch (err) {
    console.error("setup-catalog error:", err);
    res.status(500).json({ error: err.message || "Internal server error." });
  }
});

const { registerPaymentRoutes } = require("./payments");
registerPaymentRoutes(app, { admin, authMiddleware, callerIsAdmin, express });

const { registerAgoraRoutes } = require("./agora");
registerAgoraRoutes(app, { admin, authMiddleware });

app.listen(PORT, () => {
  console.log(`milkman-api listening on port ${PORT}`);
});
