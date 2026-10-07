import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

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
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });
const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
    });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 700,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([createSucceeded(), createSucceeded()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(
      client.createPayment({ amount, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await createSucceeded(4200);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so it cannot escape the payments path", async () => {
    // Unencoded, "x/refund" would hit the refund route (POST only) or a different path.
    await expectApiError(client.getPayment("x/refund"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await createSucceeded(100);
    const b = await createPending(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    await createSucceeded(100);
    const pending = await createPending(200);

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createSucceeded();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in filtered results", async () => {
    const pending = await createPending();
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a given amount", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("marks the payment refunded when partial refunds sum to the full amount", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 600 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
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
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await createPending();

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await createPending();

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await createPending();
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await createPending();

    await expectApiError(badKeyClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error body handling", () => {
  test("falls back to unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments`,
        () => HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error", "Service Unavailable");
  });
});
