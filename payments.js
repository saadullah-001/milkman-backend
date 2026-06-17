const crypto = require("crypto");

/**
 * Wallet + Stripe (test) + JazzCash/EasyPaisa (when configured / sandbox).
 */
function registerPaymentRoutes(app, { admin, authMiddleware, callerIsAdmin, express }) {
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

  async function getOrCreateStripeCustomer(uid) {
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      const err = new Error("User profile not found.");
      err.status = 404;
      throw err;
    }
    const data = snap.data();
    if (data.stripeCustomerId) return data.stripeCustomerId;

    const customer = await stripe.customers.create({
      metadata: { userId: uid },
      name: data.displayName || undefined,
      phone: data.phoneNumber || undefined,
    });
    await userRef.update({
      stripeCustomerId: customer.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return customer.id;
  }

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

  async function settleWalletTopUp(docId) {
    const ref = db.collection("payment_records").doc(docId);
    let creditData = null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data();
      if (data.purpose !== "wallet_top_up") return;
      if (data.status !== "paid" || data.walletCredited) return;
      tx.update(ref, {
        walletCredited: true,
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      creditData = data;
    });

    if (!creditData) {
      const snap = await ref.get();
      if (!snap.exists) return null;
      const data = snap.data();
      return data.creditedBalance ?? null;
    }

    const balanceAfter = await applyWalletTx({
      userId: creditData.userId,
      amount: creditData.amount,
      type: "top_up",
      note: `Added via ${creditData.provider}`,
      referenceId: docId,
      createdBy: creditData.userId,
    });

    await ref.update({ creditedBalance: balanceAfter });
    return balanceAfter;
  }

  function paymentPurpose(body) {
    return body?.purpose === "wallet_top_up" ? "wallet_top_up" : "order";
  }

  app.get("/api/payments/methods", authMiddleware, (_req, res) => {
    const pkPaymentsEnabled = process.env.ENABLE_PK_PAYMENTS === "true";
    res.json({
      currency: "PKR",
      methods: {
        cod: { enabled: true, label: "Cash on Delivery" },
        wallet: { enabled: true, label: "App Credits" },
        stripe: {
          enabled: !!stripe,
          label: "Debit / Credit Card",
          testMode: stripeSecret.startsWith("sk_test_"),
        },
        jazzcash: {
          enabled: pkPaymentsEnabled && (jazzConfigured || PAYMENTS_SANDBOX),
          label: "JazzCash",
          sandbox: !jazzConfigured && PAYMENTS_SANDBOX,
        },
        easypaisa: {
          enabled: pkPaymentsEnabled && (easypaisaConfigured || PAYMENTS_SANDBOX),
          label: "EasyPaisa",
          sandbox: !easypaisaConfigured && PAYMENTS_SANDBOX,
        },
      },
      testMode: stripeSecret.startsWith("sk_test_"),
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

      const purpose = paymentPurpose(req.body);
      const customerId = await getOrCreateStripeCustomer(req.user.uid);
      const urls = stripeCheckoutUrls();

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        line_items: [
          {
            price_data: {
              currency: "pkr",
              unit_amount: Math.round(amount * 100),
              product_data: {
                name:
                  purpose === "wallet_top_up"
                    ? "Milkman App Credits"
                    : "Milkman Order",
              },
            },
            quantity: 1,
          },
        ],
        success_url: urls.success,
        cancel_url: urls.cancel,
        metadata: {
          userId: req.user.uid,
          purpose,
          referenceId: req.body?.referenceId || "",
        },
      });

      await db.collection("payment_records").doc(session.id).set({
        provider: "stripe",
        userId: req.user.uid,
        amount,
        currency: "PKR",
        status: "pending",
        purpose,
        referenceId: req.body?.referenceId || null,
        checkoutUrl: session.url,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        sessionId: session.id,
        checkoutUrl: session.url,
        paymentIntentId: session.id,
        paymentId: session.id,
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

      const sessionId = req.body?.sessionId;
      if (sessionId) {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.metadata?.userId !== req.user.uid) {
          return res.status(403).json({ error: "Not your payment." });
        }

        if (session.mode === "setup") {
          if (session.status !== "complete") {
            return res.status(402).json({
              error: "Card setup not completed yet.",
            });
          }
          return res.json({ saved: true, paid: true, sessionId });
        }

        const paid =
          session.payment_status === "paid" || session.status === "complete";
        await db.collection("payment_records").doc(sessionId).set(
          {
            status: paid ? "paid" : session.payment_status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (!paid) {
          return res.status(402).json({
            error: "Payment not completed yet. Finish checkout in the browser.",
          });
        }

        let balanceAfter = null;
        const record = await db.collection("payment_records").doc(sessionId).get();
        if (record.exists && record.data().purpose === "wallet_top_up") {
          balanceAfter = await settleWalletTopUp(sessionId);
        }

        return res.json({
          paid: true,
          paymentStatus: "paid",
          paymentMethod: "stripe",
          sessionId,
          balance: balanceAfter,
        });
      }

      const paymentIntentId = req.body?.paymentIntentId;
      if (!paymentIntentId) {
        return res.status(400).json({
          error: "paymentIntentId or sessionId required.",
        });
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

      const balanceAfter = await settleWalletTopUp(paymentIntentId);

      res.json({
        paid: true,
        paymentStatus: "paid",
        paymentMethod: "stripe",
        paymentIntentId,
        balance: balanceAfter,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Stripe confirm failed." });
    }
  });

  function stripeCheckoutUrls() {
    return {
      success:
        process.env.STRIPE_SUCCESS_URL ||
        "https://checkout.stripe.com/success",
      cancel:
        process.env.STRIPE_CANCEL_URL || "https://checkout.stripe.com/cancel",
    };
  }

  app.post(
    "/api/payments/stripe/checkout-session",
    authMiddleware,
    async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe not configured." });
        }
        const amount = Number(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount." });
        }
        const purpose = paymentPurpose(req.body);
        const customerId = await getOrCreateStripeCustomer(req.user.uid);
        const urls = stripeCheckoutUrls();

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer: customerId,
          line_items: [
            {
              price_data: {
                currency: "pkr",
                unit_amount: Math.round(amount * 100),
                product_data: {
                  name:
                    purpose === "wallet_top_up"
                      ? "Milkman App Credits"
                      : "Milkman Order",
                },
              },
              quantity: 1,
            },
          ],
          success_url: urls.success,
          cancel_url: urls.cancel,
          metadata: {
            userId: req.user.uid,
            purpose,
            referenceId: req.body?.referenceId || "",
          },
        });

        await db.collection("payment_records").doc(session.id).set({
          provider: "stripe",
          userId: req.user.uid,
          amount,
          currency: "PKR",
          status: "pending",
          purpose,
          referenceId: req.body?.referenceId || null,
          checkoutUrl: session.url,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({
          sessionId: session.id,
          checkoutUrl: session.url,
          paymentId: session.id,
        });
      } catch (err) {
        console.error("stripe checkout-session:", err);
        res.status(500).json({ error: err.message || "Checkout failed." });
      }
    },
  );

  app.post(
    "/api/payments/stripe/complete-session",
    authMiddleware,
    async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe not configured." });
        }
        const sessionId = req.body?.sessionId;
        if (!sessionId) {
          return res.status(400).json({ error: "sessionId required." });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.metadata?.userId !== req.user.uid) {
          return res.status(403).json({ error: "Not your payment." });
        }

        const paid =
          session.payment_status === "paid" || session.status === "complete";
        await db.collection("payment_records").doc(sessionId).set(
          {
            status: paid ? "paid" : session.payment_status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (!paid) {
          return res.status(402).json({
            error: "Payment not completed yet. Finish checkout in the browser.",
          });
        }

        let balance = null;
        const record = await db.collection("payment_records").doc(sessionId).get();
        if (record.exists && record.data().purpose === "wallet_top_up") {
          balance = await settleWalletTopUp(sessionId);
        }

        res.json({
          paid: true,
          paymentStatus: "paid",
          paymentMethod: "stripe",
          sessionId,
          balance,
        });
      } catch (err) {
        res.status(500).json({ error: err.message || "Complete session failed." });
      }
    },
  );

  app.post(
    "/api/payments/stripe/setup-checkout",
    authMiddleware,
    async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe not configured." });
        }
        const customerId = await getOrCreateStripeCustomer(req.user.uid);
        const urls = stripeCheckoutUrls();

        const session = await stripe.checkout.sessions.create({
          mode: "setup",
          customer: customerId,
          payment_method_types: ["card"],
          success_url: urls.success,
          cancel_url: urls.cancel,
          metadata: { userId: req.user.uid, purpose: "save_card" },
        });

        res.json({
          sessionId: session.id,
          checkoutUrl: session.url,
        });
      } catch (err) {
        res.status(500).json({ error: err.message || "Setup checkout failed." });
      }
    },
  );

  app.post(
    "/api/payments/stripe/complete-setup",
    authMiddleware,
    async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe not configured." });
        }
        const sessionId = req.body?.sessionId;
        if (!sessionId) {
          return res.status(400).json({ error: "sessionId required." });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.metadata?.userId !== req.user.uid) {
          return res.status(403).json({ error: "Not your session." });
        }
        if (session.status !== "complete") {
          return res.status(402).json({
            error: "Card setup not completed yet.",
          });
        }

        res.json({ saved: true, sessionId });
      } catch (err) {
        res.status(500).json({ error: err.message || "Complete setup failed." });
      }
    },
  );

  app.get("/api/payments/stripe/cards", authMiddleware, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Stripe not configured." });
      }
      const customerId = await getOrCreateStripeCustomer(req.user.uid);
      const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: "card",
      });
      res.json({
        cards: methods.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand || "card",
          last4: pm.card?.last4 || "????",
          expMonth: pm.card?.exp_month || 0,
          expYear: pm.card?.exp_year || 0,
        })),
      });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || "Failed to list cards." });
    }
  });

  app.post("/api/payments/stripe/setup-intent", authMiddleware, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Stripe not configured." });
      }
      const customerId = await getOrCreateStripeCustomer(req.user.uid);
      const urls = stripeCheckoutUrls();

      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: customerId,
        payment_method_types: ["card"],
        success_url: urls.success,
        cancel_url: urls.cancel,
        metadata: { userId: req.user.uid, purpose: "save_card" },
      });

      res.json({
        sessionId: session.id,
        checkoutUrl: session.url,
        setupIntentId: session.id,
      });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || "Setup intent failed." });
    }
  });

  app.delete(
    "/api/payments/stripe/cards/:paymentMethodId",
    authMiddleware,
    async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe not configured." });
        }
        const customerId = await getOrCreateStripeCustomer(req.user.uid);
        const pm = await stripe.paymentMethods.retrieve(
          req.params.paymentMethodId,
        );
        if (pm.customer !== customerId) {
          return res.status(403).json({ error: "Not your card." });
        }
        await stripe.paymentMethods.detach(req.params.paymentMethodId);
        res.json({ removed: true });
      } catch (err) {
        res.status(500).json({ error: err.message || "Failed to remove card." });
      }
    },
  );

  function createPendingPayment(provider, userId, amount, referenceId, purpose) {
    const ref = db.collection("payment_records").doc();
    return ref
      .set({
        provider,
        userId,
        amount,
        currency: "PKR",
        status: "pending",
        purpose: purpose || "order",
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
        paymentPurpose(req.body),
      );

      if (jazzConfigured) {
        const returnUrl =
          process.env.JAZZCASH_RETURN_URL ||
          `${process.env.PUBLIC_API_URL || ""}/api/payments/jazzcash/callback`;
        const txnRefNo = `T${DateTimeNow()}`;
        const txnDateTime = formatJazzDateTime(new Date());
        const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const payload = {
          pp_Amount: Math.round(amount * 100).toString(),
          pp_BillReference: txnRefNo,
          pp_Description:
            paymentPurpose(req.body) === "wallet_top_up"
              ? "Milkman app credits"
              : "Milkman order",
          pp_Language: "EN",
          pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
          pp_Password: process.env.JAZZCASH_PASSWORD,
          pp_ReturnURL: returnUrl,
          pp_TxnCurrency: "PKR",
          pp_TxnDateTime: txnDateTime,
          pp_TxnExpiryDateTime: formatJazzDateTime(expiry),
          pp_TxnRefNo: txnRefNo,
          ppmpf_1: paymentId,
        };
        payload.pp_SecureHash = jazzCashSecureHash(
          payload,
          process.env.JAZZCASH_INTEGRITY_SALT,
        );

        const apiUrl =
          process.env.JAZZCASH_API_URL ||
          "https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction";

        const jcRes = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const jcBody = await jcRes.json().catch(() => ({}));

        const responseCode =
          jcBody.pp_ResponseCode || jcBody.responseCode || "";
        const checkoutUrl =
          jcBody.pp_RedirectURL ||
          jcBody.redirectURL ||
          jcBody.checkoutUrl ||
          null;

        if (responseCode && responseCode !== "000" && !checkoutUrl) {
          return res.status(502).json({
            error:
              jcBody.pp_ResponseMessage ||
              jcBody.responseMessage ||
              `JazzCash error (${responseCode}).`,
          });
        }

        await db.collection("payment_records").doc(paymentId).update({
          externalRef: txnRefNo,
          checkoutUrl,
          jazzcashResponse: jcBody,
        });

        if (!checkoutUrl) {
          return res.status(502).json({
            error: "JazzCash did not return a checkout URL. Check sandbox credentials.",
          });
        }

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
        paymentPurpose(req.body),
      );

      if (easypaisaConfigured) {
        const returnUrl =
          process.env.EASYPAISA_RETURN_URL ||
          `${process.env.PUBLIC_API_URL || ""}/api/payments/easypaisa/callback`;
        const orderRef = `EP${DateTimeNow()}`;
        const amountStr = amount.toFixed(2);
        const hash = easypaisaHash({
          storeId: process.env.EASYPAISA_STORE_ID,
          orderRef,
          amount: amountStr,
          hashKey: process.env.EASYPAISA_HASH_KEY,
        });
        const baseUrl =
          process.env.EASYPAISA_CHECKOUT_URL ||
          "https://easypay.easypaisa.com.pk/easypay/Index.jsf";
        const checkoutUrl =
          `${baseUrl}?` +
          new URLSearchParams({
            storeId: process.env.EASYPAISA_STORE_ID,
            orderId: orderRef,
            transactionAmount: amountStr,
            mobileAccountNo: "",
            emailAddress: "",
            tokenExpiry: "",
            bankIdentificationNumber: "",
            postBackURL: returnUrl,
            signature: hash,
          }).toString();

        await db.collection("payment_records").doc(paymentId).update({
          externalRef: orderRef,
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

      const balanceAfter = await settleWalletTopUp(paymentId);

      res.json({
        paid: true,
        paymentStatus: "paid",
        paymentMethod: data.provider,
        paymentId,
        balance: balanceAfter,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Sandbox complete failed." });
    }
  });

  /** JazzCash return / IPN — public, no auth (gateway callback). */
  app.post(
    "/api/payments/jazzcash/callback",
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const body = req.body || {};
        const responseCode = body.pp_ResponseCode || "";
        const txnRef = body.pp_TxnRefNo || body.pp_BillReference || "";
        const paymentId = body.ppmpf_1 || null;

        let ref = paymentId
          ? db.collection("payment_records").doc(paymentId)
          : null;
        if (ref) {
          const snap = await ref.get();
          if (!snap.exists) ref = null;
        }
        if (!ref && txnRef) {
          const q = await db
            .collection("payment_records")
            .where("externalRef", "==", txnRef)
            .limit(1)
            .get();
          if (!q.empty) ref = q.docs[0].ref;
        }

        if (ref && responseCode === "000") {
          await ref.update({
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            gatewayPayload: body,
          });
          await settleWalletTopUp(ref.id);
        } else if (ref) {
          await ref.update({
            status: "failed",
            gatewayPayload: body,
          });
        }

        res.status(200).send("OK");
      } catch (err) {
        console.error("jazzcash callback:", err);
        res.status(200).send("OK");
      }
    },
  );

  /** EasyPaisa post-back — public callback. */
  app.post(
    "/api/payments/easypaisa/callback",
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const body = req.body || {};
        const orderRef = body.orderRefNumber || body.orderId || "";
        const status = (body.status || body.transactionStatus || "").toString();

        const q = await db
          .collection("payment_records")
          .where("externalRef", "==", orderRef)
          .limit(1)
          .get();

        if (!q.empty) {
          const ref = q.docs[0].ref;
          const paid =
            status.toLowerCase() === "paid" ||
            status === "000" ||
            body.responseCode === "000";
          if (paid) {
            await ref.update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              gatewayPayload: body,
            });
            await settleWalletTopUp(ref.id);
          } else {
            await ref.update({ status: "failed", gatewayPayload: body });
          }
        }

        res.status(200).send("OK");
      } catch (err) {
        console.error("easypaisa callback:", err);
        res.status(200).send("OK");
      }
    },
  );

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

      let balance = null;
      if (data.status === "paid") {
        balance = await settleWalletTopUp(req.params.paymentId);
      }

      res.json({
        paymentId: snap.id,
        status: data.status,
        provider: data.provider,
        paid: data.status === "paid",
        balance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "Status check failed." });
    }
  });

  function DateTimeNow() {
    return Date.now().toString();
  }

  function formatJazzDateTime(date) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
    );
  }

  function jazzCashSecureHash(fields, integritySalt) {
    const salt = integritySalt || "";
    const sorted = Object.keys(fields)
      .filter(
        (k) =>
          k !== "pp_SecureHash" &&
          fields[k] != null &&
          String(fields[k]).length > 0,
      )
      .sort();
    const values = sorted.map((k) => String(fields[k])).join("&");
    const message = `${salt}&${values}`;
    return crypto
      .createHmac("sha256", salt)
      .update(message)
      .digest("hex")
      .toUpperCase();
  }

  function easypaisaHash({ storeId, orderRef, amount, hashKey }) {
    const raw = `${storeId}${orderRef}${amount}${hashKey}`;
    return crypto.createHash("sha256").update(raw).digest("hex");
  }
}

module.exports = { registerPaymentRoutes };
