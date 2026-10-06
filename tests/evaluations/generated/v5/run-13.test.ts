import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const input = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
  ...overrides,
});

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the call to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(input({ amount: 2500, currency: "eur" }));

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("eur");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(input({ source: "tok_pending" }));
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(input());
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("sends the API key and JSON body", async () => {
    let auth: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post("https://api.example.com/v1/payments", async ({ request }) => {
        auth = request.headers.get("Authorization");
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({ id: "pay_x" }, { status: 201 });
      }),
    );

    await client.createPayment(input({ amount: 42 }));

    expect(auth!).toBe("Bearer test_key");
    expect(contentType!).toBe("application/json");
    expect(body).toEqual({ amount: 42, currency: "usd", source: "tok_visa" });
  });

  test("uses a custom baseUrl", async () => {
    server.use(
      http.post("https://custom.example.com/api/payments", () =>
        HttpResponse.json({ id: "pay_custom" }, { status: 201 }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://custom.example.com/api",
    });
    const payment = await custom.createPayment(input());
    expect(payment.id).toBe("pay_custom");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_chargeDeclined" })),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_insufficientFunds" })),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_serverError" })),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_nope" })),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
    ["non-numeric amount", { amount: "100" as unknown as number }],
    ["missing currency", { currency: undefined as unknown as string }],
    ["missing source", { source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, overrides) => {
    await expectApiError(client.createPayment(input(overrides)), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment(input()),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment that failed", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_chargeDeclined" })),
      402,
      "card_declined",
    );
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment(input({ amount: 777 }));
    const fetched = await client.getPayment(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(777);
    expect(fetched.status).toBe("succeeded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(input({ amount: 100 }));
    const b = await client.createPayment(input({ amount: 200, source: "tok_pending" }));

    const all = await client.listPayments();

    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input());
    const pending = await client.createPayment(input({ source: "tok_pending" }));

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in filters", async () => {
    const payment = await client.createPayment(input({ amount: 100 }));
    await client.refundPayment(payment.id, { amount: 40 });

    const partial = await client.listPayments({ status: "partially_refunded" });
    expect(partial.map((p) => p.id)).toEqual([payment.id]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(300);
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await client.refundPayment(created.id, { amount: 300 });
    const second = await client.refundPayment(created.id, { amount: 200 });
    expect(second.status).toBe("partially_refunded");
    expect(second.amountRefunded).toBe(500);

    const final = await client.refundPayment(created.id);
    expect(final.status).toBe("refunded");
    expect(final.amountRefunded).toBe(1000);
  });

  test("persists the refund", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);
    expect(fetched.amountRefunded).toBe(250);
    expect(fetched.status).toBe("partially_refunded");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(input());
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 600",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    const fetched = await client.getPayment(created.id);
    expect(fetched.amountRefunded).toBe(0);
    expect(fetched.status).toBe("succeeded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input());

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error parsing fallbacks", () => {
  test("uses unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_bad", () =>
        HttpResponse.text("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_bad"), 502, "unknown_error", "Bad Gateway");
  });

  test("uses unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_bad", () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(
      client.getPayment("pay_bad"),
      503,
      "unknown_error",
      "Service Unavailable",
    );
  });
});
