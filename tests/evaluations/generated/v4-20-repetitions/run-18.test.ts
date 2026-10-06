import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string | RegExp,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toMatch(message);
  }
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

function succeededPayment(amount = 1000) {
  return client.createPayment({ ...card, amount });
}

function pendingPayment(amount = 1000) {
  return client.createPayment({ ...card, amount, source: "tok_pending" });
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(card);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await pendingPayment();

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await succeededPayment();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment(card),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test.each([
    ["zero amount", { ...card, amount: 0 }],
    ["negative amount", { ...card, amount: -5 }],
    ["non-integer amount", { ...card, amount: 10.5 }],
    ["non-numeric amount", { ...card, amount: "100" as unknown as number }],
    ["missing currency", { ...card, currency: undefined as unknown as string }],
    ["missing source", { ...card, source: undefined as unknown as string }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_bogus" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects tok_chargeDeclined with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects tok_insufficientFunds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces tok_serverError as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await succeededPayment(2500);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
    expect(fetched.amount).toBe(2500);
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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await succeededPayment();

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await succeededPayment(100);
    const b = await pendingPayment(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await succeededPayment(100);
    const pending = await pendingPayment(200);

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await succeededPayment();

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await succeededPayment(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a given amount", async () => {
    const created = await succeededPayment(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("allows successive partial refunds until fully refunded", async () => {
    const created = await succeededPayment(1000);

    await client.refundPayment(created.id, { amount: 400 });
    const final = await client.refundPayment(created.id, { amount: 600 });

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await succeededPayment(1000);

    await client.refundPayment(created.id, { amount: 300 });
    const final = await client.refundPayment(created.id);

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund", async () => {
    const created = await succeededPayment(1000);

    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);
    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 250 });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await succeededPayment();

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a fully refunded payment with 409 already_refunded", async () => {
    const created = await succeededPayment();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await pendingPayment();

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await pendingPayment();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await succeededPayment(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await succeededPayment(1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await succeededPayment(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("does not change the payment when the refund is rejected", async () => {
    const created = await succeededPayment(1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await pendingPayment();

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await pendingPayment();

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await succeededPayment();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await pendingPayment();
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects a refunded payment with 409 not_cancelable", async () => {
    const created = await succeededPayment();
    await client.refundPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });
});

describe("request details", () => {
  test("sends the bearer token and JSON content type", async () => {
    let captured: Request | undefined;
    server.use(
      http.post("https://api.example.com/v1/payments", ({ request }) => {
        captured = request.clone();
        return HttpResponse.json({} as Payment, { status: 201 });
      }),
    );

    await client.createPayment(card);

    expect(captured?.headers.get("Authorization")).toBe("Bearer test_key");
    expect(captured?.headers.get("Content-Type")).toBe("application/json");
  });

  test("falls back to unknown_error and the status text for a non-JSON error body", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("upstream down", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), 503, "unknown_error", "Service Unavailable");
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal/v2/payments/pay_1", () =>
        HttpResponse.json({ id: "pay_1" }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://payments.internal/v2",
    });

    expect((await custom.getPayment("pay_1")).id).toBe("pay_1");
  });
});
