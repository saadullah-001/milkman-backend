const crypto = require("crypto");

/**
 * Wallet + Stripe (test) + JazzCash/EasyPaisa (when configured / sandbox).
 */
function registerPaymentRoutes(app, { admin, authMiddleware, callerIsAdmin }) {
  const db = admin.firestore();
  const PAYMENTS_TEST_MODE = process.env.PAYMENTS_TEST_MODE === "true";
  const PAYMENTS_SANDBOX = process.env.PAYMENTS_SANDBOX === "true";

  const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
  let stripe = null;
  if (stripeSecret) {
    // eslint-disable-next-line global-require
    stripe = require("stripe")(stripeSecret);
  }

  const jazzConfigured =
    !!process.env.JAZZCASH_MERCHANT_ID &&
    !!process.env.JAZZCASH_PASSWORD &&
    !!process.env.JAZZCASH_INTEGRITY_SALT;

  const easypaisaConfigured =
    !!process.env.EASYPAISA_STORE_ID && !!process.env.EASYPAISA_HASH_KEY;

  async function getBalance(userId) {
    const snap = await db.collection("users").doc(userId).get();
    if (!snap.exists) return 0;
    return Number(snap.data().walletBalance || 0);
  }

  async function applyWalletTx({
    userId,
    amount,
    type,
    note,
    referenceId,
    createdBy,
  }) {
    const userRef = db.collection("users").doc(userId);
    let balanceAfter = 0;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        const err = new Error("User profile not found.");
        err.status = 404;
        throw err;
      }
      const current = Number(userSnap.data().walletBalance || 0);
      balanceAfter = Math.round((current + amount) * 100) / 100;
      if (balanceAfter < 0) {
        const err = new Error("Insufficient app credits.");
        err.status = 402;
        throw err;
      }
      tx.update(userRef, {
        walletBalance: balanceAfter,
        walletCurrency: "PKR",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const txRef = db.collection("wallet_transactions").doc();
      tx.set(txRef, {
        userId,
        amount,
        type,
        note: note || "",
        referenceId: referenceId || null,
        balanceAfter,
        createdBy: createdBy || userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return balanceAfter;
  }

  app.get("/api/payments/methods", authMiddleware, (_req, res) => {
    res.json({
      currency: "PKR",
      methods: {
        cod: { enabled: true, label: "Cash on Delivery" },
        wallet: { enabled: true, label: "App Credits" },
        stripe: {
          enabled: !!stripe,
          label: "Card (Stripe)",
          testMode: stripeSecret.startsWith("sk_test_"),
        },
        jazzcash: {
          enabled: jazzConfigured || PAYMENTS_SANDBOX,
          label: "JazzCash",
          sandbox: !jazzConfigured && PAYMENTS_SANDBOX,
        },
        easypaisa: {
          enabled: easypaisaConfigured || PAYMENTS_SANDBOX,
          label: "EasyPaisa",
          sandbox: !easypaisaConfigured && PAYMENTS_SANDBOX,
        },
      },
      testMode: PAYMENTS_TEST_MODE || PAYMENTS_SANDBOX,
    });
  });

  app.get("/api/wallet", authMiddleware, async (req, res) => {
    try {
      const uid = req.user.uid;
      const balance = await getBalance(uid);
      const txSnap = await db
        .collection("wallet_transactions")
        .where("userId", "==", uid)
        .limit(50)
        .get();
      const transactions = txSnap.docs
        .map((doc) => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || null,
        }))
        .sort((a, b) => {
          const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
          const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
          return tb - ta;
        })
        .slice(0, 20);
      res.json({ balance, currency: "PKR", transactions });
    } catch (err) {
      res.status(500).json({ error: err.message || "Internal server error." });
    }
  });

  app.post("/api/wallet/grant-credits", authMiddleware, async (req, res) => {
    try {
      const { userId, amount, note } = req.body ?? {};
      const isAdmin = await callerIsAdmin(req.user.uid);
      const selfGrant =
        PAYMENTS_TEST_MODE &&
        userId === req.user.uid &&
        Number(amount) > 0 &&
        Number(amount) <= 5000;

      if (!isAdmin && !selfGrant) {
        return res.status(403).json({ error: "Admin or test mode required." });
      }

      const targetId = typeof userId === "string" ? userId : req.user.uid;
      const credit = Number(amount);
      if (!Number.isFinite(credit) || credit <= 0 || credit > 100000) {
        return res.status(400).json({ error: "Invalid amount." });
      }

      const balanceAfter = await applyWalletTx({
        userId: targetId,
        amount: credit,
        type: isAdmin ? "admin_grant" : "test_top_up",
        note: note || (selfGrant ? "Test credits" : "Admin grant"),
        createdBy: req.user.uid,
      });

      res.json({ balance: balanceAfter, currency: "PKR" });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || "Internal server error." });
    }
  });

  app.post("/api/wallet/pay", authMiddleware, async (req, res) => {
    try {
      const { amount, referenceId, note } = req.body ?? {};
      const debit = Number(amount);
      if (!Number.isFinite(debit) || debit <= 0) {
        return res.status(400).json({ error: "Invalid amount." });
      }

      const balanceAfter = await applyWalletTx({
        userId: req.user.uid,
        amount: -debit,
        type: "purchase",
        note: note || "Order payment",
        referenceId: referenceId || null,
        createdBy: req.user.uid,
      });

      res.json({
        paid: true,
        balance: balanceAfter,
        paymentStatus: "paid",
        paymentMethod: "wallet",
      });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || "Internal server error." });
    }
  });

  app.post("/api/payments/stripe/create-intent", authMiddleware, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({
          error: "Stripe is not configured. Set STRIPE_SECRET_KEY on the server.",
        });
      }

      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount." });
      }

      // PKR: two decimal places → smallest unit
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: "pkr",
        automatic_payment_methods: { enabled: true },
        metadata: {
          userId: req.user.uid,
          referenceId: req.body?.referenceId || "",
        },
      });

      await db.collection("payment_records").doc(intent.id).set({
        provider: "stripe",
        userId: req.user.uid,
        amount,
        currency: "PKR",
        status: "pending",
        referenceId: req.body?.referenceId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
      });
    } catch (err) {
      console.error("stripe create-intent:", err);
      res.status(500).json({ error: err.message || "Stripe error." });
    }
  });

  app.post("/api/payments/stripe/confirm", authMiddleware, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Stripe not configured." });
      }
      const paymentIntentId = req.body?.paymentIntentId;
      if (!paymentIntentId) {
        return res.status(400).json({ error: "paymentIntentId required." });
      }

      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.metadata?.userId !== req.user.uid) {
        return res.status(403).json({ error: "Not your payment." });
      }

      const paid = intent.status === "succeeded";
      await db.collection("payment_records").doc(paymentIntentId).set(
        {
          status: paid ? "paid" : intent.status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (!paid) {
        return res.status(402).json({
          error: `Payment not completed (${intent.status}).`,
        });
      }

      res.json({
        paid: true,
        paymentStatus: "paid",
        paymentMethod: "stripe",
        paymentIntentId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Stripe confirm failed." });
    }
  });

  function createPendingPayment(provider, userId, amount, referenceId) {
    const ref = db.collection("payment_records").doc();
    return ref
      .set({
        provider,
        userId,
        amount,
        currency: "PKR",
        status: "pending",
        referenceId: referenceId || null,
        sandbox: PAYMENTS_SANDBOX && provider !== "stripe",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .then(() => ref.id);
  }

  app.post("/api/payments/jazzcash/initiate", authMiddleware, async (req, res) => {
    try {
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount." });
      }

      const paymentId = await createPendingPayment(
        "jazzcash",
        req.user.uid,
        amount,
        req.body?.referenceId,
      );

      if (jazzConfigured) {
        // Production/sandbox merchant — redirect to JazzCash MWALLET page
        const returnUrl =
          process.env.JAZZCASH_RETURN_URL ||
          "https://milkman.app/payments/jazzcash/return";
        const txnRef = `JC${DateTimeNow()}_${paymentId.slice(0, 8)}`;
        const integrity = jazzIntegrityHash({
          amount: amount.toFixed(2),
          txnRef,
          returnUrl,
        });
        const checkoutUrl =
          `${process.env.JAZZCASH_POST_URL || "https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction"}?` +
          new URLSearchParams({
            pp_Amount: Math.round(amount * 100).toString(),
            pp_BillReference: txnRef,
            pp_Description: "Milkman order",
            pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
            pp_ReturnURL: returnUrl,
            pp_SecureHash: integrity,
          }).toString();

        await db.collection("payment_records").doc(paymentId).update({
          externalRef: txnRef,
          checkoutUrl,
        });

        return res.json({ paymentId, checkoutUrl, provider: "jazzcash" });
      }

      if (PAYMENTS_SANDBOX) {
        return res.json({
          paymentId,
          provider: "jazzcash",
          sandbox: true,
          message: "JazzCash sandbox — complete via /api/payments/sandbox/complete",
        });
      }

      return res.status(503).json({
        error: "JazzCash not configured. Set JAZZCASH_* env vars or PAYMENTS_SANDBOX=true.",
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "JazzCash initiate failed." });
    }
  });

  app.post("/api/payments/easypaisa/initiate", authMiddleware, async (req, res) => {
    try {
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount." });
      }

      const paymentId = await createPendingPayment(
        "easypaisa",
        req.user.uid,
        amount,
        req.body?.referenceId,
      );

      if (easypaisaConfigured) {
        const checkoutUrl =
          process.env.EASYPAISA_CHECKOUT_URL ||
          "https://easypay.easypaisa.com.pk/easypay/Index.jsf";
        await db.collection("payment_records").doc(paymentId).update({
          checkoutUrl,
          storeId: process.env.EASYPAISA_STORE_ID,
        });
        return res.json({ paymentId, checkoutUrl, provider: "easypaisa" });
      }

      if (PAYMENTS_SANDBOX) {
        return res.json({
          paymentId,
          provider: "easypaisa",
          sandbox: true,
          message: "EasyPaisa sandbox — complete via /api/payments/sandbox/complete",
        });
      }

      return res.status(503).json({
        error: "EasyPaisa not configured. Set EASYPAISA_* env vars or PAYMENTS_SANDBOX=true.",
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "EasyPaisa initiate failed." });
    }
  });

  app.post("/api/payments/sandbox/complete", authMiddleware, async (req, res) => {
    try {
      if (!PAYMENTS_SANDBOX && !PAYMENTS_TEST_MODE) {
        return res.status(403).json({ error: "Sandbox mode disabled." });
      }

      const paymentId = req.body?.paymentId;
      if (!paymentId) {
        return res.status(400).json({ error: "paymentId required." });
      }

      const ref = db.collection("payment_records").doc(paymentId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Payment not found." });
      }
      const data = snap.data();
      if (data.userId !== req.user.uid) {
        return res.status(403).json({ error: "Not your payment." });
      }

      await ref.update({
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        paid: true,
        paymentStatus: "paid",
        paymentMethod: data.provider,
        paymentId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Sandbox complete failed." });
    }
  });

  app.get("/api/payments/status/:paymentId", authMiddleware, async (req, res) => {
    try {
      const snap = await db
        .collection("payment_records")
        .doc(req.params.paymentId)
        .get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Payment not found." });
      }
      const data = snap.data();
      if (data.userId !== req.user.uid) {
        return res.status(403).json({ error: "Not your payment." });
      }
      res.json({
        paymentId: snap.id,
        status: data.status,
        provider: data.provider,
        paid: data.status === "paid",
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Status check failed." });
    }
  });

  function DateTimeNow() {
    return Date.now().toString();
  }

  function jazzIntegrityHash({ amount, txnRef, returnUrl }) {
    const salt = process.env.JAZZCASH_INTEGRITY_SALT || "";
    const merchantId = process.env.JAZZCASH_MERCHANT_ID || "";
    const password = process.env.JAZZCASH_PASSWORD || "";
    const raw = `${salt}&${amount}&${txnRef}&${returnUrl}&${merchantId}&${password}`;
    return crypto.createHmac("sha256", salt).update(raw).digest("hex");
  }
}

module.exports = { registerPaymentRoutes };
